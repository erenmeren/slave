'use client'

import { useEffect, useRef, useState } from 'react'
import { SLAVE_LIFECYCLE_LABEL } from '@slave-of-ai/domain'
import { postControl } from '../lib/postControl'
import { CARD_STATE_TONE, cardStateFor } from '../lib/tones'
import type { SlaveCardData } from '../server/overview'
import { AvatarTile } from './ui/AvatarTile'
import { ProgressBar } from './ui/ProgressBar'
import { StatusPill } from './ui/StatusPill'

export const DOT: Record<SlaveCardData['status'], string> = {
  working: 'bg-tone-working',
  starting: 'bg-tone-planning',
  resuming: 'bg-tone-planning',
  pausing: 'bg-tone-paused',
  paused: 'bg-tone-paused',
  stopping: 'bg-tone-waiting',
  idle: 'bg-tone-idle',
}

/** The border-flash's `--flash-color` source per status (M5 spec §8) — no new colour tokens, just
 *  the existing status vocabulary referenced through the `@theme inline` names in globals.css.
 *  Exported: `OrgNodes.tsx`'s `SlaveNode` reuses this same map for its own border flash rather
 *  than re-deriving the status→colour assignment a second time. */
export const FLASH_COLOR: Record<SlaveCardData['status'], string> = {
  working: 'var(--color-tone-working)',
  starting: 'var(--color-tone-planning)',
  resuming: 'var(--color-tone-planning)',
  pausing: 'var(--color-tone-paused)',
  paused: 'var(--color-tone-paused)',
  stopping: 'var(--color-tone-waiting)',
  idle: 'var(--color-tone-idle)',
}

/** 800ms border-flash decay window (M5 spec §8) — the peripheral-vision cue that a status changed.
 *  Reused verbatim by the graph's node/edge flashes so every flash in the app shares one duration. */
export const BORDER_FLASH_MS = 800

/** The handoff's mono task reference: `TASK-` plus the id's first 8 characters. The product has
 *  no short task key column; this is the shortest form that is still unambiguous on one board. */
function taskRef(taskId: string): string {
  return `TASK-${taskId.slice(0, 8)}`
}

type CardAction = 'pause' | 'resume' | 'stop'

/**
 * One worker, as a ROW (M57 R18, README "Overview" → Team rows).
 *
 * It was a card in a three-up grid until this milestone, carrying every fact a worker has. The
 * README's Overview gives the team a list instead -- `34px 120px 120px 1fr 96px 32px`, one hairline
 * between rows -- because a person scanning eight workers is asking "who is stuck", not "what is
 * each one's tool call". Six facts stay on the row: the avatar's tone, the name and role, the
 * status WORD, what the worker is on, one primary action and a `⋯`.
 *
 * Everything else is in `SlavePanel`, which the name and the `⋯` both open (`docs/ia.md` rule 2 --
 * moved, not removed): the step counter, the skill, the queued message, the provider word and its
 * gate mark, the live action line, the waiting-for question, the resume-requested note, Message and
 * Stop. The progress BAR stays here (ruling P26): the panel carries no progress of any kind, and a
 * fact with nowhere else to go does not leave.
 *
 * The footer's control POSTs are unchanged -- the SAME routes `SlavePanel` uses
 * (`/api/w/:id/runs/:runId/{pause,resume,stop}`), no new endpoint, spec §3.
 */
export function SlaveCard({
  slave,
  workspaceId,
  onOpen,
}: {
  readonly slave: SlaveCardData
  /** Needed for the row's control POSTs (`/api/w/:id/runs/:runId/{pause,resume}`) -- the SAME
   *  routes `SlavePanel` uses. No new endpoint. */
  readonly workspaceId: string
  /** Opens the detail panel (spec §6) — where the message textarea and the full run record live. */
  readonly onOpen: (id: string) => void
}): React.JSX.Element {
  // M51 R7: the breaker's rung is the third fact the word is built from -- a working run the
  // breaker has spoken to reads STEERED/CONSTRAINED rather than WORKING, and nothing else moves.
  const state = cardStateFor(slave.status, slave.taskStatus, { breakerLevel: slave.breakerLevel })
  const { tone, label, pulse } = CARD_STATE_TONE[state]

  const [pending, setPending] = useState<ReadonlySet<CardAction>>(new Set())
  const [errorText, setErrorText] = useState<string | null>(null)

  // Border flash (M5 spec §8): only a CHANGE flashes — the ref holds the status this instance
  // last rendered, so the initial mount never flashes, and the timeout is cleared on
  // unmount/next-change so a rapid double-change leaves no stale timer.
  const previousStatus = useRef(slave.status)
  const [flashing, setFlashing] = useState(false)
  useEffect((): (() => void) | void => {
    if (previousStatus.current === slave.status) return
    previousStatus.current = slave.status
    setFlashing(true)
    const timer = setTimeout(() => setFlashing(false), BORDER_FLASH_MS)
    return () => clearTimeout(timer)
  }, [slave.status])

  const runId = slave.runId
  const canPause = runId !== null && (slave.status === 'starting' || slave.status === 'working' || slave.status === 'resuming')
  // `SlavePanel.tsx`'s guard, mirrored rather than restated loosely: the resume intent is a single
  // `resumeRequestedAt` column, so a second click cannot say anything the first did not. Disabled
  // here keeps that double-click a no-op instead of a second POST the server has to refuse. (The
  // panel also disables on a halted workspace; the row has no halt reason to read, and that one
  // stays server-refused into `card-error`.)
  const resumeRequestedWhilePaused = slave.status === 'paused' && slave.resumeRequestedAt !== null
  // M36 t2: a slave waiting for another slave's answer is `paused` like any other, and a bare
  // "Resume" on this row would read as continuing a pause an operator asked for. The row offers
  // "Answer" instead, which opens the panel -- the one place an answer can actually be typed and
  // delivered (the panel's message box, consumed by the resume).
  const waitingFor = slave.waitingFor
  const canResume = runId !== null && slave.status === 'paused' && waitingFor === null && !resumeRequestedWhilePaused
  const showResume = (slave.status === 'paused' || slave.status === 'pausing') && waitingFor === null

  const run = async (action: CardAction): Promise<void> => {
    if (runId === null) return
    setPending((current) => new Set(current).add(action))
    setErrorText(null)
    const result = await postControl(`/api/w/${workspaceId}/runs/${runId}/${action}`)
    if (!result.ok) setErrorText(result.error)
    setPending((current) => {
      const next = new Set(current)
      next.delete(action)
      return next
    })
  }

  return (
    <article
      data-testid="slave-card"
      data-status={slave.status}
      data-card-state={state}
      // M50 R3/D7: a released worker's row is still a row and still opens its panel -- it just
      // reads as finished. Greyed rather than removed (`docs/ia.md` rule 2).
      data-released={slave.released === null ? undefined : 'true'}
      // README "Overview" → Team rows: `34px 120px 120px 1fr 96px 32px`, padding `10px 14px`, with
      // the row's own hairline underneath. `TONE_BORDER` is gone from the recipe -- a ROW is not a
      // bordered card, and the tone now reads from the avatar tile and the status word instead.
      className={`relative grid grid-cols-[34px_120px_120px_minmax(0,1fr)_96px_32px] items-center gap-3 border-b border-line px-[14px] py-[10px] transition-colors hover:bg-hover ${
        flashing ? 'motion-safe:animate-[border-flash_800ms_ease-out]' : ''
      }${slave.released === null ? '' : ' opacity-60'}`}
      style={flashing ? ({ '--flash-color': FLASH_COLOR[slave.status] } as React.CSSProperties) : undefined}
    >
      {/* The activity sweep, unchanged (design README "Motion"): a 2.2s cubic-bezier(.4,0,.2,1)
        * gradient travelling the row's top hairline while it is `working`. The motion did not
        * change, so neither do `gate:m14-fidelity`'s three assertions on it. */}
      {state === 'working' && (
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px overflow-hidden">
          <span
            data-testid="card-sweep"
            className="block h-full w-full bg-gradient-to-r from-transparent via-s-working to-transparent motion-safe:animate-[card-sweep_2.2s_cubic-bezier(.4,0,.2,1)_infinite]"
          />
        </span>
      )}

      {/* 1. The 30px avatar tile (README "Overview" → Team rows). `size="md"` is `AvatarTile`'s
        * opt-in: that primitive renders on five other surfaces this milestone does not touch, so
        * its 28px default stays the default and this row asks for the bigger one. */}
      <AvatarTile name={slave.name} tone={tone} size="md" />

      {/* 2. Name and role. */}
      <button
        type="button"
        onClick={() => onOpen(slave.personId)}
        aria-label={`Open ${slave.name}'s detail panel`}
        className="min-w-0 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span className="flex items-center gap-[5px]">
          <span className="block truncate text-[13px] font-semibold text-t1">{slave.name}</span>
          {/* M50's lifecycle marker stays: `docs/ia.md` records it as a promise, and `project` --
            * the ordinary case -- still prints nothing, because a marker every row carries marks
            * nothing. The WORD, raw value in `title` (rule 3). */}
          {slave.lifecycle !== 'project' && (
            <span
              data-testid="card-lifecycle-chip"
              title={slave.lifecycle}
              className="shrink-0 rounded-chip border border-line2 px-[5px] text-[10.5px] text-t3"
            >
              {SLAVE_LIFECYCLE_LABEL[slave.lifecycle]}
            </span>
          )}
        </span>
        <span className="block truncate text-[12px] text-t3">{slave.role}</span>
      </button>

      {/* 3. The mini status: the dot and the WORD, in the tone. `StatusPill` keeps this row's
        * `status-pill` testid and its pulsing inner span, which `gate:m14-fidelity` reads as
        * `[data-testid="slave-card"] [data-testid="status-pill"] span`. */}
      <StatusPill tone={tone} label={label} pulse={pulse} />

      {/* 4. What this worker is doing, ellipsised, over the 3px progress bar. The
        * `card-task-title` testid is kept; the separate `card-task-ref` is folded into it, because
        * a row has one line here and the id is in `SlavePanel`, which the `⋯` opens. The BAR stays
        * (ruling P26): `SlavePanel` carries no progress at all, so this is the only surface that
        * answers "how far in is it". */}
      <span className="flex min-w-0 flex-col gap-[5px]">
        <span data-testid="card-task-title" className="min-w-0 truncate text-[13px] text-t2">
          {slave.taskTitle ?? 'idle'}
          {slave.taskId !== null && <span className="ml-2 font-mono text-[11px] text-t3">{taskRef(slave.taskId)}</span>}
        </span>
        <ProgressBar pct={slave.progressPct} tone={tone} size="card" />
      </span>

      {/* 5. ONE primary button (README "One action cluster"). Its testid follows its ACTION, so
        * `gate:m14-fidelity` still finds `card-pause` on a working row. `Unblock` is
        * accent-filled -- the README's one emphasised row action.
        *
        * `slave.taskStatus`, NEVER `slave.status` (ruling P7). `SlaveCardData.status` is a
        * `SlaveStatus` -- `idle | starting | working | pausing | paused | resuming | stopping` --
        * with no `blocked` member at all, so comparing it against `'blocked'` does not even
        * compile. The README's Unblock is about a blocked TASK, which is the field `cardStateFor`
        * already reads above. */}
      {waitingFor !== null ? (
        <RowButton testId="card-answer" accent onClick={() => onOpen(slave.personId)}>
          Answer
        </RowButton>
      ) : slave.taskStatus === 'blocked' ? (
        <RowButton testId="card-unblock" accent onClick={() => onOpen(slave.personId)}>
          Unblock
        </RowButton>
      ) : showResume ? (
        <RowButton testId="card-resume" disabled={!canResume || pending.has('resume')} onClick={() => void run('resume')}>
          Resume
        </RowButton>
      ) : (
        <RowButton testId="card-pause" disabled={!canPause || pending.has('pause')} onClick={() => void run('pause')}>
          Pause
        </RowButton>
      )}

      {/* 6. `⋯` -- Message and Stop live in `SlavePanel`, which is what this opens, and both are
        * already there (`docs/ia.md` rule 2: moved, not removed). */}
      <button
        type="button"
        data-testid="card-more"
        aria-label={`More actions for ${slave.name}`}
        onClick={() => onOpen(slave.personId)}
        className="rounded-card border-0 bg-transparent text-center text-[14px] text-t3 transition-colors hover:text-t1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        ⋯
      </button>

      {errorText !== null && (
        <span role="alert" data-testid="card-error" className="col-span-6 text-[11px] text-s-blocked">
          {errorText}
        </span>
      )}
    </article>
  )
}

/** The row's one action. Not `ui/Button`: that component fixes `data-testid="button"` for every
 *  instance, and this row's button needs the testid to say which action it is. */
function RowButton({
  testId,
  accent = false,
  disabled = false,
  onClick,
  children,
}: {
  readonly testId: string
  readonly accent?: boolean
  readonly disabled?: boolean
  readonly onClick: () => void
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-tile px-[10px] py-[5px] text-center text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
        accent ? 'border-0 bg-accent font-semibold text-accent-ink' : 'border border-line2 bg-transparent text-t1 hover:bg-hover'
      }`}
    >
      {children}
    </button>
  )
}
