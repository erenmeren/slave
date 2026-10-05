import { vi } from 'vitest'

/**
 * What jsdom lacks and the shadcn/Radix components ask for: `matchMedia` (the sidebar's phone
 * check, the theme's System), `ResizeObserver` (Radix's popovers and the command list) and
 * `scrollIntoView` (cmdk). Call once at the top of a component test file.
 */
export function stubBrowser(): void {
  if (typeof window === 'undefined') return
  window.matchMedia ??= vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
  Element.prototype.scrollIntoView ??= vi.fn()
}

/** A `fetch` that answers every call with `body` (status 200 unless given), recording the calls. */
export function stubFetch(answer: (url: string, init?: RequestInit) => { status?: number; body: unknown }): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const { status = 200, body } = answer(url, init)
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
