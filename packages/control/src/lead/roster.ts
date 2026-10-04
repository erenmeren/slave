import { prisma } from '@slave-of-ai/db/client'
import { effectiveProfileFor, effectiveSkills, type RosterMember } from '@slave-of-ai/domain'
import { readSkillBody, skillRoots, skillSourceDir, type SkillRoots } from '../skills.js'

/**
 * Lead-flow spec B2 (plan A L16): the roster's persons as `buildRosterDefinitions` takes them, in
 * the roster's own order. One line on when to use them (the persona's description, else its role),
 * and their instructions: the person's effective profile followed by each of their skills' body
 * (the persona's defaults plus their grants, minus their revokes; a skill whose files are missing
 * is left out). A released or unknown person is skipped.
 */
export async function loadLeadRoster(personIds: readonly string[], roots: SkillRoots = skillRoots()): Promise<readonly RosterMember[]> {
  if (personIds.length === 0) return []
  const persons = await prisma.person.findMany({
    where: { id: { in: [...personIds] }, releasedAt: null },
    include: {
      template: { select: { profile: true, description: true, role: true } },
      skills: { include: { skill: { include: { provider: true } } } },
    },
  })
  const members: RosterMember[] = []
  for (const id of personIds) {
    const person = persons.find((one) => one.id === id)
    if (person === undefined) continue
    const templateSkills =
      person.templateId === null
        ? []
        : await prisma.templateSkill.findMany({ where: { templateId: person.templateId }, include: { skill: { include: { provider: true } } } })
    const rowById = new Map([...templateSkills.map((row) => row.skill), ...person.skills.map((row) => row.skill)].map((skill) => [skill.id, skill] as const))
    const skills = effectiveSkills({
      templateSkillIds: templateSkills.map((row) => row.skillId),
      granted: person.skills.filter((row) => row.mode === 'granted').map((row) => row.skillId),
      revoked: person.skills.filter((row) => row.mode === 'revoked').map((row) => row.skillId),
    }).flatMap(({ skillId }) => {
      const skill = rowById.get(skillId)
      return skill === undefined || skill.missingSince !== null ? [] : [skill]
    })
    const profile = effectiveProfileFor({ seat: null, person: person.profile, template: person.template?.profile ?? null })
    const skillTexts = skills.map((skill) => {
      const dir = skillSourceDir(roots, skill.provider.name, skill.name)
      const body = dir === null ? null : readSkillBody(dir)
      return `## Skill: ${skill.name}\n${body ?? skill.description}`
    })
    const oneLine = (person.template?.description ?? '').trim()
    members.push({
      personId: person.id,
      name: person.name,
      description: oneLine !== '' ? oneLine : (person.template?.role ?? 'a specialist of this organisation'),
      instructions: [profile?.text ?? `You are ${person.name}.`, ...skillTexts].join('\n\n'),
    })
  }
  return members
}
