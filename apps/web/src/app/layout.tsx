import type React from 'react'
import localFont from 'next/font/local'
import './globals.css'
import { ThemeProvider } from '@/components/theme/ThemeProvider'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { THEME_BOOT_SCRIPT } from '@/lib/themeStorage'

/**
 * M57 R3 — the handoff's two families, self-hosted, one `localFont()` call PER FAMILY PER SUBSET.
 *
 * Per-file `unicode-range` is the whole point (a page of English must not download the latin-ext
 * face), and `next/font/local`'s `src` array entries carry only `path`/`weight`/`style` -- there is
 * no `unicodeRange` field. `declarations` IS accepted, and is applied to every `@font-face` a call
 * generates, so ONE CALL PER SUBSET is the shape that keeps the split. Two families in one
 * `font-family` stack fall back on a codepoint outside the first's range exactly the way two faces
 * of one family would.
 *
 * `adjustFontFallback: false` on all four is load-bearing, not tidying: with it on, `next/font`
 * synthesises a metric-matched local fallback and puts it INSIDE each variable's value -- and that
 * fallback family carries no `unicode-range`, so it would sit between the latin face and the
 * latin-ext face in the composed stack and swallow every latin-ext glyph. The literal fallbacks
 * live at the end of `globals.css`'s `--font-sans`/`--font-mono` instead, where they belong.
 *
 * The `unicode-range` strings are Google Fonts' own for these two subsets, taken verbatim from the
 * manifest that came with the downloaded files. They are spelled out in full at each call site
 * rather than hoisted into a `const`, because `next/font`'s SWC loader reads these options at
 * compile time and refuses anything that is not a written literal ("Font loader values must be
 * explicitly written literals") -- a shared constant fails the BUILD, which is the one check
 * neither `tsc` nor `vitest` performs.
 */
const sansLatin = localFont({
  src: [
    { path: './fonts/InstrumentSans-normal-latin.woff2', weight: '400 700', style: 'normal' },
    { path: './fonts/InstrumentSans-italic-latin.woff2', weight: '400 700', style: 'italic' },
  ],
  declarations: [{ prop: 'unicode-range', value: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD' }],
  adjustFontFallback: false,
  variable: '--font-sans-latin',
  display: 'swap',
})

const sansExt = localFont({
  src: [
    { path: './fonts/InstrumentSans-normal-latin-ext.woff2', weight: '400 700', style: 'normal' },
    { path: './fonts/InstrumentSans-italic-latin-ext.woff2', weight: '400 700', style: 'italic' },
  ],
  declarations: [{ prop: 'unicode-range', value: 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF' }],
  adjustFontFallback: false,
  variable: '--font-sans-ext',
  display: 'swap',
})

const monoLatin = localFont({
  src: [{ path: './fonts/JetBrainsMono-normal-latin.woff2', weight: '400 600', style: 'normal' }],
  declarations: [{ prop: 'unicode-range', value: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD' }],
  adjustFontFallback: false,
  variable: '--font-mono-latin',
  display: 'swap',
})

const monoExt = localFont({
  src: [{ path: './fonts/JetBrainsMono-normal-latin-ext.woff2', weight: '400 600', style: 'normal' }],
  declarations: [{ prop: 'unicode-range', value: 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF' }],
  adjustFontFallback: false,
  variable: '--font-mono-ext',
  display: 'swap',
})

const FONT_VARIABLES = `${sansLatin.variable} ${sansExt.variable} ${monoLatin.variable} ${monoExt.variable}`

export const metadata = { title: 'Slave of AI', description: 'Describe what you want built; a lead builds it and Slave proves it.' }

export const dynamic = 'force-dynamic'

/**
 * The root of every page (lead UX design U-2, U-8): the fonts, the theme and the toasts. The
 * sidebar frame is the `(app)` group's layout, so Sign in renders on its own.
 *
 * The pre-hydration script is in an explicit `<head>` so it runs before the body paints: it stamps
 * the class `dark` when the stored choice or the operating system asks for it, and
 * `suppressHydrationWarning` on `<html>` is because that is exactly its job.
 */
export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="en" className={FONT_VARIABLES} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-dvh">
        <ThemeProvider>
          <TooltipProvider delayDuration={300}>
            {children}
            <Toaster position="bottom-right" />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
