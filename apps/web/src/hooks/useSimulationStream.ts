'use client'
import { useEffect, useState } from 'react'

/** Follows a run's `version` over `/api/sim/<id>/events`; the page refreshes when it moves. */
export function useSimulationStream(simulationId: string, initialVersion: number): { readonly version: number; readonly connection: 'connected' | 'reconnecting' } {
  const [version, setVersion] = useState(initialVersion)
  const [connection, setConnection] = useState<'connected' | 'reconnecting'>('connected')
  useEffect((): (() => void) => {
    const source = new EventSource(`/api/sim/${simulationId}/events`)
    source.onopen = (): void => setConnection('connected')
    source.onerror = (): void => setConnection('reconnecting')
    source.onmessage = (message: { data: string }): void => {
      try {
        const parsed = JSON.parse(message.data) as { version?: unknown }
        if (typeof parsed.version === 'number') setVersion(parsed.version)
      } catch { /* not ours to crash over */ }
    }
    return () => source.close()
  }, [simulationId])
  return { version, connection }
}
