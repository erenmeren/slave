import { writeFileSync } from 'node:fs'
import { prisma } from '@slave-of-ai/db/client'
import {
  ENFORCE_BY_PROVIDER,
  MCP_TOOL_PREFIX,
  PERMISSION_KINDS,
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
import { permissionsFilePathFor, runTokenHash } from '@slave-of-ai/providers'
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

export async function setSlavePermission(
  slaveId: string,
  kind: string,
  mode: 'allow' | 'deny',
): Promise<Result<void, ControlRefusal>> {
  // `invalid_tool` keeps its NAME (plan erratum E11): renaming a refusal kind costs three homes to
  // rename a word no surface prints. Its payload field stays `tool` and now carries the offered
  // KIND, and its sentence moved with the vocabulary.
  if (!(PERMISSION_KINDS as readonly string[]).includes(kind)) return err({ kind: 'invalid_tool', tool: kind })
  // Narrowed by the signature, so a TypeScript caller cannot reach this -- but the route hands
  // through a parsed JSON body, and `refusalText` has to have something true to say when a
  // hand-rolled request carries `"mode": "maybe"`.
  if (mode !== 'allow' && mode !== 'deny') return err({ kind: 'invalid_permission_mode', mode: String(mode) })

  const slave = await prisma.slave.findUnique({ where: { id: slaveId }, select: { id: true } })
  if (slave === null) return err({ kind: 'slave_not_found', slaveId })

  // `@@unique([slaveId, kind])` makes this a flip in place -- the same "one row or none" shape
  // `setWorkspaceProvider` keeps for its own table.
  await prisma.slavePermission.upsert({
    where: { slaveId_kind: { slaveId, kind: kind as PermissionKind } },
    update: { mode },
    create: { slaveId, kind: kind as PermissionKind, mode },
  })
  return ok(undefined)
}
