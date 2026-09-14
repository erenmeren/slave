// @vitest-environment jsdom
import { render, screen, act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider, useTheme, THEME_STORAGE_KEY } from '../src/components/theme/ThemeProvider.js'

/** jsdom has no `matchMedia`. One stub, whose `matches` the test drives, plus the `change`
 *  listener the provider subscribes to so that `system` tracks the OS live. */
let systemDark = false
const listeners = new Set<(event: { matches: boolean }) => void>()

function installMatchMedia(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('dark') ? systemDark : false,
    media: query,
    addEventListener: (_type: string, fn: (event: { matches: boolean }) => void) => listeners.add(fn),
    removeEventListener: (_type: string, fn: (event: { matches: boolean }) => void) => listeners.delete(fn),
  }))
}

/** jsdom DOES implement `localStorage`, but this runner never hands it over: Node 26 declares a
 *  `localStorage` global of its own (inert without `--experimental-webstorage`), and vitest's jsdom
 *  environment copies a window property onto the global only when the name is absent from Node's
 *  global or on its own allow-list -- `localStorage` is neither. So `window.localStorage` under
 *  vitest is Node's, and it is `undefined`. One in-memory stub per test, exactly the way
 *  `matchMedia` above is stubbed, is what the provider actually talks to; a fresh `Map` each time
 *  is also what keeps one test's stored choice out of the next one. */
function installStorage(): void {
  const cells = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string): string | null => cells.get(key) ?? null,
    setItem: (key: string, value: string): void => void cells.set(key, value),
    removeItem: (key: string): void => void cells.delete(key),
    clear: (): void => cells.clear(),
  })
}

/** Every value `theme` has taken, in render order. The FIRST one is its own requirement (M57
 *  ruling P22: the hydration render must agree with the server's, which has no `localStorage` to
 *  read), and only a record of the renders can see it -- by the time `render()` returns, the
 *  post-mount effect has already run. */
const renders: string[] = []

function Probe(): React.JSX.Element {
  const { theme, resolved, setTheme, cycle } = useTheme()
  renders.push(theme)
  return (
    <div>
      <span data-testid="mode">{theme}</span>
      <span data-testid="resolved">{resolved}</span>
      <button data-testid="cycle" type="button" onClick={cycle} />
      <button data-testid="to-light" type="button" onClick={() => setTheme('light')} />
    </div>
  )
}

beforeEach((): void => {
  systemDark = false
  listeners.clear()
  renders.length = 0
  installMatchMedia()
  installStorage()
  document.documentElement.removeAttribute('data-theme')
})

afterEach((): void => {
  vi.unstubAllGlobals()
})

describe('the theme provider', () => {
  it('starts on "system" with no attribute stamped -- absent IS system (R2)', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(screen.getByTestId('mode').textContent).toBe('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('resolves "system" against prefers-color-scheme, and tracks it live', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(screen.getByTestId('resolved').textContent).toBe('light')
    act((): void => {
      systemDark = true
      for (const fn of listeners) fn({ matches: true })
    })
    expect(screen.getByTestId('resolved').textContent).toBe('dark')
    // Still SYSTEM: the OS changed, the operator's choice did not.
    expect(screen.getByTestId('mode').textContent).toBe('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('cycles System -> Light -> Dark -> System, stamping the attribute for the two pinned ones', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>)
    const cycle = screen.getByTestId('cycle')
    act((): void => { cycle.click() })
    expect(screen.getByTestId('mode').textContent).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    act((): void => { cycle.click() })
    expect(screen.getByTestId('mode').textContent).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    act((): void => { cycle.click() })
    expect(screen.getByTestId('mode').textContent).toBe('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('persists the choice under the key the pre-hydration script reads', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>)
    act((): void => { screen.getByTestId('to-light').click() })
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(THEME_STORAGE_KEY).toBe('theme')
  })

  it('renders "system" FIRST even with a stored "dark", so hydration matches the server (P22)', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(renders[0]).toBe('system')
    // And then, after mount, it catches up -- which is what the next case is about.
    await waitFor((): void => {
      expect(screen.getByTestId('mode').textContent).toBe('dark')
    })
  })

  it('restores a stored choice after mount', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    render(<ThemeProvider><Probe /></ThemeProvider>)
    await waitFor((): void => {
      expect(screen.getByTestId('mode').textContent).toBe('dark')
      expect(screen.getByTestId('resolved').textContent).toBe('dark')
    })
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('ignores a stored value that is not one of the three', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'neon')
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(screen.getByTestId('mode').textContent).toBe('system')
  })

  it('survives a localStorage that throws (private mode, blocked site data)', () => {
    const blown = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    vi.stubGlobal('localStorage', blown)
    expect(() => render(<ThemeProvider><Probe /></ThemeProvider>)).not.toThrow()
    expect(screen.getByTestId('mode').textContent).toBe('system')
  })
})
