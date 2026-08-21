// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceStream, type StreamEvent } from '../src/hooks/useWorkspaceStream.js'

interface Snapshot {
  readonly count: number
}

const SNAPSHOT: Snapshot = { count: 0 }

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

describe('useWorkspaceStream', () => {
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
    renderHook(() =>
      useWorkspaceStream<Snapshot>({ workspaceId: 'w1', endpoint: '/api/w/w1/overview', initial: SNAPSHOT }),
    )

    for (let i = 0; i < 5; i += 1) {
      push({ seq: i + 1, type: 'task.started' })
    }
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('schedules a refetch when the stream opens, closing the snapshot-to-stream gap', async (): Promise<void> => {
    renderHook(() =>
      useWorkspaceStream<Snapshot>({ workspaceId: 'w1', endpoint: '/api/w/w1/overview', initial: SNAPSHOT }),
    )

    act((): void => {
      FakeEventSource.instances[0]?.onopen?.()
    })
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('calls onEvent for every parsed event, synchronously and before the debounced refetch', (): void => {
    const onEvent = vi.fn()
    renderHook(() =>
      useWorkspaceStream<Snapshot>({
        workspaceId: 'w1',
        endpoint: '/api/w/w1/overview',
        initial: SNAPSHOT,
        onEvent,
      }),
    )

    push({ seq: 1, type: 'run.tool_call', agentId: 'a1', runId: 'r1', payload: { summary: 'Write x.txt' } })

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'run.tool_call', agentId: 'a1', runId: 'r1' }),
    )
    // No timer advance: onEvent must not wait for the debounce.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('calls onSnapshot with the refetched snapshot after it lands, not before', async (): Promise<void> => {
    const newer: Snapshot = { count: 7 }
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(newer), { status: 200 }))
    const onSnapshot = vi.fn()
    renderHook(() =>
      useWorkspaceStream<Snapshot>({
        workspaceId: 'w1',
        endpoint: '/api/w/w1/overview',
        initial: SNAPSHOT,
        onSnapshot,
      }),
    )

    push({ seq: 1, type: 'task.started' })
    expect(onSnapshot).not.toHaveBeenCalled()

    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(onSnapshot).toHaveBeenCalledTimes(1)
    expect(onSnapshot).toHaveBeenCalledWith(newer)
  })

  it('does not open a second EventSource when onEvent/onSnapshot identity churns across renders', (): void => {
    const { rerender } = renderHook(
      ({ onEvent, onSnapshot }: { onEvent: (event: StreamEvent) => void; onSnapshot: (snapshot: Snapshot) => void }) =>
        useWorkspaceStream<Snapshot>({ workspaceId: 'w1', endpoint: '/api/w/w1/overview', initial: SNAPSHOT, onEvent, onSnapshot }),
      { initialProps: { onEvent: (): void => {}, onSnapshot: (): void => {} } },
    )

    expect(FakeEventSource.instances).toHaveLength(1)

    // Every render below hands the hook a brand-new closure identity for both callbacks — the
    // effect's dependency array is only [workspaceId, endpoint], so this must not tear down and
    // reopen the EventSource.
    rerender({ onEvent: (): void => {}, onSnapshot: (): void => {} })
    rerender({ onEvent: (): void => {}, onSnapshot: (): void => {} })

    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0]?.closed).toBe(false)
  })

  it('still invokes the latest onEvent/onSnapshot after identity churn, via the ref', async (): Promise<void> => {
    const firstOnEvent = vi.fn()
    const secondOnEvent = vi.fn()
    const { rerender } = renderHook(
      ({ onEvent }: { onEvent: (event: StreamEvent) => void }) =>
        useWorkspaceStream<Snapshot>({ workspaceId: 'w1', endpoint: '/api/w/w1/overview', initial: SNAPSHOT, onEvent }),
      { initialProps: { onEvent: firstOnEvent } },
    )

    rerender({ onEvent: secondOnEvent })

    push({ seq: 1, type: 'task.started' })

    expect(firstOnEvent).not.toHaveBeenCalled()
    expect(secondOnEvent).toHaveBeenCalledTimes(1)
  })

  it('ignores an event payload it does not recognize', (): void => {
    const onEvent = vi.fn()
    const { result } = renderHook(() =>
      useWorkspaceStream<Snapshot>({ workspaceId: 'w1', endpoint: '/api/w/w1/overview', initial: SNAPSHOT, onEvent }),
    )

    push({ garbage: true })

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(result.current.snapshot).toEqual(SNAPSHOT)
  })

  it('ignores a bare JSON primitive payload without crashing', (): void => {
    const onEvent = vi.fn()
    const { result } = renderHook(() =>
      useWorkspaceStream<Snapshot>({ workspaceId: 'w1', endpoint: '/api/w/w1/overview', initial: SNAPSHOT, onEvent }),
    )

    expect(() => push(null)).not.toThrow()
    expect(() => push(42)).not.toThrow()

    expect(onEvent).not.toHaveBeenCalled()
    expect(result.current.snapshot).toEqual(SNAPSHOT)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('drops a stale refetch response that resolves after a newer one already landed', async (): Promise<void> => {
    const older: Snapshot = { count: 1 }
    const newer: Snapshot = { count: 2 }

    let resolveOlder!: (response: Response) => void
    const olderResponse = new Promise<Response>((resolve): void => {
      resolveOlder = resolve
    })
    fetchMock.mockImplementationOnce(() => olderResponse)
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify(newer), { status: 200 }))

    const { result } = renderHook(() =>
      useWorkspaceStream<Snapshot>({ workspaceId: 'w1', endpoint: '/api/w/w1/overview', initial: SNAPSHOT }),
    )

    push({ seq: 1, type: 'task.started' })
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(300)
    })

    push({ seq: 2, type: 'task.started' })
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(result.current.snapshot).toEqual(newer)

    await act(async (): Promise<void> => {
      resolveOlder(new Response(JSON.stringify(older), { status: 200 }))
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.snapshot).toEqual(newer)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reports reconnecting on stream error and connected on open', (): void => {
    const { result } = renderHook(() =>
      useWorkspaceStream<Snapshot>({ workspaceId: 'w1', endpoint: '/api/w/w1/overview', initial: SNAPSHOT }),
    )

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
    const { result } = renderHook(() =>
      useWorkspaceStream<Snapshot>({ workspaceId: 'w1', endpoint: '/api/w/w1/overview', initial: SNAPSHOT }),
    )

    push({ seq: 1, type: 'task.started' })
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(result.current.snapshot).toEqual(SNAPSHOT)
    vi.useRealTimers()
    await waitFor(() => expect(result.current.error).not.toBeNull())
  })

  it('closes the EventSource on unmount', (): void => {
    const { unmount } = renderHook(() =>
      useWorkspaceStream<Snapshot>({ workspaceId: 'w1', endpoint: '/api/w/w1/overview', initial: SNAPSHOT }),
    )

    unmount()

    expect(FakeEventSource.instances[0]?.closed).toBe(true)
  })
})
