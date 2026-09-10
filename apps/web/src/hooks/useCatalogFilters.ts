'use client'

import { useCallback, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import type { WorkforceCatalogFilters } from '@slave-of-ai/control'
import { catalogFilterParams, parseCatalogFilters } from '../lib/catalogFilters'

/** The five params this hook owns in the address bar, and the only ones it clears before writing
 *  its own back -- a `?tab=catalog` or a `?from=nav` that arrived on the link survives. */
const FILTER_PARAMS = ['q', 'division', 'capability', 'source', 'skill'] as const

/**
 * The catalog's five filters, carried in the URL (M46 R6).
 *
 * `window.history.replaceState`, NOT `router.replace` (plan erratum E11). `/workforce` is
 * `force-dynamic` with eight loaders, one of which scans the skills directories on disk;
 * `router.replace` re-runs all eight. `WorkforceClient` already records this reasoning for its
 * `?tab=` writes, and a keystroke in a search box is a far worse thing to re-run them for than a
 * tab click. The state that renders is React state, seeded once from the URL; the URL write is a
 * side effect so a reload or a shared link restores the same view.
 *
 * MERGED into the current query, never a bare `?q=`: dropping `?tab=catalog` would send a shared
 * link to the Slaves tab.
 */
export function useCatalogFilters(): {
  readonly filters: WorkforceCatalogFilters
  readonly setFilters: (next: WorkforceCatalogFilters) => void
} {
  const searchParams = useSearchParams()
  const [filters, setFiltersState] = useState<WorkforceCatalogFilters>(() =>
    parseCatalogFilters(new URLSearchParams(searchParams.toString())),
  )

  const setFilters = useCallback((next: WorkforceCatalogFilters): void => {
    setFiltersState(next)
    const query = new URLSearchParams(window.location.search)
    for (const key of FILTER_PARAMS) query.delete(key)
    for (const [key, value] of catalogFilterParams(next)) query.set(key, value)
    const text = query.toString()
    window.history.replaceState(null, '', text === '' ? '/workforce' : `/workforce?${text}`)
  }, [])

  return { filters, setFilters }
}
