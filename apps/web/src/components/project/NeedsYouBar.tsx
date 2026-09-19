'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import type { NeedsYouItem } from '../../server/needsYou'
import { useShellFacts } from '../../hooks/useShellFacts'
import { formatAge } from '../../lib/format'
import { Button } from '../ui/Button'
import { LiveDot } from '../ui/LiveDot'

/** How often the bar may ask `GET /api/w/:id/needs-you` again -- the same 5s the spec erratum E8
 *  names, and the same throttle-by-ref shape `ProjectSwitcher.tsx`'s own poll uses. */
const NEEDS_YOU_REFETCH_MS = 5_000

/**
 * The Command strip's queue of what is waiting on a person (M61 R7/Task 6, spec erratum E8):
 * `CommandStrip` seeds it from the layout's own server read (`buildNeedsYou`, matching the shell
 * header's other seeds); this component keeps it current with a throttled poll of its own, since
 * a layout-level client component rides no page's live stream.
 *
 * `useShellFacts(workspaceId)` is the wake-up signal, not a timer: whichever project page is
 * mounted publishes a fresh snapshot on every event its own stream sees, and a needs-you item is
 * exactly the kind of fact that snapshot's writes can create or resolve. The throttle keeps a
 * fast-streaming page (many events in a few seconds) from re-asking this route on every one of
 * them.
 */
export function NeedsYouBar({
  workspaceId,
  initial,
}: {
  readonly workspaceId: string
  readonly initial: readonly NeedsYouItem[]
}): React.JSX.Element | null {
  const [items, setItems] = useState<readonly NeedsYouItem[]>(initial)
  const shellFacts = useShellFacts(workspaceId)
  const lastFetchedAt = useRef(0)

  // `initial` is a fresh read every time the LAYOUT re-renders `CommandStrip` -- a workspace
  // switch included, which is exactly when the poll's own state (seeded for the PREVIOUS
  // workspace) must not go on being shown. `useState`'s own initial value is a mount-time default
  // only, so a prop change after mount needs this effect to actually take.
  useEffect((): void => {
    setItems(initial)
  }, [initial])

  useEffect((): (() => void) | undefined => {
    if (shellFacts === null) return undefined
    const now = Date.now()
    if (now - lastFetchedAt.current < NEEDS_YOU_REFETCH_MS) return undefined
    lastFetchedAt.current = now
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const response = await fetch(`/api/w/${workspaceId}/needs-you`)
        if (!response.ok) return
        const next = (await response.json()) as readonly NeedsYouItem[]
        if (!cancelled) setItems(next)
      } catch {
        // Keep the list we have -- a bar that empties itself because one poll failed is worse
        // than one that is a few seconds stale (`ProjectSwitcher.tsx`'s own rule).
      }
    })()
    return (): void => {
      cancelled = true
    }
  }, [workspaceId, shellFacts])

  if (items.length === 0) return null

  return (
    <section data-testid="needs-you" className="rounded-surface border border-accent/35 bg-accent/10 px-3.5 py-2.5">
      <div className="flex flex-col gap-[var(--gap-1)]">
        {items.map((item) => (
          <Link
            key={`${item.kind}-${item.id}`}
            data-testid="needs-you-row"
            data-kind={item.kind}
            href={item.href}
            className="type-meta flex items-center gap-2"
          >
            <LiveDot tone="waiting" />
            <span className="min-w-0 flex-1 truncate text-t1">{item.title}</span>
            <span className="shrink-0 text-t3">{formatAge(item.since)}</span>
            <Button variant="primary" size="sm">
              Open
            </Button>
          </Link>
        ))}
      </div>
    </section>
  )
}
