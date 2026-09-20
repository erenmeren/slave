import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(fileURLToPath(new URL('../src/app/globals.css', import.meta.url)), 'utf8')
const SIMPLE = readFileSync(fileURLToPath(new URL('../src/app/tokens/simple.css', import.meta.url)), 'utf8')
const DEVELOPER = readFileSync(fileURLToPath(new URL('../src/app/tokens/developer.css', import.meta.url)), 'utf8')

/** The handoff README's own names (M57 R1). */
const NEW_TOKENS = [
  '--bg', '--panel', '--card', '--line', '--line2', '--t1', '--t2', '--t3',
  '--hover', '--sel', '--accent', '--accent-ink',
  '--s-working', '--s-planning', '--s-review', '--s-waiting',
  '--s-blocked', '--s-done', '--s-paused', '--s-idle',
]

const SURFACE_TOKENS = ['--glass', '--glass-strong', '--edge']
const FRAME_TOKENS = ['--radius-control', '--radius-surface', '--radius-sheet', '--fs-body', '--row-h', '--gap-1', '--gap-2', '--gap-3', '--ease-out', '--ease-in-out', '--dur-fast', '--dur-base', '--dur-slow']

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

/** The three blocks R2 requires, by their exact selectors. `blockOf` is `blockIn` parameterised on
 *  `globals.css`'s own text -- the alias layer, `@theme inline` and the radii stay there, so most
 *  of this file's existing assertions still read `CSS`. The palette itself moved (M61 R2), so the
 *  three palette assertions below read `SIMPLE` instead. */
function blockIn(css: string, selector: string): string {
  const at = css.indexOf(selector)
  expect(at, `${selector} is not in the sheet`).toBeGreaterThan(-1)
  const open = css.indexOf('{', at)
  // Token blocks contain no nested braces, so the first `}` closes them.
  return css.slice(open, css.indexOf('}', open))
}
const blockOf = (selector: string): string => blockIn(CSS, selector)

describe('the token sheet', () => {
  it('declares every new token on bare :root -- the LIGHT palette', () => {
    const light = blockIn(SIMPLE, '\n:root {')
    for (const token of NEW_TOKENS) expect(light, token).toContain(`${token}:`)
  })

  it('redefines every new token under the system-dark guard', () => {
    const dark = blockIn(SIMPLE, ":root:not([data-theme='light'])")
    for (const token of NEW_TOKENS) expect(dark, token).toContain(`${token}:`)
  })

  it('redefines every new token under the pinned-dark selector, so the toggle wins both ways', () => {
    const pinned = blockIn(SIMPLE, ":root[data-theme='dark']")
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

  it('degrades .glass to the opaque panel colour under prefers-reduced-transparency, at class specificity (I1 fix, E12)', () => {
    // The bare `:root` override earlier in the sheet loses the cascade to the palette blocks'
    // more specific selectors (`:root[data-theme=…]`), so the real fallback has to live on
    // `.glass` itself -- the second `prefers-reduced-transparency` media query, the one that wraps
    // `.glass`, not `:root`.
    const firstGlassRule = CSS.indexOf('.glass {')
    const mediaStart = CSS.indexOf('@media (prefers-reduced-transparency: reduce)', firstGlassRule)
    expect(mediaStart, 'a second reduced-transparency media query, after .glass is first declared').toBeGreaterThan(-1)
    const reduceBlock = blockIn(CSS.slice(mediaStart), '.glass {')
    expect(reduceBlock).toContain('background: var(--panel)')
    expect(reduceBlock).toContain('backdrop-filter: none')
  })
})

describe('the two mode palettes (M61 R2)', () => {
  it('imports both token files right after tailwind', () => {
    expect(CSS.indexOf("@import './tokens/simple.css'")).toBeGreaterThan(CSS.indexOf("@import 'tailwindcss'"))
    expect(CSS).toContain("@import './tokens/developer.css'")
  })
  it('declares every palette token three times in each file', () => {
    for (const file of [SIMPLE, DEVELOPER]) for (const token of NEW_TOKENS) {
      expect(file.split(`${token}:`).length - 1, token).toBe(3)
    }
  })
  it('guards every developer selector on the attribute and no simple selector on it', () => {
    expect(DEVELOPER).toContain(":root[data-mode='developer'] {")
    expect(DEVELOPER).toContain(":root[data-mode='developer']:not([data-theme='light'])")
    expect(DEVELOPER).toContain(":root[data-mode='developer'][data-theme='dark']")
    expect(SIMPLE).not.toContain('data-mode')
    expect(SIMPLE).toContain('\n:root {')
    expect(SIMPLE).toContain(":root:not([data-theme='light'])")
    expect(SIMPLE).toContain(":root[data-theme='dark']")
  })
  it('keeps the status tones identical across the two modes, per theme', () => {
    const tones = (css: string, selector: string): string[] => blockIn(css, selector).match(/--s-[a-z]+: [^;]+/g) ?? []
    expect(tones(SIMPLE, '\n:root {')).toEqual(tones(DEVELOPER, ":root[data-mode='developer'] {"))
    expect(tones(SIMPLE, ":root[data-theme='dark']")).toEqual(tones(DEVELOPER, ":root[data-mode='developer'][data-theme='dark']"))
  })
  it('declares the surface tokens in both files and the frame tokens in globals', () => {
    for (const t of SURFACE_TOKENS) { expect(SIMPLE).toContain(`${t}:`); expect(DEVELOPER).toContain(`${t}:`) }
    for (const t of FRAME_TOKENS) expect(CSS).toContain(`${t}:`)
  })
  it('aliases the eleven old radii onto the three new ones', () => {
    for (const [old, target] of [['chip', 'control'], ['nav', 'control'], ['tile', 'control'], ['card', 'control'], ['panel', 'control'], ['tile-lg', 'surface'], ['panel-card', 'surface'], ['page-card', 'sheet'], ['bubble', 'sheet']]) {
      expect(CSS).toContain(`--radius-${old}: var(--radius-${target});`)
    }
    expect(CSS).toContain('--radius-pill: 999px')
  })
  it('never spells transition: all', () => { expect(CSS).not.toMatch(/transition:\s*all/) })
})
