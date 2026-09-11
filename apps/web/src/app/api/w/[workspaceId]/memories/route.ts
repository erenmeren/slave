import { z } from 'zod'
import { addMemory, refusalText } from '@slave-of-ai/control'
import { MEMORY_TYPES } from '@slave-of-ai/domain'
import { archivedRefusal } from '../../../../../server/workspaceControlRoute'
import { buildKnowledge } from '../../../../../server/memory'
import { parseKnowledgeFilters } from '../../../../../lib/knowledgeFilters'
import { refusalStatus } from '../../../../../server/refusalStatus'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  type: z.enum(MEMORY_TYPES),
  title: z.string(),
  body: z.string(),
  capabilities: z.array(z.string()).optional(),
})

/** The Knowledge tab's one read, and the one write a person makes from nothing (M49 R6). */
export async function GET(request: Request, context: { params: Promise<{ workspaceId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  // ONE parse, shared with the page's server render and with the client's filter bar
  // (`lib/knowledgeFilters.ts`): a value the union does not have is IGNORED rather than 400, so a
  // bookmarked filter from a future version shows the page instead of an error.
  const view = await buildKnowledge(workspaceId, parseKnowledgeFilters(new URL(request.url).searchParams))
  if (view === null) return Response.json({ error: 'no such workspace' }, { status: 404 })
  return Response.json(view)
}

export async function POST(request: Request, context: { params: Promise<{ workspaceId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'the body must be { "type", "title", "body" }' }, { status: 400 })
  }
  const refusal = await archivedRefusal(workspaceId)
  if (refusal !== null) return refusal
  const result = await addMemory({ workspaceId, scope: 'workspace', ...parsed.data }, gate.principal ?? undefined)
  if (!result.ok) {
    return Response.json(
      { error: refusalText(result.error), kind: result.error.kind },
      { status: refusalStatus(result.error.kind) },
    )
  }
  return Response.json({ ok: true, id: result.value.id })
}
