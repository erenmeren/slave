// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTasks } from '../src/hooks/useTasks.js'
import type { TasksSnapshot } from '../src/server/tasks.js'

const SNAPSHOT: TasksSnapshot = {
  workspace: { id: 'w1', name: 'W', haltedReason: null },
  shellFacts: {
    workspace: { id: 'w1', name: 'W' },
    counts: { agentsWorking: 0, tasksActive: 0 },
    guardrails: { budgetUsd: 20, maxConcurrentRuns: 3, runTimeoutMs: 3_600_000, maxAttempts: 3 },
    status: { goal: null, spentUsd: 0, unmeasuredRuns: 0, haltedReason: null },
  },
  tasks: [
    {
      id: 't1',
      title: 'Add the thing',
      description: 'Add the thing to the app',
      status: 'running',
      priority: 1,
      attempt: 1,
      maxAttempts: 3,
      assigneeName: 'Alex',
      branch: 'feature/add-the-thing',
      lastRejectionReason: null,
      collectable: false,
      artifacts: [],
      runs: [
        {
          id: 'r1',
          status: 'working',
          costUsd: 0.1,
          toolCalls: 2,
          startedAt: new Date(0).toISOString(),
          endedAt: null,
          worktreePath: null,
          checkpoint: null,
        },
      ],
    },
  ],
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

describe('useTasks', () => {
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

  it('connects to the workspace event stream and fetches the tasks endpoint on refetch', async (): Promise<void> => {
    renderHook(() => useTasks('w1', SNAPSHOT))

    expect(FakeEventSource.instances[0]?.url).toBe('/api/w/w1/events')

    push({ seq: 1, type: 'task.started' })
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/tasks')
  })

  it('refetches the snapshot once per event burst, not once per event', async (): Promise<void> => {
    renderHook(() => useTasks('w1', SNAPSHOT))

    for (let i = 0; i < 5; i += 1) {
      push({ seq: i + 1, type: 'task.started' })
    }
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('updates the snapshot after a refetched event lands', async (): Promise<void> => {
    const updated: TasksSnapshot = {
      ...SNAPSHOT,
      tasks: [{ ...SNAPSHOT.tasks[0]!, status: 'done' }],
    }
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(updated), { status: 200 }))
    const { result } = renderHook(() => useTasks('w1', SNAPSHOT))

    push({ seq: 1, type: 'task.updated' })
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(result.current.snapshot).toEqual(updated)
  })

  it('keeps the last snapshot and surfaces the error when a refetch fails', async (): Promise<void> => {
    fetchMock.mockImplementation(async () => new Response('db unreachable', { status: 500 }))
    const { result } = renderHook(() => useTasks('w1', SNAPSHOT))

    push({ seq: 1, type: 'task.started' })
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(result.current.snapshot).toEqual(SNAPSHOT)
    vi.useRealTimers()
    await waitFor(() => expect(result.current.error).not.toBeNull())
  })

  it('reports reconnecting on stream error and connected on open', (): void => {
    const { result } = renderHook(() => useTasks('w1', SNAPSHOT))

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
    const { unmount } = renderHook(() => useTasks('w1', SNAPSHOT))

    unmount()

    expect(FakeEventSource.instances[0]?.closed).toBe(true)
  })
})
