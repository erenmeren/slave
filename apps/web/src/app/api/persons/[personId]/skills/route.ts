import { setPersonSkills } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** M58 R15/R23: grant, revoke, or take back what this person said. Three optional lists, because
 *  they are three different acts -- see `setPersonSkills`' own docstring. */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ personId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { personId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') {
    return Response.json(
      { error: 'the body must be { "grant"?: string[], "revoke"?: string[], "clear"?: string[] }' },
      { status: 400 },
    )
  }
  const { grant, revoke, clear } = body as { grant?: unknown; revoke?: unknown; clear?: unknown }
  const ids = (value: unknown): readonly string[] | undefined | 'bad' => {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.some((one) => typeof one !== 'string')) return 'bad'
    return value as readonly string[]
  }
  const [g, r, c] = [ids(grant), ids(revoke), ids(clear)]
  if (g === 'bad' || r === 'bad' || c === 'bad') {
    return Response.json({ error: 'grant, revoke and clear must be arrays of skill ids' }, { status: 400 })
  }
  return orgControlResponse(() =>
    setPersonSkills(personId, {
      ...(g === undefined ? {} : { grant: g }),
      ...(r === undefined ? {} : { revoke: r }),
      ...(c === undefined ? {} : { clear: c }),
    }),
  )
}
