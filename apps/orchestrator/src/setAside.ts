import { execFile } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { runDirPathFor } from '@slave-of-ai/control'
import { runId as brandRunId } from '@slave-of-ai/domain'
import { changedEntries, LEFT_OUT_LISTED, withPathspecFile, type LeftOut } from './wipCommit.js'

const execFileAsync = promisify(execFile)

/** Bounded, like every git call made on a run's behalf (`wipCommit.ts`). */
const GIT_TIMEOUT_MS = 30_000

/**
 * What {@link setAsideForeignChanges} did. `failed` is reported, never thrown, and nothing is
 * removed from the worktree unless everything was saved first: a change that could not be saved
 * stays exactly where it was.
 */
export type SetAsideOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'set_aside'; readonly setAside: LeftOut; readonly savedTo: string }
  | { readonly kind: 'failed'; readonly reason: string }

/**
 * Where one set-aside of a run's foreign changes is saved: under the run's own state directory
 * (`runDirPathFor`, the directory its permissions file and pause flag already live in), outside the
 * repository and every worktree of it, one directory per set-aside so a second one -- the merge
 * pass's, after the leftover commit's -- never overwrites the first.
 */
export function setAsideDirFor(runId: string, label: 'leftover' | 'merge'): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(runDirPathFor(brandRunId(runId)), 'set-aside', `${label}-${stamp}`)
}

/**
 * Says what a set-aside did, in the log: how many paths, the first of them, and where they were
 * saved. Not an event -- nothing about the task changed, and no event type fits; the saved files
 * are the audit trail.
 */
export function logSetAside(who: string, outcome: SetAsideOutcome): void {
  if (outcome.kind === 'set_aside') {
    const { total, paths } = outcome.setAside
    console.warn(
      `${who} left ${String(total)} uncommitted change(s) to files its package does not own; set aside to ${outcome.savedTo}: ${paths.join(', ')}${total > paths.length ? ' ...' : ''}`,
    )
  } else if (outcome.kind === 'failed') {
    console.warn(`${who}: changes to files its package does not own could not be set aside and are still in the worktree: ${outcome.reason}`)
  }
}

/**
 * Takes a governed package task's uncommitted changes to paths its package does NOT own out of its
 * worktree, after saving them (Conductor Plan 3, fix round 3, controller Ruling 7).
 *
 * **Why.** The leftover-work commit stages only what the package owns (`wipCommit.ts`, Ruling 5);
 * what setup and tooling dirtied elsewhere -- a lockfile, a generated file -- was left in the tree.
 * Then verify, and the merge pass's post-rebase re-verify, judged the branch PLUS those leftovers,
 * not the tree that lands; and `git rebase` refuses a dirty tree. With them removed, the worktree
 * is the committed branch for every path the package does not own, which is what both gates must
 * judge and what the rebase needs.
 *
 * **Saved, not discarded.** Into `saveDir`: `changes.patch`, one binary-safe `git diff` of every
 * foreign path against HEAD as the worktree holds it (tracked, staged, deleted and untracked alike;
 * `git apply` puts them back), and `untracked/<path>`, a copy of each untracked foreign file as it
 * was on disk. Never `git stash`: `refs/stash` is shared by every worktree of the repository, so an
 * entry pushed here sits in the operator's own stash list, and two workspaces on one repository
 * would race on it.
 *
 * **Removed.** Tracked foreign paths are restored to HEAD in the index and the tree (a staged new
 * file leaves both); untracked foreign files are deleted. Owned paths are not touched. Ignored files
 * are not changes and are not touched either.
 */
export async function setAsideForeignChanges(input: {
  readonly worktreePath: string
  readonly owns: (path: string) => boolean
  readonly saveDir: string
}): Promise<SetAsideOutcome> {
  const git = async (args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> => {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd: input.worktreePath,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    })
    return stdout
  }

  try {
    const foreign = (await changedEntries(git)).filter((entry) => !input.owns(entry.path))
    if (foreign.length === 0) return { kind: 'none' }
    const paths = [...new Set(foreign.map((entry) => entry.path))].toSorted()
    const tracked = [...new Set(foreign.filter((entry) => !entry.untracked).map((entry) => entry.path))]
    // A path git lists twice (removed from the index, still on disk: `D ` and `??`) is restored to
    // HEAD, not deleted -- its disk copy is saved with the untracked files first.
    const untracked = foreign.filter((entry) => entry.untracked).map((entry) => entry.path)
    const deletable = untracked.filter((path) => !tracked.includes(path))

    await mkdir(input.saveDir, { recursive: true, mode: 0o700 })
    for (const path of untracked) {
      await cp(join(input.worktreePath, path), join(input.saveDir, 'untracked', path), {
        recursive: true,
        verbatimSymlinks: true,
      })
    }
    await writePatch(git, await patchable(git, input.worktreePath, paths), join(input.saveDir, 'changes.patch'))

    if (tracked.length > 0) {
      await withPathspecFile(tracked, async (file) => {
        await git([
          '--literal-pathspecs',
          'restore',
          '--source=HEAD',
          '--staged',
          '--worktree',
          `--pathspec-from-file=${file}`,
          '--pathspec-file-nul',
        ])
      })
    }
    for (const path of deletable) await rm(join(input.worktreePath, path), { recursive: true, force: true })

    return { kind: 'set_aside', setAside: { total: paths.length, paths: paths.slice(0, LEFT_OUT_LISTED) }, savedTo: input.saveDir }
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The paths a patch can name: those on disk, and those HEAD has (a deletion). A file staged new and
 * then deleted from disk is neither -- its content was never committed nor is it in the tree, and
 * naming it would fail the whole `git add`; restoring it to HEAD removes it from the index.
 */
async function patchable(
  git: (args: readonly string[]) => Promise<string>,
  worktreePath: string,
  paths: readonly string[],
): Promise<readonly string[]> {
  const kept: string[] = []
  for (const path of paths) {
    const onDisk = await lstat(join(worktreePath, path)).then(
      () => true,
      () => false,
    )
    const known =
      onDisk ||
      (await git(['cat-file', '-e', `HEAD:${path}`]).then(
        () => true,
        () => false,
      ))
    if (known) kept.push(path)
  }
  return kept
}

/**
 * One patch of `paths` against HEAD, as the worktree holds them. Built through a private index
 * (HEAD plus exactly these paths as they are on disk), because `git diff` takes no pathspec file
 * and argv has a length limit; and the worktree's own index is not touched. `--binary`, so a binary
 * file is in it whole; `--no-renames`, so each path is its own entry.
 */
async function writePatch(
  git: (args: readonly string[], env?: NodeJS.ProcessEnv) => Promise<string>,
  paths: readonly string[],
  output: string,
): Promise<void> {
  if (paths.length === 0) return
  const dir = await mkdtemp(join(tmpdir(), 'slaveofai-set-aside-'))
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') }
    await git(['read-tree', 'HEAD'], env)
    await withPathspecFile(paths, async (file) => {
      await git(['--literal-pathspecs', 'add', '--all', `--pathspec-from-file=${file}`, '--pathspec-file-nul'], env)
    })
    await git(['diff', '--cached', '--binary', '--no-renames', '--no-color', `--output=${output}`, 'HEAD'], env)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
