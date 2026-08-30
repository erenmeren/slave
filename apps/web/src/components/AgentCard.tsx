'use client'

import { useEffect, useRef, useState } from 'react'
import { postControl } from '../lib/postControl'
import { CARD_STATE_TONE, cardStateFor } from '../lib/tones'
import type { AgentCardData } from '../server/overview'
import { ShellOnlyMark } from './ShellOnlyMark'
import { AvatarTile } from './ui/AvatarTile'
import { Chip } from './ui/Chip'
import { ProgressBar } from './ui/ProgressBar'
import { StatusPill, TONE_BORDER } from './ui/StatusPill'

export const DOT: Record<AgentCardData['status'], string> = {
  working: 'bg-status-working',
  starting: 'bg-status-starting',
  resuming: 'bg-status-starting',
  pausing: 'bg-status-paused',
  paused: 'bg-status-paused',
  stopping: 'bg-status-stopping',
  idle: 'bg-status-idle',
}

/** The border-flash's `--flash-color` source per status (M5 spec §8) — no new colour tokens, just
 *  the existing status vocabulary referenced through the `@theme inline` names in globals.css.
 *  Exported: `OrgNodes.tsx`'s `AgentNode` reuses this same map for its own border flash rather
 *  than re-deriving the status→colour assignment a second time. */
export const FLASH_COLOR: Record<AgentCardData['status'], string> = {
  working: 'var(--color-status-working)',
  starting: 'var(--color-status-starting)',
  resuming: 'var(--color-status-starting)',
  pausing: 'var(--color-status-paused)',
  paused: 'var(--color-status-paused)',
  stopping: 'var(--color-status-stopping)',
  idle: 'var(--color-status-idle)',
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
 * The design handoff's agent card (README "1a — Control Room"), rebuilt: 1px border in the status
 * colour at `3d` alpha, radius 8, bg `#0f1217`, padding 12px 13px. Header = `AvatarTile` + name +
 * role + `StatusPill`; task line = mono ref + ellipsised title; a `ProgressBar` with the tone's
 * `0 0 8px` glow; a step/percent row; three chips (skill · queue · provider); a footer of three
 * ghost buttons.
 *
 * The footer POSTs to the SAME routes `AgentPanel` uses (`/api/w/:id/runs/:runId/{pause,resume,
 * stop}`) — no new endpoint, spec §3. `Message` opens the panel instead of POSTing, because the
 * message textarea and its `paused`-only writability rule already live there and a second copy of
 * that rule on the card is where the two would drift apart.
 *
 * This stays its own `<article>` rather than `<Card>`: `Card` renders a fixed
 * `data-testid="card"` with no `className`, `style` or `data-status` passthrough, and this card
 * needs all three (the border flash's `--flash-color`, the per-state border colour, and the
 * `data-status` the gate and `overview-components.test.tsx` both read).
 */
export function AgentCard({
  agent,
  liveActionLine,
  workspaceId,
  onOpen,
}: {
  readonly agent: AgentCardData
  readonly liveActionLine: string | null
  /** Needed for the footer's control POSTs (`/api/w/:id/runs/:runId/{pause,resume,stop}`) --
   *  the SAME routes `AgentPanel` uses. No new endpoint. */
  readonly workspaceId: string
  /** Opens the detail panel (spec §6) — where the message textarea and the full run record live. */
  readonly onOpen: (id: string) => void
}): React.JSX.Element {
  const line = liveActionLine ?? agent.actionLine
  const state = cardStateFor(agent.status, agent.taskStatus)
  const { tone, label, pulse } = CARD_STATE_TONE[state]

  const [pending, setPending] = useState<ReadonlySet<CardAction>>(new Set())
  const [errorText, setErrorText] = useState<string | null>(null)

  // Border flash (M5 spec §8): only a CHANGE flashes — the ref holds the status this instance
  // last rendered, so the initial mount never flashes, and the timeout is cleared on
  // unmount/next-change so a rapid double-change leaves no stale timer.
  const previousStatus = useRef(agent.status)
  const [flashing, setFlashing] = useState(false)
  useEffect((): (() => void) | void => {
    if (previousStatus.current === agent.status) return
    previousStatus.current = agent.status
    setFlashing(true)
    const timer = setTimeout(() => setFlashing(false), BORDER_FLASH_MS)
    return () => clearTimeout(timer)
  }, [agent.status])

  const runId = agent.runId
  const canPause = runId !== null && (agent.status === 'starting' || agent.status === 'working' || agent.status === 'resuming')
  // `AgentPanel.tsx`'s guard, mirrored rather than restated loosely: the resume intent is a single
  // `resumeRequestedAt` column, so a second click cannot say anything the first did not. Disabled
  // here keeps that double-click a no-op instead of a second POST the server has to refuse. (The
  // panel also disables on a halted workspace; the card has no halt reason to read, and that one
  // stays server-refused into `card-error`.)
  const resumeRequestedWhilePaused = agent.status === 'paused' && agent.resumeRequestedAt !== null
  const canResume = runId !== null && agent.status === 'paused' && !resumeRequestedWhilePaused
  const canStop = runId !== null && agent.status !== 'idle'
  const showResume = agent.status === 'paused' || agent.status === 'pausing'

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
      data-testid="agent-card"
      data-status={agent.status}
      data-card-state={state}
      // `TONE_BORDER` is `StatusPill`'s own `3d`-alpha border map, imported rather than restated:
      // the card's border and the pill's border are the SAME recipe in the handoff, and a second
      // literal copy of eight class strings is the duplication Decision 2 forbids.
      className={`relative flex flex-col gap-[9px] overflow-hidden rounded-card border bg-bg-2 px-[13px] py-[12px] transition-colors hover:border-white/20 ${
        TONE_BORDER[tone]
      } ${flashing ? 'motion-safe:animate-[border-flash_800ms_ease-out]' : ''}`}
      style={flashing ? ({ '--flash-color': FLASH_COLOR[agent.status] } as React.CSSProperties) : undefined}
    >
      {/* The activity sweep (design README "Motion"): a 2.2s cubic-bezier(.4,0,.2,1) gradient
        * travelling the top hairline while the card is `working`. Rendered as its own absolutely
        * positioned 1px strip so the keyframe moves a transform (compositor-only) rather than a
        * background-position. Present ONLY in the `working` state — the handoff's own rule. */}
      {state === 'working' && (
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px overflow-hidden">
          <span
            data-testid="card-sweep"
            className="block h-full w-full bg-gradient-to-r from-transparent via-tone-working to-transparent motion-safe:animate-[card-sweep_2.2s_cubic-bezier(.4,0,.2,1)_infinite]"
          />
        </span>
      )}

      <div className="flex items-start gap-[9px]">
        <AvatarTile name={agent.name} tone={tone} />
        <button
          type="button"
          onClick={() => onOpen(agent.id)}
          aria-label={`Open ${agent.name}'s detail panel`}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block truncate text-[13px] font-semibold text-text-1">{agent.name}</span>
          <span className="block truncate text-[10.5px] text-[#7c8697]">{agent.role}</span>
        </button>
        <StatusPill tone={tone} label={label} pulse={pulse} />
      </div>

      <div className="flex items-baseline gap-[7px]">
        <span data-testid="card-task-ref" className="shrink-0 font-mono text-[10px] text-text-3">
          {agent.taskId === null ? '—' : taskRef(agent.taskId)}
        </span>
        <span data-testid="card-task-title" className="min-w-0 truncate text-[11.5px] text-[#c8cfda]">
          {agent.taskTitle ?? 'no task'}
        </span>
      </div>

      {/* 3px, the card's own thickness (design README "1a") — every table row keeps the 6px default. */}
      <ProgressBar pct={agent.progressPct} tone={tone} size="card" />

      <div className="flex items-baseline justify-between font-mono text-[9.5px] text-text-3">
        <span data-testid="card-step">{agent.stepLabel ?? '—'}</span>
        <span data-testid="card-percent">{agent.progressPct}%</span>
      </div>

      <div data-testid="action-line" className="h-5 truncate font-mono text-xs text-text-2">
        {/* Cross-fade (M5 spec §8): a key tied to the text remounts the span on every change, which
         *  is what makes the `action-line-in` keyframe replay each time. */}
        <span key={line ?? 'idle'} className="motion-safe:animate-[action-line-in_120ms_ease-out]">
          {line}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-[5px]">
        <Chip>
          <span data-testid="card-skill-chip">{agent.skill ?? '—'}</span>
        </Chip>
        <Chip>
          {/* "queue" is this product's real queue: the instruction waiting for the next resume
            * (`AgentRun.queuedMessage`). The mockup's own chip meant a merge position, which this
            * card has no honest source for. */}
          <span data-testid="card-queue-chip">{agent.queuedMessage === null ? '—' : 'queued'}</span>
        </Chip>
        <Chip>
          {/* The bare `ProviderKind` and `—` when no run has resolved one (M12 Task 9, ruling R10):
            * real data, unlabelled. The shell-only gate mark beside it is spec §8's. */}
          <span data-testid="provider-chip">{agent.provider ?? '—'}</span>
        </Chip>
        <ShellOnlyMark gate={agent.gate} />
      </div>

      {resumeRequestedWhilePaused && (
        <span data-testid="card-resume-requested" className="text-[10.5px] text-text-3">
          {/* The panel's own wording, verbatim: the same fact told twice in two places should not
            * be told in two voices. */}
          resume requested — waiting for the daemon
        </span>
      )}

      {errorText !== null && (
        <span role="alert" data-testid="card-error" className="text-[10.5px] text-status-danger">
          {errorText}
        </span>
      )}

      <footer className="flex gap-[5px] border-t border-white/[0.06] pt-[3px]">
        {showResume ? (
          <FooterButton testId="card-resume" disabled={!canResume || pending.has('resume')} onClick={() => void run('resume')}>
            Resume
          </FooterButton>
        ) : (
          <FooterButton testId="card-pause" disabled={!canPause || pending.has('pause')} onClick={() => void run('pause')}>
            Pause
          </FooterButton>
        )}
        <FooterButton testId="card-message" disabled={false} onClick={() => onOpen(agent.id)}>
          Message
        </FooterButton>
        <FooterButton testId="card-stop" disabled={!canStop || pending.has('stop')} onClick={() => void run('stop')}>
          Stop
        </FooterButton>
      </footer>
    </article>
  )
}

/** The card footer's ghost button. Not `ui/Button`: that component fixes
 *  `data-testid="button"` for every instance and this footer needs three distinguishable ones,
 *  and its `px-3 py-1.5` is wider than the handoff's three-up equal-thirds footer. Same ghost
 *  recipe (`border-line`, `hover:border-white/20`, `hover:text-text-1`), one size down. */
function FooterButton({
  testId,
  disabled,
  onClick,
  children,
}: {
  readonly testId: string
  readonly disabled: boolean
  readonly onClick: () => void
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="flex-1 rounded-chip border border-line py-[5px] text-center text-[10.5px] font-medium text-text-2 transition-colors hover:border-white/20 hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  )
}
