import { PROFILE_FIELD_KIND, PROFILE_SPEC_MAX_ITEMS, PROFILE_SPEC_MAX_ITEM_CHARS, type ProfileOverridableField, type ProfileSpec } from '@slave-of-ai/domain'
import type { PersonSkillRow } from '@slave-of-ai/control'

/** How many cards a list reads at a time; more are read on request. */
export const PAGE = 48
/** The most one read may ask for (the control layer's own cap). */
export const PAGE_MAX = 200

/** A mark per division, so a long catalogue scans by what people are good at. Decorative. */
const DIVISION_MARK: Readonly<Record<string, string>> = {
  engineering: '💻',
  design: '🎨',
  marketing: '📢',
  product: '📊',
  'project-management': '🗂️',
  testing: '🧪',
  security: '🔒',
  support: '🛟',
  sales: '💼',
  specialized: '🎯',
  finance: '💵',
  'game-development': '🎮',
  'spatial-computing': '🥽',
  academic: '📚',
  research: '🔍',
  gis: '🗺️',
  'paid-media': '📣',
  healthcare: '🩺',
}

export function divisionMark(division: string | null): string {
  return division === null ? '✨' : (DIVISION_MARK[division] ?? '✨')
}

/** "project-management" → "Project management"; no division → "No division". */
export function divisionWord(division: string | null): string {
  if (division === null) return 'No division'
  const spaced = division.replace(/[-_]+/gu, ' ').trim()
  if (spaced === '') return division
  return spaced.length <= 3 ? spaced.toUpperCase() : `${spaced[0]?.toUpperCase() ?? ''}${spaced.slice(1)}`
}

/** The filter value a division is asked for by: its key, or `none` for "no division". */
export const divisionParam = (division: string | null): string => division ?? 'none'

/** "library:ecc" → "ecc": where a skill comes from, without the kind of root it sits in. */
export function skillSourceWord(providerName: string): string {
  const colon = providerName.indexOf(':')
  return colon === -1 ? providerName : providerName.slice(colon + 1)
}

export interface PeopleQuery {
  readonly q: string
  /** A division's key, `none`, or null for every division. */
  readonly division: string | null
  readonly skillId: string | null
  readonly templateId: string | null
  readonly onRoster: boolean
  readonly noSkills: boolean
}

export const EMPTY_PEOPLE_QUERY: PeopleQuery = { q: '', division: null, skillId: null, templateId: null, onRoster: false, noSkills: false }

/** The People list's query string, without the page. Empty for no filter at all. */
export function peopleQueryString(query: PeopleQuery): string {
  const params = new URLSearchParams()
  if (query.q.trim() !== '') params.set('q', query.q.trim())
  if (query.division !== null) params.set('division', query.division)
  if (query.skillId !== null) params.set('skill', query.skillId)
  if (query.templateId !== null) params.set('persona', query.templateId)
  if (query.onRoster) params.set('roster', '1')
  if (query.noSkills) params.set('noSkills', '1')
  return params.toString()
}

export interface PersonaQuery {
  readonly q: string
  readonly division: string | null
  /** True for active only, false for inactive only, null for both. */
  readonly active: boolean | null
}

export const EMPTY_PERSONA_QUERY: PersonaQuery = { q: '', division: null, active: null }

export function personaQueryString(query: PersonaQuery): string {
  const params = new URLSearchParams()
  if (query.q.trim() !== '') params.set('q', query.q.trim())
  if (query.division !== null) params.set('division', query.division)
  if (query.active !== null) params.set('active', query.active ? '1' : '0')
  return params.toString()
}

/** How many filters a People query carries, the search included -- what "Clear filters" clears. */
export function activeFilterCount(query: PeopleQuery): number {
  return [query.q.trim() !== '', query.division !== null, query.skillId !== null, query.templateId !== null, query.onRoster, query.noSkills].filter(Boolean).length
}

/** Where a skill of a person comes from, in words. */
export const SKILL_STATE_WORD: Readonly<Record<PersonSkillRow['state'], string>> = {
  persona: 'From the persona',
  granted: 'Given to them',
  revoked: 'Taken away',
}

/** The profile in two parts: who somebody is, and what they do. Every field is in exactly one. */
export const WHO_FIELDS: readonly ProfileOverridableField[] = ['identity', 'summary', 'operatingPrinciples', 'constraints', 'collaborationHints', 'body']
export const WHAT_FIELDS: readonly ProfileOverridableField[] = ['mission', 'capabilities', 'expertise', 'workflow', 'deliverables', 'successCriteria', 'recommendedSkills']

/** A field's label on screen: the profile's own headings, said about somebody rather than to them. */
export const FIELD_WORD: Readonly<Record<ProfileOverridableField, string>> = {
  identity: 'Identity',
  summary: 'In one line',
  mission: 'Mission',
  capabilities: 'Capabilities',
  expertise: 'Expertise',
  operatingPrinciples: 'Principles',
  constraints: 'Rules they keep',
  workflow: 'Workflow',
  deliverables: 'Deliverables',
  successCriteria: 'Success criteria',
  collaborationHints: 'Working with others',
  recommendedSkills: 'Recommended skills',
  body: 'In their own words',
}

export const isListField = (field: ProfileOverridableField): boolean => PROFILE_FIELD_KIND[field] === 'list'

/** A field's value as the lines it is edited as: a list's items, or a text as it is. */
export function fieldText(spec: ProfileSpec, field: ProfileOverridableField): string {
  const value = spec[field]
  return typeof value === 'string' ? value : value.join('\n')
}

export function fieldIsEmpty(spec: ProfileSpec, field: ProfileOverridableField): boolean {
  const value = spec[field]
  return typeof value === 'string' ? value.trim() === '' : value.length === 0
}

/** The lines of an editor's text, as a list field stores them: trimmed, blanks and a leading
 *  "1." or "-" dropped (a pasted numbered list is still one item per line). */
export function linesOf(text: string): readonly string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/u, '').trim())
    .filter((line) => line !== '')
}

/** What an edited field is saved as, or the sentence that says why it cannot be. */
export function fieldPatch(field: ProfileOverridableField, text: string): { readonly value: string | readonly string[] } | { readonly problem: string } {
  if (!isListField(field)) {
    const value = text.trim()
    if (field !== 'body' && value.length > PROFILE_SPEC_MAX_ITEM_CHARS) return { problem: `Keep this to ${String(PROFILE_SPEC_MAX_ITEM_CHARS)} characters (it has ${String(value.length)}).` }
    return { value }
  }
  const lines = linesOf(text)
  if (lines.length > PROFILE_SPEC_MAX_ITEMS) return { problem: `At most ${String(PROFILE_SPEC_MAX_ITEMS)} lines (there are ${String(lines.length)}).` }
  const long = lines.findIndex((line) => line.length > PROFILE_SPEC_MAX_ITEM_CHARS)
  if (long !== -1) return { problem: `Line ${String(long + 1)} is longer than ${String(PROFILE_SPEC_MAX_ITEM_CHARS)} characters.` }
  return { value: lines }
}

/** "Step 1: Read the request" → "Read the request": a workflow is drawn as numbered steps, so a
 *  step that numbers itself would be numbered twice. */
export function stepText(step: string): string {
  return step.replace(/^\s*(?:step\s+)?\d+\s*[:.)-]\s*/iu, '')
}

/** "On Todo", "On Todo and Shop", "On 3 projects": the rosters that list somebody, in a few words. */
export function rosterLine(projects: readonly { readonly name: string }[]): string | null {
  if (projects.length === 0) return null
  if (projects.length === 1) return `On ${projects[0]?.name ?? ''}`
  if (projects.length === 2) return `On ${projects[0]?.name ?? ''} and ${projects[1]?.name ?? ''}`
  return `On ${String(projects.length)} projects`
}

/** What deleting somebody takes, as the sentences the confirmation lists. */
export function deleteConsequences(person: { readonly name: string; readonly ownInstructions: string | null; readonly skills: readonly PersonSkillRow[]; readonly projects: readonly { readonly name: string; readonly listed: boolean }[]; readonly footprint: { readonly projects: readonly string[]; readonly runs: number }; readonly persona: { readonly name: string } | null }): readonly string[] {
  const lines: string[] = []
  const own = person.skills.filter((skill) => skill.state !== 'persona').length
  if (person.ownInstructions !== null) lines.push('Their own instructions.')
  if (own > 0) lines.push(`${String(own)} skill ${own === 1 ? 'change' : 'changes'} made for them.`)
  const rosters = person.projects.filter((project) => project.listed).map((project) => project.name)
  if (rosters.length > 0) lines.push(`Their place on the helper list of ${rosters.join(', ')}.`)
  if (person.footprint.projects.length > 0) lines.push(`Their seat in ${person.footprint.projects.join(', ')}.`)
  if (person.footprint.runs > 0) lines.push(`${String(person.footprint.runs)} past ${person.footprint.runs === 1 ? 'run' : 'runs'} of theirs, with what each recorded.`)
  if (lines.length === 0) lines.push('Nothing else: they have no instructions, skill changes, projects or runs of their own.')
  return lines
}

export type PeopleTabId = 'people' | 'personas' | 'skills'

export function tabOf(value: string | undefined): PeopleTabId {
  return value === 'personas' || value === 'skills' ? value : 'people'
}

/** What the page's address says is open: the tab, a person or a persona, and the People filters a
 *  link may carry (`skill`, `from` a persona). */
export interface PeopleLocation {
  readonly tab: PeopleTabId
  readonly personId: string | null
  readonly personaId: string | null
  readonly skillId: string | null
  readonly templateId: string | null
}

/** The address of a People location, so what is open can be linked to and survives a reload. */
export function peopleHref(location: PeopleLocation): string {
  const params = new URLSearchParams()
  if (location.tab !== 'people') params.set('tab', location.tab)
  if (location.personId !== null) params.set('person', location.personId)
  if (location.personaId !== null) params.set('persona', location.personaId)
  if (location.skillId !== null) params.set('skill', location.skillId)
  if (location.templateId !== null) params.set('from', location.templateId)
  const query = params.toString()
  return query === '' ? '/people' : `/people?${query}`
}

/** A persona's role as a second line under its name -- left out when it only repeats the division. */
export function roleLine(role: string, division: string | null): string | null {
  const word = role.trim()
  if (word === '' || word.toLowerCase() === (division ?? '').toLowerCase()) return null
  return divisionWord(word)
}

/** A profile line as plain words: the catalogue's Markdown marks (`**bold**`, `` `code` ``) are
 *  not drawn as marks. */
export function plainLine(text: string): string {
  return text.replace(/\*\*|__|`/gu, '')
}
