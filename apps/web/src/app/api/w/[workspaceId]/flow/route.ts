import { z } from 'zod'
import { setFlow } from '@slave-of-ai/control'
import { workspaceControlResponse } from '../../../../../server/workspaceControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({ flow: z.enum(['packages', 'lead']), autoMerge: z.boolean().optional(), model: z.string().optional() })
const BODY_ERROR = 'the body must be { "flow": "lead" | "packages", "autoMerge"?: boolean, "model"?: string }'

/** Lead UX design section 7: "How it is built" -- the CLI's `set-flow` (`setFlow`, which owns
 *  every refusal: an open build, a live run, open tasks, no Claude Code runtime). */
export async function POST(request: Request, context: { params: Promise<{ workspaceId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: BODY_ERROR }, { status: 400 })
  const { flow, autoMerge, model } = parsed.data
  return workspaceControlResponse(workspaceId, () => setFlow(workspaceId, flow, { ...(autoMerge === undefined ? {} : { autoMerge }), ...(model === undefined ? {} : { model }) }))
}
