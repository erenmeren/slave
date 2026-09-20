'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import type React from 'react'
import { MODE_LABEL, useMode } from '../mode/ModeProvider'
import { THEME_GLYPH, THEME_LABEL, useTheme } from '../theme/ThemeProvider'
import { useStreamState } from '../../hooks/useStreamState'
import { railFor, railIdOf, workspaceIdOf, type RailId } from '../../lib/routes'
import { ChartIcon, FlaskIcon, HomeIcon, PeopleIcon, SettingsIcon } from './icons'

const ICON: Record<RailId, (props: React.SVGProps<SVGSVGElement>) => React.JSX.Element> = {
  home: HomeIcon,
  people: PeopleIcon,
  settings: SettingsIcon,
  simulations: FlaskIcon,
  analytics: ChartIcon,
}

/**
 * The 56px icon rail (M61 R5), replacing `SidebarTree`'s 236px tree: three destinations for
 * everybody, two more (`Simulations`, `Analytics`) once developer mode is on, the mode switch and
 * the theme pill at the foot, and the project list moved OUT of it entirely -- it lives in the
 * header's `ProjectSwitcher` now.
 *
 * It expands to 208px over the page's own content on hover (`position: absolute` inside its 56px
 * track, so it never pushes the grid), only where a hover actually means something
 * (`@media (hover: hover) and (pointer: fine)`) -- a touch or a keyboard user never has to fight a
 * flyout that opens on focus and never closes.
 */
export function Rail(): React.JSX.Element {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { mode, isDeveloper, toggle } = useMode()
  const { theme, cycle } = useTheme()
  const current = railIdOf(pathname)
  const openId = workspaceIdOf(pathname) ?? searchParams.get('workspace')
  const stream = useStreamState(openId ?? '')

  return (
    <nav data-testid="rail" aria-label="Main" className="group/rail relative z-20 h-full w-[56px]">
      <a
        data-testid="skip-link"
        href="#main"
        className="sr-only rounded-chip border border-line bg-card px-3 py-1.5 text-xs text-t1 focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50"
      >
        Skip to content
      </a>
      <div className="glass absolute inset-y-0 left-0 flex w-[56px] flex-col items-center gap-1 border-r border-line py-3 transition-[width] duration-[var(--dur-base)] ease-[var(--ease-out)] [@media(hover:hover)_and_(pointer:fine)]:group-hover/rail:w-[208px] [@media(hover:hover)_and_(pointer:fine)]:group-hover/rail:items-stretch">
        <Link href="/" aria-label="Slave of AI" className="mb-2 grid h-8 w-8 place-items-center self-center rounded-control bg-accent text-accent-ink font-semibold">
          S
        </Link>
        {railFor(mode).map((item) => {
          const Icon = ICON[item.id]
          const on = current === item.id
          return (
            <Link
              key={item.id}
              href={item.href}
              data-testid="rail-item"
              data-rail={item.id}
              title={item.label}
              aria-label={item.label}
              aria-current={on ? 'page' : undefined}
              className={`mx-2 flex h-9 items-center gap-3 rounded-control px-2 text-t2 hover:bg-hover hover:text-t1 ${on ? 'bg-sel text-t1 outline outline-1 outline-accent/50' : ''}`}
            >
              <Icon className="shrink-0" />
              <span className="hidden whitespace-nowrap text-[13px] group-hover/rail:[@media(hover:hover)_and_(pointer:fine)]:inline">{item.label}</span>
            </Link>
          )
        })}
        <div className="flex-1" />
        {/* The live chip, moved verbatim from `SidebarTree`'s footer (M57 R5 footer, unchanged
          * derivation): three states, never two -- `idle` (a global route, or Settings, which
          * publishes no stream), `reconnecting` (amber, no pulse -- a chip that keeps the live
          * colour while the stream is down is a lie), and connected. */}
        <span
          data-testid="sidebar-live"
          data-connection={stream === null ? 'idle' : stream.connection}
          title={`live · ${stream?.latencyMs === null || stream === null ? '—' : `${String(stream.latencyMs)}ms`}`}
          className="mx-2 inline-flex items-center gap-[6px] text-[12px] text-t3"
        >
          <span
            aria-hidden
            className={`h-[6px] w-[6px] shrink-0 rounded-full ${
              stream === null
                ? 'bg-s-idle'
                : stream.connection === 'reconnecting'
                  ? 'bg-s-waiting'
                  : 'bg-s-working motion-safe:animate-[status-pulse_1.5s_ease-in-out_infinite]'
            }`}
          />
          <span className="hidden whitespace-nowrap group-hover/rail:[@media(hover:hover)_and_(pointer:fine)]:inline">
            live · {stream?.latencyMs === null || stream === null ? '—' : `${stream.latencyMs}ms`}
          </span>
        </span>
        {/* The theme pill, moved verbatim from `SidebarTree`'s footer. */}
        <button
          type="button"
          data-testid="theme-toggle"
          data-theme-mode={theme}
          onClick={cycle}
          title={`Theme: ${THEME_LABEL[theme]} — click for the next one`}
          className="mx-2 flex h-9 items-center gap-3 rounded-control px-2 text-t2 hover:bg-hover hover:text-t1"
        >
          <span aria-hidden className="text-[15px] leading-none">{THEME_GLYPH[theme]}</span>
          <span className="hidden whitespace-nowrap text-[12.5px] group-hover/rail:[@media(hover:hover)_and_(pointer:fine)]:inline">{THEME_LABEL[theme]}</span>
        </button>
        {/* The mode switch (M61 R5): a 2-state switch whose `aria-checked` is `isDeveloper`. */}
        <button
          type="button"
          role="switch"
          aria-checked={isDeveloper}
          data-testid="mode-toggle"
          aria-label="Developer mode"
          title={`Developer mode (${isDeveloper ? 'on' : 'off'}) · ⌘⇧D`}
          onClick={toggle}
          className="mx-2 flex h-9 items-center gap-3 rounded-control px-2 text-t2 hover:text-t1"
        >
          <span className={`relative h-[16px] w-[28px] shrink-0 rounded-pill transition-colors duration-[var(--dur-fast)] ${isDeveloper ? 'bg-accent' : 'bg-line2'}`}>
            <span
              className={`absolute top-[2px] h-[12px] w-[12px] rounded-pill bg-bg transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)] ${
                isDeveloper ? 'translate-x-[14px]' : 'translate-x-[2px]'
              }`}
            />
          </span>
          <span className="hidden whitespace-nowrap text-[12.5px] group-hover/rail:[@media(hover:hover)_and_(pointer:fine)]:inline">{MODE_LABEL[mode]}</span>
        </button>
      </div>
    </nav>
  )
}
