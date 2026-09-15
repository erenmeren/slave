import { prisma } from '@slave-of-ai/db/client'
import { orgControlResponse } from '../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../server/principal'

export const dynamic = 'force-dynamic'

/** The one malformed-body sentence both verbs answer with, so a POST and a DELETE that got the
 *  same bad body can never disagree about what a good one looks like. */
const SHAPE = 'the body must be { "personId": string, "skillId": string }'

async function pair(request: Request): Promise<{ personId: string; skillId: string } | null> {
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') return null
  const { personId, skillId } = body as { personId?: unknown; skillId?: unknown }
  if (typeof personId !== 'string' || typeof skillId !== 'string') return null
  return { personId, skillId }
}

/**
 * Grant (POST) / take away (DELETE) a skill for a PERSON — the Skills page's only write (M58 R3).
 *
 * DELETE rather than a second POST with a flag: the pair IS the resource, and a `PersonSkill` has
 * no state between present and absent for a body to carry. `orgControlResponse` (not the workspace
 * shell) because neither a person nor a skill is owned by a workspace — the catalog is a fact about
 * the daemon host's disk.
 *
 * M58: the inline write below is what Task 5 replaces with `setPersonSkills`, once
 * `packages/control/src/personSkills.ts` exists. It is here so this route keeps working through the
 * one commit in which it does not.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const parsed = await pair(request)
  if (parsed === null) return Response.json({ error: SHAPE }, { status: 400 })
  return orgControlResponse(async () => {
    const refusal = await missing(parsed)
    if (refusal !== null) return refusal
    await prisma.personSkill.upsert({
      where: { personId_skillId: { personId: parsed.personId, skillId: parsed.skillId } },
      update: { mode: 'granted' },
      create: { personId: parsed.personId, skillId: parsed.skillId, mode: 'granted' },
    })
    return { ok: true as const, value: undefined }
  })
}

export async function DELETE(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const parsed = await pair(request)
  if (parsed === null) return Response.json({ error: SHAPE }, { status: 400 })
  return orgControlResponse(async () => {
    const refusal = await missing(parsed)
    if (refusal !== null) return refusal
    await prisma.personSkill.deleteMany({ where: { personId: parsed.personId, skillId: parsed.skillId } })
    return { ok: true as const, value: undefined }
  })
}

/** The two existence checks both verbs make, in the order the refusals were worded in. */
async function missing(
  parsed: { readonly personId: string; readonly skillId: string },
): Promise<{ ok: false; error: { kind: 'skill_not_found'; skillId: string } | { kind: 'person_not_found'; personId: string } } | null> {
  const skill = await prisma.skill.findUnique({ where: { id: parsed.skillId }, select: { id: true } })
  if (skill === null) return { ok: false, error: { kind: 'skill_not_found', skillId: parsed.skillId } }
  const person = await prisma.person.findUnique({ where: { id: parsed.personId }, select: { id: true } })
  if (person === null) return { ok: false, error: { kind: 'person_not_found', personId: parsed.personId } }
  return null
}
