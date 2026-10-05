'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'

/**
 * Lead UX design U-9: a screen's one read model, re-read on an interval the data itself picks (3
 * seconds while something runs, longer otherwise). The last good value is kept through a failed
 * read; `error` says the read failed. `refresh` re-reads at once -- after a button press, so the
 * screen shows what the press did without waiting for the next tick.
 */
export function usePoll<T>(url: string, initial: T, intervalFor: (data: T) => number): { readonly data: T; readonly error: string | null; readonly refresh: () => Promise<void> } {
  const [data, setData] = useState<T>(initial)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(data)
  latest.current = data

  const refresh = useCallback(async (): Promise<void> => {
    const result = await api<T>(url)
    if (result.ok) {
      setData(result.data)
      setError(null)
    } else {
      setError(result.error)
    }
  }, [url])

  useEffect((): (() => void) => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = (): void => {
      timer = setTimeout(() => {
        void refresh().finally(() => {
          if (!stopped) tick()
        })
      }, intervalFor(latest.current))
    }
    tick()
    return (): void => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
    // `intervalFor` is read through `latest` on every tick; a new function each render must not
    // restart the loop.
  }, [refresh])

  return { data, error, refresh }
}
