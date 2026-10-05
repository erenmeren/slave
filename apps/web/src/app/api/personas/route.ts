import { z } from 'zod'
import { createTemplate, listPersonas } from '@slave-of-ai/control'
import { controlResponse, pageOf, textOf } from '../../../server/controlRoute'
import { requirePrincipal } from '../../../server/principal'

export const dynamic = 'force-dynamic'

/** The catalogue of personas, a page at a time: `q`, `division`, `active=1|0`, `offset`, `limit`. */
export async function GET(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const params = new URL(request.url).searchParams
  const [q, division, active] = [textOf(params, 'q'), textOf(params, 'division'), params.get('active')]
  return Response.json(
    await listPersonas(
      { ...(q === undefined ? {} : { q }), ...(division === undefined ? {} : { division }), ...(active === '1' ? { active: true } : active === '0' ? { active: false } : {}) },
      pageOf(params),
    ),
  )
}

const bodySchema = z.object({ name: z.string(), role: z.string(), description: z.string().optional() }).strict()
const BODY_ERROR = 'the body must be { "name": string, "role": string, "description"?: string }'

/** A persona made by hand (`createTemplate`): a name, a role and one line. It is active at once;
 *  its instructions are written afterwards. Answers its id. */
export async function POST(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: BODY_ERROR }, { status: 400 })
  const { name, role, description } = parsed.data
  return controlResponse(() => createTemplate(name.trim(), role.trim(), description === undefined || description.trim() === '' ? undefined : { description: description.trim() }))
}
