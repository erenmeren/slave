'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

/** The three values the operator can choose between (M57 R2). `system` is the default and is
 *  represented by the ABSENCE of `data-theme` on `<html>` -- which is what lets the stylesheet
 *  answer it with one `prefers-color-scheme` media query instead of a JavaScript read. */
export type ThemeChoice = 'system' | 'light' | 'dark'

/** The `localStorage` key. Exported because the pre-hydration script in `app/layout.tsx` spells
 *  the same string as a literal -- that script cannot import anything, it runs before the bundle
 *  exists -- and a test that pins the two together is the only thing keeping them in step. */
export const THEME_STORAGE_KEY = 'theme'

const CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark']

function isChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (CHOICES as readonly string[]).includes(value)
}

/** Every `localStorage` touch is wrapped: a private window, blocked site data, or a browser that
 *  throws on the accessor itself must degrade to "system", never to a blank page. */
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
    /* nothing to do: the attribute below still applies for this session */
  }
}

/** `light` | `dark`, with no third state -- what the page is ACTUALLY painted as right now. */
export type ResolvedTheme = 'light' | 'dark'

export interface ThemeState {
  readonly theme: ThemeChoice
  readonly resolved: ResolvedTheme
  readonly setTheme: (next: ThemeChoice) => void
  /** System -> Light -> Dark -> System, the sidebar footer pill's one click (prototype
   *  `App.dc.html:255`). */
  readonly cycle: () => void
}

const ThemeContext = createContext<ThemeState | null>(null)

const DARK_QUERY = '(prefers-color-scheme: dark)'

export function ThemeProvider({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  // `system`, flatly -- on the server AND on the first client render (M57 ruling P22). The
  // hydration render has to produce the markup the server produced, and the server has no
  // `localStorage` to read; an initialiser that read it would make a pinned operator's first
  // client render disagree with the HTML that arrived. What the page LOOKS like is not at stake
  // either way: `layout.tsx`'s pre-hydration script stamps `data-theme` on `<html>` before the
  // first paint, so the colours are right from the first frame and the only thing the effect
  // below catches up is the word this state spells in the sidebar pill.
  const [theme, setThemeState] = useState<ThemeChoice>('system')
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window === 'undefined' ? false : (window.matchMedia?.(DARK_QUERY).matches ?? false),
  )

  // The stored choice, read once the component is on the client for certain. Declared before the
  // attribute effect below so that both run in one commit: a pinned operator's mount removes the
  // attribute and puts it straight back, with no paint in between.
  useEffect((): void => {
    setThemeState(readStored())
  }, [])

  // `system` must FOLLOW the operating system while the page is open, not only on load -- a person
  // whose machine flips at sunset should see this flip with it (README "Interactions": "system
  // follows prefers-color-scheme live").
  useEffect((): (() => void) | undefined => {
    const query = window.matchMedia?.(DARK_QUERY)
    if (query === undefined) return undefined
    const onChange = (event: { matches: boolean }): void => setSystemDark(event.matches)
    query.addEventListener('change', onChange)
    setSystemDark(query.matches)
    return (): void => query.removeEventListener('change', onChange)
  }, [])

  // The attribute is the ONE thing the stylesheet reads. `system` REMOVES it rather than setting
  // it to some third value, because "absent" is what the media query's `:not([data-theme='light'])`
  // guard is written against.
  useEffect((): void => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const setTheme = useCallback((next: ThemeChoice): void => {
    setThemeState(next)
    writeStored(next)
  }, [])

  const cycle = useCallback((): void => {
    setThemeState((was) => {
      const next: ThemeChoice = was === 'system' ? 'light' : was === 'light' ? 'dark' : 'system'
      writeStored(next)
      return next
    })
  }, [])

  const value = useMemo<ThemeState>(
    () => ({
      theme,
      resolved: theme === 'system' ? (systemDark ? 'dark' : 'light') : theme,
      setTheme,
      cycle,
    }),
    [theme, systemDark, setTheme, cycle],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/** Throws rather than returning a default: every consumer of this hook is inside the root layout's
 *  provider by construction, so a null here is a wiring bug and a silent light theme would hide it. */
export function useTheme(): ThemeState {
  const value = useContext(ThemeContext)
  if (value === null) throw new Error('useTheme must be used inside <ThemeProvider>')
  return value
}

/** The glyph and the word the sidebar footer's pill and the Settings segmented control both show
 *  (README "Shell" and "Global Settings"; prototype `App.dc.html:254`). A label table beside the
 *  thing it names -- `docs/ia.md` rule 3's second half: this is not a status, so it keeps its own. */
export const THEME_GLYPH: Record<ThemeChoice, string> = { system: '◐', light: '☀', dark: '☾' }
export const THEME_LABEL: Record<ThemeChoice, string> = { system: 'System', light: 'Light', dark: 'Dark' }
