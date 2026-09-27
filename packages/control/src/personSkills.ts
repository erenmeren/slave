import { prisma } from '@slave-of-ai/db/client'
import { effectiveSkillIds, effectiveSkills, err, ok, type Result, type SkillOrigin } from '@slave-of-ai/domain'
import type { ControlRefusal } from './refusal.js'

/**
 * The refusal an ADD of these skill ids earns, or null (workforce cards): an id no `Skill` row
 * carries is `skill_not_found`, a row a scan could not find on disk is `skill_missing`. Only ADDS
 * are asked -- removing, revoking or clearing a missing skill is how an operator tidies up after an
 * uninstalled plugin, and refusing that would strand the link.
 */
async function refuseUnlinkable(skillIds: readonly string[]): Promise<ControlRefusal | null> {
  if (skillIds.length === 0) return null
  const found = await prisma.skill.findMany({
    where: { id: { in: [...skillIds] } },
    select: { id: true, name: true, missingSince: true },
  })
  const unknown = skillIds.find((id) => !found.some((skill) => skill.id === id))
  if (unknown !== undefined) return { kind: 'skill_not_found', skillId: unknown }
  const missing = found.find((skill) => skill.missingSince !== null)
  return missing === undefined ? null : { kind: 'skill_missing', skillId: missing.id, name: missing.name }
}

/**
 * The persona's DEFAULT skills (R3, D4).
 *
 * A SET, not an add: the caller sends the whole list and this makes the table say exactly that.
 * Changing it changes every person hired from the persona AT ONCE, because nothing copies -- the
 * effective set is computed on read by `effectiveSkills` and stored nowhere.
 *
 * Every skill id is validated BEFORE the first write, so the refusal is a returned value and the
 * transaction below never has to roll one back.
 */
export async function setTemplateSkills(
  templateId: string,
  skillIds: readonly string[],
): Promise<Result<{ readonly skills: readonly string[] }, ControlRefusal>> {
  const template = await prisma.slaveTemplate.findUnique({ where: { id: templateId }, select: { id: true } })
  if (template === null) return err({ kind: 'template_not_found', templateId })
  const wanted = [...new Set(skillIds)]
  const found = await prisma.skill.findMany({ where: { id: { in: wanted } }, select: { id: true } })
  const missing = wanted.find((id) => !found.some((skill) => skill.id === id))
  if (missing !== undefined) return err({ kind: 'skill_not_found', skillId: missing })
  // Workforce cards: only a NEWLY linked skill must be on disk -- re-sending a set that still holds
  // a link whose plugin was since uninstalled is not an add, and refusing it would make the whole
  // list uneditable until the plugin came back.
  const current = await prisma.templateSkill.findMany({ where: { templateId }, select: { skillId: true } })
  const refused = await refuseUnlinkable(wanted.filter((id) => !current.some((row) => row.skillId === id)))
  if (refused !== null) return err(refused)

  await prisma.$transaction(async (tx) => {
    await tx.templateSkill.deleteMany({ where: { templateId, skillId: { notIn: wanted.length === 0 ? [''] : wanted } } })
    for (const skillId of wanted) {
      await tx.templateSkill.upsert({
        where: { templateId_skillId: { templateId, skillId } },
        update: {},
        create: { templateId, skillId },
      })
    }
  })
  return ok({ skills: wanted.toSorted() })
}

/**
 * The persona's default skills, changed by a DELTA (workforce cards §3): add these, remove those,
 * leave every other link exactly as it is.
 *
 * `setTemplateSkills` takes the WHOLE list, which is right for the drawer's editor and wrong for a
 * card: two cards adding two different skills to one persona at the same moment would each send
 * "the set I saw plus mine", and the second write would silently drop the first one's skill. A
 * delta cannot lose a link it does not name. `createMany({ skipDuplicates })` makes an add of a
 * skill that is already there a no-op rather than a unique-constraint failure, which is also what
 * lets two concurrent adds of the SAME skill both succeed.
 *
 * Validated before the transaction (`refuseUnlinkable`), so a refusal is a returned value and never
 * a write that has to be rolled back.
 */
export async function changeTemplateSkills(
  templateId: string,
  change: { readonly add?: readonly string[]; readonly remove?: readonly string[] },
): Promise<Result<{ readonly skills: readonly string[] }, ControlRefusal>> {
  const add = [...new Set(change.add ?? [])]
  const remove = [...new Set(change.remove ?? [])]
  if (add.some((id) => remove.includes(id))) return err({ kind: 'invalid_request' })
  const template = await prisma.slaveTemplate.findUnique({ where: { id: templateId }, select: { id: true } })
  if (template === null) return err({ kind: 'template_not_found', templateId })
  const refused = await refuseUnlinkable(add)
  if (refused !== null) return err(refused)

  await prisma.$transaction(async (tx) => {
    if (remove.length > 0) await tx.templateSkill.deleteMany({ where: { templateId, skillId: { in: remove } } })
    if (add.length > 0) {
      await tx.templateSkill.createMany({ data: add.map((skillId) => ({ templateId, skillId })), skipDuplicates: true })
    }
  })
  const rows = await prisma.templateSkill.findMany({ where: { templateId }, select: { skillId: true } })
  return ok({ skills: rows.map((row) => row.skillId).toSorted() })
}

/**
 * One person's adjustment to their persona's defaults (R3).
 *
 * Three lists, and they are three different acts: `grant` says "also this", `revoke` says "not
 * this, whatever the persona says", `clear` says "I take back whatever I said about this" -- which
 * is the only way an inherited skill comes back, and is why it is not spelled as granting.
 *
 * Granting and revoking the same skill in one call is refused rather than resolved: `PersonSkill`
 * holds ONE mode per pair, so the write would have to pick, and picking silently is how a person
 * ends up with a skill they asked to remove.
 */
export async function setPersonSkills(
  personId: string,
  change: { readonly grant?: readonly string[]; readonly revoke?: readonly string[]; readonly clear?: readonly string[] },
): Promise<Result<{ readonly effective: readonly string[] }, ControlRefusal>> {
  const grant = [...new Set(change.grant ?? [])]
  const revoke = [...new Set(change.revoke ?? [])]
  const clear = [...new Set(change.clear ?? [])]
  const contested = grant.find((id) => revoke.includes(id))
  if (contested !== undefined) return err({ kind: 'invalid_request' })

  const person = await prisma.person.findUnique({ where: { id: personId }, select: { id: true, templateId: true } })
  if (person === null) return err({ kind: 'person_not_found', personId })

  const touched = [...new Set([...grant, ...revoke, ...clear])]
  const found = await prisma.skill.findMany({ where: { id: { in: touched } }, select: { id: true } })
  const missing = touched.find((id) => !found.some((skill) => skill.id === id))
  if (missing !== undefined) return err({ kind: 'skill_not_found', skillId: missing })
  const refused = await refuseUnlinkable(grant)
  if (refused !== null) return err(refused)

  await prisma.$transaction(async (tx) => {
    if (clear.length > 0) await tx.personSkill.deleteMany({ where: { personId, skillId: { in: clear } } })
    for (const skillId of grant) {
      await tx.personSkill.upsert({
        where: { personId_skillId: { personId, skillId } },
        update: { mode: 'granted' },
        create: { personId, skillId, mode: 'granted' },
      })
    }
    for (const skillId of revoke) {
      await tx.personSkill.upsert({
        where: { personId_skillId: { personId, skillId } },
        update: { mode: 'revoked' },
        create: { personId, skillId, mode: 'revoked' },
      })
    }
  })

  const rows = await readSkillRows(personId, person.templateId)
  return ok({ effective: effectiveSkillIds(rows.input) })
}

/** The two reads every effective-set answer needs, in one place so the verb and the view cannot ask
 *  the question differently. */
async function readSkillRows(personId: string, templateId: string | null) {
  const [personRows, templateRows] = await Promise.all([
    prisma.personSkill.findMany({ where: { personId }, include: { skill: { include: { provider: true } } } }),
    templateId === null
      ? Promise.resolve([])
      : prisma.templateSkill.findMany({
          where: { templateId },
          include: { skill: { include: { provider: true } } },
        }),
  ])
  return {
    input: {
      templateSkillIds: templateRows.map((row) => row.skillId),
      granted: personRows.filter((row) => row.mode === 'granted').map((row) => row.skillId),
      revoked: personRows.filter((row) => row.mode === 'revoked').map((row) => row.skillId),
    },
    byId: new Map(
      [...templateRows.map((row) => row.skill), ...personRows.map((row) => row.skill)].map(
        (skill) => [skill.id, skill] as const,
      ),
    ),
  }
}

/** What this person can actually do, with the names a surface renders and the origin a panel needs
 *  to say "from persona" (R3, R23). */
export async function personEffectiveSkills(
  personId: string,
): Promise<
  Result<
    readonly {
      readonly skillId: string
      readonly name: string
      readonly providerName: string
      readonly origin: SkillOrigin
    }[],
    ControlRefusal
  >
> {
  const person = await prisma.person.findUnique({ where: { id: personId }, select: { id: true, templateId: true } })
  if (person === null) return err({ kind: 'person_not_found', personId })
  const rows = await readSkillRows(personId, person.templateId)
  return ok(
    effectiveSkills(rows.input).flatMap((row) => {
      const skill = rows.byId.get(row.skillId)
      return skill === undefined
        ? []
        : [{ skillId: row.skillId, name: skill.name, providerName: skill.provider.name, origin: row.origin }]
    }),
  )
}
