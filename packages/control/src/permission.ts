import { writeFileSync } from 'node:fs'
import { prisma } from '@slave-of-ai/db/client'
import {
  PERMISSION_KINDS,
  TOOLS_BY_KIND,
  type PermissionKind,
  type PermissionProvider,
  type Result,
  err,
  ok,
} from '@slave-of-ai/domain'
import { permissionsFilePathFor } from '@slave-of-ai/providers'
import type { ControlRefusal } from './refusal.js'

/**
 * M18's denylist, re-pointed at M52's vocabulary and NOTHING ELSE.
 *
 * TEMPORARY, and deleted by Task 2. The column swap and the inversion are two changes and this is
 * the seam between them: after this task a denied `run_commands` row denies `Bash` exactly as a
 * denied `run tests` row did, through a new column, in the new vocabulary, with the gate's answer
 * untouched. Task 2 replaces this function and the file it writes with `resolveGrants` and
 * `permissions.json` v2, and the library that reads it, in one commit.
 *
 * The six prose rows and `CAPABILITY_TOOLS` are gone with the column: the vocabulary now lives in
 * `packages/domain/src/permission/kinds.ts`, where the Settings matrix and the worker panel can
 * both reach it without importing this barrel (plan erratum E12).
 */
export function resolveDenyList(
  rows: readonly { readonly kind: string; readonly mode: 'allow' | 'deny' }[],
  provider: PermissionProvider,
): readonly { readonly tool: string; readonly capability: string }[] {
  const byTool = new Map<string, string>()
  for (const row of rows) {
    if (row.mode !== 'deny') continue
    if (!(PERMISSION_KINDS as readonly string[]).includes(row.kind)) continue
    for (const tool of TOOLS_BY_KIND[row.kind as PermissionKind][provider]) {
      if (!byTool.has(tool)) byTool.set(tool, row.kind)
    }
  }
  return [...byTool.entries()].map(([tool, capability]) => ({ tool, capability }))
}

/**
 * Writes `permissions.json` into a run's own scratch directory (`runFilePaths`'s `runDir`) --
 * the resolved deny list `scripts/lib/permissions.sh` reads back through `SLAVEOFAI_PERMISSIONS_
 * FILE` (Task 5, spec §2). Called at every START (Task 5 dispatch sites) and every RESUME
 * (`executeResume`): a fresh snapshot each time, never merged with what was there before -- a
 * matrix edit reaches a run only the next time it starts or resumes, never one already in flight
 * between those two points, exactly as the matrix UI copy states. `deny` is written even when
 * empty: an armed-but-empty file is real JSON the gate reads as "nothing denied", a materially
 * different case from the file being absent at all, which `read_permission_verdict` treats as "no
 * matrix in play."
 *
 * `permissionsFilePathFor` (`@slave-of-ai/providers`) is the ONE definition of the `'permissions.
 * json'` filename convention (M18 Task 5, fix round 1 -- a divergent literal here fails OPEN, not
 * closed: `read_permission_verdict` treats a missing/wrong-path file exactly like "no matrix in
 * play" and allows). This function imports it rather than joining the literal itself; each
 * provider adapter's `resume()` (`packages/providers/src/claude/adapter.ts`, `cursor/adapter.ts`)
 * calls the SAME function, in-package, to re-derive the identical path from
 * `dirname(checkpoint.pauseFlagPath)` -- `resume()` has no `Checkpoint` field to recover the path
 * from directly (deliberately; see that interface's own docstring on why it may not gain a field
 * with no matching Prisma column). The helper lives in `packages/providers`, not here, for the
 * same reason `KILL_GRACE_MS` does (M13 Decision 6, `process.ts`'s own docstring): `packages/
 * control` already depends on `@slave-of-ai/providers`, never the reverse.
 */
export function writePermissionsFile(
  runDir: string,
  denyList: readonly { readonly tool: string; readonly capability: string }[],
): string {
  const permissionsFilePath = permissionsFilePathFor(runDir)
  writeFileSync(permissionsFilePath, JSON.stringify({ version: 1, deny: denyList }, null, 2))
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
