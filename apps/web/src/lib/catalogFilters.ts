import { DUPLICATE_FACETS, type DuplicateFacet } from '@slave-of-ai/domain'
import type { WorkforceCatalogFilters } from '@slave-of-ai/control'

/**
 * The Workforce Catalog's URL vocabulary (M46 R6, widened to seven by M55 R3) -- parsed the same way
 * by the route and by the client hook, the `activityFilters.ts` precedent. Pure: no prisma, no
 * React.
 *
 * LENIENT, unlike the activity timeline's `?types=`. A stale or hand-edited link is a link somebody
 * shared before a capability was renamed; dropping the token it no longer knows renders a page with
 * one fewer filter, and refusing the whole request renders an error where a catalog belongs. Three
 * of the seven have a closed vocabulary to check -- `source`, `active` and `duplicates` -- and an
 * unknown value in any of them is DROPPED, never refused.
 */
export const CATALOG_SOURCES = ['imported', 'local'] as const

export type CatalogSource = (typeof CATALOG_SOURCES)[number]

/**
 * The two WORDS the `active` param carries (M55 R3).
 *
 * The filter is a boolean in `WorkforceCatalogFilters`, and the URL is two words rather than
 * `true`/`false` for `docs/ia.md` rule 3's reason: a shared link is something a person reads, and
 * `?active=true` says less than `?active=active`. It is also what lets "absent" mean "either",
 * which is a third state neither word occupies.
 */
export const CATALOG_ACTIVATIONS = ['active', 'inactive'] as const

export type CatalogActivation = (typeof CATALOG_ACTIVATIONS)[number]

/** ONE vocabulary (`CatalogFilterBar`'s own rule): the chip says exactly the word the catalog ROW
 *  says for the same fact. `data-active` still carries the boolean for a gate to read. */
export const ACTIVATION_LABEL: Record<CatalogActivation, string> = {
  active: 'active',
  inactive: 'inactive',
}

/**
 * How long the search box waits before it asks (M53 section 6's carried "`q` undebounced", taken
 * here).
 *
 * It was cosmetic while the read model filtered an array in memory. Since M55 R3 every keystroke is
 * a `contains` over `searchText` across the whole table plus a `count` over the same `where`, and a
 * person typing "release steward" at a normal speed would fire fifteen of those. 250 ms is under the
 * threshold at which a person perceives a pause and over the interval between two keystrokes.
 */
export const CATALOG_SEARCH_DEBOUNCE_MS = 250

function text(params: URLSearchParams, key: string): string | undefined {
  const raw = (params.get(key) ?? '').trim()
  return raw === '' ? undefined : raw
}

export function parseCatalogFilters(params: URLSearchParams): WorkforceCatalogFilters {
  const q = text(params, 'q')
  const division = text(params, 'division')
  const capability = text(params, 'capability')
  const source = text(params, 'source')
  const skill = text(params, 'skill')
  const active = text(params, 'active')
  const duplicates = text(params, 'duplicates')
  return {
    ...(q !== undefined ? { q } : {}),
    ...(division !== undefined ? { division } : {}),
    ...(capability !== undefined ? { capability } : {}),
    ...(source !== undefined && (CATALOG_SOURCES as readonly string[]).includes(source)
      ? { source: source as CatalogSource }
      : {}),
    ...(skill !== undefined ? { skill } : {}),
    ...(active !== undefined && (CATALOG_ACTIVATIONS as readonly string[]).includes(active)
      ? { active: active === 'active' }
      : {}),
    ...(duplicates !== undefined && (DUPLICATE_FACETS as readonly string[]).includes(duplicates)
      ? { duplicates: duplicates as DuplicateFacet }
      : {}),
  }
}

/** The inverse, for the client that writes the filter bar's state back into the address bar
 *  (`filtersToQuery`'s idiom): only the dimensions that are set are written, so an empty filter is an
 *  empty query string rather than seven empty params. */
export function catalogFilterParams(filters: WorkforceCatalogFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.q !== undefined) params.set('q', filters.q)
  if (filters.division !== undefined) params.set('division', filters.division)
  if (filters.capability !== undefined) params.set('capability', filters.capability)
  if (filters.source !== undefined) params.set('source', filters.source)
  if (filters.skill !== undefined) params.set('skill', filters.skill)
  if (filters.active !== undefined) params.set('active', filters.active ? 'active' : 'inactive')
  if (filters.duplicates !== undefined) params.set('duplicates', filters.duplicates)
  return params
}
