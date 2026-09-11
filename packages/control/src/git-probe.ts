import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
/** A probe that hangs (a network-mounted repo, a stuck lock) must fail the verb, not the CLI. */
const PROBE_TIMEOUT_MS = 5_000

/** The two questions `createWorkspace` asks a path (spec §2 A1). Injectable so the verb's own
 *  tests never spawn git; `realGitProbe` is what production and the integration test use. */
export interface GitProbe {
  isRepository(path: string): Promise<boolean>
  branchExists(path: string, branch: string): Promise<boolean>
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
}

/** How much of the sha-256 a fingerprint keeps. Thirty-two hex characters is 128 bits, which is far
 *  past any collision risk for a value whose only use is `===` against the previous beat's. */
const FINGERPRINT_CHARS = 32

/**
 * "Has anything changed in this worktree since last time?" (M51 R1), as an injectable probe.
 *
 * Deliberately NOT a third method on {@link GitProbe} (plan erratum E7): that interface answers the
 * two questions `createWorkspace` asks a path, it has a live injection seam (`useGitProbe` in
 * `./workspace.ts`), and a third REQUIRED method would break every fake that implements it. Two
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
