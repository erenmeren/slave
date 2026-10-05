import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(fileURLToPath(new URL('../src/app/globals.css', import.meta.url)), 'utf8')

/** shadcn/ui's own names and the four state colours the design adds (lead UX design U-8, section 5). */
const TOKENS = [
  '--background', '--foreground', '--card', '--card-foreground', '--popover', '--popover-foreground',
  '--primary', '--primary-foreground', '--secondary', '--secondary-foreground', '--muted', '--muted-foreground',
  '--accent', '--accent-foreground', '--destructive', '--border', '--input', '--ring',
  '--warning', '--warning-foreground', '--warning-muted', '--success', '--success-foreground', '--success-muted',
  '--info', '--info-foreground', '--info-muted', '--checking', '--checking-foreground', '--checking-muted',
  '--sidebar', '--sidebar-foreground', '--sidebar-primary', '--sidebar-accent', '--sidebar-border', '--sidebar-ring',
]

function block(selector: string): string {
  const at = CSS.indexOf(`${selector} {`)
  expect(at, `${selector} is not in the sheet`).toBeGreaterThan(-1)
  return CSS.slice(at, CSS.indexOf('}', at))
}

describe('the theme tokens (lead UX design U-8)', () => {
  it('declares every token in light and again in dark, so both themes are whole', () => {
    const light = block(':root')
    const dark = block('.dark')
    for (const token of TOKENS) {
      expect(light, `${token} in light`).toContain(`${token}:`)
      expect(dark, `${token} in dark`).toContain(`${token}:`)
    }
  })

  it('maps every colour token to a Tailwind colour, and reads dark from the class', () => {
    for (const token of TOKENS) expect(CSS).toContain(`--color-${token.slice(2)}: var(${token})`)
    expect(CSS).toContain('@custom-variant dark (&:is(.dark *));')
  })

  it('keeps the motion of a working face off for a person who asked for less', () => {
    expect(CSS).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.working-pulse\s*\{\s*animation: none;/u)
  })
})
