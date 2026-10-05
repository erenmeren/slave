import { prisma } from '@slave-of-ai/db/client'
import { LEAD_TEAM_NAME, effectiveSkills } from '@slave-of-ai/domain'

/** One specialist of the catalogue, as the Helpers screen and the roster picker show them. */
export interface HelperRow {
  readonly id: string
  readonly name: string
  /** The persona's role ("Backend Architect"); null for a person with no persona. */
  readonly role: string | null
  /** One line on when to use them: the persona's description, empty when it has none. */
  readonly description: string
  /** What they are good at, as the catalogue groups it (the persona's source division). */
  readonly speciality: string | null
  /** Their effective skills' names, sorted. */
  readonly skills: readonly string[]
  /** The projects whose lead may call them (the projects with them on the roster). */
  readonly projects: readonly { readonly id: string; readonly name: string }[]
}

/**
 * Lead UX design section 6.5: the catalogue of specialists a lead may call on -- every person not
 * released, with their persona's role and line, their skills, and the projects that list them.
 * The lead flow's own system persons (a seat in a `Lead flow` team) are not specialists and are
 * left out. A read: nothing here writes.
 */
export async function listHelpers(): Promise<readonly HelperRow[]> {
  const [persons, workspaces] = await Promise.all([
    prisma.person.findMany({
      where: { releasedAt: null, seats: { none: { team: { name: LEAD_TEAM_NAME } } } },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        templateId: true,
        template: { select: { role: true, description: true, sourceDivision: true } },
        skills: { select: { skillId: true, mode: true } },
      },
    }),
    prisma.workspace.findMany({ where: { archivedAt: null, NOT: { leadRoster: { isEmpty: true } } }, select: { id: true, name: true, leadRoster: true } }),
  ])
  const templateIds = [...new Set(persons.flatMap((person) => (person.templateId === null ? [] : [person.templateId])))]
  const templateSkills = await prisma.templateSkill.findMany({ where: { templateId: { in: templateIds } }, select: { templateId: true, skillId: true } })
  const skillIds = new Set([...templateSkills.map((row) => row.skillId), ...persons.flatMap((person) => person.skills.map((row) => row.skillId))])
  const skillNames = new Map((await prisma.skill.findMany({ where: { id: { in: [...skillIds] }, missingSince: null }, select: { id: true, name: true } })).map((skill) => [skill.id, skill.name] as const))

  return persons.map((person) => {
    const skills = effectiveSkills({
      templateSkillIds: templateSkills.filter((row) => row.templateId === person.templateId).map((row) => row.skillId),
      granted: person.skills.filter((row) => row.mode === 'granted').map((row) => row.skillId),
      revoked: person.skills.filter((row) => row.mode === 'revoked').map((row) => row.skillId),
    })
    return {
      id: person.id,
      name: person.name,
      role: person.template?.role ?? null,
      description: (person.template?.description ?? '').trim(),
      speciality: person.template?.sourceDivision ?? null,
      skills: skills.flatMap(({ skillId }) => {
        const name = skillNames.get(skillId)
        return name === undefined ? [] : [name]
      }).sort((a, b) => a.localeCompare(b)),
      projects: workspaces.filter((workspace) => workspace.leadRoster.includes(person.id)).map((workspace) => ({ id: workspace.id, name: workspace.name })),
    }
  })
}
