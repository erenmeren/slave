import { z } from 'zod'
import { refusalText, setProfile } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../../server/orgControlRoute'
import { actorName, requirePrincipal } from '../../../../../../server/principal'
import { readTemplateProfileView } from '../../../../../../server/org'
import { refusalStatus } from '../../../../../../server/refusalStatus'

export const dynamic = 'force-dynamic'

/** `null` is not "absent" here: it is the explicit "clear the raw override", after which the
 *  rendered profile is what the next read shows -- the slave route's rule (M37 §6), one level up
 *  the same chain. So the key must be PRESENT and the value must be a string or null. */
const bodySchema = z.object({ profile: z.union([z.string(), z.null()]) })

const BODY_ERROR = 'the body must be { "profile": string | null }'

/** One template's whole specialist profile, for `ProfileDrawer` (plan erratum E10): the full
 *  effective spec, the upstream it was mapped from, the overrides in force and the stored
 *  Markdown -- ~3 KB that must not ride on every catalog row. */
export async function GET(_request: Request, context: { params: Promise<{ templateId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId } = await context.params
  const result = await readTemplateProfileView(templateId)
  if (!result.ok) {
    return Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
  }
  return Response.json(result.value)
}

/**
 * The raw Markdown override (R5, plan erratum E10), which had no web verb before this: the drawer's
 * "write it myself" replaces `SlaveTemplate.profile` wholesale, and the next import will leave the
 * row alone (`locally_edited`) for exactly as long as it stands.
 *
 * PUT rather than PATCH, unlike the slave route beside it: this REPLACES the one document a
 * template's profile is, where `PATCH …/overrides` merges fields into a patch.
 */
export async function PUT(request: Request, context: { params: Promise<{ templateId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId } = await context.params
  const raw: unknown = await request.json().catch(() => null)
  const body = bodySchema.safeParse(raw)
  if (!body.success) return Response.json({ error: BODY_ERROR }, { status: 400 })
  return orgControlResponse(() => setProfile({ templateId }, body.data.profile, actorName(gate.principal)))
}
