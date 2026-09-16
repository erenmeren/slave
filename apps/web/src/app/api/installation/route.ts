import { readInstallationSettings, refusalText, resolveReposRoot, setInstallationSettings } from '@slave-of-ai/control'
import { refusalStatus } from '../../../server/refusalStatus'
import { requirePrincipal } from '../../../server/principal'

export const dynamic = 'force-dynamic'
const BODY_ERROR = 'the body must be { reposRoot: string | null }'

/** M59 R17: the stored value, the resolved value and where the resolution came from -- three
 *  different facts, and a Settings field that showed only the last of them could not tell a person
 *  whether changing it would do anything. */
export async function GET(): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const [stored, resolved] = await Promise.all([readInstallationSettings(), resolveReposRoot()])
  return Response.json({ reposRoot: stored.reposRoot, resolved: resolved.root, source: resolved.source })
}

export async function POST(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') return Response.json({ error: BODY_ERROR }, { status: 400 })
  const value = (body as { reposRoot?: unknown }).reposRoot
  if (value !== null && typeof value !== 'string') return Response.json({ error: BODY_ERROR }, { status: 400 })
  const result = await setInstallationSettings({ reposRoot: value })
  return result.ok
    ? Response.json({ ok: true, reposRoot: result.value.reposRoot })
    : Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
}
