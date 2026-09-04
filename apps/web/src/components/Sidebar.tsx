'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/** The five global pages, in the handoff's order with Projects first (M24 §2.1). */
const ROWS = [
  { label: 'Projects', href: '/' },
  { label: 'Agents', href: '/agents' },
  { label: 'Skills', href: '/skills' },
  { label: 'Analytics', href: '/analytics' },
  { label: 'Settings', href: '/settings' },
] as const

/** One nav row (mockup geometry: `7px 9px` padding, radius 6, 12.5px label). */
function NavRow({ label, href, current }: { readonly label: string; readonly href: string; readonly current: boolean }): React.JSX.Element {
  return (
    <Link
      data-testid="nav-row"
      data-nav={label}
      href={href}
      aria-current={current ? 'page' : undefined}
      className={`flex items-center justify-between rounded-nav px-[9px] py-[7px] text-[12.5px] transition-colors ${
        current
          ? 'bg-[#151a21] font-medium text-text-1 shadow-[inset_2px_0_0_var(--color-tone-working)]'
          : 'text-text-2 hover:bg-white/[0.045] hover:text-text-1'
      }`}
    >
      <span>{label}</span>
    </Link>
  )
}

/**
 * The handoff's 212px sidebar (design README §3a), reduced to the five global rows (M24 §2.1).
 * It is the same on every page: a project's own navigation lives in the project layout's tab
 * strip, never here. Projects is current on `/` and on every `/w/:id/...` route — a project page
 * is a Projects page opened. The login page stands alone (M20 spec §3.3).
 */
export function Sidebar(): React.JSX.Element | null {
  const pathname = usePathname()
  if (pathname === '/login') return null
  const isCurrent = (href: string): boolean => (href === '/' ? pathname === '/' || pathname.startsWith('/w/') : pathname === href)
  return (
    <nav aria-label="Primary" className="flex w-[212px] shrink-0 flex-col border-r border-line bg-bg-1 px-[8px] py-[10px]">
      <div className="flex flex-col gap-px">
        {ROWS.map((row) => (
          <NavRow key={row.label} label={row.label} href={row.href} current={isCurrent(row.href)} />
        ))}
      </div>
    </nav>
  )
}
