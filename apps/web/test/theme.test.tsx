// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeSwitch } from '../src/components/app/ThemeSwitch'
import { ThemeProvider, useTheme } from '../src/components/theme/ThemeProvider'
import { THEME_BOOT_SCRIPT, THEME_STORAGE_KEY } from '../src/lib/themeStorage'

/** The operating system's answer to "prefers dark", for one test. */
function systemDark(dark: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: dark && query.includes('dark'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  window.matchMedia = globalThis.matchMedia
}

function Resolved(): React.JSX.Element {
  const { theme, resolved } = useTheme()
  return <span data-testid="resolved" data-theme={theme}>{resolved}</span>
}

/**
 * A store of its own for every test: under Node 25 and later the runtime's own `localStorage`
 * global (undefined without `--localstorage-file`) stands where jsdom's would be.
 */
function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() { return items.size },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  }
}

beforeEach(() => {
  const storage = memoryStorage()
  vi.stubGlobal('localStorage', storage)
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage })
  document.documentElement.classList.remove('dark')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the theme (lead UX design U-8)', () => {
  it('keeps the storage key a person\'s choice was saved under before the new interface', () => {
    expect(THEME_STORAGE_KEY).toBe('theme')
    expect(THEME_BOOT_SCRIPT).toContain(JSON.stringify(THEME_STORAGE_KEY))
  })

  it('stamps the class dark before the first paint for Dark, and for System on a dark machine', () => {
    systemDark(false)
    window.localStorage.setItem('theme', 'dark')
    new Function(THEME_BOOT_SCRIPT)()
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    document.documentElement.classList.remove('dark')
    window.localStorage.removeItem('theme')
    systemDark(true)
    new Function(THEME_BOOT_SCRIPT)()
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    document.documentElement.classList.remove('dark')
    window.localStorage.setItem('theme', 'light')
    new Function(THEME_BOOT_SCRIPT)()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('follows a choice made on the switch: the class, the stored value and the resolved theme', async () => {
    systemDark(false)
    render(
      <ThemeProvider>
        <ThemeSwitch />
        <Resolved />
      </ThemeProvider>,
    )
    expect(screen.getByTestId('resolved').textContent).toBe('light')
    await act(async () => screen.getByTestId('theme-dark').click())
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(window.localStorage.getItem('theme')).toBe('dark')
    expect(screen.getByTestId('theme-dark').getAttribute('aria-checked')).toBe('true')
    await act(async () => screen.getByTestId('theme-light').click())
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('reads System as the operating system says', () => {
    systemDark(true)
    render(
      <ThemeProvider>
        <Resolved />
      </ThemeProvider>,
    )
    expect(screen.getByTestId('resolved')).toMatchObject({ textContent: 'dark' })
    expect(screen.getByTestId('resolved').getAttribute('data-theme')).toBe('system')
  })
})
