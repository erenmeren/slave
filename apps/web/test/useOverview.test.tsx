// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useOverview } from '../src/hooks/useOverview.js'
import type { OverviewSnapshot } from '../src/server/overview.js'

const SNAPSHOT: OverviewSnapshot = {
  workspace: { id: 'w1', name: 'W', haltedReason: null, haltedAt: null, budgetUsd: 100, spentUsd: 0 },
  agents: [
    {
      id: 'a1',
      name: 'Alex',
      role: 'backend',
      provider: 'claude-code',
      status: 'working',
      taskTitle: 'Add the thing',
      actionLine: null,
      runId: 'r1',
    },
  ],
  tasks: { active: 1, blocked: 0, done: 0, failed: 0 },
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

describe('useOverview', () => {
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

  it('refetches the snapshot once per event burst, not once per event', async (): Promise<void> => {
    renderHook(() => useOverview('w1', SNAPSHOT))

    for (let i = 0; i < 5; i += 1) {
      push({ seq: i + 1, ts: new Date(0).toISOString(), workspaceId: 'w1', actor: 'system', type: 'task.started', payload: { title: 'x' } })
    }
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(300)
    })

    // The wake-up rule (spec §6): a chatty run costs one query per debounce window. Five fetches
    // here means the debounce is decorative and a real run hammers the snapshot endpoint.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('updates the action line immediately from run.tool_call, before any refetch', (): void => {
    const { result } = renderHook(() => useOverview('w1', SNAPSHOT))

    push({
      seq: 1,
      ts: new Date(0).toISOString(),
      workspaceId: 'w1',
      agentId: 'a1',
      runId: 'r1',
      actor: 'agent',
      type: 'run.tool_call',
      payload: { name: 'Write', summary: 'Write note3.txt' },
    })

    // No timer advance: the line is the one thing that must not wait for the debounce (spec §6).
    expect(result.current.actionLines['a1']).toBe('Write note3.txt')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ignores an event payload it does not recognize', (): void => {
    const { result } = renderHook(() => useOverview('w1', SNAPSHOT))

    push({ garbage: true })

    // Malformed data must not take the page down (spec §9): no throw, no state change.
    expect(result.current.actionLines).toEqual({})
    expect(result.current.snapshot).toEqual(SNAPSHOT)
  })

  it('ignores a bare JSON primitive payload without crashing', (): void => {
    const { result } = renderHook(() => useOverview('w1', SNAPSHOT))

    // `JSON.parse('null')` and `JSON.parse('42')` both succeed, so the handler cannot rely on the
    // parse's try/catch alone — it must also reject a parsed value that is not an object (spec §9).
    expect(() => push(null)).not.toThrow()
    expect(() => push(42)).not.toThrow()

    expect(result.current.actionLines).toEqual({})
    expect(result.current.snapshot).toEqual(SNAPSHOT)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('drops a stale refetch response that resolves after a newer one already landed', async (): Promise<void> => {
    const older: OverviewSnapshot = { ...SNAPSHOT, workspace: { ...SNAPSHOT.workspace, spentUsd: 1 } }
    const newer: OverviewSnapshot = { ...SNAPSHOT, workspace: { ...SNAPSHOT.workspace, spentUsd: 2 } }

    // The first refetch's fetch() call hangs until the test resolves it by hand; the second
    // resolves immediately — so the second (newer) response lands first, exactly the race the
    // sequence guard exists for.
    let resolveOlder!: (response: Response) => void
    const olderResponse = new Promise<Response>((resolve): void => {
      resolveOlder = resolve
    })
    fetchMock.mockImplementationOnce(() => olderResponse)
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify(newer), { status: 200 }))

    const { result } = renderHook(() => useOverview('w1', SNAPSHOT))

    push({ seq: 1, ts: new Date(0).toISOString(), workspaceId: 'w1', actor: 'system', type: 'task.started', payload: { title: 'x' } })
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(300) // fires the first (older) refetch; its fetch() is still pending
    })

    push({ seq: 2, ts: new Date(0).toISOString(), workspaceId: 'w1', actor: 'system', type: 'task.started', payload: { title: 'x' } })
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(300) // fires the second (newer) refetch, which resolves right away
    })

    expect(result.current.snapshot).toEqual(newer)

    // Now let the older, slower fetch resolve. Being older, it must not clobber the newer state.
    await act(async (): Promise<void> => {
      resolveOlder(new Response(JSON.stringify(older), { status: 200 }))
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.snapshot).toEqual(newer)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reports reconnecting on stream error and connected on open', (): void => {
    const { result } = renderHook(() => useOverview('w1', SNAPSHOT))

    act((): void => {
      FakeEventSource.instances[0]?.onerror?.()
    })
    expect(result.current.connection).toBe('reconnecting')

    act((): void => {
      FakeEventSource.instances[0]?.onopen?.()
    })
    expect(result.current.connection).toBe('connected')
  })

  it('keeps the last snapshot and surfaces the error when a refetch fails', async (): Promise<void> => {
    fetchMock.mockImplementation(async () => new Response('db unreachable', { status: 500 }))
    const { result } = renderHook(() => useOverview('w1', SNAPSHOT))

    push({ seq: 1, ts: new Date(0).toISOString(), workspaceId: 'w1', actor: 'system', type: 'task.started', payload: { title: 'x' } })
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(300)
    })

    // Never a blank screen (spec §9): the stale snapshot stays, the failure is named.
    expect(result.current.snapshot).toEqual(SNAPSHOT)
    // waitFor polls with real timers internally; the debounced fetch already resolved during the
    // advanceTimersByTimeAsync above, but waitFor's own polling loop needs real time to run under
    // fake timers, so it is switched off for this one assertion (restored in afterEach regardless).
    vi.useRealTimers()
    await waitFor(() => expect(result.current.error).not.toBeNull())
  })

  it('closes the EventSource on unmount', (): void => {
    const { unmount } = renderHook(() => useOverview('w1', SNAPSHOT))

    unmount()

    expect(FakeEventSource.instances[0]?.closed).toBe(true)
  })
})
