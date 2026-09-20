'use client'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { MODE_STORAGE_KEY, isMode, type Mode } from '../../lib/modeStorage'
import { matchesShortcut } from '../../lib/shortcuts'

export type { Mode }
export interface ModeState { readonly mode: Mode; readonly isDeveloper: boolean; readonly setMode: (next: Mode) => void; readonly toggle: () => void }
const ModeContext = createContext<ModeState | null>(null)

function readStored(): Mode { try { const raw = window.localStorage.getItem(MODE_STORAGE_KEY); return isMode(raw) ? raw : 'simple' } catch { return 'simple' } }
function writeStored(mode: Mode): void { try { window.localStorage.setItem(MODE_STORAGE_KEY, mode) } catch { /* attribute still applies this session */ } }

export function ModeProvider({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  const [mode, setModeState] = useState<Mode>('simple')
  const [hydrated, setHydrated] = useState(false)
  useEffect((): void => { setModeState(readStored()); setHydrated(true) }, [])
  // `simple` REMOVES the attribute: absent is simple, and every `[data-mode='developer']` selector
  // in the token sheet is written against presence, never against a second value.
  useEffect((): void => {
    if (!hydrated) return
    if (mode === 'developer') document.documentElement.setAttribute('data-mode', 'developer')
    else document.documentElement.removeAttribute('data-mode')
  }, [mode, hydrated])
  const setMode = useCallback((next: Mode): void => { setModeState(next); writeStored(next) }, [])
  const toggle = useCallback((): void => { setModeState((was) => { const next: Mode = was === 'simple' ? 'developer' : 'simple'; writeStored(next); return next }) }, [])
  // Mod+Shift+D. A keyboard toggle animates nothing -- there is nothing here to animate, and the
  // token sheet transitions no colour on `data-mode` (R1).
  useEffect((): (() => void) => {
    const onKey = (event: KeyboardEvent): void => { if (matchesShortcut(event, { key: 'd', shift: true })) { event.preventDefault(); toggle() } }
    window.addEventListener('keydown', onKey)
    return (): void => window.removeEventListener('keydown', onKey)
  }, [toggle])
  const value = useMemo<ModeState>(() => ({ mode, isDeveloper: mode === 'developer', setMode, toggle }), [mode, setMode, toggle])
  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>
}
export function useMode(): ModeState {
  const value = useContext(ModeContext)
  if (value === null) throw new Error('useMode must be used inside <ModeProvider>')
  return value
}
export const MODE_LABEL: Record<Mode, string> = { simple: 'Simple', developer: 'Developer' }
