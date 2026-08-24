import type React from 'react'
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google'
import './globals.css'

// The handoff typography (spec §3): IBM Plex Sans for UI, IBM Plex Mono for data/labels/section
// labels. `variable` wires each loaded font's stack into the `--font-sans`/`--font-mono` custom
// properties `globals.css` already consumes through its `@theme inline` mapping — `globals.css`
// keeps its own literal-string fallback for contexts that render outside this layout (e.g. a
// component test that mounts a `ui/` component directly, with no `<html>` wrapper).
const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-sans',
  display: 'swap',
})

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
})

export const metadata = { title: 'AI Team OS' }

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable}`}>
      <body className="flex min-h-screen">{children}</body>
    </html>
  )
}
