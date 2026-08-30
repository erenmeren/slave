import { prisma } from '@ai-team-os/db/client'
import { type Result, err, ok } from '@ai-team-os/domain'
import type { ControlRefusal } from './refusal.js'

/**
 * The design README §3a.9's six permission columns, verbatim and in its order. ONE list: this verb
 * validates against it and `apps/web/src/server/settings.ts` renders it, so a seventh column is a
 * single edit rather than two that can disagree.
 *
 * **Not yet enforced at runtime** (M14 Decision 7). Nothing in `packages/providers` or
 * `apps/orchestrator` reads `AgentPermission`; the matrix is editable and the page says so in
 * as many words. This verb exists so the intent is RECORDED before the enforcement lands, not so
 * the surface can pretend it is enforced.
 */
export const PERMISSION_TOOLS = [
  'repo read',
  'source write',
  'run tests',
  'create branch',
  'deploy prod',
  'read secrets',
] as const

export type PermissionTool = (typeof PERMISSION_TOOLS)[number]

function isPermissionTool(value: string): value is PermissionTool {
  return (PERMISSION_TOOLS as readonly string[]).includes(value)
}

export async function setAgentPermission(
  agentId: string,
  tool: string,
  mode: 'allow' | 'deny',
): Promise<Result<void, ControlRefusal>> {
  if (!isPermissionTool(tool)) return err({ kind: 'invalid_tool', tool })
  // Narrowed by the signature, so a TypeScript caller cannot reach this -- but the route hands
  // through a parsed JSON body, and `refusalText` has to have something true to say when a
  // hand-rolled request carries `"mode": "maybe"`.
  if (mode !== 'allow' && mode !== 'deny') return err({ kind: 'invalid_permission_mode', mode: String(mode) })

  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true } })
  if (agent === null) return err({ kind: 'agent_not_found', agentId })

  // `@@unique([agentId, tool])` makes this a flip in place -- the same "one row or none" shape
  // `setWorkspaceProvider` keeps for its own table.
  await prisma.agentPermission.upsert({
    where: { agentId_tool: { agentId, tool } },
    update: { mode },
    create: { agentId, tool, mode },
  })
  return ok(undefined)
}
