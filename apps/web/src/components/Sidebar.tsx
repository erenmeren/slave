'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/** The four global pages (M44 R1). Slaves and Skills became Workforce TABS; Analytics' route stays
 *  (bookmarks, and gate:m14-fidelity screenshots it) but its all-workspaces view is a section on
 *  the Projects home now and its per-workspace view is reached from the project. Nothing was
 *  removed -- `docs/ia.md` names where each one went. */
const ROWS = [
  { label: 'Projects', href: '/' },
  { label: 'Workforce', href: '/workforce' },
  { label: 'Simulations', href: '/sim' },
  { label: 'Settings', href: '/settings' },
] as const

/** One nav row (mockup geometry: `7px 9px` padding, radius 6, 12.5px label). */
function NavRow({
  label,
  href,
  current,
}: {
  readonly label: string
  readonly href: string
  readonly current: boolean
}): React.JSX.Element {
  return (
    <Link
      data-testid="nav-row"
      data-nav={label}
      href={href}
      aria-label={label}
      title={label}
      aria-current={current ? 'page' : undefined}
      className={`flex items-center gap-2 rounded-nav px-[9px] py-[7px] text-[12.5px] transition-colors max-[899px]:justify-center max-[899px]:px-0 ${
        current
          ? 'bg-bg-selected font-medium text-text-1 shadow-[inset_2px_0_0_var(--color-tone-working)]'
          : 'text-text-2 hover:bg-white/[0.045] hover:text-text-1'
      }`}
    >
      {/* The collapsed rail's glyph. The handoff ships no icon font and no images -- "every glyph
        * is text" -- so the initial IS the icon, and the row's `aria-label`/`title` carry the word
        * a screen reader and a hover need. */}
      <span aria-hidden className="hidden font-mono text-[12.5px] max-[899px]:inline">{label.slice(0, 1)}</span>
      <span className="max-[899px]:hidden">{label}</span>
    </Link>
  )
}

/**
 * The handoff's 212px sidebar (design README §3a), reduced to the FOUR global rows the M44 audit
 * left (R1): Projects, Workforce, Simulations, Settings. It is the same on every page -- a
 * project's own navigation lives in the project layout's tab strip, never here. Projects is
 * current on `/`, on every `/w/:id/...` route and on `/analytics` (a project page and a spend
 * figure are both Projects facts); Workforce is current on `/workforce` and on the two routes that
 * 307 into it. The login page stands alone (M20 spec §3.3).
 *
 * Below 900px it collapses to a 52px icon rail in CSS alone (R6) -- no media query in JavaScript,
 * no state, nothing to hydrate: the label is hidden and the row's first letter takes its place,
 * while `aria-label`/`title` keep the word for a screen reader and a hover.
 */
export function Sidebar(): React.JSX.Element | null {
  const pathname = usePathname()
  if (pathname === '/login') return null
  const isCurrent = (href: string): boolean => {
    // A project page IS a Projects page opened, and so is the analytics view of one.
    if (href === '/') return pathname === '/' || pathname.startsWith('/w/') || pathname.startsWith('/analytics')
    // `/slaves` and `/skills` are 307s to `/workforce` (next.config.ts). The two paths are listed
    // anyway: a soft navigation renders this component against the OLD pathname for one frame, and
    // a nav row that blinks off during a redirect is a nav row that looks broken.
    if (href === '/workforce') return pathname === '/workforce' || pathname === '/slaves' || pathname === '/skills'
    if (href === '/sim') return pathname === '/sim' || pathname.startsWith('/sim/')
    return pathname === href
  }
  return (
    <>
      {/* The first focusable thing in the document (M44 R6). Off-screen until it has focus, which
        * is the only time it means anything. */}
      <a
        data-testid="skip-link"
        href="#main"
        className="sr-only rounded-chip border border-line bg-bg-2 px-3 py-1.5 text-xs text-text-1 focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50"
      >
        Skip to content
      </a>
      <nav
        aria-label="Primary"
        className="flex w-[212px] shrink-0 flex-col border-r border-line bg-bg-1 px-[8px] py-[10px] max-[899px]:w-[52px] max-[899px]:px-[6px]"
      >
        <div className="flex flex-col gap-px">
          {ROWS.map((row) => (
            <NavRow key={row.label} label={row.label} href={row.href} current={isCurrent(row.href)} />
          ))}
        </div>
      </nav>
    </>
  )
}
