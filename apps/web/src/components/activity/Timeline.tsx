'use client'

import { forwardRef, useImperativeHandle, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ACTIVITY_CARDS } from './cards'
import type { ActivityEventRow } from '../../server/activity'

/** Fallback row-height estimate for the virtualizer and for the "one row of the bottom/top"
 *  thresholds below — cards vary (a `run.output` body is taller than a bare `task.started`), so
 *  this is a starting guess `measureElement` corrects per-row, not a fixed height. */
const ESTIMATED_ROW_HEIGHT = 96

export interface TimelineHandle {
  /** Scrolls the viewport to the newest (last, since events render oldest-first) row. */
  readonly scrollToBottom: () => void
}

export interface TimelineProps {
  /** Oldest-first — the shape `useActivityStream` hands back, and the order the rows render in
   *  (newest at the bottom). */
  readonly events: readonly ActivityEventRow[]
  readonly workspaceId: string
  readonly agentNameById: ReadonlyMap<string, string>
  readonly taskTitleById: ReadonlyMap<string, string>
  /** Fires whenever the viewport's distance from the bottom crosses the "pinned" threshold
   *  (within one estimated row height) — not just on the same value repeated. */
  readonly onPinnedChange: (pinned: boolean) => void
  /** Fires once per approach to the top of the viewport (within one estimated row height) — not
   *  once per scroll event while already near the top. */
  readonly onNearTop: () => void
}

/**
 * The activity timeline's virtualized row list: `ACTIVITY_CARDS[event.type]` rendered inside a
 * `useVirtualizer` viewport with `measureElement` dynamic heights, oldest event first (newest at
 * the bottom, matching a chat/log reading order). Live-follow (pinned/loadOlder) state is owned
 * by the caller (`ActivityClient`) — this component only reports the two scroll thresholds that
 * state needs and exposes `scrollToBottom` for it to act on.
 */
export const Timeline = forwardRef<TimelineHandle, TimelineProps>(function Timeline(
  { events, workspaceId, agentNameById, taskTitleById, onPinnedChange, onNearTop },
  ref,
): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Tracks whether the "near the top" threshold has already fired for the current approach, so a
  // viewport that stays near the top across several scroll events (or several re-renders as
  // `loadOlder` prepends rows) only calls `onNearTop` once — it resets the moment the viewport
  // moves back away from the top.
  const nearTopFiredRef = useRef(false)

  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 8,
  })

  useImperativeHandle(
    ref,
    (): TimelineHandle => ({
      scrollToBottom: (): void => {
        if (events.length > 0) virtualizer.scrollToIndex(events.length - 1, { align: 'end' })
      },
    }),
    [virtualizer, events.length],
  )

  const handleScroll = (): void => {
    const el = scrollRef.current
    if (el === null) return

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    onPinnedChange(distanceFromBottom <= ESTIMATED_ROW_HEIGHT)

    if (el.scrollTop <= ESTIMATED_ROW_HEIGHT) {
      if (!nearTopFiredRef.current) {
        nearTopFiredRef.current = true
        onNearTop()
      }
    } else {
      nearTopFiredRef.current = false
    }
  }

  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div
      ref={scrollRef}
      data-testid="timeline-viewport"
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto p-3"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualItems.map((virtualItem) => {
          const event = events[virtualItem.index]
          if (event === undefined) return null
          const Card = ACTIVITY_CARDS[event.type]
          return (
            <div
              key={event.seq}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualItem.start}px)` }}
              className="pb-2"
            >
              <Card
                event={event}
                workspaceId={workspaceId}
                agentName={event.agentId !== null ? (agentNameById.get(event.agentId) ?? null) : null}
                taskTitle={event.taskId !== null ? (taskTitleById.get(event.taskId) ?? null) : null}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
})
