import type { ReactElement, ReactNode } from 'react'
import Link from 'next/link'
import { TONE_DOT, TONE_TEXT, type StatusTone } from '../ui/StatusPill'
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
  /** The web session's username that produced this event, or null (M23 F6): the CLI and the
   *  orchestrator write no user, and a run whose event predates this column reads back null too.
   *  Resolved by the page from `ActivityPage.users`, the same way `agentName`/`taskTitle` are. */
  readonly userName: string | null
  /** Dimmed to opacity .35 because a roster row is selected and this event is not that agent's
   *  (design README "Filtering"). Widened onto the SHARED prop shape, not onto each card, so
   *  every entry in `ACTIVITY_CARDS` forwards it through its existing `{...props}` spread with
   *  no per-card edit. */
  readonly dimmed: boolean
}

/**
 * The river dot's tone, by the event type's dotted PREFIX. A DISPLAY mapping, not a domain one:
 * `StatusTone` describes what a card looks like, and an event type is not a status -- nothing
 * downstream may read a run's or a task's actual state back out of this. It exists so the stream
 * reads as one system at a glance (every `run.*` the same teal, every `guardrail.*` the same
 * red), which a per-type table of thirty colours would not achieve.
 */
export function toneForEventType(type: string): StatusTone {
  const prefix = type.slice(0, type.indexOf('.') + 1)
  switch (prefix) {
    case 'run.':
      return 'working'
    case 'task.':
      return 'planning'
    case 'guardrail.':
      return 'blocked'
    case 'workspace.':
      return 'review'
    case 'agent.':
      return 'waiting'
    default:
      return 'idle'
  }
}

/** The stream dot's `0 0 9px` glow (design README "1c": "7px dot, 0 0 9px glow"). A separate map
 *  from `ui/StatusPill`'s `TONE_GLOW`, which is the `0 0 8px` BAR glow the tokens section
 *  specifies for progress fills -- two different numbers in the handoff, so two maps rather than
 *  one that is wrong in one of the two places. Literal per-tone strings for the reason
 *  `TONE_GLOW` documents: Tailwind only generates a class it can find as literal source text. */
const TONE_DOT_GLOW: Record<StatusTone, string> = {
  working: 'shadow-[0_0_9px_var(--color-tone-working)]',
  planning: 'shadow-[0_0_9px_var(--color-tone-planning)]',
  review: 'shadow-[0_0_9px_var(--color-tone-review)]',
  waiting: 'shadow-[0_0_9px_var(--color-tone-waiting)]',
  blocked: 'shadow-[0_0_9px_var(--color-tone-blocked)]',
  done: 'shadow-[0_0_9px_var(--color-tone-done)]',
  paused: 'shadow-[0_0_9px_var(--color-tone-paused)]',
  idle: 'shadow-[0_0_9px_var(--color-tone-idle)]',
}

/** `2026-08-22T10:00:00.000Z` → `10:00:00` — a fixed slice of the ISO string rather than
 *  `toLocaleTimeString`, so the rendered text is timezone- and locale-independent (both in tests
 *  and across viewers). The 74px right-aligned mono column of the README's row anatomy; with the
 *  28px dot gutter beside it, the 7px dot's centre lands at exactly x=88 — the rule
 *  (`Timeline.tsx`) is drawn at that same number, and the two only agree because these two widths
 *  are fixed. */
function EventTime({ ts }: { readonly ts: string }): ReactElement {
  return (
    <time
      dateTime={ts}
      data-testid="event-time"
      className="w-[74px] flex-none pt-[1px] text-right font-mono text-[10.5px] text-text-3"
    >
      {ts.slice(11, 19)}
    </time>
  )
}

/** The 28px gutter and its 7px tone dot — the row's half of the x=88 rule. */
function EventDot({ type }: { readonly type: string }): ReactElement {
  const tone = toneForEventType(type)
  return (
    <span data-testid="event-gutter" className="flex w-[28px] flex-none justify-center pt-[4px]">
      <span
        data-testid="event-dot"
        data-tone={tone}
        aria-hidden
        className={`h-[7px] w-[7px] rounded-full ${TONE_DOT[tone]} ${TONE_DOT_GLOW[tone]}`}
      />
    </span>
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
  tone,
}: {
  readonly workspaceId: string
  readonly agentId: string | null
  readonly agentName: string | null
  /** The row's own dot tone, so "who" and its dot read as one statement (the mock paints both
   *  from the same `e.color`). */
  readonly tone: StatusTone
}): ReactElement | null {
  if (agentId === null) return null
  return (
    <Link
      href={`/w/${workspaceId}?agent=${agentId}`}
      data-testid="agent-link"
      className={`text-[12px] font-semibold hover:underline ${TONE_TEXT[tone]}`}
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
      className="hover:text-text-2 hover:underline"
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
      {/* Design README "Event rows disclose payload on click (`▸ PAYLOAD` → `▾`)". `list-none`
        * removes the browser's own disclosure triangle so the handoff's glyph is the only one. */}
      <summary
        data-testid="payload-toggle"
        className="mt-[2px] cursor-pointer list-none text-[10px] uppercase tracking-wide text-text-3 group-open:text-text-2"
      >
        <span aria-hidden className="group-open:hidden">▸</span>
        <span aria-hidden className="hidden group-open:inline">▾</span> payload
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
 * The shared shell every card in `cards.tsx` wraps its body with — the design README's "1c" river
 * row, not a card: `74px right-aligned mono timestamp · 28px dot gutter (7px dot, 0 0 9px glow) ·
 * who + event kind + text · ref`. Card bodies specialise only the middle `children` slot; none of
 * them re-implements the primitives above, and none of them had to change for this layout.
 *
 * The bordered `rounded-card` surface this used to draw is gone on purpose: the mock's stream
 * (`Slave of AI Mockups.dc.html:858`) is a river of flush rows against the page, and thirty card
 * borders stacked vertically is exactly what the vertical rule replaces.
 */
export function ActivityCard({
  event,
  workspaceId,
  agentName,
  taskTitle,
  userName,
  dimmed,
  children,
}: ActivityCardProps & { readonly children: ReactNode }): ReactElement {
  const tone = toneForEventType(event.type)
  return (
    <article
      data-testid="activity-card"
      data-event-type={event.type}
      // Dimmed, never hidden (design README "Filtering"): the river keeps its shape and its
      // timestamps stay comparable, which a filtered-out row would destroy.
      className={`flex items-start py-[6px] pr-[18px] transition-opacity ${dimmed ? 'opacity-[.35]' : ''}`}
    >
      <EventTime ts={event.ts} />
      <EventDot type={event.type} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          {/* "who": the agent when the event names one (still a link to its Overview panel), the
            * envelope's bare actor otherwise. Tone-coloured at 12px/600, as the mock's own
            * `e.who` is. */}
          {event.agentId === null ? (
            <span data-testid="event-who" className={`text-[12px] font-semibold ${TONE_TEXT[tone]}`}>
              {agentName ?? event.actor}
            </span>
          ) : (
            <AgentLink workspaceId={workspaceId} agentId={event.agentId} agentName={agentName} tone={tone} />
          )}
          <ActorBadge actor={event.actor} />
          {/* Who, by name (M23 F6) -- only when the event carries an attributed user; the CLI and
            * the orchestrator's events render with no such chip at all. */}
          {userName === null ? null : (
            <span data-testid="event-user" className={ACTOR_CHIP_CLASS}>
              by {userName}
            </span>
          )}
          {/* "event kind": the dotted type itself, mono 9.5px — the mock's `e.kind`. */}
          <span data-testid="event-kind" className="font-mono text-[9.5px] text-text-3">
            {event.type}
          </span>
        </div>
        <div className="mt-[1px] text-[12px] text-[#c8cfda]">{children}</div>
        <PayloadDetails payload={event.payload} />
      </div>
      {/* "ref": the task this row belongs to, or the unknown mark when it belongs to none. */}
      {/* A flex item, so `truncate` blockifies and actually clips: a long task title must not
        * push the row's own right edge out and destroy the river's alignment. */}
      <span data-testid="event-ref" className="max-w-[140px] flex-none truncate pt-[3px] font-mono text-[9.5px] text-text-3">
        {event.taskId === null ? (
          '—'
        ) : (
          <TaskLink workspaceId={workspaceId} taskId={event.taskId} taskTitle={taskTitle} />
        )}
      </span>
    </article>
  )
}
