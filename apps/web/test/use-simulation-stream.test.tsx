// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSimulationStream } from '../src/hooks/useSimulationStream.js'

interface FakeEventSource {
  url: string
  onopen: (() => void) | null
  onmessage: ((message: { data: string }) => void) | null
  onerror: (() => void) | null
  close: () => void
}

let instances: FakeEventSource[] = []

class StubEventSource implements FakeEventSource {
  url: string
  onopen: (() => void) | null = null
  onmessage: ((message: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(url: string) {
    this.url = url
    instances.push(this)
  }
  close(): void {
    this.closed = true
  }
}

beforeEach(() => {
  instances = []
  vi.stubGlobal('EventSource', StubEventSource)
})
afterEach(() => vi.unstubAllGlobals())

describe('useSimulationStream', () => {
  it('returns the initial version and status connected; a message bumps version; onerror/onopen toggle connection; unmount closes the source', () => {
    const { result, unmount } = renderHook(() => useSimulationStream('s1', 3, 'running'))
    expect(result.current).toEqual({ version: 3, status: 'running', connection: 'connected' })
    expect(instances).toHaveLength(1)
    expect(instances[0]?.url).toBe('/api/sim/s1/events')

    act(() => { instances[0]?.onmessage?.({ data: JSON.stringify({ version: 4, status: 'running', simTime: 4 }) }) })
    expect(result.current.version).toBe(4)

    act(() => { instances[0]?.onerror?.() })
    expect(result.current.connection).toBe('reconnecting')

    act(() => { instances[0]?.onopen?.() })
    expect(result.current.connection).toBe('connected')

    const source = instances[0] as unknown as StubEventSource
    unmount()
    expect(source.closed).toBe(true)
  })
  it('a frame with an unchanged version but a new status still updates status (fix wave, Important #1)', () => {
    const { result } = renderHook(() => useSimulationStream('s1', 3, 'running'))
    act(() => { instances[0]?.onmessage?.({ data: JSON.stringify({ version: 3, status: 'halted', simTime: 3 }) }) })
    expect(result.current.version).toBe(3)
    expect(result.current.status).toBe('halted')
  })
})
