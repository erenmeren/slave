'use client'

import { useCallback, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  knowledgeFilterParams,
  parseKnowledgeFilters,
  type KnowledgeFilters,
} from '../lib/knowledgeFilters'

/** The four params this hook owns in the address bar, and the only ones it clears before writing
 *  its own back -- a `?task=` or a `?from=nav` that arrived on the link survives
 *  (`useCatalogFilters`' own rule). */
const FILTER_PARAMS = ['scope', 'type', 'status', 'q'] as const

/**
 * The Knowledge tab's four filters, carried in the URL (M49 R6, t4 fix round 1 minor 4).
 *
 * `window.history.replaceState`, NOT `router.replace` (`useCatalogFilters`' own reasoning, and
 * plan erratum E11 there): `/w/:id/knowledge` is `force-dynamic`, so `router.replace` re-runs the
 * whole server render for every keystroke in the search box -- and the client is ALREADY asking
 * the route for exactly that answer. The state that renders is React state, seeded once from the
 * URL; the URL write is a side effect so a reload or a shared link restores the same view.
 *
 * Seeded ONCE, deliberately: the page's server render is given the same `searchParams` and hands
 * the client the rows those filters select, so the first paint already agrees with the filter bar
 * (`WorkforcePage`'s own rule) and this hook must not re-read a URL it is itself writing.
 */
export function useKnowledgeFilters(workspaceId: string): {
  readonly filters: KnowledgeFilters
  readonly setFilters: (next: KnowledgeFilters) => void
} {
  const searchParams = useSearchParams()
  const [filters, setFiltersState] = useState<KnowledgeFilters>(() =>
    parseKnowledgeFilters(new URLSearchParams(searchParams.toString())),
  )

  const setFilters = useCallback(
    (next: KnowledgeFilters): void => {
      setFiltersState(next)
      const query = new URLSearchParams(window.location.search)
      for (const key of FILTER_PARAMS) query.delete(key)
      for (const [key, value] of knowledgeFilterParams(next)) query.append(key, value)
      const text = query.toString()
      const path = `/w/${workspaceId}/knowledge`
      window.history.replaceState(null, '', text === '' ? path : `${path}?${text}`)
    },
    [workspaceId],
  )

  return { filters, setFilters }
}
