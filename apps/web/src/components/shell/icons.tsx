import type React from 'react'

/**
 * The rail's own line-icon set (M61 R5), and the two the header borrows (`SearchIcon` for
 * `HeaderSearch`, `ChevronIcon` for `ProjectSwitcher`'s trigger). One 20x20 viewBox, one stroke
 * weight, no fill -- so a page that shows several together never has to fight a mismatched glyph.
 * `aria-hidden` on every one: the rail item / button around each carries its own `aria-label` or
 * visible text, so the glyph itself names nothing a screen reader needs twice.
 */

export function HomeIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M3 9.5 10 3l7 6.5V17H3z M8 17v-5h4v5" />
    </svg>
  )
}

export function PeopleIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M7 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M14 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M2 17c0-3 2.5-5 5-5s5 2 5 5 M12.5 12.5c2.5 0 4.5 2 4.5 4.5" />
    </svg>
  )
}

export function SettingsIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M16.5 10a6.5 6.5 0 0 0-.1-1l1.6-1.2-1.5-2.6-1.9.7a6.5 6.5 0 0 0-1.7-1L12.5 3h-5l-.4 2a6.5 6.5 0 0 0-1.7 1l-1.9-.7L2 7.8 3.6 9a6.5 6.5 0 0 0 0 2L2 12.2l1.5 2.6 1.9-.7a6.5 6.5 0 0 0 1.7 1l.4 2h5l.4-2a6.5 6.5 0 0 0 1.7-1l1.9.7 1.5-2.6-1.6-1.2c.1-.3.1-.7.1-1z" />
    </svg>
  )
}

export function FlaskIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M8 3h4 M9 3v5l-4.5 7.5A1.5 1.5 0 0 0 5.8 18h8.4a1.5 1.5 0 0 0 1.3-2.5L11 8V3" />
    </svg>
  )
}

export function ChartIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M3 17h14 M5 14V9 M9 14V5 M13 14v-3 M17 14V7" />
    </svg>
  )
}

export function SearchIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12z M17 17l-3.5-3.5" />
    </svg>
  )
}

export function ChevronIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M7 8l3 3 3-3" />
    </svg>
  )
}
