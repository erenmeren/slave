import { prisma } from '@ai-team-os/db/client'
import { type Result, err, ok } from '@ai-team-os/domain'
import type { ControlRefusal } from './refusal.js'

/**
 * The design README §3a.9's six permission columns, verbatim and in its order. ONE list: this verb
 * validates against it and `apps/web/src/server/settings.ts` renders it, so a seventh column is a
 * single edit rather than two that can disagree.
 *
 * Enforcement (M18 §2) resolves ORCHESTRATOR-SIDE, at dispatch/resume snapshot time:
 * `resolveDenyList` below maps each `deny` row to real vendor tool names via `CAPABILITY_TOOLS`
 * and the result is written into a run's `permissions.json`, which the gate scripts read as a
 * dumb membership test. A matrix edit does not reach a run already in flight -- stated in the
 * matrix UI copy -- and `read secrets` stays unenforced (a path predicate, no tool carries it).
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

/**
 * v1 capability→vendor-tool resolution (spec §2, measured 2026-08-31). Coarse by design:
 * the three shell-backed capabilities all deny the shell tool outright (command-string
 * inspection is out of scope), and 'read secrets' maps to nothing — it is a path predicate
 * no tool carries, stated as unenforced in the matrix UI. Unmapped tools always pass.
 */
const CAPABILITY_TOOLS: Record<string, { readonly claude_code: readonly string[]; readonly cursor: readonly string[] }> = {
  'repo read': { claude_code: ['Read'], cursor: ['read'] },
  'source write': { claude_code: ['Write', 'Edit', 'NotebookEdit'], cursor: ['edit'] },
  'run tests': { claude_code: ['Bash'], cursor: ['shell'] },
  'create branch': { claude_code: ['Bash'], cursor: ['shell'] },
  'deploy prod': { claude_code: ['Bash'], cursor: ['shell'] },
  'read secrets': { claude_code: [], cursor: [] },
}

/** The resolved deny list `permissions.json` carries: one entry per denied vendor tool, naming
 *  the (first) denied capability that put it there. Deny rows only — unset and allow pass. */
export function resolveDenyList(
  rows: readonly { readonly tool: string; readonly mode: 'allow' | 'deny' }[],
  provider: 'claude_code' | 'cursor',
): readonly { readonly tool: string; readonly capability: string }[] {
  const byTool = new Map<string, string>()
  for (const row of rows) {
    if (row.mode !== 'deny') continue
    for (const tool of CAPABILITY_TOOLS[row.tool]?.[provider] ?? []) {
      if (!byTool.has(tool)) byTool.set(tool, row.tool)
    }
  }
  return [...byTool.entries()].map(([tool, capability]) => ({ tool, capability }))
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
