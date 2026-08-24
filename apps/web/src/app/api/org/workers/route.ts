import { listWorkers } from '../../../../server/org'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  const workers = await listWorkers()
  return Response.json({ workers })
}
