// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModeProvider, useMode } from '../src/components/mode/ModeProvider.js'
import { MODE_STORAGE_KEY } from '../src/lib/modeStorage.js'

/** jsdom DOES implement `localStorage`, but this runner never hands it over: Node 26 declares a
 *  `localStorage` global of its own (inert without `--experimental-webstorage`), and vitest's jsdom
 *  environment copies a window property onto the global only when the name is absent from Node's
 *  global or on its own allow-list -- `localStorage` is neither. So `window.localStorage` under
 *  vitest is Node's, and it is `undefined`. One in-memory stub per test -- copied from
 *  `theme.test.tsx` -- is what the provider actually talks to; a fresh `Map` each time is also what
 *  keeps one test's stored mode out of the next one. */
function installStorage(): void {
  const cells = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string): string | null => cells.get(key) ?? null,
    setItem: (key: string, value: string): void => void cells.set(key, value),
    removeItem: (key: string): void => void cells.delete(key),
    clear: (): void => cells.clear(),
  })
}

const renders: string[] = []
function Probe(): React.JSX.Element {
  const { mode, isDeveloper, setMode, toggle } = useMode()
  renders.push(mode)
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <span data-testid="dev">{String(isDeveloper)}</span>
      <button data-testid="toggle" type="button" onClick={toggle} />
      <button data-testid="to-dev" type="button" onClick={() => setMode('developer')} />
    </div>
  )
}

beforeEach(() => { renders.length = 0; installStorage(); document.documentElement.removeAttribute('data-mode') })
afterEach(() => vi.unstubAllGlobals())

describe('ModeProvider', () => {
  it('renders simple first even when developer is stored (hydration must match the server)', async () => {
    localStorage.setItem(MODE_STORAGE_KEY, 'developer')
    render(<ModeProvider><Probe /></ModeProvider>)
    expect(renders[0]).toBe('simple')
    expect(await screen.findByText('developer')).toBeTruthy()
    expect(document.documentElement.getAttribute('data-mode')).toBe('developer')
  })
  it('removes the attribute for simple and never writes "simple" as an attribute value', async () => {
    render(<ModeProvider><Probe /></ModeProvider>)
    fireEvent.click(screen.getByTestId('to-dev'))
    expect(document.documentElement.getAttribute('data-mode')).toBe('developer')
    fireEvent.click(screen.getByTestId('toggle'))
    expect(document.documentElement.hasAttribute('data-mode')).toBe(false)
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe('simple')
  })
  it('toggles on Mod+Shift+D and ignores Mod+D', () => {
    render(<ModeProvider><Probe /></ModeProvider>)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'D', metaKey: true, shiftKey: true })) })
    expect(screen.getByTestId('mode').textContent).toBe('developer')
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', metaKey: true })) })
    expect(screen.getByTestId('mode').textContent).toBe('developer')
  })
  it('throws outside the provider', () => {
    expect(() => render(<Probe />)).toThrow(/ModeProvider/)
  })
})
