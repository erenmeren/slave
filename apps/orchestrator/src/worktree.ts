import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Where worktrees live, relative to the workspace's repository root (spec §7.1). Inside the repo
 * rather than in a temp directory: a worktree is the inspection surface for a failed run (§7.4),
 * and an operator looking at why a task failed should find it next to the code, not have to be
 * told a path under `/tmp` that a reboot may already have taken away.
 */
const WORKTREE_ROOT = join('.aiteamos', 'worktrees')

/**
 * The identity every git command *the orchestrator itself* issues runs under -- layer 3 of spec
 * §7.3. Distinct from `StartRunInput.gitIdentity`, which is the *agent's* identity for the commits
 * a run produces; nothing here creates a commit, so this name is what would appear only if a git
 * subcommand unexpectedly needed an author, and it should read as the orchestrator rather than
 * impersonate whichever agent triggered the provisioning.
 *
 * Supplied per-command with `-c` rather than by writing `git config`, for the reason the M0 spike
 * found the hard way: `.git/config` is repo-wide state that worktrees do *not* isolate, so two
 * concurrent agents recovering from a missing-identity error both write it and silently overwrite
 * each other.
 */
const ORCHESTRATOR_GIT_IDENTITY = {
  name: 'AI Team OS',
  email: 'orchestrator@aiteamos.local',
} as const

/**
 * How much of a failing setup command's output reaches the thrown message. Task 13 persists that
 * message as the run's `run.failed` reason, so an unbounded one puts a whole `npm ci` log into a
 * database column. Bounded from the *front*: the last thing a failing command printed is almost
 * always the reason it failed.
 */
export const SETUP_OUTPUT_LIMIT = 16 * 1024

/**
 * How long one setup command may run. The tick awaits provisioning inline (spec §3.2), so a
 * command that never returns freezes the sweep and the reconcile pass for *every* workspace, not
 * just this one. Spec §8 gives verify commands a timeout from the workspace's guardrails and §7.2
 * gives setup none, which reads as an omission rather than a decision -- setup is the same class of
 * arbitrary shell. Ten minutes is chosen to clear a cold `npm ci` on a slow network with room to
 * spare; Task 13 should pass the workspace's own value once there is one.
 */
const DEFAULT_SETUP_TIMEOUT_MS = 10 * 60_000

/** How long a timed-out process group gets to die politely before it is killed outright. */
const KILL_GRACE_MS = 2_000

/**
 * How long to keep reading a finished command's pipes before giving up on them.
 *
 * The child exiting and its pipes closing are different events, and only the first is bounded by
 * anything this module controls: a setup command is free to leave a descendant holding the
 * inherited stdout -- `setsid`, a double fork, a backgrounded dev server -- and that descendant
 * keeps `close` from firing for as long as it lives. Measured: a `setsid`'d `sleep 20` made a
 * 300 ms timeout take 20 seconds to report, and it would do the same to a command that *succeeded*.
 * So the exit is what settles the command, and this is the bounded grace the pipes get to deliver
 * whatever was written just before it.
 */
const DRAIN_GRACE_MS = 200

/**
 * Task keys and slugs both become path segments and part of a branch name. `join()` collapses
 * `..`, so an unchecked key of `../../../../tmp/x` places the worktree outside the repository
 * entirely, and a value starting with `-` reaches git's argv where it parses as an option. Neither
 * is hypothetical: `Task` has no key column, so whatever Task 13 passes is synthesized -- plausibly
 * from a human-written title.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export interface ProvisionWorktreeInput {
  readonly repoPath: string
  readonly baseBranch: string
  readonly taskKey: string
  readonly slug: string
  readonly setupCommands: readonly string[]
  /** Per-command, not for the list as a whole. Defaults to {@link DEFAULT_SETUP_TIMEOUT_MS}. */
  readonly setupTimeoutMs?: number
}

export interface WorktreeHandle {
  readonly path: string
  readonly branch: string
  /**
   * The worktree's `HEAD` once provisioning is complete -- read *after* the setup commands, not
   * before. Setup is arbitrary shell (spec §7.2) and a workspace is free to have it commit; this
   * field is meant to answer "what did the run actually start from", which is only true of a
   * commit read at the end.
   */
  readonly headCommit: string
}

/**
 * Thrown when the task's worktree or branch is already there.
 *
 * This is a *distinguishable* outcome rather than a raw git failure because it is not an error
 * condition at all from the caller's side -- it is the normal shape of a task's second run. A task
 * that fails verify moves to `rework`, `decide()` lists `rework` as startable, and the next run
 * arrives here with the same key. Refusing is right: reusing a previous attempt's directory hands
 * the agent someone else's uncommitted state. But the adopt-versus-fail decision needs to know
 * *why* the leftovers exist, which only the caller does, and it must not be made by string-matching
 * git's stderr -- git reports the path collision and the branch collision with different exit codes
 * and different wording.
 *
 * Carries both paths so the caller can act without re-deriving them.
 */
export class WorktreeExistsError extends Error {
  constructor(
    readonly path: string,
    readonly branch: string,
    /**
     * Which half is there, as a field rather than as wording inside `message`.
     *
     * The caller's two cases live exactly here. `both` is the shape this task's own previous
     * attempt leaves: directory and branch, matching, which is what a task returning from
     * `rework` finds and the only case where adopting is defensible. `directory` alone is a
     * stray tree with nothing behind it and `branch` alone is the residue of a half-finished
     * removal -- neither is something a completed provision produced, so neither is safe to
     * adopt. Collapsing them (by short-circuiting the second check) would hand the caller the
     * adoptable case and the wreckage under one name.
     */
    readonly reason: 'directory' | 'branch' | 'both',
  ) {
    super(`worktree for this task already exists (${reason}): ${path} on ${branch}`)
    this.name = 'WorktreeExistsError'
  }
}

/**
 * Runs git with the orchestrator's identity supplied per-command. The `-c` pairs must precede the
 * subcommand, which is why this wrapper exists rather than each call site assembling its own argv.
 */
async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    [
      '-c',
      `user.name=${ORCHESTRATOR_GIT_IDENTITY.name}`,
      '-c',
      `user.email=${ORCHESTRATOR_GIT_IDENTITY.email}`,
      ...args,
    ],
    { cwd },
  )
  return stdout.trim()
}

/** True when the ref exists. `show-ref --verify` exits non-zero rather than printing when it does not. */
async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`)
    return true
  } catch {
    return false
  }
}

/**
 * The environment setup commands run under. Carries the same git identity variables the adapter
 * gives a run (§7.3 layer 1, `buildChildEnv` in `packages/providers`): setup is arbitrary shell
 * that a real workspace may well have commit something, and a setup command that hits git's
 * missing-identity error is exactly the situation whose "helpful" recovery was an unscoped
 * `git config` write into the shared common directory.
 */
function setupEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: ORCHESTRATOR_GIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: ORCHESTRATOR_GIT_IDENTITY.email,
    GIT_COMMITTER_NAME: ORCHESTRATOR_GIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: ORCHESTRATOR_GIT_IDENTITY.email,
  }
}

/**
 * Signals the child's whole process group, tolerating a group that has already gone.
 *
 * The group, not the process: `spawn(..., { detached: true })` makes the shell a group leader, and
 * signalling only the shell was measured to leave its children running -- a timed-out `npm ci`
 * would keep installing after the orchestrator had given up on it, which is a leak the operator
 * never sees.
 */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    // Already gone, or never started. Nothing to do either way.
  }
}

interface SetupOutcome {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  readonly output: string
}

/**
 * Runs one setup command in the worktree and reports how it ended.
 *
 * `spawn` rather than `execFile`, for three reasons that are all the same reason -- `execFile`'s
 * conveniences are the wrong shape for arbitrary shell that a real repository supplies:
 *
 * - **Output.** `execFile` buffers 1 MiB per stream and *kills the child* past it, rejecting with
 *   `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`. A succeeding `npm ci` on a real repository exceeds that
 *   routinely, and reported as a failure it counts as an attempt against the task (spec §13). Here
 *   the capture is bounded but the command is not: it runs to completion and only the *message*
 *   is trimmed.
 * - **Lifetime.** `execFile`'s timeout signals the immediate child only.
 * - **stdin.** `execFile` hands the child an open pipe nobody ever writes to or closes, so a
 *   command that reads stdin blocks forever. `ignore` gives it EOF immediately.
 *
 * The cost of `detached`, stated rather than discovered later: the shell is a session leader
 * outside the orchestrator's own process group, so a daemon that dies mid-provision leaves it
 * running against the worktree with nothing to reconcile -- §3.4's startup pass looks for runs
 * with dead pids, and no `AgentRun` exists yet at provisioning time. That is the right trade for
 * being able to kill the group at all, and it is Task 15's to sweep.
 */
async function runSetupCommand(command: string, cwd: string, timeoutMs: number): Promise<SetupOutcome> {
  const child = spawn('/bin/sh', ['-c', command], {
    cwd,
    env: setupEnv(),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let tail = ''
  let capturedBytes = 0
  // One decoder per stream, and never one shared between them: a decoder holds the leading bytes
  // of a character split across two reads, so feeding it from both pipes would splice one
  // stream's partial sequence onto the other's. Decoding each chunk with `toString` instead
  // destroys any multi-byte character that straddles a read -- measured at three replacement
  // characters in a single non-ASCII failure message, right where the operator is reading.
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
  const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer): void => {
    capturedBytes += chunk.length
    tail = (tail + decoders[stream].write(chunk)).slice(-SETUP_OUTPUT_LIMIT)
  }
  child.stdout.on('data', collect('stdout'))
  child.stderr.on('data', collect('stderr'))

  // Attached now, not after the exit is awaited. `close` follows `exit` closely enough that a
  // listener added on the far side of an `await` can miss it entirely -- and then every ordinary
  // setup command would sit out the full DRAIN_GRACE_MS below, turning a bounded fallback into
  // the normal path. Measured before it was fixed: two trivial commands took 452ms instead of 42.
  const closed = new Promise<void>((res) => child.on('close', () => res()))

  let timedOut = false
  const timers: NodeJS.Timeout[] = []
  const deadline = setTimeout((): void => {
    // A command that has already finished is not a command that timed out, even if the deadline
    // lands in the same turn as its exit. Marking it so would report a *succeeding* command as a
    // timeout, and a provisioning failure costs the task an attempt (spec §13).
    if (child.exitCode !== null || child.signalCode !== null) return
    timedOut = true
    if (child.pid !== undefined) {
      killGroup(child.pid, 'SIGTERM')
      timers.push(setTimeout((): void => killGroup(child.pid as number, 'SIGKILL'), KILL_GRACE_MS))
    }
  }, timeoutMs)
  timers.push(deadline)

  try {
    // `exit` settles the command; `close` only reports the pipes, which a descendant outside this
    // process group can hold open indefinitely -- see DRAIN_GRACE_MS.
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((res, rej) => {
      child.on('exit', (exitCode, exitSignal) => res([exitCode, exitSignal]))
      child.on('error', rej)
    })

    await Promise.race([closed, new Promise<void>((res) => timers.push(setTimeout(res, DRAIN_GRACE_MS)))])
    child.stdout.destroy()
    child.stderr.destroy()

    // Whatever the decoders still hold is an *incomplete* character -- `write` has already
    // returned every complete one. It is there because the command's output ended mid-character,
    // which is what `process.exit` during a large write does, and `end()` would render those
    // orphaned bytes as U+FFFD. Measured: exactly one, appended to an otherwise clean message.
    // A replacement character the child never printed is worse than the bytes it stands for.
    const dropped = capturedBytes - Buffer.byteLength(tail, 'utf8')
    const output = dropped > 0 ? `…(truncated, ${dropped} earlier bytes)\n${tail}` : tail
    return { code, signal, timedOut, output: output.trim() }
  } finally {
    for (const timer of timers) clearTimeout(timer)
  }
}

/**
 * Turns a non-zero setup outcome into the error an operator reads, naming the command, how it
 * ended, and what it printed.
 *
 * "How it ended" is three different facts, not one. A timeout is the orchestrator's own doing and
 * has no exit code to report; a signalled death (an OOM-killed `npm ci`, very plausible in a
 * container) has no exit code either, and its signal is the single most diagnostic thing about it;
 * only a plain non-zero exit has a code. Collapsing all three into "exit unknown" throws away the
 * fact the operator needs first.
 */
function setupFailure(command: string, timeoutMs: number, outcome: SetupOutcome): Error {
  const how = outcome.timedOut
    ? `timed out after ${timeoutMs}ms`
    : outcome.signal !== null
      ? `killed by ${outcome.signal}`
      : `exit ${outcome.code ?? 'unknown'}`

  return new Error(
    `setup command ${how}: ${command}` + (outcome.output === '' ? '' : `\n${outcome.output}`),
  )
}

/**
 * Creates the task's worktree on its own branch off `baseBranch`, runs the workspace's setup
 * commands inside it, and reports where it landed (spec §7.1, §7.2).
 *
 * The worktree is **not** cleaned up when a setup command fails. Spec §7.4 preserves worktrees on
 * failure because they are the inspection surface, and a half-provisioned one is the case where
 * that matters most: the operator's question is "how far did setup get", which a removed directory
 * cannot answer. Task 15's sweep owns collection.
 *
 * Leftovers from a previous attempt are refused, not adopted, and refused as a
 * {@link WorktreeExistsError} the caller can branch on -- see that class for why the decision is
 * the caller's. One half-state is deliberately left to git: a `.git/worktrees/` metadata entry
 * whose directory *and* branch are both gone still makes `worktree add` refuse, and it surfaces as
 * git's own error. It is what a `git worktree prune` exists for and is not this function's to
 * silently repair.
 */
export async function provisionWorktree(input: ProvisionWorktreeInput): Promise<WorktreeHandle> {
  for (const [field, value] of [
    ['taskKey', input.taskKey],
    ['slug', input.slug],
  ] as const) {
    if (!SAFE_SEGMENT.test(value)) {
      throw new Error(
        `${field} must match ${String(SAFE_SEGMENT)} to be safe as a path segment and a branch name, got: ${value}`,
      )
    }
  }

  // Absolute, because `path` becomes `AgentRun.worktreePath` and spec §5.7 respawns a resumed run
  // there -- from a process that may have restarted into a different working directory.
  const repoPath = resolve(input.repoPath)
  const path = join(repoPath, WORKTREE_ROOT, input.taskKey)
  const branch = `aiteamos/${input.taskKey}-${input.slug}`

  // Checked *before* the add rather than left to git's refusal, because `worktree add -b` creates
  // the branch first and then fails on the path -- measured -- so letting git refuse leaves a
  // branch behind with no worktree attached, and the next attempt fails differently than this one.
  // Both halves are evaluated before either is reported: which of them is present is the caller's
  // whole decision (see WorktreeExistsError.reason), and a short-circuit here would answer
  // "directory" for the rework case and for a stray tree alike.
  const hasDirectory = existsSync(path)
  const hasBranch = await branchExists(repoPath, branch)
  if (hasDirectory || hasBranch) {
    const reason = hasDirectory && hasBranch ? 'both' : hasDirectory ? 'directory' : 'branch'
    throw new WorktreeExistsError(path, branch, reason)
  }

  // `worktree add -b` creates the branch and the leading directories in one step.
  await git(repoPath, 'worktree', 'add', '-b', branch, path, input.baseBranch)

  // Sequential, and aborting on the first failure: setup commands are an ordered list whose later
  // entries routinely depend on earlier ones (`npm ci` then `npm run build`), so running on after
  // a failure produces a second, misleading error from the wrong command.
  const timeoutMs = input.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS
  for (const command of input.setupCommands) {
    // A spawn that never starts (a vanished cwd, no `/bin/sh`) rejects with a bare Node error,
    // and Task 13 persists whatever lands here as the run's `run.failed` reason. Wrapped so that
    // reason still names the command rather than reading as an orchestrator crash.
    const outcome = await runSetupCommand(command, path, timeoutMs).catch((cause: unknown) => {
      throw new Error(`setup command could not start: ${command}`, { cause })
    })
    if (outcome.timedOut || outcome.signal !== null || outcome.code !== 0) {
      throw setupFailure(command, timeoutMs, outcome)
    }
  }

  const headCommit = await git(path, 'rev-parse', 'HEAD')

  return { path, branch, headCommit }
}
