'use client'

import { useState } from 'react'
import Link from 'next/link'
import { LANE_LABEL, TIMELINE_LANES, type TimelineLane } from '@slave-of-ai/domain'
// Type-only, so nothing from `server/*` (and nothing under it -- control, and the Prisma client)
// reaches the client bundle. The same rule `SupervisorPanel.tsx` states for `SupervisorView`.
import type { NeedsYouItem } from '../../server/needsYou'
import type { TimelineEntry } from '../../server/timeline'
import { postControl } from '../../lib/postControl'
import { ProposalRow } from '../SupervisorPanel'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { EmptyState } from '../ui/EmptyState'
import { Panel } from '../ui/Panel'
import { SectionLabel } from '../ui/SectionLabel'
import type { StatusTone } from '../ui/StatusPill'

/** The colour each lane is read in. A literal table, never an interpolated class (`StatusPill`'s
 *  own rule): Tailwind only generates a utility it can find as literal text. */
const LANE_TONE: Readonly<Record<TimelineLane, StatusTone>> = {
  user_request: 'planning',
  interpretation: 'planning',
  plan_change: 'waiting',
  work: 'working',
  decision: 'blocked',
  verified: 'done',
}

/** `HH:MM:SS` off the ISO stamp, the way `LiveEventsPanel` does it. */
function clock(iso: string): string {
  return iso.slice(11, 19)
}

/**
 * The project's history in six lanes (M45 R2).
 *
 * ORGANISATIONAL events and pending decisions -- what the project decided, not what a model said
 * while working. `laneFor` in the domain decides which lane an entry is on, and it is exhaustive
 * over every event type the database can store, so nothing arrives here unclassified and
 * `run.tool_call` cannot appear at all.
 *
 * DECISION REQUIRED is pinned above the river rather than sorted into it, and the reason is the
 * whole point of this page: a decision waiting on a person is not a thing that happened, it is a
 * thing that has not happened yet. Everything it can do it does through a verb that already
 * existed -- the M38/M39 approve/reject routes, M36's answer route, M35's unblock -- and the rows
 * are the SAME `ProposalRow`/`DraftEditor` the Supervisor panel renders, so a proposal reads and
 * answers identically wherever it is shown.
 *
 * The RIVER is `entries` with an event type; the PINNED lane is the queue. `buildSupervisorTimeline`
 * emits an entry for every pending decision, question and blocked task too (all three with a null
 * `eventType`), and this component renders those three from `needsYou` -- the SAME queue that
 * builder was handed -- so each shows exactly once, with the affordance its kind actually has.
 *
 * The raw event type is on `data-event-type` and in `title`, never in the words: `docs/ia.md`
 * rule 3.
 */
export function SupervisorTimeline({
  workspaceId,
  entries,
  needsYou,
}: {
  readonly workspaceId: string
  readonly entries: readonly TimelineEntry[]
  readonly needsYou: readonly NeedsYouItem[]
}): React.JSX.Element {
  /** Empty means ALL -- a filter nobody has touched hides nothing. */
  const [lanes, setLanes] = useState<ReadonlySet<TimelineLane>>(new Set())
  /** The one row currently writing. Per-row rather than per-panel: answering a question and
   *  unblocking a task are two independent acts on two independent rows. */
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const [answers, setAnswers] = useState<Readonly<Record<string, string>>>({})

  const decisionEntries = entries.filter((entry) => entry.decision !== null)
  const questions = needsYou.filter((item) => item.kind === 'question' && item.messageId !== null)
  const blocked = needsYou.filter((item) => item.kind === 'blocked_task' && item.taskId !== null)
  const integrate = needsYou.filter((item) => item.kind === 'integrate')
  const waiting = decisionEntries.length + questions.length + blocked.length + integrate.length

  const river = entries.filter((entry) => entry.eventType !== null && (lanes.size === 0 || lanes.has(entry.lane)))

  /** The board's titles by id, off the entries this river already carries -- what a `cancel_task`
   *  proposal names instead of a uuid ({@link ProposalRow}'s `taskTitles`). Never a second read. */
  const taskTitles: Record<string, string> = {}
  for (const entry of entries) {
    if (entry.taskId !== null && entry.taskTitle !== null) taskTitles[entry.taskId] = entry.taskTitle
  }

  const send = async (rowId: string, url: string, body?: Record<string, unknown>): Promise<void> => {
    setBusyId(rowId)
    setErrors((was) => {
      const { [rowId]: _gone, ...rest } = was
      return rest
    })
    const result = await postControl(url, body)
    if (!result.ok) setErrors((was) => ({ ...was, [rowId]: result.error }))
    setBusyId(null)
  }

  const toggleLane = (lane: TimelineLane): void => {
    setLanes((was) => {
      const next = new Set(was)
      if (next.has(lane)) next.delete(lane)
      else next.add(lane)
      return next
    })
  }

  /** The refusal for one row, beside that row and nowhere else. */
  const rowError = (rowId: string): React.JSX.Element | false =>
    errors[rowId] !== undefined && (
      <span role="alert" data-testid="timeline-error" className="text-[11px] text-tone-blocked">
        {errors[rowId]}
      </span>
    )

  return (
    <div className="flex flex-col gap-[11px] px-[20px] pt-[16px]">
      {waiting > 0 && (
        <section data-testid="timeline-decisions">
          <Panel>
            <SectionLabel>{LANE_LABEL.decision}</SectionLabel>
            {decisionEntries.map((entry) => {
              // Narrowed by `decisionEntries`' own filter; TypeScript cannot see through it.
              const decision = entry.decision
              if (decision === null) return null
              const rowId = `decision-${decision.id}`
              const url = `/api/w/${workspaceId}/supervisor/decisions/${decision.id}`
              return (
                // A one-item `<ul>` per decision, because `ProposalRow` IS the `<li>` and the
                // anchor the needs-you tile links to has to sit on an element that wraps it.
                <ul key={entry.key} id={rowId} className="flex flex-col gap-1">
                  <ProposalRow
                    decision={decision}
                    // The panel's mailbox is not on this page, so a drafted answer shows its
                    // situation summary rather than a question this component would have to
                    // invent -- `DraftEditor` documents that `undefined` reading.
                    questions={[]}
                    taskTitles={taskTitles}
                    busy={busyId === rowId}
                    // The same two envelopes `SupervisorPanel` sends: no body at all unless the
                    // operator rewrote the draft, and a blank reason is no reason rather than an
                    // empty one.
                    onApprove={(body) => void send(rowId, `${url}/approve`, body === undefined ? undefined : { body })}
                    onReject={(reason) => void send(rowId, `${url}/reject`, reason.trim() === '' ? {} : { reason })}
                  />
                  {errors[rowId] !== undefined && <li>{rowError(rowId)}</li>}
                </ul>
              )
            })}
            {questions.length + blocked.length + integrate.length > 0 && (
              <ul className="flex flex-col gap-2">
                {questions.map((item) => {
                  const messageId = item.messageId ?? ''
                  const rowId = `question-${messageId}`
                  const answer = answers[messageId] ?? ''
                  return (
                    <li key={rowId} id={rowId} className="flex flex-col gap-1 rounded border border-line p-2">
                      {/* Another worker's words, as characters (spec §1). */}
                      <span className="text-xs text-text-1">{item.title}</span>
                      <textarea
                        data-testid="timeline-answer-input"
                        value={answer}
                        rows={2}
                        placeholder="the answer this slave receives"
                        onChange={(event) => setAnswers((was) => ({ ...was, [messageId]: event.target.value }))}
                        className="rounded border border-line bg-bg-0 p-2 text-xs text-text-1"
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          variant="primary"
                          data-testid="timeline-answer-send"
                          disabled={answer.trim() === '' || busyId === rowId}
                          onClick={() => void send(rowId, `/api/w/${workspaceId}/messages/${messageId}/answer`, { answer })}
                        >
                          answer
                        </Button>
                        {rowError(rowId)}
                      </div>
                    </li>
                  )
                })}
                {blocked.map((item) => {
                  const taskId = item.taskId ?? ''
                  const rowId = `blocked-${taskId}`
                  return (
                    <li key={rowId} className="flex items-center gap-2 rounded border border-line p-2">
                      <span className="min-w-0 flex-1 text-xs text-text-1">{item.title}</span>
                      {rowError(rowId)}
                      <Button
                        variant="ghost"
                        data-testid="timeline-unblock"
                        disabled={busyId === rowId}
                        onClick={() => void send(rowId, `/api/w/${workspaceId}/tasks/${taskId}/unblock`)}
                      >
                        unblock
                      </Button>
                    </li>
                  )
                })}
                {integrate.map((item) => (
                  // A LINK, not a button: `confirmIntegration` has no web route, and an affordance
                  // that cannot work is worse than one that is honest about where to go (E11).
                  <li key={`integrate-${item.id}`} className="flex items-center gap-2 rounded border border-line p-2">
                    <Link href={item.href} className="min-w-0 flex-1 text-xs text-text-1 underline">
                      {item.title}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </section>
      )}

      <Panel title="timeline">
        <div role="group" aria-label="Timeline lanes" data-testid="timeline-lanes" className="flex flex-wrap gap-1">
          {TIMELINE_LANES.map((lane) => {
            const on = lanes.has(lane)
            return (
              <button
                key={lane}
                type="button"
                data-testid={`timeline-lane-filter-${lane}`}
                data-lane={lane}
                aria-pressed={on}
                onClick={() => toggleLane(lane)}
                className={`rounded-chip border px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-wide transition-colors ${
                  on ? 'border-line-hover bg-bg-2 text-text-1' : 'border-line bg-transparent text-text-3 hover:text-text-2'
                }`}
              >
                {LANE_LABEL[lane]}
              </button>
            )
          })}
        </div>
        <ol data-testid="timeline" className="flex flex-col gap-1">
          {river.length === 0 ? (
            <li>
              <EmptyState testId="timeline-empty" message="nothing in these lanes yet" />
            </li>
          ) : (
            river.map((entry) => (
              <li
                key={entry.key}
                data-testid="timeline-entry"
                data-lane={entry.lane}
                data-resolved={entry.resolved ? 'true' : 'false'}
                {...(entry.eventType === null ? {} : { 'data-event-type': entry.eventType, title: entry.eventType })}
                // A decision a person already took is history, not a demand: muted, in place
                // (spec erratum E27).
                className={`flex flex-col gap-0.5 border-l-2 border-line pl-2 ${entry.resolved ? 'opacity-60' : ''}`}
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="shrink-0 font-mono text-[10px] text-text-3">{clock(entry.at)}</span>
                  <Chip tone={LANE_TONE[entry.lane]}>{entry.laneLabel}</Chip>
                  {/* A model's or a person's sentence, as JSX children (spec §1). */}
                  <span className="min-w-0 text-xs text-text-1">{entry.title}</span>
                  {entry.collapsedCount > 0 && (
                    <span className="shrink-0 text-[10px] text-text-3">+{entry.collapsedCount} earlier</span>
                  )}
                </div>
                {entry.detail !== null && <span className="text-[11px] text-text-2">{entry.detail}</span>}
                {entry.taskTitle !== null && (
                  <span className="font-mono text-[10px] text-text-3">{entry.taskTitle}</span>
                )}
              </li>
            ))
          )}
        </ol>
      </Panel>
    </div>
  )
}
