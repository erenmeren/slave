import { CATALOG_NO_SKILLS, text } from './catalogFilters'

/**
 * People's URL vocabulary (workforce cards §1) -- parsed the same way by `GET /api/persons`, by
 * `/workforce/page.tsx` and by the client hook, the `catalogFilters.ts` precedent. Pure: no prisma,
 * no React. LENIENT the same way: an unknown segment or `skills` value is DROPPED, never refused.
 *
 * `q`, `specialty`, `division` and `skills` are the SAME params the Catalog tab writes, on purpose:
 * the two tabs share one filter bar, so "frontend, nobody equipped yet" carries from one list to the
 * other. `skillId` is People's own -- the Catalog's `skill` is a recommended-skill WORD from the
 * persona text, People's is a linked `Skill` id, and one param meaning both would be a lie on one
 * of the two tabs.
 */
export const PEOPLE_STATES = ['pool', 'assigned', 'released'] as const

export type PeopleState = (typeof PEOPLE_STATES)[number]

export interface PeopleFilters {
  readonly q?: string
  /** A capability domain; a person matches when any of `Person.capabilities` is one of its keys. */
  readonly specialty?: string
  /** The import division of the persona this person was hired from. */
  readonly division?: string
  /** A `Skill.id` this person EFFECTIVELY holds (a revoke wins over the persona). */
  readonly skillId?: string
  /** Only people with no effective skill at all. */
  readonly noSkills?: boolean
  /** The segmented control; absent is "Everyone". */
  readonly state?: PeopleState
  /** A department (`CompanyTeam.id`) the person is a member of. */
  readonly department?: string
}

export type PeopleFilterKey = 'q' | 'specialty' | 'division' | 'skillId' | 'noSkills' | 'state' | 'department'

/** Every param this vocabulary owns in the address bar -- what the hook clears before writing. */
export const PEOPLE_FILTER_PARAMS = ['q', 'specialty', 'division', 'skillId', 'skills', 'state', 'department'] as const

const asState = (value: string | undefined): PeopleState | undefined => PEOPLE_STATES.find((member) => member === value)

export function parsePeopleFilters(params: URLSearchParams): PeopleFilters {
  const q = text(params, 'q')
  const specialty = text(params, 'specialty')
  const division = text(params, 'division')
  const skillId = text(params, 'skillId')
  const state = asState(text(params, 'state'))
  const department = text(params, 'department')
  return {
    ...(q !== undefined ? { q } : {}),
    ...(specialty !== undefined ? { specialty } : {}),
    ...(division !== undefined ? { division } : {}),
    ...(skillId !== undefined ? { skillId } : {}),
    ...(text(params, 'skills') === CATALOG_NO_SKILLS ? { noSkills: true } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(department !== undefined ? { department } : {}),
  }
}

/** The inverse: only the dimensions that are set, so an empty filter is an empty query string. */
export function peopleFilterParams(filters: PeopleFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.q !== undefined) params.set('q', filters.q)
  if (filters.specialty !== undefined) params.set('specialty', filters.specialty)
  if (filters.division !== undefined) params.set('division', filters.division)
  if (filters.skillId !== undefined) params.set('skillId', filters.skillId)
  if (filters.noSkills === true) params.set('skills', CATALOG_NO_SKILLS)
  if (filters.state !== undefined) params.set('state', filters.state)
  if (filters.department !== undefined) params.set('department', filters.department)
  return params
}

/**
 * One dimension changed, the others carried through -- and `''` means "drop this one" (a cleared
 * box, an `any` option, a chip clicked twice). Written out key by key, `CatalogFilterBar`'s
 * `withFilter` reason: a computed-key spread widens to an index signature under
 * `exactOptionalPropertyTypes`.
 */
export function withPeopleFilter(filters: PeopleFilters, key: PeopleFilterKey, value: string): PeopleFilters {
  const q = key === 'q' ? value : filters.q
  const specialty = key === 'specialty' ? value : filters.specialty
  const division = key === 'division' ? value : filters.division
  const skillId = key === 'skillId' ? value : filters.skillId
  const noSkills = key === 'noSkills' ? value === 'true' : filters.noSkills
  const state = key === 'state' ? asState(value) : filters.state
  const department = key === 'department' ? value : filters.department
  return {
    ...(q !== undefined && q !== '' ? { q } : {}),
    ...(specialty !== undefined && specialty !== '' ? { specialty } : {}),
    ...(division !== undefined && division !== '' ? { division } : {}),
    ...(skillId !== undefined && skillId !== '' ? { skillId } : {}),
    ...(noSkills === true ? { noSkills } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(department !== undefined && department !== '' ? { department } : {}),
  }
}
