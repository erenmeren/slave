import { assignSkill, unassignSkill } from '@ai-team-os/control'
import { orgControlResponse } from '../../../../server/orgControlRoute'

export const dynamic = 'force-dynamic'

/** The one malformed-body sentence both verbs answer with, so a POST and a DELETE that got the
 *  same bad body can never disagree about what a good one looks like. */
const SHAPE = 'the body must be { "agentId": string, "skillId": string }'

async function pair(request: Request): Promise<{ agentId: string; skillId: string } | null> {
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') return null
  const { agentId, skillId } = body as { agentId?: unknown; skillId?: unknown }
  if (typeof agentId !== 'string' || typeof skillId !== 'string') return null
  return { agentId, skillId }
}

/**
 * Assign (POST) / unassign (DELETE) a skill to an agent — the Skills page's only write.
 *
 * DELETE rather than a second POST with a flag: the pair IS the resource, and `AgentSkill` has no
 * state between present and absent for a body to carry. `orgControlResponse` (not the workspace
 * shell) because neither an agent nor a skill is owned by a workspace — the catalog is a fact
 * about the daemon host's disk.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = await pair(request)
  if (parsed === null) return Response.json({ error: SHAPE }, { status: 400 })
  return orgControlResponse(() => assignSkill(parsed.agentId, parsed.skillId))
}

export async function DELETE(request: Request): Promise<Response> {
  const parsed = await pair(request)
  if (parsed === null) return Response.json({ error: SHAPE }, { status: 400 })
  return orgControlResponse(() => unassignSkill(parsed.agentId, parsed.skillId))
}
