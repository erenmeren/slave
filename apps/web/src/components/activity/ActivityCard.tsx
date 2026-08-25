import type { ReactElement, ReactNode } from 'react'
import Link from 'next/link'
import type { ActivityEventRow } from '../../server/activity'

// `ui/Chip.tsx`'s exact recipe (`inline-flex items-center rounded-chip border px-2 py-0.5
// text-xs`, neutral surface `border-line bg-bg-2 text-text-2`), not the literal component --
// `Chip` takes only `tone`/`children`, no `data-testid` passthrough, and this badge's own
// `actor-badge` test-id (`activity-cards.test.tsx`) must stay put. Same judgment `TaskCard.tsx`'s
// `CHIP_CLASS` documents; kept at the row rhythm's existing compact `text-[10px]` size (spec 1c)
// rather than Chip's own `text-xs`.
const ACTOR_CHIP_CLASS = 'inline-flex items-center rounded-chip border border-line bg-bg-2 px-1.5 py-0.5 font-mono text-[10px] text-text-3'

/**
 * The one prop shape every card in `ACTIVITY_CARDS` (`cards.tsx`) takes. `agentName`/`taskTitle`
 * are resolved by the page from its roster — `null` means "not found" (or the event carries no
 * id at all), in which case the shared shell falls back to the bare id.
 */
export interface ActivityCardProps {
  readonly event: ActivityEventRow
  readonly workspaceId: string
  readonly agentName: string | null
  readonly taskTitle: string | null
}

/** `2026-08-22T10:00:00.000Z` → `10:00:00` — a fixed slice of the ISO string rather than
 *  `toLocaleTimeString`, so the rendered text is timezone- and locale-independent (both in tests
 *  and across viewers). */
function EventTime({ ts }: { readonly ts: string }): ReactElement {
  return (
    <time dateTime={ts} data-testid="event-time" className="font-mono text-xs text-text-3">
      {ts.slice(11, 19)}
    </time>
  )
}

/** The envelope's `actor` (`human` / `agent` / `system`) — distinct from a payload's
 *  `requestedBy`/`category`, which some intervention cards show in the body alongside this. */
function ActorBadge({ actor }: { readonly actor: string }): ReactElement {
  return (
    <span data-testid="actor-badge" className={ACTOR_CHIP_CLASS}>
      {actor}
    </span>
  )
}

/** Links to the Overview panel's `?agent=` param (spec surface — no agent detail route exists
 *  outside it). Renders nothing when the event carries no `agentId`. */
function AgentLink({
  workspaceId,
  agentId,
  agentName,
}: {
  readonly workspaceId: string
  readonly agentId: string | null
  readonly agentName: string | null
}): ReactElement | null {
  if (agentId === null) return null
  return (
    <Link
      href={`/w/${workspaceId}?agent=${agentId}`}
      data-testid="agent-link"
      className="text-xs text-text-2 hover:text-text-1 hover:underline"
    >
      {agentName ?? agentId}
    </Link>
  )
}

/** Links to the tasks board's `?task=` param. Renders nothing when the event carries no `taskId`. */
function TaskLink({
  workspaceId,
  taskId,
  taskTitle,
}: {
  readonly workspaceId: string
  readonly taskId: string | null
  readonly taskTitle: string | null
}): ReactElement | null {
  if (taskId === null) return null
  return (
    <Link
      href={`/w/${workspaceId}/tasks?task=${taskId}`}
      data-testid="task-link"
      className="text-xs text-text-2 hover:text-text-1 hover:underline"
    >
      {taskTitle ?? taskId}
    </Link>
  )
}

/** The collapsible raw-payload section every card carries, closed by default — pretty-printed
 *  JSON behind a `<details>`/`<summary>` toggle rather than a click handler, so it needs no state
 *  of its own and degrades to plain markup with no JS. */
function PayloadDetails({ payload }: { readonly payload: Record<string, unknown> }): ReactElement {
  return (
    <details className="group">
      <summary
        data-testid="payload-toggle"
        className="cursor-pointer text-[10px] uppercase tracking-wide text-text-3 group-open:text-text-2"
      >
        payload
      </summary>
      <pre
        data-testid="payload-json"
        className="mt-1 overflow-x-auto rounded border border-line bg-bg-0 p-2 font-mono text-[10px] text-text-2"
      >
        {JSON.stringify(payload, null, 2)}
      </pre>
    </details>
  )
}

/**
 * The shared shell every card in `cards.tsx` wraps its body with: time, actor badge, agent/task
 * links, and the collapsible raw-payload `<details>`. Card bodies specialise only the middle
 * `children` slot — none of them re-implement the primitives above.
 */
export function ActivityCard({
  event,
  workspaceId,
  agentName,
  taskTitle,
  children,
}: ActivityCardProps & { readonly children: ReactNode }): ReactElement {
  return (
    // `ui/Card.tsx`'s surface tokens (`bg-bg-2`, `rounded-card`), not the literal component: `Card`
    // renders its own `<div>`/`<button>` with a fixed `data-testid="card"` and no `data-event-type`
    // passthrough, and `activity-page.test.tsx` asserts both this row's `activity-card` test-id and
    // its `data-event-type` directly on the element. Same judgment `AgentCard.tsx` documents for
    // its own `<article>`.
    <article
      data-testid="activity-card"
      data-event-type={event.type}
      className="flex flex-col gap-1.5 rounded-card border border-line bg-bg-2 p-3"
    >
      <header className="flex flex-wrap items-center gap-2">
        <EventTime ts={event.ts} />
        <ActorBadge actor={event.actor} />
        <AgentLink workspaceId={workspaceId} agentId={event.agentId} agentName={agentName} />
        <TaskLink workspaceId={workspaceId} taskId={event.taskId} taskTitle={taskTitle} />
      </header>
      <div className="text-sm text-text-1">{children}</div>
      <PayloadDetails payload={event.payload} />
    </article>
  )
}
