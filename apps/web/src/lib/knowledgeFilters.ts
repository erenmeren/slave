import {
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  type MemoryScope,
  type MemoryStatus,
  type MemoryType,
} from '@slave-of-ai/domain'

/**
 * The Knowledge tab's URL vocabulary (M49 R6) -- four params, parsed the same way by the route, by
 * the page's server render and by the client hook. Pure: no prisma, no React, the
 * `lib/catalogFilters.ts` precedent.
 *
 * LENIENT, like the catalog's and unlike the activity timeline's `?types=`: a value the union does
 * not have is DROPPED rather than refused, because a bookmarked filter from a future version --
 * or from a build where a member was renamed -- must show the page, not an error.
 *
 * `status` is the one REPEATABLE param: "what is still live" is two statuses and always has been
 * (`DEFAULT_KNOWLEDGE_STATUSES`), so a link that says "show me the withdrawn ones too" has to be
 * expressible. The other three are one value each.
 */
export interface KnowledgeFilters {
  readonly scope?: MemoryScope
  readonly type?: MemoryType
  readonly statuses?: readonly MemoryStatus[]
  readonly q?: string
}

const member = <T extends string>(raw: string | null, known: readonly string[]): T | undefined =>
  raw !== null && known.includes(raw) ? (raw as T) : undefined

export function parseKnowledgeFilters(params: URLSearchParams): KnowledgeFilters {
  const scope = member<MemoryScope>(params.get('scope'), MEMORY_SCOPES)
  const type = member<MemoryType>(params.get('type'), MEMORY_TYPES)
  // Deduped, so `?status=removed&status=removed` is one status rather than two -- the route turns
  // this into an `IN`, and a repeated member there is a longer query saying the same thing.
  const statuses = [
    ...new Set(
      params.getAll('status').filter((one): one is MemoryStatus => (MEMORY_STATUSES as readonly string[]).includes(one)),
    ),
  ]
  const q = (params.get('q') ?? '').trim()
  return {
    ...(scope === undefined ? {} : { scope }),
    ...(type === undefined ? {} : { type }),
    // An EMPTY list after the filter is no list at all, never "show nothing": a link whose every
    // status token this build does not know still means "show me this project's knowledge".
    ...(statuses.length === 0 ? {} : { statuses }),
    ...(q === '' ? {} : { q }),
  }
}

/** The inverse, for the client that writes its filter bar back into the address bar
 *  (`catalogFilterParams`' idiom): only the dimensions that are set are written, so an unfiltered
 *  page is an empty query string rather than four empty params. */
export function knowledgeFilterParams(filters: KnowledgeFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.scope !== undefined) params.set('scope', filters.scope)
  if (filters.type !== undefined) params.set('type', filters.type)
  for (const status of filters.statuses ?? []) params.append('status', status)
  if (filters.q !== undefined && filters.q.trim() !== '') params.set('q', filters.q.trim())
  return params
}

/**
 * Next hands a repeated param as an array and a single one as a string; `URLSearchParams` is what
 * every reader of these filters takes, so a server page converts once here rather than teaching
 * {@link parseKnowledgeFilters} about two shapes (`WorkforcePage`'s own `queryOf`, widened because
 * `status` is deliberately repeatable).
 */
export function knowledgeQueryOf(params: Record<string, string | readonly string[] | undefined>): URLSearchParams {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    for (const one of typeof value === 'string' ? [value] : value) query.append(key, one)
  }
  return query
}
