'use client'

import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react'
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
  /** The agent whose roster row is selected, or `null` for no roster filter. Every row that is
   *  NOT that agent's renders dimmed (design README "Filtering": dim, never hide). Optional so a
   *  caller with no roster beside it -- and this file's own scroll-anchoring test -- can leave it
   *  off entirely. */
  readonly dimmedAgentId?: string | null
  /** Fires whenever the viewport's distance from the bottom crosses the "pinned" threshold —
   *  both from an actual scroll and from a row's measured height changing (e.g. a payload
   *  `<details>` expanding), since the latter moves the true bottom with no scroll event of its
   *  own to report it. */
  readonly onPinnedChange: (pinned: boolean) => void
  /** Fires once per approach to the top of the viewport (within one estimated row height) — not
   *  once per scroll event while already near the top. */
  readonly onNearTop: () => void
}

/**
 * The activity timeline's virtualized row list: `ACTIVITY_CARDS[event.type]` rendered inside a
 * `useVirtualizer` viewport with `measureElement` dynamic heights, oldest event first (newest at
 * the bottom, matching a chat/log reading order). Live-follow (pinned/loadOlder) *state* is owned
 * by the caller (`ActivityClient`) — this component reports the scroll/resize thresholds that
 * state needs and exposes `scrollToBottom` for it to act on; it also owns the two purely
 * geometric corrections a virtualized, absolutely-positioned list needs on its own account: an
 * explicit mount-time scroll to the bottom, and a scroll-anchor correction across a `loadOlder`
 * prepend.
 */
export const Timeline = forwardRef<TimelineHandle, TimelineProps>(function Timeline(
  { events, workspaceId, agentNameById, taskTitleById, dimmedAgentId = null, onPinnedChange, onNearTop },
  ref,
): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Tracks whether the "near the top" threshold has already fired for the current approach, so a
  // viewport that stays near the top across several scroll events (or several re-renders as
  // `loadOlder` prepends rows) only calls `onNearTop` once — it resets the moment the viewport
  // moves back away from the top.
  const nearTopFiredRef = useRef(false)
  // Gates both `handleScroll` and the virtualizer's resize-driven `onChange` until the mount
  // layout effect below has positioned the viewport at the bottom. Without this, a notification
  // landing before that positioning (the initial per-row `measureElement` pass fires several,
  // synchronously, before any effect runs) would read pre-scroll, oldest-row-first geometry and
  // could misreport `pinned`/fire `onNearTop` from a position the user never actually saw.
  const mountedRef = useRef(false)

  // Motion pass (spec §4.6): the "live boundary" seq — rows above it are new since mount / since
  // the last confirmed `loadOlder` prepend and get the entry `rise`; rows at or below it are
  // already-seen (whether present at mount or loaded as history) and never animate. Seeded once
  // from whatever's on screen at mount (a fresh mount's own rows are never "new"); the `seq`
  // ordering invariant — a prepend only ever adds smaller seqs, a live arrival only ever adds
  // larger ones — is what keeps a single ref correct for both cases without further updates (the
  // prepend-anchor effect below reaffirms it anyway, at the one place a prepend is confirmed).
  // A ref, not state: each row is a stable DOM node keyed by its own seq (`getItemKey` above), so
  // its entry class is decided once, at that node's own first render — no re-render is needed to
  // pick up a later ref update, and using state here would only risk a spurious extra re-render.
  const liveBoundarySeqRef = useRef<number>(events.at(-1)?.seq ?? -Infinity)
  // Marks "the events buffer was empty as of the last render" — the reset signal for a
  // filter/workspace switch reload (mirrors `ActivityClient`'s own `lastAccountedSeqRef` reset,
  // one file over: "the buffer passing through empty... re-seeds the baseline instead of scoring
  // the reload as arrivals"). Without this, a reload's seqs sitting ABOVE the stale boundary reads
  // as EVERY row being "new" — not a stray replay but a full-page animation flash on a routine
  // filter change (fix round 1 review finding).
  //
  // Read/written synchronously in the render body itself, not an effect: the `isLive` check below
  // runs in this SAME render, so a reseed landing only after commit (an effect) would be one
  // commit too late — this render's rows would already have painted against the stale boundary.
  const boundaryUnsetRef = useRef<boolean>(events.length === 0)
  if (events.length === 0) {
    boundaryUnsetRef.current = true
  } else if (boundaryUnsetRef.current) {
    // The buffer just repopulated after passing through empty — this whole page is a fresh
    // baseline, not live arrivals: reseed from ITS OWN newest row, same as a genuine mount.
    liveBoundarySeqRef.current = events.at(-1)?.seq ?? liveBoundarySeqRef.current
    boundaryUnsetRef.current = false
  }

  const derivePinned = (el: HTMLElement): boolean => {
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    return distanceFromBottom <= ESTIMATED_ROW_HEIGHT
  }

  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 8,
    // The virtualizer's own measurement cache is keyed by this, not by array index — without it,
    // a `loadOlder` prepend (which reassigns every existing row's index) hands a stale
    // measurement, cached for whatever event used to sit at that index, to the event that sits
    // there now (review finding: Important 4). `seq` is the one stable identity a row has.
    getItemKey: (index) => events[index]?.seq ?? index,
    // Fires on every scroll AND on every measured-size change (e.g. a payload `<details>`
    // expanding) — the second case moves the true bottom with no DOM scroll event of its own, so
    // `pinned` would otherwise go stale the moment a row's height changes without the viewport
    // itself moving (review finding: Important 5).
    onChange: (): void => {
      if (!mountedRef.current) return
      const el = scrollRef.current
      if (el === null) return
      onPinnedChange(derivePinned(el))
    },
  })

  // Single-writer scroll compensation for a resized row (review finding, fix round 2). Left
  // alone, the library's own default `shouldAdjustScrollPositionOnItemSizeChange` heuristic
  // ALSO compensates a row's FIRST measurement synchronously inside its own `measureElement` ref
  // callback (during commit — before the prepend-anchor effect below ever runs): a freshly
  // prepended row's estimate-vs-measured delta puts its start above the current scroll offset,
  // which is exactly the shape that heuristic compensates for. The anchor effect below then adds
  // that SAME row's full height again — double-compensating, over-scrolling past the intended
  // anchor point in a real browser. (jsdom's fix-round-1 test didn't surface this: `scrollTo` was
  // stubbed to a no-op, and the library's own internal `scrollOffset` never syncs from a raw
  // `el.scrollTop` property write, so its `defaultShouldAdjust` check never even ran there.)
  //
  // One writer per case, chosen explicitly:
  //  - FIRST measure of a row — its key not yet in `itemSizeCache`, the exact discriminator
  //    `resizeItem` itself computes at this same synchronous point, before that call inserts the
  //    key (`virtual-core/dist/esm/index.js`'s `resizeItem`: `isFirstMeasure =
  //    !this.itemSizeCache.has(key)`, computed before `this.itemSizeCache.set(key, size)`) —
  //    never let the library compensate. The prepend-anchor effect below is the sole writer for
  //    this case: it owns the *sum* of every newly prepended row's height, not one row's
  //    estimate-vs-measured delta.
  //  - RE-measure of an already-cached row (e.g. a payload `<details>` expanding — fix round 1's
  //    Important 5): keep the library's own default behavior, replicated here explicitly since
  //    supplying this callback at all replaces `defaultShouldAdjust` outright, not just extends
  //    it — an item entirely above the fold gets compensated, unless the viewport is actively
  //    scrolling backward, exactly the branch `resizeItem` runs internally.
  //
  // Assigned directly on the instance during render, not inside an effect: a freshly attached
  // row's first measurement can run synchronously from a ref callback in the very same commit
  // that creates the virtualizer, before any effect of this component would get a chance to run.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance): boolean => {
    const isFirstMeasure = !instance.itemSizeCache.has(item.key)
    if (isFirstMeasure) return false
    // `getScrollOffset()` (what `resizeItem` itself calls) is a private method in the published
    // types; `scrollOffset` is the same value as a public field once the virtualizer has scrolled
    // at all — true here, since a re-measure by definition means the row was already visible.
    const scrollOffsetWithAdjustments = (instance.scrollOffset ?? 0) + instance.scrollAdjustments
    return item.start + item.size <= scrollOffsetWithAdjustments && instance.scrollDirection !== 'backward'
  }

  const scrollToBottom = (): void => {
    if (events.length > 0) virtualizer.scrollToIndex(events.length - 1, { align: 'end' })
  }

  useImperativeHandle(ref, (): TimelineHandle => ({ scrollToBottom }), [virtualizer, events.length])

  // Mount-only: position the viewport at the newest (bottom) row before the user ever sees the
  // oldest-first initial layout (review finding: Critical 2 — a freshly loaded page must open
  // already pinned to the bottom, not at the top; nothing previously scrolled it there).
  useLayoutEffect((): void => {
    scrollToBottom()
    mountedRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only by design
  }, [])

  // Scroll anchoring across a `loadOlder` prepend (review finding: Important 3): older rows land
  // above the current viewport, which grows the timeline's total height without moving
  // `scrollTop` — left alone, every already-visible row silently shifts down and the reading
  // position jumps. Compensated by adding exactly the newly prepended rows' own height (each
  // looked up in the virtualizer's measurement cache — Important 4's `getItemKey` is what keeps
  // that cache correctly attributed by `seq` through the reindex a prepend causes — falling back
  // to the same estimate the virtualizer itself would use for a row it hasn't measured yet).
  //
  // Deliberately NOT `getTotalSize()` before/after: the virtualizer needs its own extra settle
  // pass after the very first commit (the scroll viewport's own rect, and therefore which rows
  // even count as "in range" to measure, isn't known until that commit's layout effects run), so
  // a `getTotalSize()` read from this same mount-adjacent effect can still reflect an
  // under-measured, estimate-only total — usable as neither an old nor a new snapshot. Reading
  // only the handful of genuinely new rows' own sizes sidesteps that entirely.
  const prevFirstSeqRef = useRef<number | undefined>(events[0]?.seq)
  useLayoutEffect((): void => {
    const prevFirstSeq = prevFirstSeqRef.current
    const newFirstSeq = events[0]?.seq
    prevFirstSeqRef.current = newFirstSeq

    // Nothing to anchor: `prevFirstSeq === undefined` means the buffer was empty last render (no
    // previous head to compare against — a reset in progress, or the ref's own mount-time
    // initializer if `events` was empty at mount); `newFirstSeq === undefined` means it's empty
    // THIS render; `newFirstSeq === prevFirstSeq` means the head is unchanged — which is also what
    // this effect's very first run after a genuine mount lands in, since `prevFirstSeqRef` is
    // pre-seeded from that same initial render's `events[0]?.seq`. (Fix round 1: this comment
    // previously read "mount, reset, or no prepend", implying each disjunct maps to one of those
    // three scenarios one-to-one — it doesn't; only the "mount, first effect run" case is cleanly
    // one of the three named disjuncts on its own, as described here.)
    if (prevFirstSeq === undefined || newFirstSeq === undefined || newFirstSeq === prevFirstSeq) return

    const oldFirstIndexInNew = events.findIndex((event) => event.seq === prevFirstSeq)
    if (oldFirstIndexInNew <= 0) return // not a plain prepend (the previous first row is gone, or still first)

    // Motion pass (spec §4.6, Task 10 brief Step 2): reaffirm the live boundary on every confirmed
    // `loadOlder` prepend. In practice this never changes the value — a prepend only ever adds
    // OLDER (smaller) seqs than the boundary, so the row-entry gate below stays correct with no
    // update at all — but tracking it here keeps the rule explicit at the one place a prepend is
    // actually detected, rather than relying solely on the seq-ordering invariant to hold forever.
    liveBoundarySeqRef.current = events[events.length - 1]?.seq ?? liveBoundarySeqRef.current

    let addedHeight = 0
    for (let i = 0; i < oldFirstIndexInNew; i += 1) {
      const key = events[i]?.seq
      addedHeight += (key !== undefined ? virtualizer.itemSizeCache.get(key) : undefined) ?? ESTIMATED_ROW_HEIGHT
    }
    const el = scrollRef.current
    if (el !== null) el.scrollTop += addedHeight
  }, [events, virtualizer])

  const handleScroll = (): void => {
    if (!mountedRef.current) return
    const el = scrollRef.current
    if (el === null) return

    onPinnedChange(derivePinned(el))

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
      // `pt-3` and NOT `p-3` (the mock's own `padding:12px 0 0`, `AI Team OS Mockups.dc.html:855`):
      // a left padding here would shift every row right without moving the rule, and the dot
      // would no longer sit on it. The row's `pr-[18px]` carries the right-hand inset instead.
      className="flex-1 overflow-y-auto pt-3"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {/* The design README's vertical rule at x=88 (1c / §3a.5). Absolutely positioned inside
          * THIS element rather than the scroll viewport: this one is already `position: relative`
          * and is as tall as the whole river, so the rule spans every row instead of only the
          * first viewport's worth and then scrolling away. `left` is INLINE so the gate can read
          * the exact number back off `getComputedStyle`. */}
        <span
          data-testid="timeline-rule"
          aria-hidden
          style={{ left: '88px' }}
          className="pointer-events-none absolute inset-y-0 w-px bg-[linear-gradient(180deg,transparent,rgba(46,230,207,.28),rgba(123,140,255,.18),transparent)]"
        />
        {virtualItems.map((virtualItem) => {
          const event = events[virtualItem.index]
          if (event === undefined) return null
          const Card = ACTIVITY_CARDS[event.type]
          // Spec §4.6: only a row that arrived after the live boundary was established animates
          // in. As of M14 Task 12 that entry is the handoff's own `rise` (design README "Motion":
          // "new rows enter with a 0.3s `translateY(5px)` rise"), not M5's `action-line-in`
          // cross-fade. No layout shift either way: the row's box is already sized by
          // `measureElement`/the estimate before the animation starts, and `rise` moves the row
          // by a transform, which does not participate in layout.
          const isLive = event.seq > liveBoundarySeqRef.current
          return (
            <div
              key={event.seq}
              data-index={virtualItem.index}
              data-testid="timeline-row"
              ref={virtualizer.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualItem.start}px)` }}
              // No gap between rows: the mock's river is flush (`AI Team OS Mockups.dc.html:857`,
              // a bare `flex-direction:column` with no gap); each row's own `py-[6px]` is the rhythm.
              className={isLive ? 'motion-safe:animate-[rise_0.3s_ease-out]' : ''}
            >
              <Card
                event={event}
                workspaceId={workspaceId}
                agentName={event.agentId !== null ? (agentNameById.get(event.agentId) ?? null) : null}
                taskTitle={event.taskId !== null ? (taskTitleById.get(event.taskId) ?? null) : null}
                dimmed={dimmedAgentId !== null && event.agentId !== dimmedAgentId}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
})
