import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Bounded, like every git call made on a run's behalf: a contended `index.lock` must not hang a conclusion. */
const GIT_TIMEOUT_MS = 30_000

/**
 * What {@link commitUncommittedWork} did. `failed` is reported, never thrown: the conclusion that
 * calls this goes on to verify and review either way, and a worker's work that could not be
 * committed for it is still exactly what it would have been without this function.
 */
export type WipCommitOutcome =
  | { readonly kind: 'clean' }
  | { readonly kind: 'committed'; readonly sha: string; readonly message: string; readonly leftOut?: LeftOut }
  | { readonly kind: 'nothing_owned'; readonly leftOut: LeftOut }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string }

/** How many of the paths a package run's leftover commit left out are named: enough to read. */
export const LEFT_OUT_LISTED = 20

/**
 * The uncommitted paths a package run's leftover commit did NOT stage because the package does not
 * own them: every one counted, the first {@link LEFT_OUT_LISTED} (sorted) named.
 */
export interface LeftOut {
  readonly total: number
  readonly paths: readonly string[]
}

/** The commit message, spelt once: `wip(<task key>): uncommitted work at run end`. */
export function wipCommitMessage(taskKey: string): string {
  return `wip(${taskKey}): uncommitted work at run end`
}

/**
 * Commits whatever a SUCCEEDED implementation run left uncommitted in its worktree, on the worker's
 * behalf and under the worker's own git identity (H9 F7 rule a).
 *
 * **Why.** Verify runs against the worktree, but review judges `base...branch` -- COMMITS. On
 * 2026-09-21 a Cursor worker made 170 tool calls of real work and never committed; the review saw
 * an empty diff and rejected it, and because earlier platform failures had already spent the
 * task's attempts, that rejection failed the task and blocked most of the board. A worker that
 * forgot to commit still hands over its work.
 *
 * **Under whose name.** The worker's -- the same `GIT_AUTHOR_*`/`GIT_COMMITTER_*` pair its own
 * process commits under (`buildChildEnv`), supplied per command rather than by writing
 * `git config`, for the M0 reason: `.git/config` is shared by every worktree of the repository.
 * The message says plainly that the orchestrator made this commit, so nobody reads it as a
 * deliberate step of the worker's.
 *
 * **What it will not do.** It commits only when HEAD is the task's own branch: a worker that left
 * the worktree detached or on some other branch has done something this function cannot put right,
 * and a commit there would not reach the diff review reads anyway. It never commits files git
 * ignores, and the run's own files (`.cursor/hooks.json`, injected skills) are kept out of `git
 * status` by `.git/info/exclude` already. `--no-verify`, because a repository's own commit hooks
 * are the worker's to satisfy on its own commits; this one exists to hand the work over, and verify
 * runs the project's checks straight after it. `commit.gpgsign=false`, because a signing prompt
 * with nobody at the terminal is a conclusion that never finishes.
 *
 * **A package run (final review I1, controller Ruling 5).** With `owns`, only the changed paths it
 * accepts are staged and committed; every other change stays in the worktree, uncommitted and
 * untouched, and is reported as `leftOut`. Setup commands and tooling dirty files no package owns
 * (a lockfile, a generated file) on every provisioning; committed here under the worker's name they
 * reached the branch the ownership audit judges, failed it, and came back on every rework. The
 * worker's OWN commits are not filtered -- the audit still rejects a foreign file it committed. The
 * commit names its paths (`--pathspec-from-file`, so `--only` semantics), so a foreign file the
 * worker staged but never committed cannot ride along from the index either.
 *
 * Idempotent: a conclusion replayed after a restart finds a clean tree (or only foreign changes)
 * and commits nothing.
 */
export async function commitUncommittedWork(input: {
  readonly worktreePath: string
  readonly branch: string
  readonly taskKey: string
  readonly identity: { readonly name: string; readonly email: string }
  /** A governed package run's ownership: only paths it accepts are committed. Absent: everything. */
  readonly owns?: (path: string) => boolean
}): Promise<WipCommitOutcome> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: input.identity.name,
    GIT_AUTHOR_EMAIL: input.identity.email,
    GIT_COMMITTER_NAME: input.identity.name,
    GIT_COMMITTER_EMAIL: input.identity.email,
  }
  const git = async (args: readonly string[]): Promise<string> => {
    const { stdout } = await execFileAsync(
      'git',
      ['-c', `user.name=${input.identity.name}`, '-c', `user.email=${input.identity.email}`, '-c', 'commit.gpgsign=false', ...args],
      { cwd: input.worktreePath, env, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    )
    return stdout
  }

  try {
    const status = await git(['status', '--porcelain', '--untracked-files=all'])
    if (status.trim() === '') return { kind: 'clean' }

    const head = (await git(['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim()
    if (head !== `refs/heads/${input.branch}`) {
      return {
        kind: 'skipped',
        reason: `HEAD is ${head === '' ? 'detached' : head}, not refs/heads/${input.branch}: a commit here would not reach the branch review reads`,
      }
    }

    const message = wipCommitMessage(input.taskKey)
    const owns = input.owns
    if (owns === undefined) {
      await git(['add', '--all'])
      await git(['commit', '--no-verify', '-q', '-m', message])
      const sha = (await git(['rev-parse', 'HEAD'])).trim()
      return { kind: 'committed', sha, message }
    }

    const changed = await changedPaths(git)
    const owned = changed.filter((path) => owns(path))
    const foreign = changed.filter((path) => !owns(path))
    const leftOut: LeftOut | undefined =
      foreign.length === 0 ? undefined : { total: foreign.length, paths: foreign.slice(0, LEFT_OUT_LISTED) }
    if (owned.length === 0) return leftOut === undefined ? { kind: 'clean' } : { kind: 'nothing_owned', leftOut }
    await withPathspecFile(owned, async (file) => {
      const spec = [`--pathspec-from-file=${file}`, '--pathspec-file-nul']
      await git(['--literal-pathspecs', 'add', '--all', ...spec])
      await git(['--literal-pathspecs', 'commit', '--no-verify', '-q', '-m', message, ...spec])
    })
    const sha = (await git(['rev-parse', 'HEAD'])).trim()
    return leftOut === undefined ? { kind: 'committed', sha, message } : { kind: 'committed', sha, message, leftOut }
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Every path with an uncommitted change -- staged or not, tracked or untracked, deleted included --
 * sorted. `-z` keeps each path exactly as it is (a leading space, a quote, a newline), and
 * `--no-renames` lists a staged rename as both of its paths, so each side is judged on its own.
 */
async function changedPaths(git: (args: readonly string[]) => Promise<string>): Promise<readonly string[]> {
  const out = await git(['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'])
  const paths = out
    .split('\0')
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3))
  return [...new Set(paths)].toSorted()
}

/** The paths to stage, NUL-separated in a private temporary file: argv has a length limit, a tree
 *  of leftover work does not. */
async function withPathspecFile(paths: readonly string[], use: (file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'slaveofai-wip-'))
  try {
    const file = join(dir, 'pathspec')
    await writeFile(file, paths.join('\0'))
    await use(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
