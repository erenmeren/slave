import { listTemplateDuplicatesView } from '../../../../../../server/org'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** Every pair one template is in, for the profile drawer's Duplicates group (M55 R6). A 200 with an
 *  EMPTY array for a template that is in none, and a 200 with an empty array for a template id
 *  nobody wrote -- "nothing looks like this row" and "there is no such row" are the same answer to
 *  the question this endpoint is asked, and a 404 here would make an open drawer flash an error
 *  band the instant a template was deleted in another tab. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ templateId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId } = await context.params
  return Response.json(await listTemplateDuplicatesView(templateId))
}
