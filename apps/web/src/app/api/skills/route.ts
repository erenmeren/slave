import { listSkillUse } from '@slave-of-ai/control'
import { requirePrincipal } from '../../../server/principal'

export const dynamic = 'force-dynamic'

/** Every skill of the library with how many people and personas have it: the Skills tab and the
 *  skill pickers. A read. */
export async function GET(): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  return Response.json({ skills: await listSkillUse() })
}
