'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { PAGE, PAGE_MAX } from './words'

/**
 * A long list read a page at a time: the rows read so far, the newest page (for its totals), and
 * `more` to read the next page. A new `query` starts over from the first page; a new `reloadKey`
 * re-reads what is shown (after a write somewhere changed it). `initial` is the first page the
 * server already read for `initialQuery`, so the first paint does not wait for a request.
 */
export function usePagedList<P extends { readonly total: number }, T extends { readonly id: string }>(
  base: string,
  query: string,
  rowsOf: (page: P) => readonly T[],
  options: { readonly initial?: P | null; readonly initialQuery?: string; readonly reloadKey?: number } = {},
): { readonly rows: readonly T[]; readonly page: P | null; readonly loading: boolean; readonly error: string | null; readonly more: () => Promise<void> } {
  const { initial = null, initialQuery = '', reloadKey = 0 } = options
  const seeded = initial !== null && query === initialQuery
  const [rows, setRows] = useState<readonly T[]>(seeded ? rowsOf(initial) : [])
  const [page, setPage] = useState<P | null>(seeded ? initial : null)
  const [loading, setLoading] = useState(!seeded)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)
  const shown = useRef({ query: seeded ? query : null, reloadKey, count: rows.length })
  shown.current.count = rows.length
  const pick = useRef(rowsOf)
  pick.current = rowsOf

  const read = useCallback(
    async (offset: number, limit: number, append: boolean): Promise<void> => {
      const mine = ++request.current
      setLoading(true)
      const result = await api<P>(`${base}?${query === '' ? '' : `${query}&`}offset=${String(offset)}&limit=${String(limit)}`)
      if (mine !== request.current) return
      setLoading(false)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setError(null)
      setPage(result.data)
      const read = pick.current(result.data)
      // A row that moved onto this page while the earlier ones were on screen (somebody was added
      // or deleted in between) is already shown: it is not drawn a second time.
      setRows((current) => (append ? [...current, ...read.filter((row) => !current.some((had) => had.id === row.id))] : read))
    },
    [base, query],
  )

  useEffect((): void => {
    const last = shown.current
    if (last.query === query && last.reloadKey === reloadKey) return
    const sameQuery = last.query === query
    shown.current = { query, reloadKey, count: last.count }
    void read(0, sameQuery ? Math.min(Math.max(last.count, PAGE), PAGE_MAX) : PAGE, false)
  }, [query, reloadKey, read])

  const more = useCallback((): Promise<void> => read(shown.current.count, PAGE, true), [read])
  return { rows, page, loading, error, more }
}
