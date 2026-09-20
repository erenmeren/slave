// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Rail } from '../src/components/shell/Rail.js'
import { ModeProvider } from '../src/components/mode/ModeProvider.js'
import { ThemeProvider } from '../src/components/theme/ThemeProvider.js'

vi.mock('next/navigation', () => ({
  usePathname: () => '/workforce',
  useSearchParams: () => new URLSearchParams(),
}))

/** jsdom DOES implement `localStorage`, but this runner never hands it over (Node 26's own global
 *  shadows it) -- the same stub `mode.test.tsx`/`theme.test.tsx` install, copied here because
 *  `Rail` renders both `ModeProvider` and `ThemeProvider`'s consumers. */
function installStorage(): void {
  const cells = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string): string | null => cells.get(key) ?? null,
    setItem: (key: string, value: string): void => void cells.set(key, value),
    removeItem: (key: string): void => void cells.delete(key),
    clear: (): void => cells.clear(),
  })
}

beforeEach((): void => {
  installStorage()
  document.documentElement.removeAttribute('data-mode')
})

afterEach((): void => {
  vi.unstubAllGlobals()
})

function renderRail(): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <ModeProvider>
        <Rail />
      </ModeProvider>
    </ThemeProvider>,
  )
}

describe('the rail (M61 R5)', () => {
  it('draws home, people, settings in simple mode, with the current one marked', () => {
    renderRail()
    const items = screen.getAllByTestId('rail-item')
    expect(items.map((item) => item.getAttribute('data-rail'))).toEqual(['home', 'people', 'settings'])
    const people = items.find((item) => item.getAttribute('data-rail') === 'people')
    expect(people?.getAttribute('aria-current')).toBe('page')
  })

  it('adds simulations and analytics, last, once developer mode is on -- and says so on the switch', () => {
    renderRail()
    expect(screen.getByTestId('mode-toggle').getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByTestId('mode-toggle'))
    const items = screen.getAllByTestId('rail-item')
    expect(items.map((item) => item.getAttribute('data-rail'))).toEqual([
      'home',
      'people',
      'settings',
      'simulations',
      'analytics',
    ])
    expect(screen.getByTestId('mode-toggle').getAttribute('aria-checked')).toBe('true')
  })

  it('keeps the live chip, the theme pill and the skip link', () => {
    renderRail()
    expect(screen.getByTestId('sidebar-live')).toBeTruthy()
    expect(screen.getByTestId('theme-toggle')).toBeTruthy()
    expect(screen.getByTestId('skip-link')).toBeTruthy()
    expect(screen.getByTestId('skip-link').getAttribute('href')).toBe('#main')
  })
})
