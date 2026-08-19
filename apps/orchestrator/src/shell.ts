import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/**
 * Running one arbitrary shell command from a workspace's configuration, safely.
 *
 * Shared by worktree provisioning (a workspace's `setupCommands`) and verify (its
 * `verifyCommands`), because they are the same problem: a string the operator supplied, run in a
 * worktree, on a timer, whose output an operator has to be able to read afterwards. The hazards
 * below were each measured against provisioning before this module existed, and every one of them
 * applies to `npm test` exactly as it applies to `npm ci` -- a second implementation would meet
 * them all again, one review at a time.
 */

/**
 * How much of a failing setup command's output reaches the thrown message. Task 13 persists that
 * message as the run's `run.failed` reason, so an unbounded one puts a whole `npm ci` log into a
 * database column. Bounded from the *front*: the last thing a failing command printed is almost
 * always the reason it failed.
 */
export const COMMAND_OUTPUT_LIMIT = 16 * 1024

/**
 * How long one setup command may run. The tick awaits provisioning inline (spec §3.2), so a
 * command that never returns freezes the sweep and the reconcile pass for *every* workspace, not
 * just this one. Spec §8 gives verify commands a timeout from the workspace's guardrails and §7.2
 * gives setup none, which reads as an omission rather than a decision -- setup is the same class of
 * arbitrary shell. Ten minutes is chosen to clear a cold `npm ci` on a slow network with room to
 * spare; Task 13 should pass the workspace's own value once there is one.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000

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

export interface CommandOutcome {
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
export async function runShellCommand(input: {
  readonly command: string
  readonly cwd: string
  readonly timeoutMs: number
  readonly env?: NodeJS.ProcessEnv
}): Promise<CommandOutcome> {
  const { command, cwd, timeoutMs } = input
  const child = spawn('/bin/sh', ['-c', command], {
    cwd,
    env: input.env ?? process.env,
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
    tail = (tail + decoders[stream].write(chunk)).slice(-COMMAND_OUTPUT_LIMIT)
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
export function commandFailure(command: string, timeoutMs: number, outcome: CommandOutcome): Error {
  const how = outcome.timedOut
    ? `timed out after ${timeoutMs}ms`
    : outcome.signal !== null
      ? `killed by ${outcome.signal}`
      : `exit ${outcome.code ?? 'unknown'}`

  return new Error(
    `command ${how}: ${command}` + (outcome.output === '' ? '' : `\n${outcome.output}`),
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
