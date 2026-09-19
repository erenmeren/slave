// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHome } from '../src/hooks/useHome.js'
import { ModeProvider } from '../src/components/mode/ModeProvider.js'
import { MODE_STORAGE_KEY } from '../src/lib/modeStorage.js'
import type { HomeSnapshot } from '../src/server/home.js'

// Mirrors `useHome.ts`'s own local `HOME_POLL_MS` -- not imported from `server/home.js`, the same
// boundary the hook itself documents (a value import there drags Prisma into a browser bundle;
// here it would spin up a real Prisma client in every unit-test process for no reason).
const HOME_POLL_MS = 10_000

function snapshot(over: Partial<HomeSnapshot> = {}): HomeSnapshot {
  return {
    projects: [],
    needsYou: [],
    feed: [],
    numbers: { peopleWorking: 0, peopleIdle: 0, spendUsd: 0, unmeasured: false, finishedThisWeek: 0 },
    kpis: [],
    ...over,
  }
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** jsdom implements `localStorage` but this runner never hands it over (`command-strip.test.tsx`'s
 *  own note) -- `ModeProvider`'s hydration effect needs a working one. */
function installStorage(): void {
  const cells = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string): string | null => cells.get(key) ?? null,
    setItem: (key: string, value: string): void => void cells.set(key, value),
    removeItem: (key: string): void => void cells.delete(key),
    clear: (): void => cells.clear(),
  })
}

/** I4 (final-review wave): `useHome` now reads `useMode()` -- every `renderHook` below needs the
 *  same `<ModeProvider>` a real page tree provides. */
function wrapper({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return <ModeProvider>{children}</ModeProvider>
}

describe('useHome', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach((): void => {
    vi.useFakeTimers()
    installStorage()
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
    renderHook(() => useHome(initial, false), { wrapper })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('polls again after HOME_POLL_MS while the tab stays visible', async (): Promise<void> => {
    // `initial` is hoisted OUTSIDE the render callback, held stable across re-renders --
    // `renderHook`'s callback re-runs on every render of the hook's host, and a fresh `snapshot()`
    // literal there would make `useHome`'s own `initial`-resync effect fire (and re-render) on
    // every single render, forever.
    const initial = snapshot()
    renderHook(() => useHome(initial, false), { wrapper })

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
    renderHook(() => useHome(initial, false), { wrapper })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOME_POLL_MS * 2)
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refetches once when the tab becomes visible again', async (): Promise<void> => {
    setVisibility('hidden')
    const initial = snapshot()
    renderHook(() => useHome(initial, false), { wrapper })
    expect(fetchMock).not.toHaveBeenCalled()

    await act(async () => {
      setVisibility('visible')
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('requests ?archived=1 when archived is true', async (): Promise<void> => {
    const initial = snapshot()
    renderHook(() => useHome(initial, true), { wrapper })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOME_POLL_MS)
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/home?archived=1', expect.anything())
  })

  it('requests ?kpis=1 only in developer mode (I4)', async (): Promise<void> => {
    const initial = snapshot()
    renderHook(() => useHome(initial, false), { wrapper })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOME_POLL_MS)
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/home', expect.anything())

    fetchMock.mockClear()
    window.localStorage.setItem(MODE_STORAGE_KEY, 'developer')
    const developerInitial = snapshot()
    renderHook(() => useHome(developerInitial, false), { wrapper })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOME_POLL_MS)
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/home?kpis=1', expect.anything())
  })

  it('aborts the in-flight fetch on unmount, and a response arriving after unmount never reaches state', async (): Promise<void> => {
    // A fetch the test controls the resolution of, unlike the auto-resolving `beforeEach` mock --
    // this is what lets the assertion below actually distinguish "the guard works" from "the
    // request just happened to finish before `unmount()` ran".
    let resolveFetch: ((response: Response) => void) | null = null
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
    const controlledFetch = vi.fn((_url: string, _options: { signal: AbortSignal }) => pending)
    vi.stubGlobal('fetch', controlledFetch)

    const initial = snapshot()
    const { unmount, result } = renderHook(() => useHome(initial, false), { wrapper })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOME_POLL_MS)
    })
    expect(controlledFetch).toHaveBeenCalledTimes(1)
    const options = controlledFetch.mock.calls[0]?.[1] as { signal: AbortSignal }
    expect(options.signal.aborted).toBe(false)

    unmount()
    expect(options.signal.aborted).toBe(true)

    // The response lands AFTER unmount -- a distinguishable snapshot, so a guard that failed to
    // drop it would show up here rather than passing by coincidence. `pending` is awaited twice
    // (once as `load()`'s own continuation, once here) with an extra microtask flush after, so
    // `load()`'s post-`await` guard has definitely run before the assertion reads `result.current`.
    await act(async () => {
      resolveFetch?.(new Response(JSON.stringify(snapshot({ numbers: { peopleWorking: 0, peopleIdle: 0, spendUsd: 0, unmeasured: false, finishedThisWeek: 999 } })), { status: 200 }))
      await pending
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current).toEqual(initial)
  })
})
