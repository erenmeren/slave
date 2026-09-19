// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHome } from '../src/hooks/useHome.js'
import type { HomeSnapshot } from '../src/server/home.js'

// Mirrors `useHome.ts`'s own local `HOME_POLL_MS` -- not imported from `server/home.js`, the same
// boundary the hook itself documents (a value import there drags Prisma into a browser bundle;
// here it would spin up a real Prisma client in every unit-test process for no reason).
const HOME_POLL_MS = 10_000

function snapshot(): HomeSnapshot {
  return {
    projects: [],
    needsYou: [],
    feed: [],
    numbers: { peopleWorking: 0, peopleIdle: 0, spendUsd: 0, unmeasured: false, finishedThisWeek: 0 },
    kpis: [],
  }
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useHome', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach((): void => {
    vi.useFakeTimers()
    setVisibility('visible')
    fetchMock = vi.fn(async () => new Response(JSON.stringify(snapshot()), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach((): void => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  it('does not fetch on mount -- the server render is already fresh', (): void => {
    const initial = snapshot()
    renderHook(() => useHome(initial, false))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('polls again after HOME_POLL_MS while the tab stays visible', async (): Promise<void> => {
    // `initial` is hoisted OUTSIDE the render callback, held stable across re-renders --
    // `renderHook`'s callback re-runs on every render of the hook's host, and a fresh `snapshot()`
    // literal there would make `useHome`'s own `initial`-resync effect fire (and re-render) on
    // every single render, forever.
    const initial = snapshot()
    renderHook(() => useHome(initial, false))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOME_POLL_MS)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOME_POLL_MS)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not poll while the tab is hidden', async (): Promise<void> => {
    setVisibility('hidden')
    const initial = snapshot()
    renderHook(() => useHome(initial, false))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOME_POLL_MS * 2)
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refetches once when the tab becomes visible again', async (): Promise<void> => {
    setVisibility('hidden')
    const initial = snapshot()
    renderHook(() => useHome(initial, false))
    expect(fetchMock).not.toHaveBeenCalled()

    await act(async () => {
      setVisibility('visible')
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('requests ?archived=1 when archived is true', async (): Promise<void> => {
    const initial = snapshot()
    renderHook(() => useHome(initial, true))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOME_POLL_MS)
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/home?archived=1', expect.anything())
  })

  it('aborts the in-flight fetch on unmount', (): void => {
    const initial = snapshot()
    const { unmount } = renderHook(() => useHome(initial, false))
    expect(() => unmount()).not.toThrow()
  })
})
