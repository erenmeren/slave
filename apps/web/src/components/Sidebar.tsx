'use client'

import type React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useProjectName } from '../hooks/useProjectName'
import { useWorkspaceStream } from '../hooks/useWorkspaceStream'
import type { ShellFacts } from '../server/shell'

/** The nine rows of the handoff's 3a shell, in its own order (design README §3a). Five are
 *  workspace-scoped and render only on a `/w/:id/...` route; four are global and always render. */
const GLOBAL_ROWS = [
  { label: 'Projects', href: '/' },
  { label: 'Skills', href: '/skills' },
  { label: 'Analytics', href: '/analytics' },
  { label: 'Settings', href: '/settings' },
] as const

const PROJECT_ROWS = [
  { label: 'Overview', path: (id: string) => `/w/${id}`, badge: 'none' },
  // `Agents` is the GLOBAL agents page (M11 Task 8) and keeps its global href; it sits among the
  // workspace-scoped rows because its badge is a workspace fact, and because README §3a puts it
  // second. Off a workspace route there is no count to carry, so the row does not render.
  { label: 'Agents', path: () => '/agents', badge: 'agentsWorking' },
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
        <span data-testid={`nav-badge-${label}`} className="font-mono text-[9.5px] font-medium text-text-3">
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
      <dt className="text-text-3">{label}</dt>
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
 * It rides the workspace's SSE stream through `useWorkspaceStream` exactly as every other live
 * view does, with `initial: null` because the root layout has no snapshot to hand it. Until the
 * first refetch lands, every figure reads `—`.
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
  const { snapshot } = useWorkspaceStream<ShellFacts | null>({
    workspaceId,
    endpoint: `/api/w/${workspaceId}/shell`,
    initial: null,
  })
  const facts = snapshot

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

/** The handoff's 212px sidebar (design README §3a). Nine rows in the README's order: five
 *  workspace-scoped (only on a `/w/:id/...` route) then four global, with the Guardrails block
 *  pinned to the bottom. */
export function Sidebar({ workspaceId: workspaceIdProp, projectName }: SidebarProps = {}): React.JSX.Element {
  const pathname = usePathname()
  const workspaceId = workspaceIdProp ?? workspaceIdFromPathname(pathname)
  const announcedName = useProjectName(workspaceId)

  return (
    <nav
      aria-label="Primary"
      className="flex w-[212px] shrink-0 flex-col border-r border-line bg-bg-1 px-[8px] py-[10px]"
    >
      {workspaceId !== null && (
        <>
          <div
            data-testid="project-section"
            className="truncate px-[9px] pb-[7px] font-mono text-[9px] uppercase tracking-[.09em] text-text-3"
          >
            {projectName ?? announcedName ?? workspaceId}
          </div>
          <ProjectNav workspaceId={workspaceId} pathname={pathname} />
        </>
      )}
      <div className={`flex flex-col gap-px ${workspaceId === null ? '' : 'mt-[12px]'}`}>
        {GLOBAL_ROWS.map((row) => (
          <NavRow key={row.label} label={row.label} href={row.href} current={pathname === row.href} />
        ))}
      </div>
    </nav>
  )
}
