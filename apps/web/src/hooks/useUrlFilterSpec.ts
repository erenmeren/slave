'use client'

import { useCallback, useState } from 'react'
import { useSearchParams } from 'next/navigation'

/** One filter vocabulary as the address bar holds it: the params it OWNS -- the only ones it clears
 *  before writing its own back -- and the parse in both directions. Pass a MODULE constant: the
 *  hook's writer depends on it. */
export interface UrlFilterSpec<F> {
  readonly keys: readonly string[]
  readonly parse: (params: URLSearchParams) => F
  readonly toParams: (filters: F) => URLSearchParams
}

/**
 * Filters carried in the URL (M46 R6; generalised by workforce cards so the Catalog and People tabs
 * share one idiom and one bar).
 *
 * Named `useUrlFilterSpec`, not `useUrlFilters`: that name already belongs to the Activity tab's
 * own hook (`apps/web/src/hooks/useUrlFilters.ts`, a fixed four-dimension shape with its own
 * `router.replace`-based writer) -- a different, unrelated hook this one must not collide with.
 *
 * `window.history.replaceState`, NOT `router.replace` (M46 plan erratum E11): `/workforce` is
 * `force-dynamic` with a dozen loaders, one of which scans the skills directories on disk, and a
 * keystroke in a search box is a far worse thing to re-run them for than a tab click. The state that
 * renders is React state, seeded once from the URL; the URL write is a side effect so a reload or a
 * shared link restores the same view.
 *
 * MERGED into the current query, never a bare `?q=`: dropping `?tab=catalog` would send a shared
 * link to the People tab.
 */
export function useUrlFilterSpec<F>(spec: UrlFilterSpec<F>): {
  readonly filters: F
  readonly setFilters: (next: F) => void
} {
  const searchParams = useSearchParams()
  const [filters, setFiltersState] = useState<F>(() => spec.parse(new URLSearchParams(searchParams.toString())))

  const setFilters = useCallback(
    (next: F): void => {
      setFiltersState(next)
      const query = new URLSearchParams(window.location.search)
      for (const key of spec.keys) query.delete(key)
      for (const [key, value] of spec.toParams(next)) query.set(key, value)
      const text = query.toString()
      window.history.replaceState(null, '', text === '' ? '/workforce' : `/workforce?${text}`)
    },
    [spec],
  )

  return { filters, setFilters }
}
