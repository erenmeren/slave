import { closeSync, existsSync, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  runBrokeredOperation,
  runFilePaths,
  type BrokerExecutor,
} from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import {
  BROKER_REFUSAL_REASONS,
  runId as brandRunId,
  type BrokerRefusalReason,
  type WorkspaceId,
} from '@slave-of-ai/domain'
import { brokerChannelPathFor, brokerReplyPathFor } from '@slave-of-ai/providers'
import { z } from 'zod'
import { runShellCommand } from './shell.js'
import { NON_TERMINAL_RUN_STATUSES } from './world.js'

/**
 * The orchestrator's half of the capability broker (M52 R3): read the requests a worker appended,
 * authorise them through `packages/control`, run what survives, and write each answer back.
 *
 * THE CHANNEL IS A FILE, and that is a choice with a reason. `SLAVEOFAI_BROKER_CHANNEL` is the
 * FOURTH channel of the shape `SLAVEOFAI_PAUSE_FLAG`, `SLAVEOFAI_PERMISSIONS_FILE` and
 * `SLAVEOFAI_TOOL_RESULTS` already are: no port, no listener, no second process, and nothing to
 * authenticate against. The alternative the direction reached for -- a CLI that authenticates
 * against the database -- cannot exist: M52's own `CHILD_ENV_ALLOW` removes `DATABASE_URL` from the
 * child, so a process spawned in the worker's shell has no database, which is the entire point.
 *
 * IDENTITY, AND WHAT IT IS WORTH. A request line carries a run token, and `runBrokeredOperation`
 * resolves the run from that token alone -- so this pass adds the second half, which the token
 * cannot supply: a line whose `runId` is not the directory it was found in is refused
 * (`identity_mismatch`), and a reply is only ever written into the directory its request came from.
 * Without that, a token lifted from a sibling's channel could be replayed on the thief's OWN
 * channel and the operation's output delivered to the thief (plan erratum E15).
 *
 * WHAT IS LEFT, stated rather than implied: a run directory is 0700 under the same uid as every
 * other run on this host, so a worker that enumerates `<state>/slaveofai/runs/` and reads a
 * sibling's channel -- after that sibling has made at least one request -- can act as that sibling
 * ON ITS OWN CHANNEL. Three things reduce it and none of them removes it: the directories are named
 * by uuid, they are outside every worktree a worker can see (M52 R4, which is what made that true),
 * and a served request cannot be replayed, because its reply file is its idempotency key.
 *
 * IDEMPOTENCY IS THE FILE. This module keeps an in-memory byte offset per channel, and that offset
 * is an optimisation, never the correctness: a daemon restart re-reads every channel from byte zero,
 * and what stops a second execution is that `broker-<requestId>.json` already exists. Two daemons
 * serving one channel would race on that existence check; the design's answer is the one this
 * repository already relies on for every run -- one daemon per workspace.
 *
 * NOTHING HERE THROWS OUT OF A TICK. This runs inside `sweep()`, which runs inside the daemon's
 * tick. Every read is `try`/`catch`, an unparseable line is skipped (never a reply -- a line that is
 * not a request has no `requestId` to answer), and an executor that throws becomes a refused reply
 * rather than a dead daemon.
 *
 * WHAT IT COSTS THE TICK, named rather than discovered later: a brokered operation runs INLINE, so
 * a deploy that takes its whole `BROKER_TIMEOUT_MS` holds this workspace's sweep for two minutes --
 * no guardrail check, no orphan check, no breaker beat until it returns (the pumps are their own
 * promise chains and keep running). The alternative -- starting the execution and not awaiting it --
 * costs the property this whole module is built on: while an operation is in flight its reply file
 * does not exist yet, so the only thing that could stop a second execution would be an in-memory
 * set, and an in-memory set does not survive the restart that the reply file is here to survive. A
 * deploy that runs twice is worse than a sweep that is late, so the operation is awaited.
 */

/**
 * One line a worker may append. Bounded before it is parsed: a peer that never sends a newline is
 * otherwise an unbounded memory sink, so the read is capped at {@link CHANNEL_READ_MAX_BYTES} per
 * pass and any single line over {@link REQUEST_LINE_MAX_BYTES} is DROPPED rather than truncated --
 * the `tool-result-tap.sh` rule (`:39-43`), for its reason: half a request is not a request.
 */
export const REQUEST_LINE_MAX_BYTES = 8 * 1024
const CHANNEL_READ_MAX_BYTES = 256 * 1024

const requestSchema = z
  .object({
    requestId: z.string().regex(/^[a-f0-9]{32}$/u),
    runId: z.string().min(1),
    runToken: z.string().regex(/^[0-9a-f]{64}$/u),
    op: z.string().min(1).max(64),
    params: z.record(z.string(), z.unknown()),
  })
  .strict()

/**
 * The one `reason` a reply may carry that is NOT one of the seven `BrokerRefusalReason`s.
 *
 * The refusal vocabulary is closed at seven and every one of them is an ANSWER -- a thing the
 * broker decided about this request. "The pass itself broke" is not one of those, and borrowing a
 * refusal word for it would tell a worker (and, through it, a person reading a transcript) that a
 * rule refused them when no rule did. Spelled once, here, so the CLI that prints it can recognise
 * it by the same token.
 */
export const BROKER_INTERNAL_ERROR_REASON = 'internal_error'

/** What the daemon writes into `broker-<requestId>.json`, and the whole of what a worker learns. */
export interface BrokerReply {
  readonly requestId: string
  /** Whether the operation RAN, never whether it succeeded: a bound script that exits 3 is an
   *  execution, and its exit code is the operation's own verdict (Task 3's rule, unchanged here). */
  readonly ok: boolean
  readonly exitCode: number | null
  readonly output: string
  readonly reason: BrokerRefusalReason | typeof BROKER_INTERNAL_ERROR_REASON | null
}

/**
 * What a reader of a reply file may rely on -- the shape {@link BrokerReply} is written in, read
 * back by the worker's own thin client (`cli.ts`'s `broker run`) with `safeParse`.
 *
 * A SCHEMA and not a cast: the client parses a file it did not write, in a directory the worker can
 * write, so "whatever is in there is a reply" is exactly the assumption that must not be made. A
 * file that does not fit is treated as not-yet-an-answer and the client keeps waiting, which ends at
 * `BROKER_CLIENT_TIMEOUT_MS` with a sentence rather than at a stack trace.
 */
export const brokerReplySchema = z.object({
  requestId: z.string(),
  ok: z.boolean(),
  exitCode: z.number().int().nullable(),
  output: z.string(),
  reason: z.string().nullable(),
})

/** A reply as READ back. Separate from {@link BrokerReply}, which is how one is written: a reader
 *  must accept a `reason` this version's vocabulary does not have, and decide what to do about it.
 *  {@link isBrokerRefusalReason} is that decision. */
export type BrokerReplyRead = z.infer<typeof brokerReplySchema>

/**
 * Byte offsets, per channel path, so an ordinary pass reads only what was appended since the last
 * one. AN OPTIMISATION AND NEVER THE CORRECTNESS -- see the module header. Two consequences follow
 * from that one sentence and both are relied on below: a restart may reset it (that is what
 * {@link resetBrokerCursors} models), and a pass may PRUNE it for a channel it did not visit, which
 * is what keeps a daemon that has served a thousand runs from holding a thousand dead entries.
 */
const cursors = new Map<string, number>()

/** What a daemon restart does to {@link cursors}. Exported for the test that pins the property;
 *  `resetTickObservation` (`./sweep.ts`) is the same shape for the same reason. */
export function resetBrokerCursors(): void {
  cursors.clear()
}

/**
 * One pass over every live run's channel in this workspace (M52 R3).
 *
 * Returns the request ids it served -- the `brokerServed` list on `SweepReport`, empty on every
 * tick of a project that has never used the broker, which is nearly all of them. A `void` return
 * would leave the sweep having to read the directory back to learn what its own pass had done.
 *
 * `execute` defaults to {@link realBrokerExecutor}; every test in this repository passes its own,
 * because `packages/control` hands out an argv and takes an outcome and nothing here needs a real
 * deploy script to prove the channel.
 */
export async function serveBrokerRequests(deps: {
  readonly workspaceId: WorkspaceId
  readonly execute?: BrokerExecutor
}): Promise<readonly string[]> {
  const execute = deps.execute ?? realBrokerExecutor
  const served: string[] = []
  const visited = new Set<string>()

  let runs: readonly { readonly id: string; readonly checkpoint: { readonly pauseFlagPath: string } | null }[]
  let repoPath: string
  try {
    // Every NON-TERMINAL status, not `sweep`'s narrower `SWEEPABLE`: a `paused` worker waiting on a
    // reply it asked for before its pause is not a forgery, and `stopping` is a run that has not
    // stopped yet. The broker's own question 3 (`run_not_live`) is the authority on which of these
    // may actually have an operation run for it -- this query only decides whose channel is read.
    runs = await prisma.slaveRun.findMany({
      where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] }, slave: { team: { workspaceId: deps.workspaceId } } },
      select: { id: true, checkpoint: { select: { pauseFlagPath: true } } },
    })
    if (runs.length === 0) return served
    repoPath = (
      await prisma.workspace.findUniqueOrThrow({ where: { id: deps.workspaceId }, select: { repoPath: true } })
    ).repoPath
  } catch (error) {
    console.error('[broker] could not load this workspace’s live runs:', error)
    return served
  }

  for (const run of runs) {
    const runDir = runDirFor(run, repoPath)
    if (runDir === null) continue
    const channelPath = brokerChannelPathFor(runDir)
    visited.add(channelPath)
    // A run that has never asked for anything has no channel at all, which is nearly every run:
    // one `stat` and the pass is done with it.
    if (!existsSync(channelPath)) continue
    for (const line of readNewLines(channelPath)) {
      const requestId = await serveOneLine(run.id, runDir, line, execute)
      if (requestId !== null) served.push(requestId)
    }
  }

  // Channels this pass did not visit belong to runs that have ended (or to another workspace, if a
  // process ever sweeps two). Dropping their offsets is safe for exactly the reason a restart is:
  // the offset is an optimisation and the reply file is the key.
  for (const key of [...cursors.keys()]) if (!visited.has(key)) cursors.delete(key)

  return served
}

/**
 * Where this run's files are, or `null` when this process cannot say.
 *
 * WHAT WAS RECORDED BEATS WHAT THIS PROCESS WOULD DERIVE -- the ruling `requestPause`
 * (`packages/control/src/pause.ts`) already implements for the pause flag, and for the same reason:
 * `runFilePaths` reads `SLAVEOFAI_STATE_DIR`/`XDG_STATE_HOME`/`homedir()`, so a daemon under
 * systemd and a shell that exports one of them compute different answers, and the adapter told the
 * child ONE of them. The checkpoint's `pauseFlagPath` is the path the child was actually spawned
 * with, so it wins; the derivation is only for a run that has never paused.
 *
 * `null` rather than a throw: `runFilePaths` stats the repository and refuses a path that is gone,
 * and a workspace whose repository has been moved is broken in ways the broker's pass is not the
 * place to announce -- once per second, per run, forever. Such a run has no scratch directory this
 * process can compute and therefore no channel to read, which is the whole of what this pass needs
 * to know.
 */
function runDirFor(
  run: { readonly id: string; readonly checkpoint: { readonly pauseFlagPath: string } | null },
  repoPath: string,
): string | null {
  const recorded = run.checkpoint?.pauseFlagPath
  if (recorded !== undefined && recorded !== '') return dirname(recorded)
  try {
    return runFilePaths(repoPath, brandRunId(run.id)).runDir
  } catch {
    return null
  }
}

/**
 * Everything appended to this channel since the last pass, as complete lines.
 *
 * The tail after the final newline is deliberately NOT consumed: a worker's `O_APPEND` write is
 * atomic below `PIPE_BUF`, but nothing promises that for a longer one, and half a request is not a
 * request. It is left in the file for the next pass to find complete -- unless it is already longer
 * than a request may be, in which case it is skipped over, because waiting for a newline that is
 * never coming would wedge this channel forever.
 */
function readNewLines(channelPath: string): readonly string[] {
  let fd: number | null = null
  try {
    fd = openSync(channelPath, 'r')
    const size = fstatSync(fd).size
    let start = cursors.get(channelPath) ?? 0
    // A channel that SHRANK was truncated or replaced under us; the only honest answer is to read
    // it from the beginning again, and the reply files keep that from re-running anything.
    if (size < start) start = 0
    const want = Math.min(size - start, CHANNEL_READ_MAX_BYTES)
    if (want <= 0) {
      cursors.set(channelPath, start)
      return []
    }
    const buffer = Buffer.alloc(want)
    const read = readSync(fd, buffer, 0, want, start)
    const text = buffer.subarray(0, read).toString('utf8')
    const lastNewline = text.lastIndexOf('\n')
    if (lastNewline === -1) {
      if (read >= REQUEST_LINE_MAX_BYTES) cursors.set(channelPath, start + read)
      else cursors.set(channelPath, start)
      return []
    }
    // Byte length of the CONSUMED prefix, not its character count: the read may have ended
    // mid-character, and those bytes stay unconsumed with the rest of the partial line.
    cursors.set(channelPath, start + Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8'))
    return text.slice(0, lastNewline).split('\n')
  } catch (error) {
    console.error(`[broker] could not read the channel ${channelPath}:`, error)
    return []
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * One line: parse it, decide whether it may be answered at all, and answer it exactly once.
 *
 * Returns the request id if a reply was written, `null` otherwise. A line this function cannot read
 * is skipped in silence -- there is no `requestId` to name a reply file with, so there is nowhere
 * to put an answer even if one were owed.
 */
async function serveOneLine(
  runId: string,
  runDir: string,
  line: string,
  execute: BrokerExecutor,
): Promise<string | null> {
  if (line === '' || Buffer.byteLength(line, 'utf8') > REQUEST_LINE_MAX_BYTES) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  const request = requestSchema.safeParse(parsed)
  if (!request.success) return null

  let replyPath: string
  try {
    replyPath = brokerReplyPathFor(runDir, request.data.requestId)
  } catch {
    return null
  }
  // THE IDEMPOTENCY KEY. Checked before anything is executed, so a channel re-read from byte zero
  // -- a restart, a truncation, a pass that ran twice -- costs one `stat` and nothing else.
  if (existsSync(replyPath)) return null

  // Plan erratum E15, and the half the token cannot supply: the line claims a run, and the claim is
  // only believed when it names the run whose directory this line was found in. Refused BEFORE
  // `runBrokeredOperation`, which would otherwise resolve the stolen token's own run quite happily
  // and deliver its output here.
  if (request.data.runId !== runId) {
    writeReply(replyPath, refusal(request.data.requestId, 'identity_mismatch'))
    return request.data.requestId
  }

  let reply: BrokerReply
  try {
    const result = await runBrokeredOperation(
      { runToken: request.data.runToken, op: request.data.op, params: request.data.params },
      { execute },
    )
    reply = result.ok
      ? {
          requestId: request.data.requestId,
          ok: true,
          exitCode: result.value.exitCode,
          output: result.value.output,
          reason: null,
        }
      : refusal(
          request.data.requestId,
          result.error.kind === 'broker_refused' ? result.error.reason : BROKER_INTERNAL_ERROR_REASON,
        )
  } catch (error) {
    // The executor threw, or the database did. The worker gets an answer either way: a request that
    // is never replied to costs it the full `BROKER_CLIENT_TIMEOUT_MS` to learn nothing.
    console.error(`[broker] serving ${request.data.op} for run ${runId} failed:`, error)
    reply = refusal(request.data.requestId, BROKER_INTERNAL_ERROR_REASON)
  }
  writeReply(replyPath, reply)
  return request.data.requestId
}

function refusal(
  requestId: string,
  reason: BrokerRefusalReason | typeof BROKER_INTERNAL_ERROR_REASON,
): BrokerReply {
  return { requestId, ok: false, exitCode: null, output: '', reason }
}

/** Whether a word off a reply file is one of the seven. The CLI reads replies it did not write, so
 *  the check belongs beside the type rather than in the reader. */
export function isBrokerRefusalReason(reason: unknown): reason is BrokerRefusalReason {
  return typeof reason === 'string' && (BROKER_REFUSAL_REASONS as readonly string[]).includes(reason)
}

/**
 * The reply, appearing at its final name ALL AT ONCE.
 *
 * Written beside itself and renamed: `rename` within a directory is atomic, so the client polling
 * for `broker-<id>.json` never opens a half-written one. Mode 0600 inside an already-0700
 * directory, for that directory's own reason.
 */
function writeReply(replyPath: string, reply: BrokerReply): void {
  const partial = `${replyPath}.partial`
  try {
    writeFileSync(partial, `${JSON.stringify(reply)}\n`, { mode: 0o600 })
    renameSync(partial, replyPath)
  } catch (error) {
    console.error(`[broker] could not write the reply ${replyPath}:`, error)
    try {
      unlinkSync(partial)
    } catch {
      // Nothing to clean up, or nothing that can be. The next pass re-serves this request.
    }
  }
}

/**
 * The one place a brokered operation actually runs.
 *
 * Through `runShellCommand` (`./shell.ts`) rather than a second spawn implementation: it already
 * has the process-GROUP kill (a `setsid`'d child of a deploy script outliving its parent is exactly
 * the leak it was written for), the 16 KiB output cap bounded from the FRONT, the drain grace and
 * the stdin EOF. A second implementation would meet all four again, one review at a time.
 *
 * `command` is ARGV and is quoted into a single shell word list here -- the PARAMETERS never enter
 * the string at all. They ride in the environment as `SLAVEOFAI_BROKER_PARAM_<NAME>`, which is what
 * makes "a parameter cannot become a token in a command line" a property of the shape rather than of
 * a regex. (The registry's regexes are still there, and are the second lock: the measured failure
 * this avoids is a parent that re-serialised its selection into a flat unquoted flag string and gave
 * its child a different capability set than it intended.)
 *
 * THE CHILD'S WHOLE ENVIRONMENT IS BUILT HERE, and `credentialEnvVar` is a NAME (Task 3's R1, spec
 * R3). Not `{...process.env, ...}`: the daemon's environment is the one place every operator secret
 * on this host lives, and a deploy script does not need any of it except the one credential it was
 * bound to. The value is read out of `process.env` one line before the spawn and is not returned,
 * logged, evented or written to the reply -- `runBrokeredOperation` has already refused
 * `credential_unset` if it is absent or empty, so this read cannot be blank. `PATH` is the single
 * exception and is taken from `CHILD_ENV_ALLOW`'s own reasoning -- argv[0] is absolute, but the
 * script it names will want to find `sh`.
 *
 * `cwd` is `/`, deliberately: not the daemon's own working directory (which is wherever an operator
 * happened to start it) and above all not a worktree, which is the one directory on this machine
 * the WORKER can write. A relative path inside an operator's deploy script must not resolve through
 * something the worker planted; a script that needs scratch space makes its own.
 */
export const realBrokerExecutor: BrokerExecutor = async (input) => {
  const credential =
    input.credentialEnvVar === null ? {} : { [input.credentialEnvVar]: process.env[input.credentialEnvVar] ?? '' }
  const startedAt = Date.now()
  const outcome = await runShellCommand({
    command: input.command.map(shellQuote).join(' '),
    cwd: '/',
    timeoutMs: input.timeoutMs,
    env: { PATH: process.env['PATH'] ?? '', ...credential, ...input.params },
  })
  return {
    exitCode: outcome.code,
    durationMs: Date.now() - startedAt,
    // A timeout kills the group and leaves an exit code of `null`, which on its own reads to a
    // worker as "nothing happened". It is told what happened -- and told it without the command,
    // which is the operator's configuration and not the worker's business (`describeOutcome` names
    // it, which is why that helper is not used here).
    output: outcome.timedOut
      ? `the operation timed out after ${String(input.timeoutMs)}ms and its process group was killed\n${outcome.output}`.trim()
      : outcome.output,
  }
}

/** Single-quote one argv element for `/bin/sh -c`. Three lines, its own test, and it exists because
 *  the alternative -- trusting that no bound command ever contains a space -- is the kind of
 *  assumption that holds until an operator's path has one in it. */
function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}
