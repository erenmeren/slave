import { listPersons } from '../../../../server/persons'
import { listWorkers } from '../../../../server/org'

export const dynamic = 'force-dynamic'

/** M58 R15: `workers` is still the SEAT list every project surface polls; `people` is the person
 *  list the Workforce People tab polls. Both, from one route, because the header count and the
 *  People table are the same poll on the same page. */
export async function GET(): Promise<Response> {
  const [workers, people] = await Promise.all([listWorkers(), listPersons()])
  return Response.json({ workers, people })
}
