import { writeFileSync } from 'node:fs'
import { prisma } from '@slave-of-ai/db/client'
import {
  ENFORCE_BY_PROVIDER,
  MCP_TOOL_PREFIX,
  PERMISSION_KINDS,
  PERMISSION_LABEL,
  TOOL_VOCABULARY,
  type PermissionKind,
  type PermissionProvider,
  type PermissionRowInput,
  type PermissionRunKind,
  type Result,
  err,
  grantsFor,
  ok,
  resolveGrants,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { permissionsFilePathFor, runTokenHash } from '@slave-of-ai/providers'
import type { Principal } from './principal.js'
import type { ControlRefusal } from './refusal.js'

/**
 * Writes `permissions.json` v2 into the run's own scratch directory (M52 R2).
 *
 * v1 was a DENY list and an absent file allowed; v2 is an ALLOW list, and the file is the whole
 * verdict: what this run may call, which operation governs each of those tools, which operations
 * were granted at all, the vocabulary the gate needs to NAME the operation behind a refusal, how
 * much of it this provider can enforce, and WHICH RUN the verdict is about.
 * `scripts/lib/permissions.sh` refuses anything it cannot read as exactly that, and refusing means
 * stopping the run.
 *
 * `grants` is not a duplicate of `allow` (M52 erratum E16). `toolKindFor` resolves every `mcp__*`
 * name through a PREFIX, and a prefix is not enumerable, so `resolveGrants` puts no MCP name on the
 * allow list however `network_fetch` resolves. The gate therefore decides by KIND -- the tool's own
 * name first, then `prefixes` -- and one `network_fetch` grant opens every MCP tool rather than the
 * two `allow` can spell. `allow` stays because it is the readable half: an operator looking at a
 * run's verdict wants to see the names, and the gate's first question is still "is this tool on the
 * list".
 *
 * Still rewritten at every START and every RESUME and never merged: a matrix edit reaches a run only
 * the next time it starts or resumes, exactly as the matrix copy has always said. Mode 0600, inside
 * a 0700 directory outside the repository -- and no plaintext token is ever written here (erratum
 * E7), only its hash, because a run directory is readable by every sibling run under the same uid.
 *
 * `permissionsFilePathFor` (`@slave-of-ai/providers`) is the ONE definition of the
 * `'permissions.json'` filename convention (M18 Task 5, fix round 1). This function imports it
 * rather than joining the literal itself; each provider adapter's `resume()` calls the SAME
 * function, in-package, to re-derive the identical path from `dirname(checkpoint.pauseFlagPath)` --
 * `resume()` has no `Checkpoint` field to recover the path from directly (deliberately; see that
 * interface's own docstring on why it may not gain a field with no matching Prisma column). The
 * helper lives in `packages/providers`, not here, for the same reason `KILL_GRACE_MS` does (M13
 * Decision 6): `packages/control` already depends on `@slave-of-ai/providers`, never the reverse.
 */
export function writePermissionsFile(
  runDir: string,
  input: {
    readonly rows: readonly { readonly kind: string; readonly mode: 'allow' | 'deny' }[]
    readonly provider: PermissionProvider
    readonly runKind: PermissionRunKind
    readonly runId: string
    /** The PLAINTEXT token this spawn will put in the child's environment. Only its hash is written
     *  here; the plaintext is never persisted anywhere (M52 R4, plan erratum E7). */
    readonly runToken: string
  },
): string {
  const permissionsFilePath = permissionsFilePathFor(runDir)
  const rows = input.rows.filter((row): row is PermissionRowInput =>
    (PERMISSION_KINDS as readonly string[]).includes(row.kind),
  )
  const body = {
    version: 2,
    runId: input.runId,
    tokenHash: runTokenHash(input.runToken),
    enforce: ENFORCE_BY_PROVIDER[input.provider],
    grants: grantsFor(rows, input.runKind)
      .filter((grant) => grant.source === 'baseline' || grant.source === 'granted')
      .map((grant) => grant.kind),
    allow: resolveGrants(rows, input.provider, input.runKind),
    vocabulary: TOOL_VOCABULARY[input.provider],
    // The name families the vocabulary cannot enumerate. ONE entry today, spelled from the domain's
    // own constant rather than as a literal, so a second prefix rule lands here by construction.
    prefixes: [{ prefix: MCP_TOOL_PREFIX, kind: 'network_fetch' satisfies PermissionKind }],
  }
  // 0600 (D15): the verdict that governs a worker is not world-readable, and `writeFileSync`'s
  // `mode` applies only when the file is CREATED -- which is every time here, because the file is
  // rewritten wholesale at every start and every resume and never opened for append.
  writeFileSync(permissionsFilePath, JSON.stringify(body, null, 2), { mode: 0o600 })
  return permissionsFilePath
}

/**
 * One worker, one operation, as it stands right now -- and who last said so (M52 R5).
 *
 * The read is the EVENT's, not a race guard: `from` is what a person needs to see a month later and
 * an `upsert` alone cannot report it. Both writers below take the same shape, so the reasoning about
 * concurrency is stated once here. Two writers flipping one kind at once produce two events whose
 * `from` values each agree with what that writer saw, which is the honest record of what happened --
 * a lock would buy an ordering nobody can observe and would hold a row across an append.
 */
async function priorMode(slaveId: string, kind: PermissionKind): Promise<'allow' | 'deny' | null> {
  const row = await prisma.slavePermission.findUnique({
    where: { slaveId_kind: { slaveId, kind } },
    select: { mode: true },
  })
  return row?.mode ?? null
}

/** The worker a permission verb is about, with the two facts its event needs beside the existence
 *  check: a workspace to be filed against and a name to print. One `findUnique`, because a second
 *  query for either would be a second reading of one row. */
async function slaveForPermission(
  slaveId: string,
): Promise<{ readonly name: string; readonly workspaceId: string } | null> {
  const row = await prisma.slave.findUnique({
    where: { id: slaveId },
    select: { name: true, team: { select: { workspaceId: true } } },
  })
  return row === null ? null : { name: row.name, workspaceId: row.team.workspaceId }
}

/**
 * Grant or refuse one operation for one worker (M52 R1/R5).
 *
 * `principal` is the trailing optional parameter every event-appending control verb takes: the web
 * fills it from the session, the CLI passes nothing, and `carryOut` passes the approver's. It lands
 * on the ROW (`grantedBy`) as well as in the event, because the worker panel prints "Granted by X on
 * Y" from the row and a projection that had to join the event log for it would be a second reading.
 *
 * The read-before-write is not a race guard, it is the event -- see {@link priorMode}.
 *
 * No event when nothing changed. A PUT that re-sends the same body is the same state -- that is what
 * PUT promises -- and an event per click would make the timeline a log of a person's mouse. Nothing
 * is written at all in that case, so the original granter keeps the row: `grantedBy` answers "who
 * decided this", not "who last looked at it".
 *
 * `actor: 'human'` unconditionally, with no `origin` parameter (the shape `setSlaveLifecycle` has).
 * There is no automatic path to this verb: the Supervisor's `request_permission` is always
 * `proposed`, so `carryOut` reaches it only on the far side of a person's approval, and the approver
 * is the granter.
 */
export async function setSlavePermission(
  slaveId: string,
  kind: string,
  mode: 'allow' | 'deny',
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  // `invalid_tool` keeps its NAME (plan erratum E11): renaming a refusal kind costs three homes to
  // rename a word no surface prints. Its payload field stays `tool` and now carries the offered
  // KIND, and its sentence moved with the vocabulary.
  if (!(PERMISSION_KINDS as readonly string[]).includes(kind)) return err({ kind: 'invalid_tool', tool: kind })
  // Narrowed by the signature, so a TypeScript caller cannot reach this -- but the route hands
  // through a parsed JSON body, and `refusalText` has to have something true to say when a
  // hand-rolled request carries `"mode": "maybe"`.
  if (mode !== 'allow' && mode !== 'deny') return err({ kind: 'invalid_permission_mode', mode: String(mode) })

  const slave = await slaveForPermission(slaveId)
  if (slave === null) return err({ kind: 'slave_not_found', slaveId })

  const from = await priorMode(slaveId, kind as PermissionKind)
  if (from === mode) return ok(undefined)

  // `@@unique([slaveId, kind])` makes this a flip in place -- the same "one row or none" shape
  // `setWorkspaceProvider` keeps for its own table. `grantedAt` is set explicitly on the update
  // half: the column defaults to `now()` on INSERT and there is no `@updatedAt`, so a flip that did
  // not touch it would print the moment the FIRST decision was taken beside the second one's author.
  await prisma.slavePermission.upsert({
    where: { slaveId_kind: { slaveId, kind: kind as PermissionKind } },
    update: { mode, grantedBy: principal?.userId ?? null, grantedAt: new Date() },
    create: { slaveId, kind: kind as PermissionKind, mode, grantedBy: principal?.userId ?? null },
  })
  await appendPermissionChanged(slaveId, slave, kind as PermissionKind, from, mode, principal)
  return ok(undefined)
}

/**
 * Take a decision back (M52 R5): the row is DELETED, and the kind returns to "never asked".
 *
 * The verb `setSlavePermission` never had. Under M18 it did not matter -- `allow` and unset resolved
 * identically -- and under default-deny the three states finally differ, so a person who granted
 * something in error needs a way back to the state before they did rather than a `deny` that reads
 * as a considered refusal.
 *
 * Deleting nothing is SUCCESS, not a refusal: DELETE is idempotent, the route behind it is a DELETE,
 * and "there was nothing to take back" is the caller's desired end state. No row, no change, no
 * event.
 */
export async function clearSlavePermission(
  slaveId: string,
  kind: string,
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  if (!(PERMISSION_KINDS as readonly string[]).includes(kind)) return err({ kind: 'invalid_tool', tool: kind })

  const slave = await slaveForPermission(slaveId)
  if (slave === null) return err({ kind: 'slave_not_found', slaveId })

  const from = await priorMode(slaveId, kind as PermissionKind)
  if (from === null) return ok(undefined)

  // `deleteMany`, not `delete`: the row was read a moment ago and a concurrent revoke of the same
  // kind would make `delete` throw on a row that is already in the state the caller wanted.
  await prisma.slavePermission.deleteMany({ where: { slaveId, kind: kind as PermissionKind } })
  await appendPermissionChanged(slaveId, slave, kind as PermissionKind, from, null, principal)
  return ok(undefined)
}

/** The one `permission.changed` append, shared by the grant and the revoke so the triple a person
 *  reads is spelled once. AFTER the write and outside any transaction: the decision is the fact, and
 *  an append that threw inside one would roll back the very change it failed to record. */
async function appendPermissionChanged(
  slaveId: string,
  slave: { readonly name: string; readonly workspaceId: string },
  kind: PermissionKind,
  from: 'allow' | 'deny' | null,
  to: 'allow' | 'deny' | null,
  principal: Principal | undefined,
): Promise<void> {
  await appendEvent({
    type: 'permission.changed',
    workspaceId: slave.workspaceId,
    slaveId,
    actor: 'human',
    payload: {
      slaveId,
      name: slave.name,
      kind,
      // The LABEL beside the key: the key is what every rule is written against, and the label is
      // what a timeline prints -- a reader months later should not have to hold the vocabulary in
      // their head to know what was granted.
      kindLabel: PERMISSION_LABEL[kind],
      from,
      to,
      by: principal?.userId ?? null,
    },
    userId: principal?.userId ?? null,
  })
}
