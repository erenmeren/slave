import type React from 'react'
import localFont from 'next/font/local'
import './globals.css'
import { buildSidebarTree } from '../server/sidebar'
import { requirePrincipal } from '../server/principal'
import { ShellFrame } from '../components/shell/ShellFrame'
import { Rail } from '../components/shell/Rail'
import { HeaderActionProvider } from '../components/shell/HeaderActionProvider'
import { RightPanelProvider } from '../components/shell/RightPanelProvider'
import { ThemeProvider } from '../components/theme/ThemeProvider'
import { THEME_STORAGE_KEY } from '../lib/themeStorage'
import { ModeProvider } from '../components/mode/ModeProvider'
import { MODE_STORAGE_KEY } from '../lib/modeStorage'

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

/**
 * M57 R2 / erratum E8 — the flash killer. M61 R1 adds a second clause: the MODE the operator
 * pinned, stamped the same way and for the same reason.
 *
 * It is inline, it is in `<head>`, and it cannot import anything: it runs before the bundle exists.
 * That is why `THEME_STORAGE_KEY` and `MODE_STORAGE_KEY` are interpolated into it rather than
 * spelled twice, and why `apps/web/test/theme.test.tsx` and `apps/web/test/shortcuts.test.ts` pin
 * the constants' values -- those are the two halves of keeping one string in one place across a
 * boundary a module graph cannot cross.
 *
 * BOTH COME FROM THEIR OWN PLAIN MODULES, NOT FROM `ThemeProvider`/`ModeProvider` (M57 erratum
 * E20). This file is a server component, and importing a constant out of a `'use client'` module
 * gives a CLIENT REFERENCE rather than the string: the script would ship as
 * `localStorage.getItem(undefined)` and stamp nothing, so a pinned operator got the flash this
 * script exists to kill on every load. `gate:m57-ui-redesign` stage 1 caught it for the theme half
 * -- no jsdom test can, because in a test both sides import the same real module.
 *
 * It stamps NOTHING for `system` or for `simple`: absent is the default for each, and the
 * stylesheet answers both with a selector guard rather than a third attribute value.
 */
const BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t)}var m=localStorage.getItem(${JSON.stringify(MODE_STORAGE_KEY)});if(m==='developer'){document.documentElement.setAttribute('data-mode','developer')}}catch(e){}})()`

export const metadata = { title: 'Slave of AI' }

/** The tree is read on the SERVER so the first paint carries the real project list — a sidebar
 *  that arrives one frame late is the most visible kind of late. `force-dynamic` because it is a
 *  database read on every request and there is nothing to cache across operators. */
export const dynamic = 'force-dynamic'

export default async function RootLayout({ children }: { children: React.ReactNode }): Promise<React.JSX.Element> {
  // GATED ON A PRINCIPAL (spec erratum E11, scan finding 55). Without this, `/login` — the one page
  // in the product a signed-out person can reach — opens a database connection and lists every
  // project before anybody has authenticated. `GET /api/sidebar` has always been gated; the layout
  // read was not.
  //
  // `requirePrincipal` is the SAME gate that route asks, which is the point: it answers "this
  // installation has no accounts at all" (loopback: `{ principal: null }`, and the tree is read for
  // everybody, as it always has been) and "signed in" identically, and only a signed-OUT accounts
  // install comes back carrying a `response`. That `Response` is DISCARDED here on purpose -- a
  // layout renders, it does not refuse; the empty tree is what `/login` gets, and every route
  // behind it is already 401'd by its own handler.
  const gate = await requirePrincipal()
  const projects = 'response' in gate ? [] : await buildSidebarTree()
  return (
    <html lang="en" className={FONT_VARIABLES} suppressHydrationWarning>
      {/* An explicit `<head>` so the script above is genuinely in it (erratum E8): a `<script>`
        * rendered in `<body>` runs after the body has painted, which is the flash. `next/font`'s
        * own preload `<link>`s are injected by the framework and are unaffected by an authored
        * head. `suppressHydrationWarning` on `<html>` because the script mutates the element's
        * attributes before React sees it -- which is exactly its job. */}
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
      </head>
      {/* No `min-h-screen` any more (M61 R4): `globals.css`'s `html, body { height: 100%; overflow:
        * hidden }` is what fixes the frame to the viewport now, and a `min-h-screen` body would
        * fight that by letting the document itself grow past `100dvh`. */}
      <body>
        <ThemeProvider>
          <ModeProvider>
            <RightPanelProvider>
              <HeaderActionProvider>
                {/* The header takes the TREE as a prop rather than reading the facts store alone
                  * (spec erratum E12): the store is published by five of a project's eight page
                  * clients, and the breadcrumb has to be able to name the project on all eight.
                  * `ShellFrame` owns the third column, because how wide it is depends on the ROUTE
                  * and on whether somebody collapsed it -- two client facts a server layout has
                  * no way to read (M57 R8). The sidebar slot is the icon `Rail` now (M61 R5) --
                  * `SidebarTree` and the project TREE it drew are gone; the project list lives in
                  * the header's `ProjectSwitcher` instead, fed by the same `projects` read. */}
                <ShellFrame sidebar={<Rail />} projects={projects}>
                  {children}
                </ShellFrame>
              </HeaderActionProvider>
            </RightPanelProvider>
          </ModeProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
