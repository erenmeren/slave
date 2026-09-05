// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useGraph } from '../src/hooks/useGraph.js'
import type { GraphSnapshot } from '../src/server/graph.js'

// Fixture widening only (M14 Task 11): `GraphSnapshot` gained `shellFacts` and `GraphSlave` gained
// the drawer's facts. This hook test asserts on neither -- it only round-trips whatever it is given.
const SHELL_FACTS: GraphSnapshot['shellFacts'] = {
  workspace: { id: 'w1', name: 'W' },
  counts: { slavesWorking: 0, tasksActive: 0 },
  guardrails: { budgetUsd: null, maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 3 },
  status: { goal: null, spentUsd: 0, unmeasuredRuns: 0, haltedReason: null },
}

const SNAPSHOT: GraphSnapshot = {
  shellFacts: SHELL_FACTS,
  workspace: { id: 'w1', name: 'W', haltedReason: null },
  teams: [{ id: 'team1', name: 'Engineering' }],
  slaves: [
    {
      id: 'a1',
      name: 'Alex',
      role: 'backend',
      teamId: 'team1',
      status: 'idle',
      activeTaskId: null,
      activeTaskTitle: null,
      activeRunId: null,
      provider: null,
      model: null,
      progressPct: 0,
      checkpoints: [],
      recentEvents: [],
      hasSkillData: false,
    },
  ],
  tasks: [
    {
      id: 't1',
      title: 'Add the thing',
      status: 'ready',
      priority: 1,
      attempt: 0,
      maxAttempts: 3,
      dependenciesDone: true,
    },
  ],
  dependencies: [],
}

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

describe('useGraph', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach((): void => {
    vi.useFakeTimers()
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource)
    fetchMock = vi.fn(async () => new Response(JSON.stringify(SNAPSHOT), { status: 200 }))
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

  it('connects to the workspace event stream and fetches the graph endpoint on refetch', async (): Promise<void> => {
    renderHook(() => useGraph('w1', SNAPSHOT))

    expect(FakeEventSource.instances[0]?.url).toBe('/api/w/w1/events')

    push({ seq: 1, type: 'task.dependency_added' })
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/graph')
  })

  it('refetches the snapshot once per event burst, not once per event', async (): Promise<void> => {
    renderHook(() => useGraph('w1', SNAPSHOT))

    for (let i = 0; i < 5; i += 1) {
      push({ seq: i + 1, type: 'task.started' })
    }
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('updates the snapshot after a refetched event lands', async (): Promise<void> => {
    const updated: GraphSnapshot = {
      ...SNAPSHOT,
      tasks: [{ ...SNAPSHOT.tasks[0]!, status: 'done' }],
    }
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(updated), { status: 200 }))
    const { result } = renderHook(() => useGraph('w1', SNAPSHOT))

    push({ seq: 1, type: 'task.done' })
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(result.current.snapshot).toEqual(updated)
  })

  it('keeps the last snapshot and surfaces the error when a refetch fails', async (): Promise<void> => {
    fetchMock.mockImplementation(async () => new Response('db unreachable', { status: 500 }))
    const { result } = renderHook(() => useGraph('w1', SNAPSHOT))

    push({ seq: 1, type: 'task.started' })
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(result.current.snapshot).toEqual(SNAPSHOT)
    vi.useRealTimers()
    await waitFor(() => expect(result.current.error).not.toBeNull())
  })

  it('reports reconnecting on stream error and connected on open', (): void => {
    const { result } = renderHook(() => useGraph('w1', SNAPSHOT))

    act((): void => {
      FakeEventSource.instances[0]?.onerror?.()
    })
    expect(result.current.connection).toBe('reconnecting')

    act((): void => {
      FakeEventSource.instances[0]?.onopen?.()
    })
    expect(result.current.connection).toBe('connected')
  })

  it('closes the EventSource on unmount', (): void => {
    const { unmount } = renderHook(() => useGraph('w1', SNAPSHOT))

    unmount()

    expect(FakeEventSource.instances[0]?.closed).toBe(true)
  })

  it('passes every raw frame to onEvent, recognized or not, without waiting for the debounce', (): void => {
    const onEvent = vi.fn()
    renderHook(() => useGraph('w1', SNAPSHOT, onEvent))

    push({ seq: 1, type: 'task.dependency_added', taskId: 't1' })

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ seq: 1, type: 'task.dependency_added', taskId: 't1' }))
  })

  it('does not resubscribe the EventSource when onEvent identity churns across renders', (): void => {
    const { rerender } = renderHook(({ onEvent }: { onEvent: (event: unknown) => void }) => useGraph('w1', SNAPSHOT, onEvent), {
      initialProps: { onEvent: (): void => {} },
    })

    expect(FakeEventSource.instances).toHaveLength(1)

    rerender({ onEvent: (): void => {} })
    rerender({ onEvent: (): void => {} })

    expect(FakeEventSource.instances).toHaveLength(1)
  })
})
