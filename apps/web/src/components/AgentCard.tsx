import { useEffect, useRef, useState } from 'react'
import type { AgentCardData } from '../server/overview'
import { Sparkline } from './Sparkline'
import { Chip } from './ui/Chip'

export const DOT: Record<AgentCardData['status'], string> = {
  working: 'bg-status-working',
  starting: 'bg-status-starting',
  resuming: 'bg-status-starting',
  pausing: 'bg-status-paused',
  paused: 'bg-status-paused',
  stopping: 'bg-status-stopping',
  idle: 'bg-status-idle',
}

/** The border-flash's `--flash-color` source per status (spec §8) — no new colour tokens, just
 *  the existing status vocabulary referenced through the `@theme inline` names in globals.css.
 *  Exported: `OrgNodes.tsx`'s `AgentNode` (M7 task 8) reuses this same map for its own border
 *  flash rather than re-deriving the status→colour assignment a second time. */
export const FLASH_COLOR: Record<AgentCardData['status'], string> = {
  working: 'var(--color-status-working)',
  starting: 'var(--color-status-starting)',
  resuming: 'var(--color-status-starting)',
  pausing: 'var(--color-status-paused)',
  paused: 'var(--color-status-paused)',
  stopping: 'var(--color-status-stopping)',
  idle: 'var(--color-status-idle)',
}

/** 800ms border-flash decay window (spec §8) — the peripheral-vision cue that a status changed.
 *  Exported: reused verbatim by the graph's node/edge flashes (M7 task 8) so every flash in the app
 *  shares one duration. */
export const BORDER_FLASH_MS = 800

export function AgentCard({
  agent,
  liveActionLine,
  onOpen,
}: {
  readonly agent: AgentCardData
  readonly liveActionLine: string | null
  /** Opens the detail panel (spec §6) — the M4 card's disabled pause/stop buttons moved there. */
  readonly onOpen: (id: string) => void
}): React.JSX.Element {
  const line = liveActionLine ?? agent.actionLine

  // Border flash (spec §8): the card's border takes the status colour on a status change and
  // decays back to the line colour over ~800ms. Only a *change* flashes — the ref holds the
  // status this instance last rendered, so the initial mount (ref seeded to the same value) never
  // flashes, and the timeout is cleared on unmount/next-change so a rapid double-change doesn't
  // leave a stale timer clearing a newer flash.
  const previousStatus = useRef(agent.status)
  const [flashing, setFlashing] = useState(false)
  useEffect((): (() => void) | void => {
    if (previousStatus.current === agent.status) return
    previousStatus.current = agent.status
    setFlashing(true)
    const timer = setTimeout(() => setFlashing(false), BORDER_FLASH_MS)
    return () => clearTimeout(timer)
  }, [agent.status])

  return (
    <article
      data-status={agent.status}
      // Card's surface tokens (`ui/Card.tsx`, spec §3 -- `bg-bg-2` #0f1217, `rounded-card` 8px):
      // this stays its own `<article>` rather than `<Card>` itself. `Card` renders a plain
      // `<div>`/`<button>` with no `className`, `style`, or `data-status` passthrough, and this
      // card's border-flash (`--flash-color`, the `border-flash` keyframe below) and its own
      // `data-status` need exactly those extension points, plus the tests assert an `<article>`
      // element directly (`overview-components.test.tsx`).
      className={`flex flex-col gap-2 rounded-card border border-line bg-bg-2 p-3 transition-colors ${
        flashing ? 'motion-safe:animate-[border-flash_800ms_ease-out]' : ''
      }`}
      style={flashing ? ({ '--flash-color': FLASH_COLOR[agent.status] } as React.CSSProperties) : undefined}
    >
      <button
        type="button"
        onClick={() => onOpen(agent.id)}
        aria-label={`Open ${agent.name}'s detail panel`}
        className="flex items-center gap-2 text-left"
      >
        <span
          data-testid="status-dot"
          className={`inline-block h-2 w-2 rounded-full ${DOT[agent.status]} ${agent.status === 'working' ? 'animate-pulse' : ''}`}
        />
        <span className="text-sm font-medium">{agent.name}</span>
        <span className="text-xs text-text-3">{agent.role}</span>
        <span data-testid="status-label" className="ml-auto text-xs text-text-2">
          {agent.status}
        </span>
      </button>
      <div className="text-sm text-text-1">{agent.taskTitle ?? <span className="text-text-3">idle</span>}</div>
      <div data-testid="action-line" className="h-5 truncate font-mono text-xs text-text-2">
        {/* Cross-fade (spec §8): a key tied to the text remounts the span on every change, which
         *  is what makes the `action-line-in` keyframe replay each time. */}
        <span key={line ?? 'idle'} className="motion-safe:animate-[action-line-in_120ms_ease-out]">
          {line}
        </span>
      </div>
      <footer className="flex items-center gap-2">
        <Chip>{agent.provider}</Chip>
        <span className="ml-auto text-text-3">
          <Sparkline buckets={agent.sparkline} width={60} height={16} label={`${agent.name}'s tool calls, last 10 minutes`} />
        </span>
      </footer>
    </article>
  )
}
