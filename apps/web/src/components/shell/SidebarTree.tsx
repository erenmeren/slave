'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { SECTIONS, VIEWS, sectionOf, viewOf, workspaceIdOf } from '../../lib/routes'
import type { SidebarProject } from '../../server/sidebar'
import { useShellFacts } from '../../hooks/useShellFacts'
import { useStreamState } from '../../hooks/useStreamState'
import { THEME_GLYPH, THEME_LABEL, useTheme } from '../theme/ThemeProvider'

/** The three destinations that are not a project (M44 R1, unchanged). `Projects` is not among
 *  them: it is the TREE's own root row, above the project list, and it is a link like the rest. */
const GLOBAL_ROWS = [
  { label: 'Workforce', href: '/workforce' },
  { label: 'Simulations', href: '/sim' },
  { label: 'Settings', href: '/settings' },
] as const

/** README "Shell" → Sidebar: rows are 13.5px at `7px 10px`, radius 8; selected takes `--sel`,
 *  weight 600 and `--t1`, everything else `--t2`. One recipe, three callers. */
function rowClass(selected: boolean, dense = false): string {
  const size = dense ? 'px-[9px] py-[5px] text-[13px] rounded-tile' : 'px-[10px] py-[7px] text-[13.5px] rounded-card'
  const state = selected ? 'bg-sel font-semibold text-t1' : 'text-t2 hover:bg-hover hover:text-t1'
  return `flex w-full items-center gap-2 ${size} ${state} transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent`
}

/** The 7px status dot beside a project row. Its colour is the project's own state through the
 *  handoff's status tokens -- one class per state, spelled literally so Tailwind's static scan
 *  finds them (the rule `ui/StatusPill.tsx` already documents for the same reason). */
const PROJECT_DOT: Record<SidebarProject['status'], string> = {
  archived: 'bg-s-idle',
  halted: 'bg-s-blocked',
  needs_you: 'bg-s-waiting',
  working: 'bg-s-working',
  idle: 'bg-s-idle',
}

/** How long a `facts` wake-up has to wait before it may refetch the tree again (spec erratum E11,
 *  scan finding 23). Module scope, not a component const: it is a constant of the design, and the
 *  effect below reads it. */
const SIDEBAR_REFETCH_MS = 10_000

/** The one route a signed-out person can reach (`lib/boundary.ts`'s public paths). The frame still
 *  renders there -- the header's breadcrumb says `Sign in` -- but the tree has nothing to show and
 *  nothing to ask for. */
const LOGIN_PATH = '/login'

/**
 * The sidebar, as a TREE (M57 R5).
 *
 * `initial` is the root layout's server read, so the first paint is right; after that the tree
 * refetches `GET /api/sidebar` on two triggers and no more. The first is a ROUTE CHANGE (a project
 * was created, archived or renamed on the page you just left). The second is a wake-up from the
 * CURRENT workspace's stream, observed through `useShellFacts` -- every workspace page client
 * publishes to that store on every one of its own 250ms-debounced refetches, so its identity
 * changing IS "something happened in this project", and the tree costs no second `EventSource`.
 * That is the defect `hooks/useShellFacts.ts:18-24` exists to prevent, and this component is the
 * fourth consumer to respect it.
 */
export function SidebarTree({ initial }: { readonly initial: readonly SidebarProject[] }): React.JSX.Element {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [projects, setProjects] = useState<readonly SidebarProject[]>(initial)
  const lastPathname = useRef(pathname)
  // WHICH PROJECT IS OPEN, and the query string is the second way of saying it (ruling T3-2).
  // `/analytics?workspace=<id>` is a project's page that does not live under `/w/<id>` -- it is the
  // one VIEWS destination with a global route (`lib/routes.ts:52-54`) -- so a pathname-only answer
  // would close the whole subtree the moment somebody followed the Analytics chip out of it.
  const workspaceParam = searchParams.get('workspace')
  const openId = workspaceIdOf(pathname) ?? workspaceParam
  const facts = useShellFacts(openId)
  const section = sectionOf(pathname)
  const view = viewOf(pathname)
  const { theme, cycle } = useTheme()
  // `/login` keeps the frame and loses the tree (ruling T3-3): a person who is not signed in has no
  // projects to be shown and no business asking for the list. The rows are dropped HERE rather than
  // by handing the layout an empty array, because in loopback mode the layout's read is not gated at
  // all and `initial` arrives full even on this route.
  const signedOut = pathname === LOGIN_PATH
  const rows = signedOut ? [] : projects
  // The footer chip is the project header's old `connection` badge, moved (README "Shell" →
  // Sidebar footer). Its source is the SAME module store the header read -- `useStreamState`,
  // published by whichever workspace page is streaming -- so the number is the same number, on a
  // different wall. `null` on a global route and before the first frame, and the chip then says
  // `live · —` rather than inventing one.
  const stream = useStreamState(openId ?? '')

  // THROTTLE (spec erratum E11, scan finding 23). `pathname` may fire this at will -- a
  // navigation is rare and a person just did it. `facts` may not: `sameFacts` compares twelve live
  // figures, and spend, `slavesWorking`, `tasksActive` and `slavesPaused` all move several times a
  // minute while a run is live, so an unthrottled effect fires `GET /api/sidebar` -- four queries
  // -- at roughly the stream's own cadence, for a tree whose rows change when somebody creates or
  // archives a project. A ref, not state: bumping it must not re-render.
  //
  // It starts at MOUNT TIME, not at 0 (ruling T3-5): `initial` is the root layout's own read from
  // this very request, so a zero here would make every page load fetch the tree a second time, one
  // frame after the server sent it. The window opens ten seconds later, and a route change still
  // jumps the queue.
  const lastFetchedAt = useRef(Date.now())

  useEffect((): (() => void) | undefined => {
    // A pathname change always refetches; a facts change waits its turn.
    const forced = lastPathname.current !== pathname
    lastPathname.current = pathname
    if (pathname === LOGIN_PATH) return undefined
    const now = Date.now()
    if (!forced && now - lastFetchedAt.current < SIDEBAR_REFETCH_MS) return undefined
    lastFetchedAt.current = now
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const response = await fetch('/api/sidebar')
        if (!response.ok) return
        const next = (await response.json()) as readonly SidebarProject[]
        if (!cancelled) setProjects(next)
      } catch {
        // Keep the tree we have. A sidebar that empties itself because one fetch failed is worse
        // than one that is a few seconds stale.
      }
    })()
    return (): void => {
      cancelled = true
    }
    // `facts` is the wake-up: its identity changes on every snapshot the open project's page
    // refetches. `pathname` is the other: you may have just come back from creating a project.
  }, [pathname, facts])

  return (
    <>
      {/* The first focusable thing in the document (M44 R6), unchanged. Off-screen until it has
        * focus, which is the only time it means anything. */}
      <a
        data-testid="skip-link"
        href="#main"
        className="sr-only rounded-chip border border-line bg-card px-3 py-1.5 text-xs text-t1 focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50"
      >
        Skip to content
      </a>
      <nav
        aria-label="Primary"
        data-testid="sidebar-tree"
        className="flex w-[236px] shrink-0 flex-col overflow-y-auto border-r border-line bg-panel px-[10px] pb-[12px] pt-[14px]"
      >
        {/* Brand (README: 26px accent square, 13.5/600 name, 11.5px muted sub). */}
        <div className="flex items-center gap-[10px] px-2 pb-3 pt-1">
          <span aria-hidden className="h-[26px] w-[26px] shrink-0 rounded-card bg-accent" />
          <span className="min-w-0">
            <span className="block truncate text-[13.5px] font-semibold text-t1">Slave of AI</span>
            <span className="block truncate text-[11.5px] text-t3">self-hosted</span>
          </span>
        </div>

        {/* The ⌘K field. It is RENDERED and INERT this milestone (spec §6 names it): the README
          * draws it, a missing control would read as an unfinished design, and a control that
          * looked live but did nothing would be worse than either. `aria-disabled` is how it says
          * so to a screen reader, and it is not focusable. */}
        <div
          data-testid="sidebar-search"
          aria-disabled="true"
          className="mb-[10px] flex items-center gap-2 rounded-card border border-line2 bg-card px-[10px] py-[6px] text-[12.5px] text-t3"
        >
          <span className="flex-1">Search or jump…</span>
          <span className="font-mono text-[11px] font-medium">⌘K</span>
        </div>

        <div className="flex flex-col gap-px">
          <Link href="/" className={rowClass(pathname === '/')} aria-current={pathname === '/' ? 'page' : undefined}>
            <span className="flex-1 text-left">Projects</span>
            <span className="font-mono text-[11.5px] font-medium text-t3">{rows.length}</span>
          </Link>

          {/* The project list, indented behind a hairline rule -- the README's own geometry. */}
          <div className="ml-[10px] flex flex-col gap-px border-l border-line pl-[6px]">
            {rows.map((project) => {
              const open = project.id === openId
              return (
                <div key={project.id} className="flex flex-col gap-px">
                  <Link
                    data-testid="sidebar-project"
                    data-project-id={project.id}
                    data-status={project.status}
                    title={project.statusLabel}
                    aria-current={open ? 'page' : undefined}
                    href={`/w/${project.id}`}
                    className={rowClass(open)}
                  >
                    <span aria-hidden className={`h-[7px] w-[7px] shrink-0 rounded-full ${PROJECT_DOT[project.status]}`} />
                    <span className="flex-1 truncate text-left">{project.name}</span>
                    {project.needsYouCount > 0 && (
                      <span data-testid="sidebar-needs-you" className="font-mono text-[11px] font-medium text-s-waiting">
                        {project.needsYouCount}
                      </span>
                    )}
                  </Link>

                  {open && (
                    <div className="ml-[14px] flex flex-col gap-px">
                      {SECTIONS.map((spec) => (
                        <Link
                          key={spec.id}
                          data-testid="sidebar-section"
                          data-section={spec.id}
                          href={spec.href(project.id)}
                          aria-current={section === spec.id ? 'page' : undefined}
                          className={rowClass(section === spec.id, true)}
                        >
                          <span className="flex-1 text-left">{spec.label}</span>
                          {spec.id === 'tasks' && facts !== null && (
                            <span className="font-mono text-[11px] font-medium text-t3">{facts.counts.tasksActive}</span>
                          )}
                        </Link>
                      ))}
                      {/* README: mono 600 10.5px, .08em, `--t3`. This is the `Advanced ▾` menu's
                        * three destinations, visible (M57 R11). */}
                      <div className="px-[9px] pb-[3px] pt-2 font-mono text-[10.5px] font-semibold uppercase tracking-[.08em] text-t3">
                        Views
                      </div>
                      <div className="flex flex-wrap gap-1 px-[6px] pb-[6px]">
                        {VIEWS.map((spec) => {
                          // Analytics answers from the SEARCH STRING, because its route carries no
                          // `/w/<id>` for `viewOf` to read (`lib/routes.ts:97-98` says the caller
                          // decides, and this is the caller). The other two are a path segment.
                          const current =
                            spec.id === 'analytics'
                              ? pathname === '/analytics' && workspaceParam === project.id
                              : spec.id === view
                          return (
                            <Link
                              key={spec.id}
                              data-testid="sidebar-view"
                              data-view={spec.id}
                              href={spec.href(project.id)}
                              aria-current={current ? 'page' : undefined}
                              className={`rounded-nav border px-2 py-[3px] text-[12px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${
                                current ? 'border-accent text-accent' : 'border-line2 text-t2 hover:text-t1'
                              }`}
                            >
                              {spec.label}
                            </Link>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <div className="h-2" />

          {GLOBAL_ROWS.map((row) => {
            // `/slaves` and `/skills` are 307s into `/workforce` (next.config.ts). Both paths are
            // listed anyway: a soft navigation renders this component against the OLD pathname for
            // one frame, and a row that blinks off during a redirect looks broken.
            const current =
              row.href === '/workforce'
                ? pathname === '/workforce' || pathname === '/slaves' || pathname === '/skills'
                : row.href === '/sim'
                  ? pathname === '/sim' || pathname.startsWith('/sim/')
                  : pathname === row.href
            return (
              <Link
                key={row.label}
                data-testid="sidebar-global"
                data-nav={row.label}
                href={row.href}
                aria-label={row.label}
                title={row.label}
                aria-current={current ? 'page' : undefined}
                className={rowClass(current)}
              >
                <span className="flex-1 text-left">{row.label}</span>
              </Link>
            )
          })}
        </div>

        {/* Footer: the live chip the project header's `connection` badge used to be, and the theme
          * pill (README "Shell" → Sidebar footer). */}
        <div className="mt-auto flex items-center justify-between gap-2 px-[6px] pt-3 text-[12px] text-t3">
          {/* Three states, never two: `idle` (no page is streaming — a global route, or the
            * Settings tab, which publishes no stream), `reconnecting` (amber, no pulse — a chip
            * that keeps the live colour while the stream is down is a lie), and connected. */}
          <span data-testid="sidebar-live" data-connection={stream === null ? 'idle' : stream.connection} className="inline-flex items-center gap-[6px]">
            <span
              aria-hidden
              className={`h-[6px] w-[6px] rounded-full ${
                stream === null
                  ? 'bg-s-idle'
                  : stream.connection === 'reconnecting'
                    ? 'bg-s-waiting'
                    : 'bg-s-working motion-safe:animate-[status-pulse_1.5s_ease-in-out_infinite]'
              }`}
            />
            live · {stream?.latencyMs === null || stream === null ? '—' : `${stream.latencyMs}ms`}
          </span>
          <button
            type="button"
            data-testid="theme-toggle"
            data-theme-mode={theme}
            onClick={cycle}
            title={`Theme: ${THEME_LABEL[theme]} — click for the next one`}
            className="inline-flex items-center gap-[6px] rounded-pill border border-line2 bg-card px-2 py-1 text-[12px] font-medium text-t2 transition-colors hover:text-t1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span aria-hidden className="text-[13px] leading-none">{THEME_GLYPH[theme]}</span>
            {THEME_LABEL[theme]}
          </button>
        </div>
      </nav>
    </>
  )
}
