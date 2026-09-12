import { timingSafeEqual } from 'node:crypto'
import { prisma } from '@slave-of-ai/db/client'
import {
  BROKERED_OPERATIONS,
  BROKER_TIMEOUT_MS,
  NON_TERMINAL_RUN_STATUSES,
  type BrokerRefusalReason,
  type PermissionRowInput,
  type PermissionRunKind,
  type Result,
  err,
  grantsFor,
  ok,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { hashToolInput, runTokenHash } from '@slave-of-ai/providers'
import type { ControlRefusal } from './refusal.js'

/**
 * The prefix a brokered operation's parameters reach the child under (M52 R3).
 *
 * The parameters ride in the ENVIRONMENT, never in the command line: that is what makes "a parameter
 * cannot become a token in a command line" a property of the shape rather than of a quoting rule
 * somebody has to keep getting right. The registry's own regexes are still there and are the second
 * lock.
 */
export const BROKER_PARAM_ENV_PREFIX = 'SLAVEOFAI_BROKER_PARAM_'

/**
 * How one brokered operation actually runs, injected (M52 R3).
 *
 * `packages/control` does not spawn -- `apps/orchestrator/src/broker.ts` holds the real one, built
 * on `runShellCommand`, which already has the process-GROUP kill, the 16 KiB output cap and the
 * drain grace that a second implementation would meet again one review at a time. The seam is the
 * `ModelDecider` shape (`simulation/llm.ts:25-26`), for its reason: the control layer hands out an
 * argv and a bounded environment and takes an outcome.
 *
 * `credentialEnvVar` is a NAME and never a value. The secret is read by the EXECUTOR, in the
 * daemon's own process, one line before the child is spawned -- spec R3's own sentence: "the
 * orchestrator reads `process.env[envVar]` at execution time and nothing else ever holds it".
 * Nothing in `packages/control` ever binds it to anything: this module asks only whether the
 * variable is set, because a binding whose credential is missing must refuse rather than run the
 * operation with an empty one.
 *
 * `params` is the WHOLE of what the worker asked for, already parsed by the registry's schema and
 * spelled as `SLAVEOFAI_BROKER_PARAM_*`. Together with the credential these are the child's whole
 * environment -- not an addition to the daemon's -- plus the `PATH` the executor adds so the script
 * argv[0] names can find `sh`.
 */
export type BrokerExecutor = (input: {
  readonly command: readonly string[]
  readonly credentialEnvVar: string | null
  readonly params: Readonly<Record<string, string>>
  readonly timeoutMs: number
}) => Promise<{ readonly exitCode: number | null; readonly durationMs: number; readonly output: string }>

/**
 * What a brokered operation did. Never what it was run WITH: no argv, no environment, no credential.
 *
 * `output` is the executor's already-bounded head, and it is returned to the worker's own CLI and
 * nowhere else -- it is not in the event, because a deploy script's chatter is not audit and could
 * carry anything the operator's own tooling printed.
 */
export interface BrokerOutcome {
  readonly op: string
  readonly exitCode: number | null
  readonly durationMs: number
  readonly output: string
}

/** The run a token resolved to, with everything the remaining six questions need -- one read. */
interface BrokerRun {
  readonly id: string
  readonly status: string
  readonly kind: PermissionRunKind
  readonly slaveId: string
  readonly workspaceId: string
  readonly archivedAt: Date | null
  /** The worker's own rows, in `grantsFor`'s input shape -- the Prisma `PermissionKind` enum is
   *  exactly `PERMISSION_KINDS`, so the six are the only values a column can hold. */
  readonly permissions: readonly PermissionRowInput[]
}

/**
 * Run a named operation on a worker's behalf, or refuse (M52 R3).
 *
 * SEVEN questions, in this order, and the order is load-bearing:
 *   1. Is this an op at all?          -- `not_brokered`, before a single row is read. An unknown
 *                                        verb must not become a database query a caller can time.
 *   2. Who is asking?                 -- `identity_mismatch`. The token is hashed and looked up on
 *                                        `SlaveRun.runTokenHash` (`@unique`), compared with
 *                                        `timingSafeEqual` over equal-length digests. Identity comes
 *                                        from the ENVIRONMENT THE PARENT SET, never from a field in
 *                                        the request line: a request that carries a `runId` is
 *                                        making a claim, and the claim is discarded in favour of
 *                                        the token's own answer. (The failure this avoids is a
 *                                        measured one elsewhere: a hook shim that let a
 *                                        payload-supplied worker id win over the trusted env var.)
 *                                        The DATABASE is the authority and the only one (plan
 *                                        erratum E17): `permissions.json` sits in a directory the
 *                                        worker can write, so a file verdict is forgeable by
 *                                        anything holding `run_commands`, and nothing here reads it.
 *   3. Is that run still live?        -- `run_not_live`. A concluded run has no worker to act for,
 *                                        and a token recovered afterwards is exactly what R4's
 *                                        rotation exists to kill.
 *   4. Is this real?                  -- `simulation`. Belt and braces: a simulated role is not a
 *                                        `Slave`, holds no `SlavePermission` and can reach no
 *                                        `SlaveRun`, so this arm should be unreachable -- and an
 *                                        archived workspace answers it too, which is the reachable
 *                                        half.
 *   5. May this worker?               -- `permission_denied`, from `grantsFor` over the SAME rows
 *                                        and the SAME run kind the gate resolved, so the broker and
 *                                        the hook can never disagree about one worker.
 *   6. Is anything bound here?        -- `not_brokered`, scoped to THIS workspace.
 *   7. Do the parameters fit, and is the secret present? -- `invalid_params`, then
 *                                        `credential_unset`. Parameters are parsed by the registry's
 *                                        own zod schema (strict), so a smuggled key is a refusal and
 *                                        not a silent drop.
 *
 * Every refusal is a RETURNED value and every one of them happens before the first write, so none of
 * them is inside a transaction -- a refusal after a write inside `$transaction` commits that write
 * unless it throws, and the way this function avoids that rule is by not needing it. There is
 * exactly one write in the whole function and it is the last statement.
 *
 * `broker.refused` is appended for every refusal that got far enough to NAME a run (questions 3-7).
 * Questions 1 and 2 have no run to file an event against and no workspace to file it in, so they
 * refuse silently -- a forged token that produced a timeline entry would let anyone who can write a
 * line into a channel write into a project's history.
 *
 * The credential's VALUE is never read here at all: this function asks whether the variable is set
 * and hands its NAME to the executor.
 */
export async function runBrokeredOperation(
  input: { readonly runToken: string; readonly op: string; readonly params: unknown },
  deps: { readonly execute: BrokerExecutor },
): Promise<Result<BrokerOutcome, ControlRefusal>> {
  const op = input.op

  // 1. An unknown verb, answered from a static manifest with no row read and no time to measure.
  if (!Object.hasOwn(BROKERED_OPERATIONS, op)) return refused(op, 'not_brokered')
  const operation = BROKERED_OPERATIONS[op as keyof typeof BROKERED_OPERATIONS]

  // 2. Who is asking. The token, never a claim in the request line.
  const run = await loadRunByToken(input.runToken)
  if (run === null) return refused(op, 'identity_mismatch')

  const record = async (reason: BrokerRefusalReason): Promise<Result<BrokerOutcome, ControlRefusal>> => {
    await appendEvent({
      type: 'broker.refused',
      workspaceId: run.workspaceId,
      slaveId: run.slaveId,
      runId: run.id,
      actor: 'slave',
      payload: { op, reason },
    })
    return refused(op, reason)
  }

  // 3. A concluded run has nobody to act for.
  if (!(NON_TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) return record('run_not_live')

  // 4. Nothing crosses the simulation boundary (R6).
  if (run.archivedAt !== null) return record('simulation')

  // 5. The same resolution the gate performed. `grantsFor`, not `resolveGrants`: `deploy_release`
  //    and `read_secret` name no vendor tool however they resolve -- being broker grants is exactly
  //    what makes them expressible here and not as a tool deny -- so the KIND-level answer is the
  //    only one that can speak about them. It is the same answer `permissions.json`'s `grants` array
  //    carries, from the same function.
  const granted = grantsFor(run.permissions, run.kind).find((grant) => grant.kind === operation.grant)
  if (granted === undefined || (granted.source !== 'baseline' && granted.source !== 'granted')) {
    return record('permission_denied')
  }

  // 6. What this project actually runs for that verb.
  const binding = await prisma.brokerBinding.findUnique({
    where: { workspaceId_op: { workspaceId: run.workspaceId, op } },
    select: { command: true, credential: { select: { envVar: true } } },
  })
  if (binding === null || binding.command.length === 0) return record('not_brokered')

  // 7. The parameters the manifest accepts, then the secret this host has.
  const parsed = operation.params.safeParse(input.params)
  if (!parsed.success) return record('invalid_params')
  const params = parsed.data as Record<string, string>

  const credentialEnvVar = binding.credential?.envVar ?? null
  // The ONE line in `packages/control` that touches the daemon's own environment for a credential,
  // and it does not keep what it finds: an unset variable and an empty one are both "not set here",
  // because handing a deploy script an empty token is a failure that looks like a permission error
  // twenty minutes later.
  if (credentialEnvVar !== null && (process.env[credentialEnvVar] ?? '') === '') return record('credential_unset')

  const outcome = await deps.execute({
    command: binding.command,
    credentialEnvVar,
    params: Object.fromEntries(
      Object.entries(params).map(([key, value]) => [`${BROKER_PARAM_ENV_PREFIX}${key.toUpperCase()}`, String(value)]),
    ),
    timeoutMs: BROKER_TIMEOUT_MS,
  })

  await appendEvent({
    type: 'broker.executed',
    workspaceId: run.workspaceId,
    slaveId: run.slaveId,
    runId: run.id,
    actor: 'slave',
    payload: {
      op,
      // Verbatim, because it is the whole audit value: "which environment did this worker deploy
      // to" is the question a person asks first, and the registry's regex already bounds it to a
      // key -- never a URL and never a path.
      //
      // A MANIFEST INVARIANT, not a guess: `broker.executed`'s payload schema requires a non-empty
      // `environment`, so every entry in `BROKERED_OPERATIONS` must carry one. A second op added
      // without it would throw here, AFTER the operation ran -- which is the loudest place for that
      // mistake to land and the reason it is written down rather than defaulted away.
      environment: String(params['environment'] ?? ''),
      // Of the PARSED params, not the raw input: two calls that asked for the same thing in a
      // different key order are the same call, which is what the correlation is for.
      paramsHash: hashToolInput(params),
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
    },
  })

  return ok({ op, exitCode: outcome.exitCode, durationMs: outcome.durationMs, output: outcome.output })
}

function refused(op: string, reason: BrokerRefusalReason): Result<BrokerOutcome, ControlRefusal> {
  return err({ kind: 'broker_refused', op, reason })
}

/**
 * The run a plaintext token belongs to, or `null` -- and everything the remaining questions need,
 * in one read.
 *
 * `SlaveRun.runTokenHash` is `@unique`, so the lookup is an index probe on a digest and the
 * plaintext never reaches a query. The `timingSafeEqual` afterwards is belt and braces over two
 * equal-length hex digests: the index has already decided, and this is the comparison that would
 * still be constant-time if a future version resolved the row some other way.
 */
async function loadRunByToken(runToken: string): Promise<BrokerRun | null> {
  const hash = runTokenHash(runToken)
  const row = await prisma.slaveRun.findUnique({
    where: { runTokenHash: hash },
    select: {
      id: true,
      status: true,
      kind: true,
      slaveId: true,
      runTokenHash: true,
      slave: {
        select: {
          permissions: { select: { kind: true, mode: true } },
          team: { select: { workspaceId: true, workspace: { select: { archivedAt: true } } } },
        },
      },
    },
  })
  if (row === null || row.runTokenHash === null) return null
  if (!timingSafeEqual(Buffer.from(row.runTokenHash, 'hex'), Buffer.from(hash, 'hex'))) return null
  return {
    id: row.id,
    status: row.status,
    kind: row.kind,
    slaveId: row.slaveId,
    workspaceId: row.slave.team.workspaceId,
    archivedAt: row.slave.team.workspace.archivedAt,
    permissions: row.slave.permissions,
  }
}
