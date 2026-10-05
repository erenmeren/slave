import { z } from 'zod'
import { createPerson, isProviderKind, listPeople, refusalText, setPersonOnRoster } from '@slave-of-ai/control'
import { pageOf, textOf } from '../../../server/controlRoute'
import { requirePrincipal } from '../../../server/principal'
import { refusalStatus } from '../../../server/refusalStatus'
import { archivedRefusal } from '../../../server/workspaceControlRoute'

export const dynamic = 'force-dynamic'

/** The People list, a page at a time: `q`, `division`, `skill`, `persona`, `roster=1`,
 *  `noSkills=1`, `offset`, `limit`. A read. */
export async function GET(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const params = new URL(request.url).searchParams
  const [q, division, skillId, templateId] = [textOf(params, 'q'), textOf(params, 'division'), textOf(params, 'skill'), textOf(params, 'persona')]
  return Response.json(
    await listPeople(
      {
        ...(q === undefined ? {} : { q }),
        ...(division === undefined ? {} : { division }),
        ...(skillId === undefined ? {} : { skillId }),
        ...(templateId === undefined ? {} : { templateId }),
        ...(params.get('roster') === '1' ? { onRoster: true } : {}),
        ...(params.get('noSkills') === '1' ? { noSkills: true } : {}),
      },
      pageOf(params),
    ),
  )
}

const bodySchema = z
  .object({ templateId: z.string().min(1).optional(), name: z.string().optional(), model: z.string().min(1).optional(), provider: z.string().min(1).optional(), workspaceId: z.string().min(1).optional() })
  .strict()
const BODY_ERROR = 'the body must be { "templateId"?: string, "name"?: string, "model"?: string, "provider"?: string, "workspaceId"?: string }'

/**
 * A new person (`createPerson`): from a persona, or from a name alone. With `workspaceId` they are
 * put on that project's roster as well; when the roster refuses, the person still exists and the
 * answer says so (`created: true` beside the refusal), so the screen can open them.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: BODY_ERROR }, { status: 400 })
  const { templateId, model, provider, workspaceId } = parsed.data
  const name = parsed.data.name?.trim()
  if (templateId === undefined && (name === undefined || name === '')) return Response.json({ error: 'a person needs a name, or a persona to take one from' }, { status: 400 })
  if (provider !== undefined && !isProviderKind(provider)) return Response.json({ error: `no provider kind ${provider}` }, { status: 400 })
  if (workspaceId !== undefined) {
    const refusal = await archivedRefusal(workspaceId)
    if (refusal !== null) return refusal
  }

  const created = await createPerson(
    {
      ...(templateId === undefined ? {} : { templateId }),
      ...(name === undefined || name === '' ? {} : { name }),
      ...(model === undefined ? {} : { model }),
      ...(provider === undefined ? {} : { provider }),
    },
    gate.principal ?? undefined,
  )
  if (!created.ok) return Response.json({ error: refusalText(created.error) }, { status: refusalStatus(created.error.kind) })
  if (workspaceId !== undefined) {
    const listed = await setPersonOnRoster(created.value.personId, workspaceId, true)
    if (!listed.ok) return Response.json({ error: refusalText(listed.error), personId: created.value.personId, name: created.value.name, created: true }, { status: refusalStatus(listed.error.kind) })
  }
  return Response.json({ ok: true, personId: created.value.personId, name: created.value.name })
}
