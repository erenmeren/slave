'use client'
import { useEffect, useState } from 'react'

/** Follows a run's `version` and `status` over `/api/sim/<id>/events`; the page refreshes when
 *  either moves (fix wave, Important #1) -- a status verb (pause, halt) never bumps `version`, so
 *  `version` alone would miss it. */
export function useSimulationStream(simulationId: string, initialVersion: number, initialStatus: string): { readonly version: number; readonly status: string; readonly connection: 'connected' | 'reconnecting' } {
  const [version, setVersion] = useState(initialVersion)
  const [status, setStatus] = useState(initialStatus)
  const [connection, setConnection] = useState<'connected' | 'reconnecting'>('connected')
  useEffect((): (() => void) => {
    const source = new EventSource(`/api/sim/${simulationId}/events`)
    source.onopen = (): void => setConnection('connected')
    source.onerror = (): void => setConnection('reconnecting')
    source.onmessage = (message: { data: string }): void => {
      try {
        const parsed = JSON.parse(message.data) as { version?: unknown; status?: unknown }
        if (typeof parsed.version === 'number') setVersion(parsed.version)
        if (typeof parsed.status === 'string') setStatus(parsed.status)
      } catch { /* not ours to crash over */ }
    }
    return () => source.close()
  }, [simulationId])
  return { version, status, connection }
}
