import { z } from 'zod'
import { leadStatus, refusalText, setLeadSettings } from '@slave-of-ai/control'
import { archivedRefusal } from '../../../../../server/workspaceControlRoute'
import { refusalStatus } from '../../../../../server/refusalStatus'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

const bodySchema = z
  .object({ timeLimitMs: z.number().nullable().optional(), roster: z.array(z.string()).optional(), model: z.string().optional() })
  .refine((body) => body.timeLimitMs !== undefined || body.roster !== undefined || body.model !== undefined)
const BODY_ERROR = 'the body must name one of { "timeLimitMs": number | null, "roster": string[], "model": string }'

/** Lead UX design section 7: the CLI's `lead-status`, as JSON. The Project screen reads
 *  `/project` instead; this is the same view the CLI prints, for a caller that wants it. */
export async function GET(request: Request, context: { params: Promise<{ workspaceId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const version = new URL(request.url).searchParams.get('version')
  if (version !== null && !/^[1-9]\d{0,8}$/u.test(version)) return Response.json({ error: `goal version "${version}" is not a positive whole number` }, { status: 400 })
  const result = await leadStatus(workspaceId, version === null ? undefined : Number(version))
  return result.ok ? Response.json({ lead: result.value }) : Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
}

/** Lead UX design section 7: the Settings sheet's time limit, helpers and the lead's model -- the
 *  CLI's `set-lead` (`setLeadSettings` owns every bound and its sentence). Answers what was stored. */
export async function PATCH(request: Request, context: { params: Promise<{ workspaceId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: BODY_ERROR }, { status: 400 })
  const refusal = await archivedRefusal(workspaceId)
  if (refusal !== null) return refusal
  const { timeLimitMs, roster, model } = parsed.data
  const result = await setLeadSettings(workspaceId, {
    ...(timeLimitMs === undefined ? {} : { timeLimitMs }),
    ...(roster === undefined ? {} : { roster }),
    ...(model === undefined ? {} : { model }),
  })
  return result.ok
    ? Response.json({ ok: true, timeLimitMs: result.value.timeLimitMs, roster: result.value.roster })
    : Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
}
