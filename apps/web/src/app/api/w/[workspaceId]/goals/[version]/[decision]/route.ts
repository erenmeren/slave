import { BUILD_DECISIONS, decideBuild, type BuildDecision } from '@slave-of-ai/control'
import { workspaceControlResponse } from '../../../../../../../server/workspaceControlRoute'
import { requirePrincipal } from '../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** The URL's words for {@link BuildDecision}: `/goals/:n/accept`, `/leave`, `/retry`, `/merged`. */
function isDecision(value: string): value is BuildDecision {
  return (BUILD_DECISIONS as readonly string[]).includes(value)
}

/**
 * Lead UX design section 7: the decision card's four answers -- Accept as it is, Leave it
 * unmerged, Check again (the CLI's `retry-goal`), I merged it (`confirm-goal-merge`) -- through the
 * one control function that also closes the build's card (`decideBuild`). The `report` sibling is
 * a static segment and wins over this one, so `/goals/:n/report` is unchanged.
 */
export async function POST(_request: Request, context: { params: Promise<{ workspaceId: string; version: string; decision: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, version, decision } = await context.params
  if (!isDecision(decision)) return Response.json({ error: `no decision "${decision}"; one of ${BUILD_DECISIONS.join(', ')}` }, { status: 404 })
  if (!/^[1-9]\d{0,8}$/u.test(version)) return Response.json({ error: `goal version "${version}" is not a positive whole number` }, { status: 400 })
  return workspaceControlResponse(workspaceId, () => decideBuild(workspaceId, Number(version), decision, gate.principal ?? undefined))
}
