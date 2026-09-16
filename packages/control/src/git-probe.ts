import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
/** A probe that hangs (a network-mounted repo, a stuck lock) must fail the verb, not the CLI. */
const PROBE_TIMEOUT_MS = 5_000

/** The questions `createWorkspace` and the intake's detection (M59 R6) ask a path. Injectable so
 *  the verbs' own tests never spawn git; `realGitProbe` is what production, the integration tests
 *  and the gates use, and it is the only implementation in this repository --
 *  `grep -rn useGitProbe` finds the seam (`./workspace.ts`) and no caller. */
export interface GitProbe {
  isRepository(path: string): Promise<boolean>
  branchExists(path: string, branch: string): Promise<boolean>
  /** Every local branch, in `git`'s own order. Empty for a path that is not a repository and for
   *  one whose only branch is unborn (a fresh `git init` with no commit yet). */
  listBranches(path: string): Promise<readonly string[]>
  /** What `HEAD` points at -- including an UNBORN branch, which is exactly the state a repository
   *  `initRepository` (M59 R7) just created is in, and the reason this is `symbolic-ref` rather
   *  than a read of `listBranches`. Falls back to `main` when it is among the branches, then to
   *  the first branch, then to null (a detached HEAD in a repository with no branches at all). */
  defaultBranch(path: string): Promise<string | null>
}

async function git(cwd: string, ...args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: PROBE_TIMEOUT_MS })
    return stdout.trim()
  } catch {
    return null
  }
}

export const realGitProbe: GitProbe = {
  async isRepository(path) {
    // `rev-parse --is-inside-work-tree` prints `true` only from inside a work tree; a bare repo
    // prints `false`, a non-repo exits 128. Both non-`true` answers refuse: the orchestrator
    // provisions worktrees off a checked-out base branch, which a bare repo does not have.
    return (await git(path, 'rev-parse', '--is-inside-work-tree')) === 'true'
  },
  async branchExists(path, branch) {
    return (await git(path, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)) !== null
  },
  async listBranches(path) {
    const out = await git(path, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
    if (out === null || out === '') return []
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
  },
  async defaultBranch(path) {
    const head = await git(path, 'symbolic-ref', '--short', 'HEAD')
    if (head !== null && head !== '') return head
    const branches = await this.listBranches(path)
    if (branches.includes('main')) return 'main'
    return branches[0] ?? null
  },
}

/** How much of the sha-256 a fingerprint keeps. Thirty-two hex characters is 128 bits, which is far
 *  past any collision risk for a value whose only use is `===` against the previous beat's. */
const FINGERPRINT_CHARS = 32

/**
 * "Has anything changed in this worktree since last time?" (M51 R1), as an injectable probe.
 *
 * Deliberately NOT a method on {@link GitProbe} (plan erratum E7): that interface answers what a
 * path IS as a git repository, it has a live injection seam (`useGitProbe` in `./workspace.ts`),
 * and this probe answers a different question -- has anything CHANGED since last time -- that
 * `createWorkspace` and the intake's detection have no use for. `realGitProbe` is `GitProbe`'s
 * only implementation in this repository, so growing that interface breaks no fake (M59 plan
 * erratum E6 corrects the earlier claim that it would); the split here is about which question
 * belongs to which caller, not about protecting an implementation that does not exist. Two
 * interfaces in one file, sharing the same `git()` helper and the same {@link PROBE_TIMEOUT_MS}, is
 * the honest shape -- and the sweep, which is the only caller, injects this one on `SweepDeps`
 * rather than reaching for the module-level singleton the other has.
 */
export interface WorktreeProbe {
  fingerprint(path: string): Promise<string | null>
}

/**
 * `git status --porcelain` + `git rev-parse HEAD`, hashed.
 *
 * THE EXACT PAIR `apps/orchestrator/src/pump.ts` already takes when it writes a checkpoint, for the
 * same reason: between them they are the only "did the code change" evidence this system has, and
 * they catch both halves of it -- a commit moves HEAD, an uncommitted edit moves the porcelain.
 *
 * A FINGERPRINT rather than the porcelain itself, because the porcelain of a big dirty tree is
 * unbounded and the only question ever asked of this value is "is it the same string as last
 * time".
 *
 * **`null` means "no evidence either way", and a null SUPPRESSES the no-progress arm rather than
 * tripping it** (D17 -- the sweep passes `worktreeChanged: true` for it). A probe that timed out, a
 * worktree that was collected, a run with no worktree at all (a planning run): none of those is a
 * worker going in circles, and a breaker that read a failed measurement as a loop would stop
 * healthy runs on a slow disk.
 */
export const realWorktreeProbe: WorktreeProbe = {
  async fingerprint(path) {
    const head = await git(path, 'rev-parse', 'HEAD')
    const porcelain = await git(path, 'status', '--porcelain')
    // EITHER half missing is a null: a repository whose HEAD cannot be read is not a measurement
    // with one good half, it is a measurement that did not happen.
    if (head === null || porcelain === null) return null
    return createHash('sha256').update(`${head}\n${porcelain}`).digest('hex').slice(0, FINGERPRINT_CHARS)
  },
}
