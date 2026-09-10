import type { WorkforceCatalogFilters } from '@slave-of-ai/control'

/**
 * The Workforce Catalog's URL vocabulary (M46 R6) -- five params, parsed the same way by the route
 * and by the client hook, the `activityFilters.ts` precedent. Pure: no prisma, no React.
 *
 * LENIENT, unlike the activity timeline's `?types=`. A stale or hand-edited link is a link somebody
 * shared before a capability was renamed; dropping the token it no longer knows renders a page with
 * one fewer filter, and refusing the whole request renders an error where a catalog belongs. Only
 * `source` has a closed vocabulary to check at all -- the other four are free text the read model
 * matches in memory, so an unknown value there is simply a filter that selects nothing.
 */
export const CATALOG_SOURCES = ['imported', 'local'] as const

export type CatalogSource = (typeof CATALOG_SOURCES)[number]

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
  return {
    ...(q !== undefined ? { q } : {}),
    ...(division !== undefined ? { division } : {}),
    ...(capability !== undefined ? { capability } : {}),
    ...(source !== undefined && (CATALOG_SOURCES as readonly string[]).includes(source)
      ? { source: source as CatalogSource }
      : {}),
    ...(skill !== undefined ? { skill } : {}),
  }
}

/** The inverse, for the client that writes the filter bar's state back into the address bar
 *  (`filtersToQuery`'s idiom): only the dimensions that are set are written, so an empty filter is
 *  an empty query string rather than five empty params. */
export function catalogFilterParams(filters: WorkforceCatalogFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.q !== undefined) params.set('q', filters.q)
  if (filters.division !== undefined) params.set('division', filters.division)
  if (filters.capability !== undefined) params.set('capability', filters.capability)
  if (filters.source !== undefined) params.set('source', filters.source)
  if (filters.skill !== undefined) params.set('skill', filters.skill)
  return params
}
