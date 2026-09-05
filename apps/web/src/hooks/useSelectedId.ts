'use client'

import { useCallback, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

/**
 * Shared "which thing is open in the side panel" state for a single `?<param>=<id>` query
 * param — used by the tasks board's `?task=` and the overview's `?slave=` (Task 9) alike.
 *
 * The selection lives in local React state (not derived fresh from `useSearchParams()` on every
 * render) so opening/closing the panel re-renders synchronously; `router.replace` is a side
 * effect that keeps the URL in sync for a refresh to restore, not the source of truth for the
 * render — shallow routing, no server round-trip (design doc §5/§6).
 */
export function useSelectedId(param: string): readonly [string | null, (id: string | null) => void] {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [selected, setSelected] = useState<string | null>(() => searchParams.get(param))

  const select = useCallback(
    (id: string | null): void => {
      setSelected(id)
      const next = new URLSearchParams(searchParams.toString())
      if (id === null) next.delete(param)
      else next.set(param, id)
      const query = next.toString()
      router.replace(query.length > 0 ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [router, pathname, searchParams, param],
  )

  return [selected, select] as const
}
