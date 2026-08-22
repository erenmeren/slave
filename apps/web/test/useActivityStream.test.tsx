// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useActivityStream } from '../src/hooks/useActivityStream.js'
import { EMPTY_ACTIVITY_FILTERS, type ActivityFilters } from '../src/lib/activityFilters.js'
import type { ActivityEventRow, ActivityPage } from '../src/server/activity.js'

/** Minimal EventSource stand-in: capture instances, let tests push messages and errors. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }
  close(): void {
    this.closed = true
  }
}

function row(seq: number, overrides: Partial<ActivityEventRow> = {}): ActivityEventRow {
  return {
    seq,
    ts: new Date(seq * 1000).toISOString(),
    type: 'task.created',
    actor: 'system',
    agentId: null,
    taskId: null,
    runId: null,
    payload: { title: `row ${seq}` },
    summary: 'task.created',
    ...overrides,
  }
}

const INITIAL: ActivityPage = {
  workspace: { id: 'w1', name: 'mine', haltedReason: null },
  // Descending, as the history route returns it.
  events: [row(3), row(2), row(1)],
  nextBefore: 1,
  sparkline: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  agents: [],
  tasks: [],
}

describe('useActivityStream', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach((): void => {
    vi.useFakeTimers()
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource)
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ events: [], nextBefore: null, sparkline: new Array(10).fill(0) }), {
          status: 200,
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach((): void => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const push = (data: unknown): void => {
    act((): void => {
      FakeEventSource.instances[0]?.onmessage?.({ data: JSON.stringify(data) })
    })
  }

  it('mounts with initial.events reversed to ascending', () => {
    const { result } = renderHook(() =>
      useActivityStream({ workspaceId: 'w1', filters: EMPTY_ACTIVITY_FILTERS, initial: INITIAL }),
    )

    expect(result.current.events.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('opens the EventSource at the stream route with the filter query and the newest seq (unfiltered mount)', () => {
    renderHook(() =>
      useActivityStream({ workspaceId: 'w1', filters: EMPTY_ACTIVITY_FILTERS, initial: INITIAL }),
    )

    const url = FakeEventSource.instances[0]?.url ?? ''
    expect(url.startsWith('/api/w/w1/activity/stream?')).toBe(true)
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('from')).toBe('3')
  })

  it('Finding 1: a filtered mount refetches page 1 through the history route instead of seeding the unfiltered `initial` page, then opens the stream from the refetched page', async () => {
    const filteredPage = { events: [row(9), row(7)], nextBefore: null, sparkline: new Array(10).fill(0) }
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(filteredPage), { status: 200 }))

    const { result } = renderHook(() =>
      useActivityStream({
        workspaceId: 'w1',
        filters: { agents: ['a1'], tasks: [], types: [] },
        initial: INITIAL, // unfiltered — must NOT be what lands in the buffer
      }),
    )

    // Nothing opens synchronously: the refetch must land first.
    expect(FakeEventSource.instances).toHaveLength(0)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/w/w1/activity?agents=a1'))
    // The buffer is the filtered page (7, 9), not INITIAL's unfiltered (1, 2, 3).
    expect(result.current.events.map((e) => e.seq)).toEqual([7, 9])

    const url = FakeEventSource.instances[0]?.url ?? ''
    expect(url.startsWith('/api/w/w1/activity/stream?')).toBe(true)
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('agents')).toBe('a1')
    expect(params.get('from')).toBe('9')
  })

  it('appends arriving events in seq order', () => {
    const { result } = renderHook(() =>
      useActivityStream({ workspaceId: 'w1', filters: EMPTY_ACTIVITY_FILTERS, initial: INITIAL }),
    )

    push({ seq: 4, ts: new Date().toISOString(), type: 'task.started', actor: 'system', workspaceId: 'w1', payload: { title: 'x' } })
    push({ seq: 5, ts: new Date().toISOString(), type: 'task.started', actor: 'system', workspaceId: 'w1', payload: { title: 'y' } })

    expect(result.current.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('deduplicates arriving events by seq', () => {
    const { result } = renderHook(() =>
      useActivityStream({ workspaceId: 'w1', filters: EMPTY_ACTIVITY_FILTERS, initial: INITIAL }),
    )

    push({ seq: 4, ts: new Date().toISOString(), type: 'task.started', actor: 'system', workspaceId: 'w1', payload: { title: 'x' } })
    push({ seq: 4, ts: new Date().toISOString(), type: 'task.started', actor: 'system', workspaceId: 'w1', payload: { title: 'x' } })

    expect(result.current.events.map((e) => e.seq)).toEqual([1, 2, 3, 4])
  })

  it('derives summary client-side from the raw ExecutionEvent envelope with feedSummary', () => {
    const { result } = renderHook(() =>
      useActivityStream({ workspaceId: 'w1', filters: EMPTY_ACTIVITY_FILTERS, initial: INITIAL }),
    )

    push({
      seq: 4,
      ts: new Date().toISOString(),
      type: 'run.tool_call',
      actor: 'agent',
      workspaceId: 'w1',
      agentId: 'a1',
      payload: { name: 'Write', summary: 'Write x.txt' },
    })

    const appended = result.current.events.find((e) => e.seq === 4)
    expect(appended?.summary).toBe('Write x.txt')
    expect(appended?.agentId).toBe('a1')
    expect(appended?.taskId).toBeNull()
  })

  it('closes the source and refetches page 1 when filters change (deep inequality)', async () => {
    const page1: { events: ActivityEventRow[]; nextBefore: number | null; sparkline: number[] } = {
      events: [row(9), row(8)],
      nextBefore: 8,
      sparkline: new Array(10).fill(0),
    }
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(page1), { status: 200 }))

    const { result, rerender } = renderHook(
      ({ filters }: { filters: ActivityFilters }) => useActivityStream({ workspaceId: 'w1', filters, initial: INITIAL }),
      { initialProps: { filters: EMPTY_ACTIVITY_FILTERS } },
    )

    expect(FakeEventSource.instances).toHaveLength(1)
    const first = FakeEventSource.instances[0]

    rerender({ filters: { agents: ['a1'], tasks: [], types: [] } })

    expect(first?.closed).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.events.map((e) => e.seq)).toEqual([8, 9])
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/w/w1/activity?'))
    expect(FakeEventSource.instances).toHaveLength(2)
    const secondUrl = FakeEventSource.instances[1]?.url ?? ''
    expect(new URLSearchParams(secondUrl.split('?')[1]).get('from')).toBe('9')
  })

  it('does not tear down the stream when the same filter set arrives in a different order', async () => {
    const { rerender } = renderHook(
      ({ filters }: { filters: ActivityFilters }) => useActivityStream({ workspaceId: 'w1', filters, initial: INITIAL }),
      { initialProps: { filters: { agents: ['a1', 'a2'], tasks: [], types: [] } } },
    )

    // A non-empty filter set is present at mount, so this takes the refetch branch (Finding 1)
    // and the stream doesn't open until that refetch resolves.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(FakeEventSource.instances).toHaveLength(1)

    rerender({ filters: { agents: ['a2', 'a1'], tasks: [], types: [] } })

    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0]?.closed).toBe(false)
  })

  it('does not refetch when the filters rerender with a new but deeply-equal object', () => {
    const { rerender } = renderHook(
      ({ filters }: { filters: ActivityFilters }) => useActivityStream({ workspaceId: 'w1', filters, initial: INITIAL }),
      { initialProps: { filters: EMPTY_ACTIVITY_FILTERS } },
    )

    expect(FakeEventSource.instances).toHaveLength(1)

    rerender({ filters: { agents: [], tasks: [], types: [] } })

    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0]?.closed).toBe(false)
  })

  it('loadOlder GETs before=<oldest seq> and prepends the results', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ events: [row(0)], nextBefore: null }), { status: 200 }))

    const { result } = renderHook(() =>
      useActivityStream({ workspaceId: 'w1', filters: EMPTY_ACTIVITY_FILTERS, initial: INITIAL }),
    )

    await act(async () => {
      result.current.loadOlder()
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('before=1'))
    expect(result.current.events.map((e) => e.seq)).toEqual([0, 1, 2, 3])
  })

  it('sets exhausted when loadOlder receives nextBefore: null', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ events: [row(0)], nextBefore: null }), { status: 200 }))

    const { result } = renderHook(() =>
      useActivityStream({ workspaceId: 'w1', filters: EMPTY_ACTIVITY_FILTERS, initial: INITIAL }),
    )

    expect(result.current.exhausted).toBe(false)

    await act(async () => {
      result.current.loadOlder()
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.exhausted).toBe(true)
  })

  it('allows only one in-flight loadOlder at a time', async () => {
    let resolveFetch!: (response: Response) => void
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
    )

    const { result } = renderHook(() =>
      useActivityStream({ workspaceId: 'w1', filters: EMPTY_ACTIVITY_FILTERS, initial: INITIAL }),
    )

    act(() => {
      result.current.loadOlder()
    })
    expect(result.current.loadingOlder).toBe(true)

    act(() => {
      result.current.loadOlder()
    })

    // Only the first call's fetch went out.
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFetch(new Response(JSON.stringify({ events: [], nextBefore: null }), { status: 200 }))
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.loadingOlder).toBe(false)
  })

  it('discards a stale loadOlder completion after the filters change mid-flight', async () => {
    let resolveOld!: (response: Response) => void
    const oldFetch = new Promise<Response>((resolve) => {
      resolveOld = resolve
    })
    // Call order is deterministic: (1) loadOlder's `before=1` fetch under the OLD filters,
    // dispatched synchronously below; (2) the filter-switch's own page-1 refetch, dispatched by
    // the rerender that follows.
    fetchMock.mockImplementationOnce(() => oldFetch)
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ events: [row(20)], nextBefore: null, sparkline: new Array(10).fill(0) }), {
          status: 200,
        }),
    )

    const { result, rerender } = renderHook(
      ({ filters }: { filters: ActivityFilters }) => useActivityStream({ workspaceId: 'w1', filters, initial: INITIAL }),
      { initialProps: { filters: EMPTY_ACTIVITY_FILTERS } },
    )

    act(() => {
      result.current.loadOlder()
    })
    expect(result.current.loadingOlder).toBe(true)

    rerender({ filters: { agents: ['a1'], tasks: [], types: [] } })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // The new filter's page 1 landed: buffer and cursor reflect it.
    expect(result.current.events.map((e) => e.seq)).toEqual([20])
    expect(result.current.exhausted).toBe(true)

    await act(async () => {
      resolveOld(new Response(JSON.stringify({ events: [row(0)], nextBefore: 0 }), { status: 200 }))
      await vi.advanceTimersByTimeAsync(0)
    })

    // The stale old-filter completion must not splice into the new buffer or reopen the cursor —
    // and must still clear the loading flag it set, so a real loadOlder click isn't stuck forever.
    expect(result.current.events.map((e) => e.seq)).toEqual([20])
    expect(result.current.exhausted).toBe(true)
    expect(result.current.loadingOlder).toBe(false)
  })

  it('reports reconnecting on stream error and connected on open', () => {
    const { result } = renderHook(() =>
      useActivityStream({ workspaceId: 'w1', filters: EMPTY_ACTIVITY_FILTERS, initial: INITIAL }),
    )

    act(() => {
      FakeEventSource.instances[0]?.onerror?.()
    })
    expect(result.current.connection).toBe('reconnecting')

    act(() => {
      FakeEventSource.instances[0]?.onopen?.()
    })
    expect(result.current.connection).toBe('connected')
  })

  it('increments the current sparkline bucket on run.tool_call arrival', () => {
    const { result } = renderHook(() =>
      useActivityStream({ workspaceId: 'w1', filters: EMPTY_ACTIVITY_FILTERS, initial: INITIAL }),
    )

    const before = result.current.sparkline.at(-1) ?? 0

    push({
      seq: 4,
      ts: new Date().toISOString(),
      type: 'run.tool_call',
      actor: 'agent',
      workspaceId: 'w1',
      agentId: 'a1',
      payload: { name: 'Write', summary: 'Write x.txt' },
    })

    expect(result.current.sparkline.at(-1)).toBe(before + 1)
  })

  it('rotates sparkline buckets left on a minute-boundary timer', async () => {
    const { result } = renderHook(() =>
      useActivityStream({ workspaceId: 'w1', filters: EMPTY_ACTIVITY_FILTERS, initial: INITIAL }),
    )

    const initialBuckets = [...result.current.sparkline]

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    expect(result.current.sparkline).toEqual([...initialBuckets.slice(1), 0])
  })

  it('closes the source and clears the sparkline timer on unmount', () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval')
    const { unmount } = renderHook(() =>
      useActivityStream({ workspaceId: 'w1', filters: EMPTY_ACTIVITY_FILTERS, initial: INITIAL }),
    )

    unmount()

    expect(FakeEventSource.instances[0]?.closed).toBe(true)
    expect(clearIntervalSpy).toHaveBeenCalled()
  })

  it('Finding 2: an empty filtered page 1 omits `from` on the stream URL instead of sending from=0', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ events: [], nextBefore: null, sparkline: new Array(10).fill(0) }), {
          status: 200,
        }),
    )

    renderHook(() =>
      useActivityStream({
        workspaceId: 'w1',
        filters: { agents: ['a1'], tasks: [], types: [] },
        initial: INITIAL,
      }),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    const url = FakeEventSource.instances[0]?.url ?? ''
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.has('from')).toBe(false)
  })

  it('Finding 3: a filter switch re-seeds the sparkline from the history response, not just the live stream', async () => {
    const freshSparkline = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ events: [row(9)], nextBefore: null, sparkline: freshSparkline }), {
          status: 200,
        }),
    )

    const { result, rerender } = renderHook(
      ({ filters }: { filters: ActivityFilters }) => useActivityStream({ workspaceId: 'w1', filters, initial: INITIAL }),
      { initialProps: { filters: EMPTY_ACTIVITY_FILTERS } },
    )

    // Seeded from `initial.sparkline` at mount (unfiltered — no refetch involved).
    expect(result.current.sparkline).toEqual(INITIAL.sparkline)

    rerender({ filters: { agents: ['a1'], tasks: [], types: [] } })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // Re-seeded from the history route's response, not merely rotated/incremented client-side.
    expect(result.current.sparkline).toEqual(freshSparkline)
  })

  it('Finding 4: a rejected page-1 refetch still opens the stream (from the last known watermark) instead of leaving a dead page reporting stale state', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('network down')
    })

    const { result, rerender } = renderHook(
      ({ filters }: { filters: ActivityFilters }) => useActivityStream({ workspaceId: 'w1', filters, initial: INITIAL }),
      { initialProps: { filters: EMPTY_ACTIVITY_FILTERS } },
    )

    expect(FakeEventSource.instances).toHaveLength(1) // unfiltered mount: no fetch involved yet

    rerender({ filters: { agents: ['a1'], tasks: [], types: [] } })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // The failure surfaces...
    expect(result.current.error).toBeTruthy()
    // ...but the stream reopened anyway, from the last watermark this instance actually held
    // (INITIAL's newest seq, 3) — the live tail survives the failed history fetch instead of
    // `sourceRef` staying null with the page still looking connected.
    expect(FakeEventSource.instances).toHaveLength(2)
    const url = FakeEventSource.instances[1]?.url ?? ''
    expect(new URLSearchParams(url.split('?')[1]).get('from')).toBe('3')
  })
})
