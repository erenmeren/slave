'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { THEME_STORAGE_KEY } from '../../lib/themeStorage'

/** The three choices (lead UX design U-8): System is the default and follows the operating system. */
export type ThemeChoice = 'system' | 'light' | 'dark'

export { THEME_STORAGE_KEY }

const CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark']

function isChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (CHOICES as readonly string[]).includes(value)
}

/** Every `localStorage` touch is wrapped: a private window or blocked site data degrades to
 *  System, never to a blank page. */
function readStored(): ThemeChoice {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isChoice(raw) ? raw : 'system'
  } catch {
    return 'system'
  }
}

function writeStored(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, choice)
  } catch {
    /* the class below still applies for this session */
  }
}

/** What the page is painted as right now. */
export type ResolvedTheme = 'light' | 'dark'

export interface ThemeState {
  readonly theme: ThemeChoice
  readonly resolved: ResolvedTheme
  readonly setTheme: (next: ThemeChoice) => void
}

const ThemeContext = createContext<ThemeState | null>(null)

const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * The theme as shadcn/ui reads it: the class `dark` on `<html>` (the `@custom-variant dark` in
 * `globals.css`). The root layout's pre-hydration script stamps the class before the first paint;
 * this provider keeps it right afterwards -- a choice made on the page, and System following the
 * operating system live. Both state values start flat (`system`, not dark) so the first client
 * render matches the server's; the class is left alone until the stored choice has been read, so
 * the script's stamp is never removed for a frame.
 */
export function ThemeProvider({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  const [theme, setThemeState] = useState<ThemeChoice>('system')
  const [hydrated, setHydrated] = useState<boolean>(false)
  const [systemDark, setSystemDark] = useState<boolean>(false)

  useEffect((): void => {
    setThemeState(readStored())
    setHydrated(true)
  }, [])

  useEffect((): (() => void) | undefined => {
    const query = window.matchMedia?.(DARK_QUERY)
    if (query === undefined) return undefined
    const onChange = (event: { matches: boolean }): void => setSystemDark(event.matches)
    query.addEventListener('change', onChange)
    setSystemDark(query.matches)
    return (): void => query.removeEventListener('change', onChange)
  }, [])

  const resolved: ResolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme

  useEffect((): void => {
    if (!hydrated) return
    document.documentElement.classList.toggle('dark', resolved === 'dark')
    document.documentElement.style.colorScheme = resolved
  }, [resolved, hydrated])

  const setTheme = useCallback((next: ThemeChoice): void => {
    setThemeState(next)
    writeStored(next)
  }, [])

  const value = useMemo<ThemeState>(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/** Throws rather than returning a default: every consumer is inside the root layout's provider. */
export function useTheme(): ThemeState {
  const value = useContext(ThemeContext)
  if (value === null) throw new Error('useTheme must be used inside <ThemeProvider>')
  return value
}

export const THEME_LABEL: Readonly<Record<ThemeChoice, string>> = { system: 'System', light: 'Light', dark: 'Dark' }

