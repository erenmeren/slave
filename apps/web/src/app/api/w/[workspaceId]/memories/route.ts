import { z } from 'zod'
import { addMemory, refusalText } from '@slave-of-ai/control'
import { MEMORY_SCOPES, MEMORY_STATUSES, MEMORY_TYPES, type MemoryScope, type MemoryStatus, type MemoryType } from '@slave-of-ai/domain'
import { archivedRefusal } from '../../../../../server/workspaceControlRoute'
import { buildKnowledge } from '../../../../../server/memory'
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
  const url = new URL(request.url)
  const scope = url.searchParams.get('scope')
  const type = url.searchParams.get('type')
  const status = url.searchParams.getAll('status')
  const q = url.searchParams.get('q')
  // A query value the union does not have is IGNORED rather than 400: a bookmarked filter from a
  // future version must show the page, not an error (`parseActivityFilters`' own rule). A `status`
  // list that survives the filter EMPTY is dropped for the same reason -- an empty `statuses` would
  // ask `listMemories` for nothing at all, which is not what a bookmark meant.
  const statuses = status.filter((one): one is MemoryStatus => (MEMORY_STATUSES as readonly string[]).includes(one))
  const view = await buildKnowledge(workspaceId, {
    ...(scope !== null && (MEMORY_SCOPES as readonly string[]).includes(scope) ? { scope: scope as MemoryScope } : {}),
    ...(type !== null && (MEMORY_TYPES as readonly string[]).includes(type) ? { type: type as MemoryType } : {}),
    ...(statuses.length === 0 ? {} : { statuses }),
    ...(q === null || q.trim() === '' ? {} : { q }),
  })
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
