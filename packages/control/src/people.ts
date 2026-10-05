import { prisma } from '@slave-of-ai/db/client'
import { LEAD_ROSTER_MAX, LEAD_TEAM_NAME, NON_TERMINAL_RUN_STATUSES, effectiveSkills, err, ok, type Result } from '@slave-of-ai/domain'
import { readTemplateProfile, type TemplateProfileView } from './catalog.js'
import { setLeadSettings } from './lead/flow.js'
import { deletePerson, personFootprint } from './persons.js'
import type { Principal } from './principal.js'
import type { ControlRefusal } from './refusal.js'

/** How many cards one page of People or Personas carries unless the caller asks otherwise. */
export const PEOPLE_PAGE_SIZE = 48
/** The most one request may ask for: a list of hundreds is read a page at a time. */
export const PEOPLE_PAGE_MAX = 200

export interface PageRequest {
  readonly offset?: number
  readonly limit?: number
}

/** A division of the catalogue with how many rows carry it; `key` null is "no division". */
export interface DivisionFacet {
  readonly key: string | null
  readonly count: number
}

export interface PeopleFilters {
  /** Every word must be in the name, the role, the persona's name or its one line. */
  readonly q?: string
  /** The persona's division; `none` asks for people whose persona has none (or who have no persona). */
  readonly division?: string
  /** Only people who effectively have this skill. */
  readonly skillId?: string
  /** Only people hired from this persona. */
  readonly templateId?: string
  /** Only people some project's roster lists. */
  readonly onRoster?: boolean
  /** Only people with no skill at all. */
  readonly noSkills?: boolean
}

/** One person as the People list draws them: enough for a card, nothing a card does not show. */
export interface PersonCard {
  readonly id: string
  readonly name: string
  /** The name of the persona they were made from ("Backend Architect"); null for a person made from nothing. */
  readonly personaName: string | null
  /** The persona's role, as the scheduler of an older project matches it; null with no persona. */
  readonly role: string | null
  readonly division: string | null
  /** The persona's one line; empty when it has none. */
  readonly description: string
  readonly templateId: string | null
  /** Effective skills that are still on disk: the persona's defaults plus grants, minus revokes. */
  readonly skillCount: number
  /** True when the person carries instructions of their own, which replace the persona's profile. */
  readonly ownInstructions: boolean
  /** The projects whose roster lists them. */
  readonly projects: readonly { readonly id: string; readonly name: string }[]
  /** A run of theirs is open right now, on any seat. */
  readonly working: boolean
}

export interface PeoplePage {
  readonly people: readonly PersonCard[]
  /** How many people match the filters, this page or not. */
  readonly total: number
  /** How many people there are with no filter at all. */
  readonly all: number
  readonly offset: number
  readonly limit: number
  readonly divisions: readonly DivisionFacet[]
}

/** The page bounds a request asked for, made safe: a whole offset of 0 or more, a limit of 1 to the cap. */
function bounds(page: PageRequest): { readonly offset: number; readonly limit: number } {
  const whole = (value: number | undefined, fallback: number): number => (value !== undefined && Number.isInteger(value) && value >= 0 ? value : fallback)
  return { offset: whole(page.offset, 0), limit: Math.min(Math.max(whole(page.limit, PEOPLE_PAGE_SIZE), 1), PEOPLE_PAGE_MAX) }
}

const wordsOf = (query: string | undefined): readonly string[] => (query ?? '').toLowerCase().split(/\s+/u).filter((word) => word !== '')

function facetsOf(divisions: readonly (string | null)[]): readonly DivisionFacet[] {
  const counts = new Map<string | null, number>()
  for (const division of divisions) counts.set(division, (counts.get(division) ?? 0) + 1)
  return [...counts]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => (a.key === null ? 1 : 0) - (b.key === null ? 1 : 0) || b.count - a.count || (a.key ?? '').localeCompare(b.key ?? ''))
}

const divisionMatches = (wanted: string | undefined, division: string | null): boolean => wanted === undefined || (wanted === 'none' ? division === null : division === wanted)

/**
 * Everybody the People area lists, with what each list needs to filter on. The catalogue is small
 * enough (hundreds of people, a few hundred persona skill links) that one light read of all of it
 * and a filter in memory is cheaper than a query per filter combination -- and the effective skill
 * set (persona defaults plus grants, minus revokes) is not something SQL can filter on directly.
 * Released people and the lead flow's own system seats are not catalogue people and are left out.
 */
async function loadPool(): Promise<{
  readonly persons: readonly {
    readonly id: string
    readonly name: string
    readonly templateId: string | null
    readonly templateName: string | null
    readonly role: string | null
    readonly division: string | null
    readonly description: string
    readonly skillIds: readonly string[]
    readonly ownInstructions: boolean
    readonly projects: readonly { readonly id: string; readonly name: string }[]
  }[]
}> {
  const where = { releasedAt: null, seats: { none: { team: { name: LEAD_TEAM_NAME } } } }
  const [persons, withProfile, templateSkills, liveSkills, workspaces] = await Promise.all([
    prisma.person.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        templateId: true,
        template: { select: { name: true, role: true, description: true, sourceDivision: true } },
        skills: { select: { skillId: true, mode: true } },
      },
    }),
    prisma.person.findMany({ where: { ...where, profile: { not: null } }, select: { id: true } }),
    prisma.templateSkill.findMany({ select: { templateId: true, skillId: true } }),
    prisma.skill.findMany({ where: { missingSince: null }, select: { id: true } }),
    prisma.workspace.findMany({ where: { archivedAt: null, NOT: { leadRoster: { isEmpty: true } } }, orderBy: { name: 'asc' }, select: { id: true, name: true, leadRoster: true } }),
  ])
  const own = new Set(withProfile.map((row) => row.id))
  const live = new Set(liveSkills.map((row) => row.id))
  const byTemplate = new Map<string, string[]>()
  for (const row of templateSkills) byTemplate.set(row.templateId, [...(byTemplate.get(row.templateId) ?? []), row.skillId])
  const listedBy = new Map<string, { readonly id: string; readonly name: string }[]>()
  for (const workspace of workspaces) {
    for (const personId of workspace.leadRoster) listedBy.set(personId, [...(listedBy.get(personId) ?? []), { id: workspace.id, name: workspace.name }])
  }
  return {
    persons: persons.map((person) => ({
      id: person.id,
      name: person.name,
      templateId: person.templateId,
      templateName: person.template?.name ?? null,
      role: person.template?.role ?? null,
      division: person.template?.sourceDivision ?? null,
      description: (person.template?.description ?? '').trim(),
      skillIds: effectiveSkills({
        templateSkillIds: person.templateId === null ? [] : (byTemplate.get(person.templateId) ?? []),
        granted: person.skills.filter((row) => row.mode === 'granted').map((row) => row.skillId),
        revoked: person.skills.filter((row) => row.mode === 'revoked').map((row) => row.skillId),
      })
        .map((row) => row.skillId)
        .filter((skillId) => live.has(skillId)),
      ownInstructions: own.has(person.id),
      projects: listedBy.get(person.id) ?? [],
    })),
  }
}

/** The ids, of these, with a run open right now on any seat. */
async function workingAmong(personIds: readonly string[]): Promise<ReadonlySet<string>> {
  if (personIds.length === 0) return new Set()
  const seats = await prisma.slave.findMany({
    where: { personId: { in: [...personIds] }, runs: { some: { status: { in: [...NON_TERMINAL_RUN_STATUSES] } } } },
    select: { personId: true },
  })
  return new Set(seats.map((seat) => seat.personId))
}

/**
 * The People list, a page at a time: everybody a lead may be given as a helper, searched and
 * filtered, sorted by name. `total` counts the matches, `all` everybody, and `divisions` every
 * division with its count over everybody -- so the filter chips do not change as a filter is
 * applied. A read: nothing here writes.
 */
export async function listPeople(filters: PeopleFilters = {}, page: PageRequest = {}): Promise<PeoplePage> {
  const { offset, limit } = bounds(page)
  const pool = await loadPool()
  const words = wordsOf(filters.q)
  const matching = pool.persons.filter((person) => {
    if (!divisionMatches(filters.division, person.division)) return false
    if (filters.templateId !== undefined && person.templateId !== filters.templateId) return false
    if (filters.skillId !== undefined && !person.skillIds.includes(filters.skillId)) return false
    if (filters.onRoster === true && person.projects.length === 0) return false
    if (filters.noSkills === true && person.skillIds.length > 0) return false
    if (words.length === 0) return true
    const haystack = [person.name, person.role ?? '', person.templateName ?? '', person.description].join(' ').toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
  const shown = matching.slice(offset, offset + limit)
  const working = await workingAmong(shown.map((person) => person.id))
  return {
    people: shown.map((person) => ({
      id: person.id,
      name: person.name,
      personaName: person.templateName,
      role: person.role,
      division: person.division,
      description: person.description,
      templateId: person.templateId,
      skillCount: person.skillIds.length,
      ownInstructions: person.ownInstructions,
      projects: person.projects,
      working: working.has(person.id),
    })),
    total: matching.length,
    all: pool.persons.length,
    offset,
    limit,
    divisions: facetsOf(pool.persons.map((person) => person.division)),
  }
}

/** One skill of a person, with where it comes from -- or that the person said no to it. */
export interface PersonSkillRow {
  readonly skillId: string
  readonly name: string
  readonly providerName: string
  readonly description: string
  /** `persona`: a default of their persona. `granted`: given to this person. `revoked`: taken from
   *  this person, whatever the persona says -- listed so it can be given back. */
  readonly state: 'persona' | 'granted' | 'revoked'
  /** A revoked skill that the persona would otherwise supply. */
  readonly fromPersona: boolean
  /** The skill's files are no longer on disk: it is listed and not handed to a session. */
  readonly missing: boolean
}

/** A lead-flow project a person may be put on the roster of. */
export interface RosterProject {
  readonly id: string
  readonly name: string
  readonly listed: boolean
  /** The roster is at its cap and does not list them: adding is refused. */
  readonly full: boolean
}

export interface PersonDetail {
  readonly id: string
  readonly name: string
  readonly role: string | null
  readonly division: string | null
  readonly description: string
  readonly model: string | null
  readonly provider: string | null
  readonly createdAt: string
  readonly working: boolean
  readonly persona: { readonly id: string; readonly name: string; readonly active: boolean } | null
  /** The persona's profile, both halves and the merge; null for a person with no persona. */
  readonly profile: TemplateProfileView | null
  /** The person's own instructions. When set they REPLACE the persona's profile for this person. */
  readonly ownInstructions: string | null
  readonly skills: readonly PersonSkillRow[]
  /** Every open lead-flow project, with whether its roster lists them. */
  readonly projects: readonly RosterProject[]
  /** What a delete would take: the projects they hold a seat on and the runs they made. */
  readonly footprint: { readonly projects: readonly string[]; readonly runs: number }
}

/** One person, whole: who they are, what they can do, where they are listed. Null when gone. */
export async function readPerson(personId: string): Promise<PersonDetail | null> {
  const person = await prisma.person.findUnique({
    where: { id: personId },
    include: {
      template: { select: { id: true, name: true, role: true, description: true, sourceDivision: true, active: true } },
      skills: { include: { skill: { include: { provider: true } } } },
    },
  })
  if (person === null) return null
  const [templateSkills, workspaces, working, footprint, profile] = await Promise.all([
    person.templateId === null ? Promise.resolve([]) : prisma.templateSkill.findMany({ where: { templateId: person.templateId }, include: { skill: { include: { provider: true } } } }),
    prisma.workspace.findMany({ where: { archivedAt: null, flow: 'lead' }, orderBy: { name: 'asc' }, select: { id: true, name: true, leadRoster: true } }),
    workingAmong([personId]),
    personFootprint(personId),
    person.templateId === null ? Promise.resolve(null) : readTemplateProfile(person.templateId),
  ])
  const persona = new Set(templateSkills.map((row) => row.skillId))
  const revoked = new Set(person.skills.filter((row) => row.mode === 'revoked').map((row) => row.skillId))
  const rows = new Map<string, PersonSkillRow>()
  const row = (skill: { id: string; name: string; description: string; missingSince: Date | null; provider: { name: string } }, state: PersonSkillRow['state']): PersonSkillRow => ({
    skillId: skill.id,
    name: skill.name,
    providerName: skill.provider.name,
    description: skill.description,
    state,
    fromPersona: persona.has(skill.id),
    missing: skill.missingSince !== null,
  })
  for (const link of templateSkills) rows.set(link.skillId, row(link.skill, revoked.has(link.skillId) ? 'revoked' : 'persona'))
  for (const link of person.skills) {
    if (link.mode === 'revoked') rows.set(link.skillId, row(link.skill, 'revoked'))
    else if (!rows.has(link.skillId)) rows.set(link.skillId, row(link.skill, 'granted'))
  }
  return {
    id: person.id,
    name: person.name,
    role: person.template?.role ?? null,
    division: person.template?.sourceDivision ?? null,
    description: (person.template?.description ?? '').trim(),
    model: person.model,
    provider: person.provider,
    createdAt: person.createdAt.toISOString(),
    working: working.has(personId),
    persona: person.template === null ? null : { id: person.template.id, name: person.template.name, active: person.template.active },
    profile: profile !== null && profile.ok ? profile.value : null,
    ownInstructions: person.profile,
    skills: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name) || a.skillId.localeCompare(b.skillId)),
    projects: workspaces.map((workspace) => {
      const listed = workspace.leadRoster.includes(personId)
      return { id: workspace.id, name: workspace.name, listed, full: !listed && workspace.leadRoster.length >= LEAD_ROSTER_MAX }
    }),
    footprint: { projects: footprint?.projects ?? [], runs: footprint?.runs ?? 0 },
  }
}

/**
 * Puts a person on a lead-flow project's roster, or takes them off it. The roster's own rules
 * (lead flow only, at most `LEAD_ROSTER_MAX`, each person once) are `setLeadSettings`'s and are
 * answered in its words. An id the roster still carries for a person who has since been deleted or
 * released is dropped on the way, so one stale entry cannot make every later change a refusal.
 * Already as asked is not an error: the roster is answered as it stands.
 */
export async function setPersonOnRoster(personId: string, workspaceId: string, listed: boolean): Promise<Result<{ readonly roster: readonly string[] }, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { leadRoster: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  const person = await prisma.person.findUnique({ where: { id: personId }, select: { id: true } })
  if (person === null) return err({ kind: 'person_not_found', personId })
  const known = new Set((await prisma.person.findMany({ where: { id: { in: workspace.leadRoster }, releasedAt: null }, select: { id: true } })).map((row) => row.id))
  const kept = workspace.leadRoster.filter((id) => known.has(id) && id !== personId)
  const result = await setLeadSettings(workspaceId, { roster: listed ? [...kept, personId] : kept })
  return result.ok ? ok({ roster: result.value.roster }) : result
}

/**
 * Deletes a person (`deletePerson`: every seat, run and memory of theirs; refused while a run of
 * theirs is open) and then takes their id off every roster that listed them -- a roster is a list
 * of ids with no foreign key, so nothing else would.
 */
export async function deletePersonEverywhere(
  personId: string,
  principal?: Principal,
): Promise<Result<{ readonly seats: number; readonly runs: number; readonly memories: number; readonly projects: readonly string[]; readonly rosters: number }, ControlRefusal>> {
  const deleted = await deletePerson(personId, principal)
  if (!deleted.ok) return deleted
  const listing = await prisma.workspace.findMany({ where: { leadRoster: { has: personId } }, select: { id: true, leadRoster: true } })
  for (const workspace of listing) {
    await prisma.workspace.update({ where: { id: workspace.id }, data: { leadRoster: workspace.leadRoster.filter((id) => id !== personId) } })
  }
  return ok({ ...deleted.value, rosters: listing.length })
}

export interface PersonaFilters {
  /** Every word must be in the name, the role or the one line. */
  readonly q?: string
  /** The division; `none` asks for personas with none (the ones made by hand). */
  readonly division?: string
  /** Only personas that are (true) or are not (false) offered when a team is formed. */
  readonly active?: boolean
}

/** One persona as the catalogue lists it. */
export interface PersonaCard {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly division: string | null
  readonly description: string
  readonly active: boolean
  /** Somebody edited a field of its profile: it differs from what the catalogue shipped. */
  readonly customised: boolean
  /** Made here by hand rather than imported. */
  readonly handMade: boolean
  /** Default skills still on disk. */
  readonly skillCount: number
  /** People hired from it (released ones left out). */
  readonly personCount: number
}

export interface PersonaPage {
  readonly personas: readonly PersonaCard[]
  readonly total: number
  readonly all: number
  readonly activeCount: number
  readonly offset: number
  readonly limit: number
  readonly divisions: readonly DivisionFacet[]
}

/** The catalogue of personas, a page at a time, searched and filtered, sorted by name. A read. */
export async function listPersonas(filters: PersonaFilters = {}, page: PageRequest = {}): Promise<PersonaPage> {
  const { offset, limit } = bounds(page)
  const [templates, links, persons] = await Promise.all([
    prisma.slaveTemplate.findMany({
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, role: true, description: true, sourceDivision: true, active: true, sourceId: true, profileOverrides: true },
    }),
    prisma.templateSkill.findMany({ where: { skill: { missingSince: null } }, select: { templateId: true } }),
    prisma.person.groupBy({ by: ['templateId'], where: { releasedAt: null, templateId: { not: null } }, _count: { _all: true } }),
  ])
  const skillCount = new Map<string, number>()
  for (const link of links) skillCount.set(link.templateId, (skillCount.get(link.templateId) ?? 0) + 1)
  const personCount = new Map(persons.map((row) => [row.templateId, row._count._all] as const))
  const words = wordsOf(filters.q)
  const matching = templates.filter((template) => {
    if (!divisionMatches(filters.division, template.sourceDivision)) return false
    if (filters.active !== undefined && template.active !== filters.active) return false
    if (words.length === 0) return true
    const haystack = [template.name, template.role, template.description].join(' ').toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
  return {
    personas: matching.slice(offset, offset + limit).map((template) => ({
      id: template.id,
      name: template.name,
      role: template.role,
      division: template.sourceDivision,
      description: template.description.trim(),
      active: template.active,
      customised: template.profileOverrides !== null && typeof template.profileOverrides === 'object' && Object.keys(template.profileOverrides).length > 0,
      handMade: template.sourceId === null,
      skillCount: skillCount.get(template.id) ?? 0,
      personCount: personCount.get(template.id) ?? 0,
    })),
    total: matching.length,
    all: templates.length,
    activeCount: templates.filter((template) => template.active).length,
    offset,
    limit,
    divisions: facetsOf(templates.map((template) => template.sourceDivision)),
  }
}

/** A skill as a list or a picker shows it. */
export interface SkillRow {
  readonly id: string
  readonly name: string
  readonly providerName: string
  readonly description: string
  /** The skill's files are no longer on disk. */
  readonly missing: boolean
}

export interface PersonaDetail {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly division: string | null
  readonly description: string
  readonly active: boolean
  readonly handMade: boolean
  /** Where in the catalogue it came from; null for one made by hand. */
  readonly sourcePath: string | null
  readonly profile: TemplateProfileView
  /** Its default skills: what everybody hired from it has unless they said otherwise. */
  readonly skills: readonly SkillRow[]
  /** People hired from it (released ones left out). */
  readonly personCount: number
}

/** One persona, whole: its profile (what the catalogue says, what was edited here, the merge), its
 *  default skills and how many people were hired from it. */
export async function readPersona(templateId: string): Promise<Result<PersonaDetail, ControlRefusal>> {
  const profile = await readTemplateProfile(templateId)
  if (!profile.ok) return profile
  const [template, links, personCount] = await Promise.all([
    prisma.slaveTemplate.findUnique({ where: { id: templateId }, select: { id: true, name: true, role: true, description: true, sourceDivision: true, active: true, sourceId: true } }),
    prisma.templateSkill.findMany({ where: { templateId }, include: { skill: { include: { provider: true } } } }),
    prisma.person.count({ where: { templateId, releasedAt: null } }),
  ])
  if (template === null) return err({ kind: 'template_not_found', templateId })
  return ok({
    id: template.id,
    name: template.name,
    role: template.role,
    division: template.sourceDivision,
    description: template.description.trim(),
    active: template.active,
    handMade: template.sourceId === null,
    sourcePath: profile.value.upstream?.source?.path ?? null,
    profile: profile.value,
    skills: links
      .map((link) => ({ id: link.skill.id, name: link.skill.name, providerName: link.skill.provider.name, description: link.skill.description, missing: link.skill.missingSince !== null }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    personCount,
  })
}

/** A skill with who has it. */
export interface SkillUse extends SkillRow {
  /** People who effectively have it: by their persona or by a grant, and not revoked. */
  readonly personCount: number
  /** Personas that carry it as a default. */
  readonly personaCount: number
}

/** Every skill of the library with how many people and personas have it, sorted by name. A read. */
export async function listSkillUse(): Promise<readonly SkillUse[]> {
  const [skills, links, pool] = await Promise.all([
    prisma.skill.findMany({ include: { provider: true } }),
    prisma.templateSkill.findMany({ select: { skillId: true } }),
    loadPool(),
  ])
  const personas = new Map<string, number>()
  for (const link of links) personas.set(link.skillId, (personas.get(link.skillId) ?? 0) + 1)
  const people = new Map<string, number>()
  for (const person of pool.persons) for (const skillId of person.skillIds) people.set(skillId, (people.get(skillId) ?? 0) + 1)
  return skills
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      providerName: skill.provider.name,
      description: skill.description,
      missing: skill.missingSince !== null,
      personCount: people.get(skill.id) ?? 0,
      personaCount: personas.get(skill.id) ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.providerName.localeCompare(b.providerName))
}
