'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import type { NeedsYouItem } from '../../server/needsYou'
import { useShellFacts } from '../../hooks/useShellFacts'
import { formatAge } from '../../lib/format'
import { postControl } from '../../lib/postControl'
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
 *
 * Review fix round 1 (Important 1): a `decision` row answers in place again, the way the deleted
 * `NeedsYouCard.tsx` let it -- `postControl` against the same
 * `/api/w/:id/supervisor/decisions/:id/(approve|reject)` route, `needs-you-approve`/
 * `needs-you-reject`, and the same shared `needs-you-error` line. It refetches directly on success
 * rather than waiting for the throttled poll: the row it just answered must not sit there stale
 * for up to `NEEDS_YOU_REFETCH_MS`.
 */
export function NeedsYouBar({
  workspaceId,
  initial,
}: {
  readonly workspaceId: string
  readonly initial: readonly NeedsYouItem[]
}): React.JSX.Element | null {
  const [items, setItems] = useState<readonly NeedsYouItem[]>(initial)
  const [busy, setBusy] = useState<string | null>(null)
  const [errorText, setErrorText] = useState<string | null>(null)
  const shellFacts = useShellFacts(workspaceId)
  const lastFetchedAt = useRef(0)

  // `initial` is a fresh read every time the LAYOUT re-renders `CommandStrip` -- a workspace
  // switch included, which is exactly when the poll's own state (seeded for the PREVIOUS
  // workspace) must not go on being shown. `useState`'s own initial value is a mount-time default
  // only, so a prop change after mount needs this effect to actually take.
  useEffect((): void => {
    setItems(initial)
  }, [initial])

  const load = async (): Promise<void> => {
    try {
      const response = await fetch(`/api/w/${workspaceId}/needs-you`)
      if (!response.ok) return
      const next = (await response.json()) as readonly NeedsYouItem[]
      setItems(next)
    } catch {
      // Keep the list we have -- a bar that empties itself because one poll failed is worse
      // than one that is a few seconds stale (`ProjectSwitcher.tsx`'s own rule).
    }
  }

  useEffect((): (() => void) | undefined => {
    if (shellFacts === null) return undefined
    const now = Date.now()
    if (now - lastFetchedAt.current < NEEDS_YOU_REFETCH_MS) return undefined
    lastFetchedAt.current = now
    let cancelled = false
    void (async (): Promise<void> => {
      if (!cancelled) await load()
    })()
    return (): void => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `load` closes over `workspaceId`
    // alone and is recreated every render; depending on it would defeat the throttle above.
  }, [workspaceId, shellFacts])

  /** Copied off the deleted `NeedsYouCard.tsx`'s own `answer` -- same route, same "no optimistic
   *  removal, the refusal belongs to the attempt that earned it" rule. It DOES refetch on success
   *  now, though (unlike the old card, which rode the page's own stream): this bar has no stream
   *  of its own to ride, so the row it just answered has to be asked for directly. */
  const answer = async (decisionId: string, verdict: 'approve' | 'reject'): Promise<void> => {
    setBusy(decisionId)
    setErrorText(null)
    const result = await postControl(`/api/w/${workspaceId}/supervisor/decisions/${decisionId}/${verdict}`)
    setBusy(null)
    if (!result.ok) {
      setErrorText(result.error)
      return
    }
    lastFetchedAt.current = Date.now()
    await load()
  }

  if (items.length === 0) return null

  return (
    <section data-testid="needs-you" className="rounded-surface border border-accent/35 bg-accent/10 px-3.5 py-2.5">
      {errorText !== null && (
        <p role="alert" data-testid="needs-you-error" className="type-meta mb-[var(--gap-1)] text-s-blocked">
          {errorText}
        </p>
      )}
      <div className="flex flex-col gap-[var(--gap-1)]">
        {items.map((item) => (
          // A `<div>`, not a `<Link>` (review fix round 1, Important 1): a decision row's Approve/
          // Reject are real `<button>`s, and nesting a button inside an anchor is invalid HTML the
          // Task 6 version got away with only because nothing on the row was ever clicked but the
          // row itself. The title is the row's own link now; the buttons are its siblings.
          <div key={`${item.kind}-${item.id}`} data-testid="needs-you-row" data-kind={item.kind} className="type-meta flex items-center gap-2">
            <LiveDot tone="waiting" />
            <Link href={item.href} className="min-w-0 flex-1 truncate text-t1 hover:underline">
              {item.title}
            </Link>
            <span className="shrink-0 text-t3">{formatAge(item.since)}</span>
            {item.kind === 'decision' && item.decisionId !== null && (
              <span className="flex flex-none gap-[6px]">
                <Button
                  variant="primary"
                  size="sm"
                  data-testid="needs-you-approve"
                  disabled={busy === item.decisionId}
                  onClick={() => void answer(item.decisionId as string, 'approve')}
                >
                  Approve
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="needs-you-reject"
                  disabled={busy === item.decisionId}
                  onClick={() => void answer(item.decisionId as string, 'reject')}
                >
                  Reject
                </Button>
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
