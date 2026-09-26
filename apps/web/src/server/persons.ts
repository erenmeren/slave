import { type Prisma, prisma } from '@slave-of-ai/db/client'
import {
  capabilityKeysInDomain,
  escapeLikeWildcards,
  listCapabilities,
  type CapabilityDomainFacet,
  type ProviderKind,
} from '@slave-of-ai/control'
import {
  NO_WORKFLOW_PREVIEW,
  USER_PERSON_LABEL,
  effectiveModelFor,
  effectiveProfileFor,
  effectiveProviderFor,
  effectiveSkills,
  normalisePersona,
  storedWorkflowPreview,
  userPersonStatus,
  type CapabilityRecord,
  type OverrideOrigin,
  type SlaveLifecycle,
  type UserPersonState,
  type WorkflowPreview,
} from '@slave-of-ai/domain'
import type { PeopleFilters } from '../lib/peopleFilters'
import { CARD_SKILL_SELECT, personCardSkills, type CardSkillRow, type CardSkillSource } from '../lib/cardSkills'

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

/** The fields every People row carries, off one person read -- ONE place, so the unpaged list the
 *  company pickers use and the card page cannot disagree about a person's state or seats. */
function personRowOf(
  person: {
    readonly id: string
    readonly name: string
    readonly capabilities: readonly string[]
    readonly lifecycle: SlaveLifecycle
    readonly releasedAt: Date | null
    readonly releaseReason: string | null
    readonly template: { readonly id: string; readonly name: string } | null
    readonly departments: readonly { readonly companyTeam: { readonly id: string; readonly name: string } }[]
    readonly seats: readonly Parameters<typeof seatRowOf>[0][]
  },
  skillCount: number,
): PersonRow {
  const status = userPersonStatus({
    releasedAt: person.releasedAt?.toISOString() ?? null,
    openSeats: person.seats.length,
  })
  return {
    personId: person.id,
    name: person.name,
    personaId: person.template?.id ?? null,
    personaName: person.template?.name ?? null,
    state: status.state,
    stateLabel: USER_PERSON_LABEL[status.state],
    departments: person.departments.map((row) => ({ companyTeamId: row.companyTeam.id, name: row.companyTeam.name })),
    seats: person.seats.map((seat) => seatRowOf(seat)),
    skillCount,
    capabilities: person.capabilities,
    lifecycle: person.lifecycle,
    releasedAt: person.releasedAt?.toISOString() ?? null,
    releaseReason: person.releaseReason,
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

  return people.map((person) =>
    personRowOf(
      person,
      effectiveSkills({
        templateSkillIds: person.templateId === null ? [] : (defaultsByTemplate.get(person.templateId) ?? []),
        granted: person.skills.filter((row) => row.mode === 'granted').map((row) => row.skillId),
        revoked: person.skills.filter((row) => row.mode === 'revoked').map((row) => row.skillId),
      }).length,
    ),
  )
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

/** One skill the picker offers (workforce cards §3) -- and what the two drawers' editors read. */
export interface SkillCatalogueRow {
  readonly skillId: string
  readonly name: string
  readonly providerName: string
  readonly description: string
  /** `Skill.missingSince` is set -- shown greyed, and an add of it is refused (`skill_missing`). */
  readonly missing: boolean
}

/** Every skill there is, for the editors and the picker that add one (R23, R25, workforce cards). */
export async function listSkillCatalogue(): Promise<readonly SkillCatalogueRow[]> {
  const rows = await prisma.skill.findMany({
    orderBy: [{ provider: { name: 'asc' } }, { name: 'asc' }],
    include: { provider: { select: { name: true } } },
  })
  return rows.map((row) => ({
    skillId: row.id,
    name: row.name,
    providerName: row.provider.name,
    description: row.description,
    missing: row.missingSince !== null,
  }))
}

/** One person as a workforce CARD draws them (spec §2): the People row, plus the persona's import
 *  division, the chips and the persona's workflow preview. */
export interface PersonCardRow extends PersonRow {
  readonly division: string | null
  readonly skills: readonly CardSkillRow[]
  /** The workflow of the persona this person was hired from, overrides applied. A person-level
   *  profile override is free Markdown with no structured workflow to read, so it is not consulted;
   *  a person made from nothing previews nothing. */
  readonly workflowPreview: WorkflowPreview
}

/** People's filter menus -- over EVERY person, before any filter ran (M46 R6's rule). */
export interface PeopleFacets {
  readonly domains: readonly CapabilityDomainFacet[]
  /** The import divisions of the personas anybody here was hired from. */
  readonly divisions: readonly string[]
}

export interface PeoplePageView {
  readonly rows: readonly PersonCardRow[]
  readonly facets: PeopleFacets
  /** Every person this filter matches, so the count can say `showing 100 of 312`. */
  readonly total: number
  /** Pass back as `?cursor=` for the next page; null when this page is the end. */
  readonly nextCursor: string | null
}

/** The Catalog's own page size (`CATALOG_PAGE_SIZE`): the pool keeps up to three people per
 *  persona, so a full import makes People several hundred long -- a page, not a list. */
export const PEOPLE_PAGE_SIZE = 100

/**
 * The ids of every person with NO effective skill: no grant, and no inherited skill they have not
 * revoked. Raw SQL because "every one of the persona's skills is revoked BY THIS PERSON" correlates
 * two relations on the person's own id, which a Prisma relation filter cannot say. Bounded by the
 * People table itself -- hundreds of ids, fed back as one `in`.
 */
async function peopleWithNoSkills(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM "Person" p
    WHERE NOT EXISTS (SELECT 1 FROM "PersonSkill" g WHERE g."personId" = p.id AND g.mode = 'granted')
      AND NOT EXISTS (
        SELECT 1 FROM "TemplateSkill" t
        WHERE t."templateId" = p."templateId"
          AND NOT EXISTS (
            SELECT 1 FROM "PersonSkill" r WHERE r."personId" = p.id AND r."skillId" = t."skillId" AND r.mode = 'revoked'
          )
      )
  `
  return rows.map((row) => row.id)
}

/**
 * Every filter as a Prisma clause -- the catalog's `catalogWhere` idiom, over `Person`.
 *
 * F14: `q`'s persona-default-skill branch matches a linked skill's NAME the same way the catalog's
 * own `q` matches one, but only when THIS PERSON has not revoked that particular skill -- the same
 * "effectively held" rule `effectiveSkills` and the `skillId` clause below already carry,
 * asked per matching skill id since a relation filter cannot correlate "this exact skill" across
 * `template.defaultSkills` and this person's own `skills` any other way. `q` also matches a
 * capability KEY or LABEL containing it (spec §1 lists capability among what People searches) --
 * `Person.capabilities` holds taxonomy keys, never free text, so unlike the catalog's `searchText`
 * this has no denormalised column to `contains` and resolves the matching keys from the taxonomy
 * the specialty clause already loaded.
 */
async function peopleWhere(filters: PeopleFilters, taxonomy: readonly CapabilityRecord[]): Promise<Prisma.PersonWhereInput> {
  const clauses: Prisma.PersonWhereInput[] = []
  const q = (filters.q ?? '').trim()
  if (q !== '') {
    const raw = escapeLikeWildcards(q)
    const folded = normalisePersona(q)
    const lower = q.toLowerCase()
    const matchingSkills = await prisma.skill.findMany({
      where: { name: { contains: raw, mode: 'insensitive' } },
      select: { id: true },
    })
    const matchingCapabilityKeys = taxonomy
      .filter((record) => record.key.toLowerCase().includes(lower) || record.label.toLowerCase().includes(lower))
      .map((record) => record.key)
    clauses.push({
      OR: [
        { name: { contains: raw, mode: 'insensitive' } },
        // The persona's own words -- summary, capabilities, expertise -- folded exactly as the
        // catalog folds its search, because `searchText` was folded that way.
        ...(folded === '' ? [] : [{ template: { searchText: { contains: escapeLikeWildcards(folded) } } }]),
        { skills: { some: { mode: 'granted', skill: { name: { contains: raw, mode: 'insensitive' } } } } },
        // F14: a persona default skill matching by name, EXCLUDING one this person revoked -- per
        // matching skill id, so the exclusion is checked against the SAME skill that matched.
        ...matchingSkills.map((skill) => ({
          AND: [
            { template: { defaultSkills: { some: { skillId: skill.id } } } },
            { skills: { none: { skillId: skill.id, mode: 'revoked' as const } } },
          ],
        })),
        // F14: a capability key or label containing q -- `frontend.styling`'s label is "Styling and
        // layout", so a search for "layout" finds a person who carries that key even though the key
        // itself never spells the word.
        ...(matchingCapabilityKeys.length === 0 ? [] : [{ capabilities: { hasSome: matchingCapabilityKeys } }]),
      ],
    })
  }
  if (filters.specialty !== undefined) {
    const keys = capabilityKeysInDomain(filters.specialty, taxonomy)
    // An unknown domain matches NOTHING, spelled out (the catalog's rule).
    clauses.push(keys.length === 0 ? { id: { in: [] } } : { capabilities: { hasSome: keys } })
  }
  if (filters.division !== undefined) clauses.push({ template: { sourceDivision: filters.division } })
  if (filters.department !== undefined) clauses.push({ departments: { some: { companyTeamId: filters.department } } })
  if (filters.skillId !== undefined) {
    // EFFECTIVELY held: granted, or inherited and not revoked -- `effectiveSkills` as a clause.
    clauses.push({
      OR: [
        { skills: { some: { skillId: filters.skillId, mode: 'granted' } } },
        {
          AND: [
            { template: { defaultSkills: { some: { skillId: filters.skillId } } } },
            { skills: { none: { skillId: filters.skillId, mode: 'revoked' } } },
          ],
        },
      ],
    })
  }
  // `userPersonStatus`, as three clauses: released wins, then any open seat, then the pool.
  if (filters.state === 'released') clauses.push({ releasedAt: { not: null } })
  if (filters.state === 'assigned') clauses.push({ releasedAt: null, seats: { some: { closedAt: null } } })
  if (filters.state === 'pool') clauses.push({ releasedAt: null, seats: { none: { closedAt: null } } })
  if (filters.noSkills === true) clauses.push({ id: { in: await peopleWithNoSkills() } })
  return clauses.length === 0 ? {} : { AND: clauses }
}

/** People's own domain and division facets -- the "same rule as readCatalogFacets" comment below is
 *  the whole reason this is not just a call to it: `readCatalogFacets` counts `SlaveTemplate` rows
 *  by their `capabilityKeys` column, and People has no such column -- `Person.capabilities` is the
 *  one to count, over a different table entirely. */
async function readPeopleFacets(): Promise<PeopleFacets> {
  const [domainRows, divisionRows] = await Promise.all([
    // Same rule as readCatalogFacets: one row per domain, a person counted ONCE however many keys
    // they carry in it; joined to the taxonomy so a chip's count is exactly what clicking it
    // returns.
    prisma.$queryRaw<{ domain: string; count: number }[]>`
      SELECT c.domain AS domain, count(DISTINCT p.id)::int AS count
      FROM "Person" p
      CROSS JOIN LATERAL unnest(p.capabilities) AS k(key)
      JOIN "Capability" c ON c.key = k.key
      GROUP BY c.domain
      ORDER BY count DESC, domain ASC
    `,
    prisma.slaveTemplate.findMany({
      where: { sourceDivision: { not: null }, hiredPersons: { some: {} } },
      select: { sourceDivision: true },
      distinct: ['sourceDivision'],
      orderBy: { sourceDivision: 'asc' },
    }),
  ])
  return {
    domains: domainRows.map((row) => ({ domain: row.domain, count: row.count })),
    divisions: divisionRows.flatMap((row) => (row.sourceDivision === null ? [] : [row.sourceDivision])),
  }
}

/**
 * People as CARDS (workforce cards §1/§5), filtered, faceted and PAGED in the database the way the
 * catalog is -- client-side filtering over several hundred pool people plus facets was the wrong
 * place for it.
 *
 * Five queries for a page, never one per person: the taxonomy (the specialty clause needs it), the
 * page, its count, the facets, and every persona default skill of every persona on the page.
 */
export async function listPeoplePage(
  filters: PeopleFilters = {},
  options: { readonly cursor?: string } = {},
): Promise<PeoplePageView> {
  const where = await peopleWhere(filters, await listCapabilities())
  const [people, total, facets] = await Promise.all([
    prisma.person.findMany({
      where,
      // `name` is unique, `id` makes the order total by construction -- the catalog's cursor rule.
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: PEOPLE_PAGE_SIZE,
      ...(options.cursor === undefined ? {} : { cursor: { id: options.cursor }, skip: 1 }),
      include: {
        template: { select: { id: true, name: true, sourceDivision: true, profileSpec: true, profileOverrides: true } },
        departments: { include: { companyTeam: { select: { id: true, name: true } } } },
        skills: { select: { mode: true, skill: { select: CARD_SKILL_SELECT } } },
        seats: { where: { closedAt: null }, include: seatInclude },
      },
    }),
    prisma.person.count({ where }),
    readPeopleFacets(),
  ])
  const templateIds = [...new Set(people.flatMap((person) => (person.templateId === null ? [] : [person.templateId])))]
  const templateSkills =
    templateIds.length === 0
      ? []
      : await prisma.templateSkill.findMany({
          where: { templateId: { in: templateIds } },
          select: { templateId: true, skill: { select: CARD_SKILL_SELECT } },
        })
  const defaultsByTemplate = new Map<string, CardSkillSource[]>()
  for (const row of templateSkills) {
    const list = defaultsByTemplate.get(row.templateId)
    if (list === undefined) defaultsByTemplate.set(row.templateId, [row.skill])
    else list.push(row.skill)
  }

  const rows = people.map((person): PersonCardRow => {
    const skills = personCardSkills({
      templateSkills: person.templateId === null ? [] : (defaultsByTemplate.get(person.templateId) ?? []),
      personSkills: person.skills.map((row) => ({ ...row.skill, mode: row.mode })),
    })
    return {
      ...personRowOf(person, skills.filter((skill) => skill.state !== 'revoked').length),
      division: person.template?.sourceDivision ?? null,
      skills,
      workflowPreview:
        person.template === null
          ? NO_WORKFLOW_PREVIEW
          : storedWorkflowPreview(person.template.profileSpec, person.template.profileOverrides),
    }
  })
  return {
    rows,
    facets,
    total,
    // A short page is the end (the catalog's rule); a full one hands back a cursor even when
    // nothing follows, which costs one empty request and never a missing row.
    nextCursor: people.length < PEOPLE_PAGE_SIZE ? null : (people.at(-1)?.id ?? null),
  }
}
