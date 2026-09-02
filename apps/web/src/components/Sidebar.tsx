'use client'

import type React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useProjectName } from '../hooks/useProjectName'
import { useShellFacts } from '../hooks/useShellFacts'
import type { ShellFacts } from '../server/shell'

/** The nine rows of the handoff's 3a shell, in its own order (design README §3a): Overview ·
 *  Agents · Tasks · Graph · Activity · Projects · Skills · Analytics · Settings. Four of them
 *  (Overview, Tasks, Graph, Activity) are `/w/:id/...` pages and render only on a workspace
 *  route — they have nowhere to point without one. The other five are global and always render;
 *  see `AGENTS_ROW` for the one that is both. */
const GLOBAL_ROWS = [
  { label: 'Projects', href: '/' },
  { label: 'Skills', href: '/skills' },
  { label: 'Analytics', href: '/analytics' },
  { label: 'Settings', href: '/settings' },
] as const

/**
 * `Agents` is the one row that is BOTH. Its page (`/agents`, M11 Task 8) is global and must be
 * reachable — and marked current — from every page, including `/agents` itself, where the root
 * layout mounts `<Sidebar />` with no workspace in scope. But its badge is a workspace fact.
 *
 * So the row is rendered from exactly one of two places, never both: from `ProjectNav` while a
 * workspace is in scope (that is where the count lives), and at the head of the global list
 * otherwise, where it simply carries no badge. Either way it holds README §3a's second position
 * among the rows that are showing.
 */
const AGENTS_ROW = { label: 'Agents', href: '/agents' } as const

const PROJECT_ROWS = [
  { label: 'Overview', path: (id: string) => `/w/${id}`, badge: 'none' },
  { label: AGENTS_ROW.label, path: () => AGENTS_ROW.href, badge: 'agentsWorking' },
  { label: 'Tasks', path: (id: string) => `/w/${id}/tasks`, badge: 'tasksActive' },
  { label: 'Graph', path: (id: string) => `/w/${id}/graph`, badge: 'none' },
  { label: 'Activity', path: (id: string) => `/w/${id}/activity`, badge: 'none' },
] as const

/**
 * Pulls a `w/:id` workspace id straight out of the pathname. The global shell mounts one
 * `<Sidebar>` in `app/layout.tsx` with no per-route props (a root layout gets no dynamic-segment
 * params of its own) -- this is how it still knows which project section to show. Existing
 * `w/[workspaceId]` pages that already know their id keep passing it explicitly via the
 * `workspaceId` prop instead (see `SidebarProps`), which this defers to when given.
 */
function workspaceIdFromPathname(pathname: string): string | null {
  const match = /^\/w\/([^/]+)/.exec(pathname)
  return match?.[1] ?? null
}

export interface SidebarProps {
  /** Explicit override for call sites that already know it. Omit to derive it from the current
   *  pathname instead (the global shell mount's path). */
  readonly workspaceId?: string
  /** The open project's display name, headline for the project section. The global shell mount
   *  has no cheap way to resolve this today (a root layout gets no per-route data) and omits it,
   *  so the header falls back to a route-announced name (`useProjectName`, M11 Task 10 ruling 2)
   *  and, failing that, the bare workspace id. */
  readonly projectName?: string
}

/** One nav row (mockup geometry: `7px 9px` padding, radius 6, 12.5px label, 9.5px mono badge).
 *  `badge` is already a rendered string (`'—'` before the snapshot lands), or absent for a row
 *  that carries no count at all. */
function NavRow({
  label,
  href,
  current,
  badge,
}: {
  readonly label: string
  readonly href: string
  readonly current: boolean
  readonly badge?: string
}): React.JSX.Element {
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
      {badge !== undefined && (
        <span data-testid={`nav-badge-${label}`} className="font-mono text-[9.5px] font-medium text-text-faint">
          {badge}
        </span>
      )}
    </Link>
  )
}

/** `1800000` → `30m`; `90000` → `1m30s`; `45000` → `45s`. The guardrail block shows a duration a
 *  person reads, not a millisecond count. */
export function formatTimeout(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s`
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`
}

function GuardrailRow({
  testId,
  label,
  value,
}: {
  readonly testId: string
  readonly label: string
  readonly value: string
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-text-faint">{label}</dt>
      <dd data-testid={testId} className="text-text-1">
        {value}
      </dd>
    </div>
  )
}

/**
 * The workspace-scoped half of the sidebar: the five project rows with their live badges, plus the
 * Guardrails block. Its own component because the counts need a hook and hooks cannot be
 * conditional — `Sidebar` renders this only when the pathname carries a workspace.
 *
 * Where the facts come from is decided HERE, once, and the two paths are two components rather
 * than one component with a conditional hook (controller ruling carried from M14 Task 3):
 *
 * - a page that already streams this workspace PUBLISHES them (`hooks/useShellFacts.ts`), and no
 *   second connection is opened at all. As of M14 Task 12 all four workspace pages do this
 *   (Overview, Tasks, Graph, Activity), which is every `/w/:id/...` route there is;
 * - anywhere else, it reads `/api/w/:id/shell` ONCE and shows what comes back.
 *
 * That second path is deliberately a one-shot `fetch` and NOT a stream. Until Task 12 it was its
 * own `EventSource`, which is what the publish mechanism existed to displace; leaving a live
 * fallback in place would keep the duplicate-connection failure mode alive for any future route
 * that forgets to publish, silently. A route that wants live figures publishes them — that is the
 * contract — and the fetch is only here so a page that does not still shows real numbers instead
 * of four dashes forever.
 *
 * The one-render `mayFallBack` gate is what makes "only when nobody publishes" true at MOUNT as
 * well as in steady state. `layout.tsx` renders `<Sidebar />` before `{children}`, so this
 * component's effects run before the page's publish effect in the same commit; without the gate
 * the sidebar would fire a request and discard it a beat later on every page that does publish,
 * which is the duplicate work this exists to remove. Both updates land in one batched re-render,
 * so the fallback mounts only where the publish never came — and until its response lands the
 * rows render exactly what they rendered before: the unknown mark.
 *
 * Returns a FRAGMENT, not a wrapper: its two blocks are direct flex children of `<nav>` so the
 * guardrail block's `mt-auto` has the sidebar's own free space to absorb, and its `order-last`
 * puts it below the global rows that follow it in the DOM (README §3a: the block sits at the
 * bottom of the sidebar, under everything).
 */
export function ProjectNav({
  workspaceId,
  pathname,
}: {
  readonly workspaceId: string
  readonly pathname: string
}): React.JSX.Element {
  const published = useShellFacts(workspaceId)
  const [mayFallBack, setMayFallBack] = useState(false)
  useEffect((): void => setMayFallBack(true), [])

  if (published !== null) return <ProjectNavRows workspaceId={workspaceId} pathname={pathname} facts={published} />
  if (!mayFallBack) return <ProjectNavRows workspaceId={workspaceId} pathname={pathname} facts={null} />
  return <FetchingProjectNav workspaceId={workspaceId} pathname={pathname} />
}

/**
 * The fallback path: ONE `fetch` of `/api/w/:id/shell` per workspace, never a stream (M14 Task 12
 * ruling — see `ProjectNav`'s doc comment). Until it resolves, every figure reads `—`, exactly as
 * before. A failed or non-200 response leaves the figures at `—` rather than throwing: these are
 * decorations on a nav, and there is no sensible way for a sidebar to report its own fetch error.
 */
function FetchingProjectNav({
  workspaceId,
  pathname,
}: {
  readonly workspaceId: string
  readonly pathname: string
}): React.JSX.Element {
  const [facts, setFacts] = useState<ShellFacts | null>(null)

  useEffect((): (() => void) => {
    // Guards against a late response landing after this component has moved to another workspace
    // (or unmounted entirely) and overwriting the newer one's figures.
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const response = await fetch(`/api/w/${workspaceId}/shell`)
        if (!response.ok) return
        const body = (await response.json()) as ShellFacts
        if (!cancelled) setFacts(body)
      } catch {
        // Left at `—`.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  return <ProjectNavRows workspaceId={workspaceId} pathname={pathname} facts={facts} />
}

/** The rows themselves — no hooks, no fetching, so both paths above render exactly the same
 *  markup from the same `ShellFacts | null`. */
function ProjectNavRows({
  workspaceId,
  pathname,
  facts,
}: {
  readonly workspaceId: string
  readonly pathname: string
  readonly facts: ShellFacts | null
}): React.JSX.Element {
  const badgeFor = (key: 'none' | 'agentsWorking' | 'tasksActive'): string | undefined => {
    if (key === 'none') return undefined
    if (facts === null) return '—'
    return String(facts.counts[key])
  }

  return (
    <>
      <div className="flex flex-col gap-px">
        {PROJECT_ROWS.map((row) => {
          const href = row.path(workspaceId)
          const badge = badgeFor(row.badge)
          return (
            <NavRow
              key={row.label}
              label={row.label}
              href={href}
              current={pathname === href}
              {...(badge === undefined ? {} : { badge })}
            />
          )
        })}
      </div>
      <div className="order-last -mx-[8px] mt-auto border-t border-line px-[12px] pt-[12px]">
        <div className="mb-[7px] font-mono text-[9px] font-medium uppercase tracking-[.09em] text-text-3">Guardrails</div>
        <dl className="flex flex-col gap-[6px] font-mono text-[10.5px]">
          <GuardrailRow
            testId="guardrail-budget"
            label="budget"
            value={
              facts === null || facts.guardrails.budgetUsd === null ? '—' : `$${facts.guardrails.budgetUsd.toFixed(2)}`
            }
          />
          <GuardrailRow
            testId="guardrail-concurrency"
            label="concurrency"
            value={facts === null ? '—' : String(facts.guardrails.maxConcurrentRuns)}
          />
          <GuardrailRow
            testId="guardrail-timeout"
            label="run timeout"
            value={facts === null ? '—' : formatTimeout(facts.guardrails.runTimeoutMs)}
          />
          <GuardrailRow
            testId="guardrail-attempts"
            label="attempts"
            value={facts === null ? '—' : String(facts.guardrails.maxAttempts)}
          />
        </dl>
      </div>
    </>
  )
}

/** The handoff's 212px sidebar (design README §3a). Nine rows in the README's order on a
 *  workspace route; off one, the four `/w/:id/...` rows drop and five remain (Agents · Projects ·
 *  Skills · Analytics · Settings), with the Guardrails block pinned to the bottom. */
export function Sidebar({ workspaceId: workspaceIdProp, projectName }: SidebarProps = {}): React.JSX.Element | null {
  const pathname = usePathname()
  const workspaceId = workspaceIdProp ?? workspaceIdFromPathname(pathname)
  const announcedName = useProjectName(workspaceId)
  // The shell is a logged-in surface; the login page stands alone (M20 spec §3.3). Hooks above
  // run unconditionally so the early return keeps React's hook order stable.
  if (pathname === '/login') return null

  return (
    <nav
      aria-label="Primary"
      className="flex w-[212px] shrink-0 flex-col border-r border-line bg-bg-1 px-[8px] py-[10px]"
    >
      {workspaceId !== null && (
        <>
          <div
            data-testid="project-section"
            className="truncate px-[9px] pb-[7px] font-mono text-[9px] uppercase tracking-[.09em] text-text-faint"
          >
            {projectName ?? announcedName ?? workspaceId}
          </div>
          <ProjectNav workspaceId={workspaceId} pathname={pathname} />
        </>
      )}
      <div className={`flex flex-col gap-px ${workspaceId === null ? '' : 'mt-[12px]'}`}>
        {/* Off a workspace route `ProjectNav` does not mount, so `Agents` is rendered here
          * instead — badge-less, since the count is a workspace fact. This is what keeps the row
          * present and `aria-current` on `/agents`, the page it links to. */}
        {workspaceId === null && (
          <NavRow label={AGENTS_ROW.label} href={AGENTS_ROW.href} current={pathname === AGENTS_ROW.href} />
        )}
        {GLOBAL_ROWS.map((row) => (
          <NavRow key={row.label} label={row.label} href={row.href} current={pathname === row.href} />
        ))}
      </div>
    </nav>
  )
}
