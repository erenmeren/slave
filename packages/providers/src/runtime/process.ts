import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/**
 * How long a signalled process gets to exit on its own before it is killed outright.
 *
 * ONE value, as of M13 Series B. There were three escalations in this repo -- `packages/control`'s
 * `killWithEscalation`, `pause-signal.ts`'s `terminatePid`, and each adapter's `terminateChild` --
 * and `pause-signal.ts`'s own comment explained why it was written a third time: `packages/control`
 * DEPENDS on this package, so importing it back would be a cycle. The fix is the direction, not the
 * duplication: the primitive lives below `control`, and `control/src/kill.ts` re-exports it
 * (M13 Decision 6).
 */
export const KILL_GRACE_MS = 2_000

/** How often the grace window is re-checked, so a process that dies at once is not waited out. */
const DEATH_POLL_MS = 25

export function isAlive(pid: number | null): boolean {
  if (pid === null || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists and belongs to someone else -- alive, just not ours to
    // inspect. Only ESRCH means gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function signalRun(pid: number | null, signal: NodeJS.Signals): boolean {
  if (pid === null || pid <= 0) return false
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, DEATH_POLL_MS))
  }
  return !isAlive(pid)
}

/**
 * SIGTERM, a polled grace window, then SIGKILL. Returns whether anything was signalled.
 *
 * Polled rather than sleeping the whole grace period, so the common case -- a process that exits
 * promptly on SIGTERM -- costs milliseconds instead of seconds inside an emergency stop's per-run
 * loop. A process that IGNORES SIGTERM still costs the whole window, which is what makes the
 * orchestrator's `pause_requested` interval observable (M13 Task 1).
 */
export async function killWithEscalation(pid: number | null, graceMs: number = KILL_GRACE_MS): Promise<boolean> {
  const signalled = signalRun(pid, 'SIGTERM')
  // `false` means the process is already gone (ESRCH) or there was never a pid. Nothing to
  // escalate against.
  if (!signalled || pid === null) return signalled
  if (await waitForExit(pid, graceMs)) return true
  signalRun(pid, 'SIGKILL')
  await waitForExit(pid, graceMs)
  return true
}

/**
 * The same escalation against a live `ChildProcess` this process spawned.
 *
 * A separate entry point rather than `killWithEscalation(child.pid)` because a spawner has
 * something a pid-holder does not: the `exit` event, which resolves the moment the child is reaped
 * rather than at the next poll, and `exitCode`/`signalCode`, which say the child is already gone
 * without signalling anything at all.
 */
export function terminateChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()

  return new Promise<void>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      child.kill('SIGKILL')
    }, graceMs)

    child.once('exit', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    })

    child.kill('SIGTERM')
  })
}

/**
 * Where a run's resolved permission matrix snapshot lives, inside its own scratch directory (M18
 * Task 5, fix round 1 -- Important 1). The ONE definition of the `'permissions.json'` filename
 * convention: before this existed, `packages/control`'s `writePermissionsFile` and both adapters'
 * `resume()` derivations each joined the literal independently, and a one-character drift between
 * them fails OPEN, not closed -- `read_permission_verdict` (`scripts/lib/permissions.sh`) treats a
 * missing/wrong-path file exactly like "no matrix in play" and allows. Lives here, below
 * `packages/control`, for the same reason `KILL_GRACE_MS` above does (M13 Decision 6):
 * `packages/control` already depends on `@slave-of-ai/providers` (it imports `PROVIDER_KINDS` and
 * `signalPause` from it), never the reverse, so the shared primitive belongs on this side of that
 * edge and `writePermissionsFile` imports it rather than re-deriving it.
 */
export function permissionsFilePathFor(runDir: string): string {
  return join(runDir, 'permissions.json')
}

/**
 * The ONLY environment variables a worker's child inherits from this process (M52 R3).
 *
 * An explicit NAME list -- never a prefix rule, never a denylist. The denylist was tried in the
 * harness this finding comes from and leaked three times before it was replaced by a four-entry
 * allow list; a hardcoded five-name strip list there was measured SEVEN names short of a live
 * session's dump. Denylists close instances; allow lists close the class.
 *
 * What each name is here FOR, because a list with no reasons grows by accretion:
 *   - PATH, HOME, SHELL, USER      the child spawns `git` and its own subprocesses.
 *   - LANG, LC_ALL, TERM           output encoding; a missing LANG mangles non-ASCII diffs.
 *   - TMPDIR                       the CLI writes scratch files.
 *   - XDG_CONFIG_HOME, XDG_CACHE_HOME  where the vendor CLI keeps its own auth and cache. This is
 *                                  the pair that makes "the vendor CLI reads its own auth" work,
 *                                  and it is why this is an allow list rather than an empty
 *                                  environment: the credential the CLI uses is the OPERATOR's, held
 *                                  by the vendor, and this system never sees it.
 *   - NODE_EXTRA_CA_CERTS, SSL_CERT_FILE  corporate TLS. A child that cannot verify a certificate
 *                                  fails in a way nobody can read.
 *
 * MEASURED, not guessed (M52 Task 2 Step 8): `claude 2.1.269` and `cursor-agent 2026.08.25-3e8eec8`
 * were both run under exactly this list and nothing else, and both answered `--version` at exit 0;
 * so did `packages/providers/test/fake-claude.mjs` playing a whole fixture and both gate fakes. No
 * name had to be added to make any of them work.
 *
 * What is deliberately NOT here, and asserted so by `runtime-process.test.ts` and by the gate:
 * `DATABASE_URL`, `SLAVEOFAI_SESSION_SECRET`, `SLAVEOFAI_PASSWORD`, and every API key an operator's
 * shell happens to hold. The WORKER'S OWN PROCESS therefore cannot reach the database to rewrite
 * its own permissions, and holds no key it could spend -- which is the whole point of asking the
 * broker for an operation by name instead (R3).
 *
 * SAID EXACTLY, because a stronger sentence stood here and was false (M52 final review, Important
 * 3): this list governs the worker's own child and nothing else. The verify and setup commands a
 * project defines still run through `runShellCommand`'s default environment, which is the daemon's
 * whole `process.env` (`apps/orchestrator/src/verify.ts`, `worktree.ts`'s `setupEnv`) -- and they
 * execute scripts inside the worktree the worker just wrote, so `npm test` on a repository whose
 * `package.json` the worker edited is repo-controlled code running with `DATABASE_URL` and every
 * operator key. That is the next boundary to close, and it is not closed by reusing this list:
 * this repository's own verify commands need `DATABASE_URL` to run at all. Backlogged as an
 * allow-listed verify/setup environment.
 */
export const CHILD_ENV_ALLOW = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
] as const

/**
 * The environment every runtime's child is spawned with (ADR 0001, "Concurrency and the git common
 * directory").
 *
 * Identity is supplied per-process rather than by writing `git config`: two concurrent M0 slaves
 * both hit the same missing-identity failure, and the one that recovered with an unscoped
 * `git config user.name/user.email` wrote into the repo-wide `.git/config`, which every worktree
 * shares. Environment variables are per-process, write no file, and cannot leak to a sibling
 * worktree's run.
 *
 * AN ALLOW LIST UNDERNEATH, NOT AN INHERITANCE (M52 R3). Until this milestone the base was
 * `...process.env` -- the daemon's whole environment, `DATABASE_URL` included, handed to a process
 * that is not trusted with it. It is `CHILD_ENV_ALLOW` now, and a name the parent does not hold is
 * ABSENT from the child rather than present and empty: an empty `PATH` is a child that cannot find
 * `git`, and it would read as a configuration rather than as a gap.
 *
 * `SLAVEOFAI_PAUSE_FLAG` is the ONE channel either gate reads the flag path on -- the same variable
 * `scripts/pause-gate.sh` and `scripts/cursor-shell-gate.sh` read. It was measured arriving intact
 * on the Cursor side: Cursor evaluates a hook's command in a shell whose environment is its own
 * `process.env` plus Cursor's additions, so setting it on the child is sufficient and no second
 * channel is needed (M12 Task 11 §3 Q3, §8(e)). One concept, one name, whichever runtime the run
 * is on.
 *
 * `SLAVEOFAI_PERMISSIONS_FILE` (M18 Task 5) is the same shape of channel, for the same reason:
 * `scripts/lib/permissions.sh`'s `read_permission_verdict` is the ONE place either gate reads the
 * verdict's path from. `permissionsFilePath` is required, not optional -- every start and every
 * resume writes `permissions.json` (`packages/control`'s `writePermissionsFile`) before spawning,
 * so there is no real call site that has a pause flag but no verdict to point at.
 */
export function buildChildEnv(input: {
  readonly gitIdentity: { readonly name: string; readonly email: string }
  readonly pauseFlagPath: string
  readonly permissionsFilePath: string
  /**
   * `SLAVEOFAI_TOOL_RESULTS` (M51 R6), the third channel of this exact shape: the absolute path of
   * the run's `tool-results.ndjson`, which `scripts/tool-result-tap.sh` appends one bounded line to
   * per completed tool call.
   *
   * OPTIONAL where the two above are required, and the key is left ABSENT rather than set empty
   * when it is missing. The tap reads "unset or empty" as "this run is not tapped" either way, but
   * a variable that is there with nothing in it is a channel announced and not opened -- and the
   * absence is what makes Cursor's spawn (which passes nothing) visibly untapped rather than
   * accidentally so. Cursor's results come from its own stream (`reportsToolResults`), not from a
   * hook.
   */
  readonly toolResultsPath?: string
  /**
   * M52 R4: the run this child IS, and the proof of it. The id is for the broker's request lines;
   * the token is what the hook hashes against `permissions.json`'s `tokenHash` and what the broker
   * compares before it resolves a grant. Optional for `toolResultsPath`'s reason -- and an absent
   * token is FAIL-CLOSED rather than permissive: the child then meets a hash it cannot match.
   */
  readonly runId?: string
  readonly runToken?: string
  /** M52 R3: the request/reply channel, the FOURTH file channel of this exact shape. */
  readonly brokerChannelPath?: string
  /**
   * M52 erratum E6: the absolute path of the orchestrator CLI the thin client runs. There is no
   * `orchestrator` binary on anybody's PATH -- `package.json`'s script is an npm script -- so this
   * is how the worker finds one.
   */
  readonly brokerCliPath?: string
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of CHILD_ENV_ALLOW) {
    const value = process.env[name]
    // Absent, never empty: a name the parent does not hold must not arrive as a configured blank.
    if (value !== undefined) env[name] = value
  }
  return {
    ...env,
    GIT_AUTHOR_NAME: input.gitIdentity.name,
    GIT_AUTHOR_EMAIL: input.gitIdentity.email,
    GIT_COMMITTER_NAME: input.gitIdentity.name,
    GIT_COMMITTER_EMAIL: input.gitIdentity.email,
    SLAVEOFAI_PAUSE_FLAG: input.pauseFlagPath,
    SLAVEOFAI_PERMISSIONS_FILE: input.permissionsFilePath,
    ...(input.toolResultsPath === undefined ? {} : { SLAVEOFAI_TOOL_RESULTS: input.toolResultsPath }),
    ...(input.runId === undefined ? {} : { SLAVEOFAI_RUN_ID: input.runId }),
    ...(input.runToken === undefined ? {} : { SLAVEOFAI_RUN_TOKEN: input.runToken }),
    ...(input.brokerChannelPath === undefined ? {} : { SLAVEOFAI_BROKER_CHANNEL: input.brokerChannelPath }),
    ...(input.brokerCliPath === undefined ? {} : { SLAVEOFAI_BROKER_CLI: input.brokerCliPath }),
  }
}

/**
 * Where a run's broker request channel lives (M52 R3) -- the ONE definition of the
 * `'broker.ndjson'` filename, for `permissionsFilePathFor`'s reason: the adapter sets the child's
 * `SLAVEOFAI_BROKER_CHANNEL` from it and the daemon tails the same file back, and a one-character
 * drift would leave the daemon watching a file nothing writes -- which looks exactly like a worker
 * that never asked for anything.
 */
export function brokerChannelPathFor(runDir: string): string {
  return join(runDir, 'broker.ndjson')
}

/**
 * Where the daemon writes ONE request's reply. The request id is the filename, which is also the
 * idempotency key: the server serves a request only if this file does not already exist, so a
 * daemon restart that re-reads the channel from byte 0 cannot execute anything twice.
 */
export function brokerReplyPathFor(runDir: string, requestId: string): string {
  // `requestId` is checked by the caller against /^[a-f0-9]{32}$/ before it reaches here; this is
  // the second lock, and it is the one that runs in the process that opens the file.
  if (!/^[a-f0-9]{32}$/u.test(requestId)) {
    throw new Error(`brokerReplyPathFor: bad request id ${JSON.stringify(requestId)}`)
  }
  return join(runDir, `broker-${requestId}.json`)
}

/**
 * Where the daemon records that it is ABOUT TO run one request (M52 R3, fix round 1).
 *
 * The reply file is the idempotency key, but it can only be written once the operation has
 * returned -- so between the child exiting and the reply landing there is a window in which a dead
 * daemon, or a reply that could not be written, leaves no evidence that anything ran. This file is
 * created with `wx` BEFORE the operation starts, which closes it: a claim with no reply beside it
 * is an operation whose OUTCOME IS UNKNOWN, and the one thing that must never happen to it is a
 * second execution.
 *
 * Beside the reply and named from the same request id, in this one place, for
 * {@link brokerReplyPathFor}'s reason: two spellings of one filename is a daemon that cannot find
 * its own evidence.
 */
export function brokerClaimPathFor(runDir: string, requestId: string): string {
  if (!/^[a-f0-9]{32}$/u.test(requestId)) {
    throw new Error(`brokerClaimPathFor: bad request id ${JSON.stringify(requestId)}`)
  }
  return join(runDir, `broker-${requestId}.claim`)
}

/**
 * `sha256` hex of a run token (M52 R4). One definition, used by the writer (`writePermissionsFile`
 * and the four dispatch sites) and by the broker's authoriser -- the hook computes the same thing
 * in its own `node -e`, in six characters of JavaScript, because it may not import anything.
 */
export function runTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Where a run's tool-result tap writes, inside its own scratch directory (M51 R6). The ONE
 * definition of the `'tool-results.ndjson'` filename, for `permissionsFilePathFor`'s reason above:
 * the adapter sets the child's `SLAVEOFAI_TOOL_RESULTS` from it and its own tailer reads the same
 * file back, and a one-character drift between those two would leave the tailer watching a file
 * nothing ever writes -- which looks exactly like "the tap filled no gap".
 */
export function toolResultsPathFor(runDir: string): string {
  return join(runDir, 'tool-results.ndjson')
}
