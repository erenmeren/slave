'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { THEME_STORAGE_KEY } from '../../lib/themeStorage'

/** The three values the operator can choose between (M57 R2). `system` is the default and is
 *  represented by the ABSENCE of `data-theme` on `<html>` -- which is what lets the stylesheet
 *  answer it with one `prefers-color-scheme` media query instead of a JavaScript read. */
export type ThemeChoice = 'system' | 'light' | 'dark'

/** RE-EXPORTED, not declared here (M57 erratum E20). The key itself lives in
 *  `lib/themeStorage.ts`, a module with no `'use client'` on it, because `app/layout.tsx`
 *  interpolates it into the pre-hydration script and a SERVER component importing it from this
 *  file gets a client reference rather than the string. Every existing importer of
 *  `THEME_STORAGE_KEY` from this module keeps working. */
export { THEME_STORAGE_KEY }

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
  // first paint, so the colours are right from the first frame and the only thing the effects
  // below catch up is the word this state spells in the sidebar pill.
  const [theme, setThemeState] = useState<ThemeChoice>('system')
  // Flips true once the effect below has read the stored choice. The attribute effect stays
  // inert until then -- otherwise `theme` reading `'system'` on that first render (a pinned
  // operator included) would REMOVE the `data-theme` the pre-hydration script already stamped in
  // one commit, and only put it back in a LATER commit once `setThemeState` below lands, leaving
  // a window for a paint to land in between: the exact flash the script exists to prevent.
  const [hydrated, setHydrated] = useState<boolean>(false)
  // Flat `false`, same reasoning as `theme` above: the server has no `matchMedia` to read, so an
  // initialiser that read it would make a dark-OS client's first render disagree with the
  // server's. The `matchMedia` effect below re-reads `query.matches` on mount, so this only holds
  // for that first render.
  const [systemDark, setSystemDark] = useState<boolean>(false)

  // The stored choice, read once the component is on the client for certain. Also what lets the
  // attribute effect below start doing its job.
  useEffect((): void => {
    setThemeState(readStored())
    setHydrated(true)
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
  // guard is written against. Inert until `hydrated`: before the stored choice has been read,
  // `theme` reads `'system'` even for a pinned operator, and this effect touching the attribute on
  // that render would remove what the pre-hydration script already stamped.
  useEffect((): void => {
    if (!hydrated) return
    if (theme === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', theme)
  }, [theme, hydrated])

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
