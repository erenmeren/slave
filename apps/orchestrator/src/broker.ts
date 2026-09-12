import { closeSync, existsSync, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { runBrokeredOperation, runDirPathFor, type BrokerExecutor } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import {
  BROKER_REFUSAL_REASONS,
  runId as brandRunId,
  type BrokerRefusalReason,
  type WorkspaceId,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { brokerChannelPathFor, brokerClaimPathFor, brokerReplyPathFor } from '@slave-of-ai/providers'
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
 * AT MOST ONCE, AND WHAT THAT COSTS. Two files per request, and the order is the whole mechanism
 * (fix round 1, review Important 1). `broker-<requestId>.claim` is created with `wx` BEFORE the
 * operation starts; `broker-<requestId>.json` is written after it returns. So:
 *
 *   - no claim, no reply  -> never served; serve it.
 *   - claim, no reply, in flight HERE -> being served right this moment; leave it alone.
 *   - claim, no reply, nothing in flight -> a process died between the child exiting and the reply
 *     landing, or the reply could not be written. THE OUTCOME IS UNKNOWN. The worker is told so
 *     (`internal_error`) and the operation is NEVER run again. An operator checks the target.
 *   - reply -> answered; nothing more to do, whatever the channel says.
 *
 * The in-memory byte offset per channel is an optimisation on top of that and never the
 * correctness: a daemon restart re-reads every channel from byte zero, and so does a worker
 * TRUNCATING its own channel, which it can do at will -- the two files are what stop a second
 * execution in both cases. What is NOT guaranteed: exactly-once. A claim that outlives its process
 * costs the worker its answer, which is the direction an irreversible operation has to fail in.
 * Two daemons serving one channel would race on the `wx`; the design's answer is the one this
 * repository already relies on for every run -- one daemon per workspace.
 *
 * A LATE FAILURE STILL READS AS "NOTHING HAPPENED", and that is the residual under the claim:
 * `broker.executed`'s append happens after the child ran, so a database failure there becomes an
 * `internal_error` reply for an operation that really did deploy. The claim file is the evidence
 * that it might have; the reply's own sentence is what stops a worker being told it may retry.
 *
 * NOTHING HERE THROWS OUT OF A PASS. Every read is `try`/`catch`, an unparseable line is skipped
 * (never a reply -- a line that is not a request has no `requestId` to answer), and an executor
 * that throws becomes a refused reply rather than a dead daemon.
 *
 * IT IS NOT PART OF THE TICK (fix round 1, review Important 3). This pass used to run inside
 * `sweep()`, which runs inside the daemon's coalesced tick -- so one brokered operation froze the
 * budget guardrail, dispatch, the merge pass, the breaker beat, orphan reconciliation AND the
 * global simulation pass for as long as it ran, which is `BROKER_TIMEOUT_MS` times the number of
 * pending requests and not the flat two minutes the first version of this header claimed. It is the
 * daemon's OWN pass now (`daemon.ts`'s `brokerPass`), on its own coalescer and its own interval,
 * running beside the tick rather than inside it, and drained on shutdown so an operation in flight
 * still gets its reply written. Awaiting the execution is safe there, and it is the claim file
 * above -- not the await -- that makes a second execution impossible.
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
 * The requests THIS process is executing right now (fix round 1, review Important 3).
 *
 * The claim file cannot tell "a dead process left this" from "a live pass is in the middle of it",
 * and those two demand opposite answers: recover the first, leave the second alone. This set is the
 * difference. The daemon's broker pass is coalesced, so two passes do not overlap there -- but the
 * recovery arm must not be one `setInterval` away from answering `internal_error` for an operation
 * that is still running, and a guard that depends on a caller's scheduling is not a guard.
 */
const inFlight = new Set<string>()

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

  let runs: readonly {
    readonly id: string
    readonly slaveId: string
    readonly checkpoint: { readonly pauseFlagPath: string } | null
  }[]
  try {
    // Every NON-TERMINAL status, not `sweep`'s narrower `SWEEPABLE`: a `paused` worker waiting on a
    // reply it asked for before its pause is not a forgery, and `stopping` is a run that has not
    // stopped yet. The broker's own question 3 (`run_not_live`) is the authority on which of these
    // may actually have an operation run for it -- this query only decides whose channel is read.
    runs = await prisma.slaveRun.findMany({
      where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] }, slave: { team: { workspaceId: deps.workspaceId } } },
      // `slaveId` rides along for the E15 event (fix round 1, review Important 2): the refusal is
      // filed against the run whose DIRECTORY the line was found in, and an `ExecutionEvent` needs
      // a slave to name.
      select: { id: true, slaveId: true, checkpoint: { select: { pauseFlagPath: true } } },
    })
  } catch (error) {
    console.error('[broker] could not load this workspace’s live runs:', error)
    return served
  }

  for (const run of runs) {
    const runDir = runDirFor(run)
    const channelPath = brokerChannelPathFor(runDir)
    visited.add(channelPath)
    // A run that has never asked for anything has no channel at all, which is nearly every run:
    // one `stat` and the pass is done with it.
    if (!existsSync(channelPath)) continue
    for (const line of readNewLines(channelPath)) {
      const requestId = await serveOneLine(deps.workspaceId, run, runDir, line, execute)
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
 * Where this run's files are.
 *
 * WHAT WAS RECORDED BEATS WHAT THIS PROCESS WOULD DERIVE -- the ruling `requestPause`
 * (`packages/control/src/pause.ts`) already implements for the pause flag, and for the same reason:
 * the derivation reads `SLAVEOFAI_STATE_DIR`/`XDG_STATE_HOME`/`homedir()`, so a daemon under systemd
 * and a shell that exports one of them compute different answers, and the adapter told the child ONE
 * of them. The checkpoint's `pauseFlagPath` is the path the child was actually spawned with, so it
 * wins; the derivation is only for a run that has never paused.
 *
 * `runDirPathFor` and NOT `runFilePaths` (fix round 1): this pass is a READER and asks this question
 * of every live run every half second. `runFilePaths` stats the repository and `mkdirSync`s the
 * directory -- synchronous work, on the event loop, creating directories for runs that have never
 * asked for anything. It also meant a run whose repository had moved had no derivable channel at
 * all, which is a fact about the repository and not about the channel.
 */
function runDirFor(run: { readonly id: string; readonly checkpoint: { readonly pauseFlagPath: string } | null }): string {
  const recorded = run.checkpoint?.pauseFlagPath
  return recorded !== undefined && recorded !== '' ? dirname(recorded) : runDirPathFor(brandRunId(run.id))
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
 * One line: parse it, decide whether it may be answered at all, and answer it AT MOST once.
 *
 * Returns the request id if a reply was written, `null` otherwise. A line this function cannot read
 * is skipped in silence -- there is no `requestId` to name a reply file with, so there is nowhere
 * to put an answer even if one were owed.
 *
 * The order of the four gates is the module header's table, and it is load-bearing: in flight here,
 * then answered already, then CLAIMED but unanswered (the outcome is unknown and must not be
 * re-run), and only then a claim of our own -- taken with `wx`, which is one atomic syscall and not
 * a check followed by a write.
 */
async function serveOneLine(
  workspaceId: WorkspaceId,
  run: { readonly id: string; readonly slaveId: string },
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
  const { requestId, op } = request.data

  let replyPath: string
  let claimPath: string
  try {
    replyPath = brokerReplyPathFor(runDir, requestId)
    claimPath = brokerClaimPathFor(runDir, requestId)
  } catch {
    return null
  }

  // 1. A pass that is still running this one. Never two answers, and never a recovery that
  //    overtakes a live operation.
  if (inFlight.has(requestId)) return null
  // 2. THE IDEMPOTENCY KEY. One `stat`, and a channel re-read from byte zero -- a restart, a
  //    truncation, a pass that ran twice -- costs nothing else.
  if (existsSync(replyPath)) return null

  // 3./4. Claim it, or discover that somebody already did. `wx` answers both questions in one
  //       syscall: a claim we could not create because it exists is a claim a process that is no
  //       longer running left behind, and what it marks is an operation whose OUTCOME IS UNKNOWN.
  try {
    writeFileSync(claimPath, `${JSON.stringify({ requestId, op, claimedAt: new Date().toISOString() })}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      // A claim that cannot be written is an operation that must not run: without the claim there
      // is nothing to stop the next pass running it again. The worker waits out its own deadline,
      // which is the direction an irreversible operation has to fail in.
      console.error(`[broker] could not claim ${requestId} for run ${run.id}:`, error)
      return null
    }
    writeReply(replyPath, {
      requestId,
      ok: false,
      exitCode: null,
      output:
        'the orchestrator started this operation and did not finish recording it: its outcome is ' +
        'UNKNOWN and it will not be run again. Check the target before asking for it a second time.',
      reason: BROKER_INTERNAL_ERROR_REASON,
    })
    return requestId
  }

  inFlight.add(requestId)
  try {
    // Plan erratum E15, and the half the token cannot supply: the line claims a run, and the claim
    // is only believed when it names the run whose directory this line was found in. Refused BEFORE
    // `runBrokeredOperation`, which would otherwise resolve the stolen token's own run quite
    // happily and deliver its output here.
    if (request.data.runId !== run.id) {
      // AND THE TIMELINE HEARS ABOUT IT (fix round 1, review Important 2). This is the single
      // highest-signal security event the design can produce, and until this round its only record
      // was a file in the attacker's own directory that the attacker could delete. Questions 1 and 2
      // in `packages/control` refuse silently because they have no run to file against; this one
      // does -- the run whose directory the line sits in is known, live, in this workspace, and is
      // exactly the worker that wrote the line. Same payload shape control uses.
      await appendEvent({
        type: 'broker.refused',
        workspaceId,
        slaveId: run.slaveId,
        runId: run.id,
        actor: 'slave',
        payload: { op, reason: 'identity_mismatch' },
      })
      writeReply(replyPath, refusal(requestId, 'identity_mismatch'))
      return requestId
    }

    const result = await runBrokeredOperation(
      { runToken: request.data.runToken, op, params: request.data.params },
      { execute },
    )
    writeReply(
      replyPath,
      result.ok
        ? { requestId, ok: true, exitCode: result.value.exitCode, output: result.value.output, reason: null }
        : refusal(
            requestId,
            result.error.kind === 'broker_refused' ? result.error.reason : BROKER_INTERNAL_ERROR_REASON,
          ),
    )
    return requestId
  } catch (error) {
    // The executor threw, or the database did. The worker gets an answer either way: a request that
    // is never replied to costs it the full `BROKER_CLIENT_TIMEOUT_MS` to learn nothing. The claim
    // stays where it is, so this is the LAST word on this request whatever happens next.
    console.error(`[broker] serving ${op} for run ${run.id} failed:`, error)
    writeReply(replyPath, refusal(requestId, BROKER_INTERNAL_ERROR_REASON))
    return requestId
  } finally {
    inFlight.delete(requestId)
  }
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
 *
 * A FAILURE HERE DOES NOT RE-SERVE THE REQUEST (fix round 1, review Important 1). It used to: the
 * claim file did not exist, so a reply that could not be written left the request looking untouched
 * and the next pass deployed again. Now the claim is already on disk, so the next pass finds
 * "claimed, unanswered" and tells the worker its outcome is unknown -- which is the failure an
 * audit trail can recover from, where a second deploy is not.
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
      // Nothing to clean up, or nothing that can be. The claim stands either way.
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
