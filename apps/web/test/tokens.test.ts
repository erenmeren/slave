import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(fileURLToPath(new URL('../src/app/globals.css', import.meta.url)), 'utf8')

/** The handoff README's own names (M57 R1). */
const NEW_TOKENS = [
  '--bg', '--panel', '--card', '--line', '--line2', '--t1', '--t2', '--t3',
  '--hover', '--sel', '--accent', '--accent-ink',
  '--s-working', '--s-planning', '--s-review', '--s-waiting',
  '--s-blocked', '--s-done', '--s-paused', '--s-idle',
]

/** Every name `src/` already paints with. Nothing here may stop being declared: ~90 files spell
 *  these as Tailwind utilities, and a deleted token is a silently unstyled page. */
const OLD_TOKENS = [
  '--bg-0', '--bg-1', '--bg-2', '--bg-selected', '--bg-card-alt', '--bg-canvas', '--bg-floor',
  '--text-1', '--text-2', '--text-3', '--text-faint', '--text-body', '--text-dim', '--line-hover',
  '--tone-working', '--tone-planning', '--tone-review', '--tone-waiting',
  '--tone-blocked', '--tone-done', '--tone-paused', '--tone-idle',
  '--radius-chip', '--radius-nav', '--radius-tile', '--radius-card', '--radius-panel',
  '--radius-pill', '--radius-hair', '--radius-bubble',
  '--shadow-resting', '--font-sans', '--font-mono',
]

/** The three blocks R2 requires, by their exact selectors. */
function blockOf(selector: string): string {
  const at = CSS.indexOf(selector)
  expect(at, `${selector} is not in globals.css`).toBeGreaterThan(-1)
  const open = CSS.indexOf('{', at)
  // Token blocks contain no nested braces, so the first `}` closes them.
  return CSS.slice(open, CSS.indexOf('}', open))
}

describe('the token sheet', () => {
  it('declares every new token on bare :root -- the LIGHT palette', () => {
    const light = blockOf('\n:root {')
    for (const token of NEW_TOKENS) expect(light, token).toContain(`${token}:`)
  })

  it('redefines every new token under the system-dark guard', () => {
    const dark = blockOf(":root:not([data-theme='light'])")
    for (const token of NEW_TOKENS) expect(dark, token).toContain(`${token}:`)
  })

  it('redefines every new token under the pinned-dark selector, so the toggle wins both ways', () => {
    const pinned = blockOf(":root[data-theme='dark']")
    for (const token of NEW_TOKENS) expect(pinned, token).toContain(`${token}:`)
  })

  it('guards the system-dark block so an explicit light choice beats the OS', () => {
    expect(CSS).toContain("@media (prefers-color-scheme: dark)")
    expect(CSS).toContain(":root:not([data-theme='light'])")
  })

  it('keeps every old token declared, as an alias of a new one (R1: nothing leaves the sheet)', () => {
    const light = blockOf('\n:root {')
    for (const token of OLD_TOKENS) expect(light, token).toContain(`${token}:`)
  })

  it('maps every new token into @theme inline, so Tailwind can reach it', () => {
    const theme = blockOf('@theme inline')
    for (const token of ['--color-bg', '--color-panel', '--color-card', '--color-line2',
      '--color-t1', '--color-t2', '--color-t3', '--color-hover', '--color-sel',
      '--color-accent', '--color-accent-ink', '--color-s-working', '--color-s-idle',
      '--radius-tile-lg', '--radius-panel-card', '--radius-page-card', '--shadow-card']) {
      expect(theme, token).toContain(`${token}:`)
    }
  })

  it('keeps every old @theme mapping, so no existing utility class stops resolving', () => {
    const theme = blockOf('@theme inline')
    for (const token of ['--color-bg-0', '--color-bg-1', '--color-bg-2', '--color-line',
      '--color-text-1', '--color-text-2', '--color-text-3', '--color-text-faint',
      '--color-text-body', '--color-text-dim', '--color-bg-selected', '--color-bg-card-alt',
      '--color-bg-canvas', '--color-bg-floor', '--color-line-hover',
      '--color-tone-working', '--color-tone-idle', '--radius-pill', '--font-sans', '--font-mono']) {
      expect(theme, token).toContain(`${token}:`)
    }
  })

  it('takes the README pill radius (999px), not the old 20px (erratum E9)', () => {
    expect(blockOf('\n:root {')).toContain('--radius-pill: 999px')
  })

  it('still kills every animation under prefers-reduced-motion', () => {
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)')
    expect(CSS).toContain('animation-name: none !important')
  })
})
