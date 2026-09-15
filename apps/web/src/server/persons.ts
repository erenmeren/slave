import { prisma } from '@slave-of-ai/db/client'
import type { ProviderKind } from '@slave-of-ai/control'
import {
  USER_PERSON_LABEL,
  effectiveModelFor,
  effectiveProfileFor,
  effectiveProviderFor,
  effectiveSkills,
  userPersonStatus,
  type OverrideOrigin,
  type SlaveLifecycle,
  type UserPersonState,
} from '@slave-of-ai/domain'

/** One project seat, as every People surface sees it. Dates are ISO STRINGS, never `Date`: this
 *  crosses the server/client boundary and rides in a poll payload. */
export interface PersonSeatRow {
  readonly slaveId: string
  readonly teamId: string
  readonly teamName: string
  readonly workspaceId: string
  readonly projectName: string
  readonly role: string
  readonly runtimeRoles: readonly string[]
  readonly closedAt: string | null
}

/** A skill on the person panel (R23). `revoked` is the third STATE, not a third origin: the skill is
 *  inherited and this person does not have it, which is what a struck-through row means. */
export interface PersonSkillRow {
  readonly skillId: string
  readonly name: string
  readonly providerName: string
  readonly state: 'persona' | 'person' | 'revoked'
}

export interface PersonRow {
  readonly personId: string
  readonly name: string
  readonly personaId: string | null
  readonly personaName: string | null
  /** DERIVED (R6). The raw state goes on `data-person-state`, the label is what a person reads. */
  readonly state: UserPersonState
  readonly stateLabel: string
  readonly departments: readonly { readonly companyTeamId: string; readonly name: string }[]
  /** OPEN seats only -- "where they work". A closed seat is history and belongs to the panel. */
  readonly seats: readonly PersonSeatRow[]
  readonly skillCount: number
  readonly capabilities: readonly string[]
  readonly lifecycle: SlaveLifecycle
  readonly releasedAt: string | null
  readonly releaseReason: string | null
}

export interface PersonDetail extends PersonRow {
  readonly profile: { readonly text: string; readonly origin: OverrideOrigin } | null
  readonly model: { readonly value: string; readonly origin: OverrideOrigin } | null
  readonly provider: { readonly value: ProviderKind; readonly origin: OverrideOrigin } | null
  readonly skills: readonly PersonSkillRow[]
  readonly selectionRationale: string | null
  readonly runs: number
  /** Every seat, closed ones included -- the Projects group shows what was, greyed. */
  readonly allSeats: readonly PersonSeatRow[]
}

const seatInclude = {
  team: { include: { workspace: { select: { id: true, name: true } } } },
} as const

function seatRowOf(seat: {
  id: string
  teamId: string
  role: string
  runtimeRoles: string[]
  closedAt: Date | null
  team: { name: string; workspace: { id: string; name: string } }
}): PersonSeatRow {
  return {
    slaveId: seat.id,
    teamId: seat.teamId,
    teamName: seat.team.name,
    workspaceId: seat.team.workspace.id,
    projectName: seat.team.workspace.name,
    role: seat.role,
    runtimeRoles: seat.runtimeRoles,
    closedAt: seat.closedAt?.toISOString() ?? null,
  }
}

/**
 * Everybody who works here, one row each (R22).
 *
 * FOUR queries for the whole page, never one per person: the people with their seats and
 * departments, the persona default skills for every persona anybody was hired from, and nothing
 * else -- `skillCount` is `effectiveSkills().length`, computed here off two lists rather than asked
 * of the database per row.
 */
export async function listPersons(): Promise<readonly PersonRow[]> {
  const people = await prisma.person.findMany({
    orderBy: { name: 'asc' },
    include: {
      template: { select: { id: true, name: true } },
      departments: { include: { companyTeam: { select: { id: true, name: true } } } },
      skills: { select: { skillId: true, mode: true } },
      seats: { where: { closedAt: null }, include: seatInclude },
    },
  })
  const templateIds = [...new Set(people.flatMap((person) => (person.templateId === null ? [] : [person.templateId])))]
  const templateSkills =
    templateIds.length === 0
      ? []
      : await prisma.templateSkill.findMany({ where: { templateId: { in: templateIds } } })
  const defaultsByTemplate = new Map<string, string[]>()
  for (const row of templateSkills) {
    const list = defaultsByTemplate.get(row.templateId)
    if (list === undefined) defaultsByTemplate.set(row.templateId, [row.skillId])
    else list.push(row.skillId)
  }

  return people.map((person) => {
    const status = userPersonStatus({
      releasedAt: person.releasedAt?.toISOString() ?? null,
      openSeats: person.seats.length,
    })
    const effective = effectiveSkills({
      templateSkillIds: person.templateId === null ? [] : (defaultsByTemplate.get(person.templateId) ?? []),
      granted: person.skills.filter((row) => row.mode === 'granted').map((row) => row.skillId),
      revoked: person.skills.filter((row) => row.mode === 'revoked').map((row) => row.skillId),
    })
    return {
      personId: person.id,
      name: person.name,
      personaId: person.template?.id ?? null,
      personaName: person.template?.name ?? null,
      state: status.state,
      stateLabel: USER_PERSON_LABEL[status.state],
      departments: person.departments.map((row) => ({ companyTeamId: row.companyTeam.id, name: row.companyTeam.name })),
      seats: person.seats.map(seatRowOf),
      skillCount: effective.length,
      capabilities: person.capabilities,
      lifecycle: person.lifecycle,
      releasedAt: person.releasedAt?.toISOString() ?? null,
      releaseReason: person.releaseReason,
    }
  })
}

/**
 * One person, everything the panel shows (R23).
 *
 * The three override chains are walked HERE, server-side, by the same functions `buildRunContext`
 * walks at dispatch -- so what the panel says a run will be told and what it is actually told cannot
 * drift. The SEAT rung is deliberately absent from this view's chain: this is the PERSON's panel and
 * there is no one seat to read; a seat's own override shows on its row in the Projects group.
 */
export async function readPerson(personId: string): Promise<PersonDetail | null> {
  const person = await prisma.person.findUnique({
    where: { id: personId },
    include: {
      template: { select: { id: true, name: true, profile: true, defaultModel: true, provider: true } },
      departments: { include: { companyTeam: { select: { id: true, name: true } } } },
      skills: { include: { skill: { include: { provider: { select: { name: true } } } } } },
      seats: { include: seatInclude, orderBy: [{ closedAt: 'asc' }, { id: 'asc' }] },
    },
  })
  if (person === null) return null

  const templateSkills =
    person.templateId === null
      ? []
      : await prisma.templateSkill.findMany({
          where: { templateId: person.templateId },
          include: { skill: { include: { provider: { select: { name: true } } } } },
        })
  const runs = await prisma.slaveRun.count({ where: { slave: { personId } } })

  const granted = person.skills.filter((row) => row.mode === 'granted').map((row) => row.skillId)
  const revoked = person.skills.filter((row) => row.mode === 'revoked').map((row) => row.skillId)
  const skillById = new Map(
    [...templateSkills.map((row) => row.skill), ...person.skills.map((row) => row.skill)].map(
      (skill) => [skill.id, skill] as const,
    ),
  )
  const effective = effectiveSkills({
    templateSkillIds: templateSkills.map((row) => row.skillId),
    granted,
    revoked,
  })
  // The revoked INHERITED rows ride along, struck through -- a person has to see what the persona
  // gives before they can put it back (R23).
  const revokedInherited = templateSkills
    .filter((row) => revoked.includes(row.skillId))
    .map((row) => ({
      skillId: row.skillId,
      name: row.skill.name,
      providerName: row.skill.provider.name,
      state: 'revoked' as const,
    }))
  const skills: readonly PersonSkillRow[] = [
    ...effective.flatMap((row) => {
      const skill = skillById.get(row.skillId)
      return skill === undefined
        ? []
        : [{ skillId: row.skillId, name: skill.name, providerName: skill.provider.name, state: row.origin }]
    }),
    ...revokedInherited,
  ].toSorted((a, b) => a.name.localeCompare(b.name))

  const openSeats = person.seats.filter((seat) => seat.closedAt === null)
  const status = userPersonStatus({
    releasedAt: person.releasedAt?.toISOString() ?? null,
    openSeats: openSeats.length,
  })

  return {
    personId: person.id,
    name: person.name,
    personaId: person.template?.id ?? null,
    personaName: person.template?.name ?? null,
    state: status.state,
    stateLabel: USER_PERSON_LABEL[status.state],
    departments: person.departments.map((row) => ({ companyTeamId: row.companyTeam.id, name: row.companyTeam.name })),
    seats: openSeats.map(seatRowOf),
    allSeats: person.seats.map(seatRowOf),
    skillCount: effective.length,
    capabilities: person.capabilities,
    lifecycle: person.lifecycle,
    releasedAt: person.releasedAt?.toISOString() ?? null,
    releaseReason: person.releaseReason,
    profile: effectiveProfileFor({ seat: null, person: person.profile, template: person.template?.profile ?? null }),
    model: effectiveModelFor({ seat: null, person: person.model, template: person.template?.defaultModel ?? null }),
    provider: effectiveProviderFor<ProviderKind>({
      seat: null,
      person: person.provider,
      template: person.template?.provider ?? null,
    }),
    skills,
    selectionRationale: person.selectionRationale,
    runs,
  }
}

/** Who this project could seat: everybody who is not released and holds no OPEN seat here (R27).
 *  Somebody already on another project IS a candidate -- that is the whole milestone. */
export async function listPoolCandidates(
  workspaceId: string,
): Promise<readonly { readonly personId: string; readonly name: string }[]> {
  const rows = await prisma.person.findMany({
    where: { releasedAt: null, seats: { none: { closedAt: null, team: { workspaceId } } } },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  })
  return rows.map((row) => ({ personId: row.id, name: row.name }))
}

/** Every skill there is, for the two editors that add one (R23, R25). */
export async function listSkillCatalogue(): Promise<
  readonly { readonly skillId: string; readonly name: string; readonly providerName: string }[]
> {
  const rows = await prisma.skill.findMany({
    orderBy: [{ provider: { name: 'asc' } }, { name: 'asc' }],
    include: { provider: { select: { name: true } } },
  })
  return rows.map((row) => ({ skillId: row.id, name: row.name, providerName: row.provider.name }))
}
