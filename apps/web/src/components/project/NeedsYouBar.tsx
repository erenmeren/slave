'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import type { NeedsYouItem } from '../../server/needsYou'
import { useShellFacts } from '../../hooks/useShellFacts'
import { formatAge } from '../../lib/format'
import { aboutCard, postControl, postDecision } from '../../lib/postControl'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { LiveDot } from '../ui/LiveDot'
import { ScrollArea } from '../ui/ScrollArea'

/** What one click on a needs-you row does: a machine card's approve or reject, or `send_answer` on
 *  a question card that offers it (pre-flight F56). */
export type NeedsYouVerdict = 'approve' | 'reject' | 'send_answer'

/**
 * One click on a needs-you row, posted (plan B Task 9): a machine card through its approve/reject
 * route, a question card's `send_answer` through the decide route -- so the person's decision is
 * recorded and reported (spec H1), never the bare approve. Shared by the strip and Home, which draw
 * the same row. Returns what to show: the outcome or a settled-first notice (each named by the card
 * it is about), or the refusal.
 */
export async function answerNeedsYou(
  workspaceId: string,
  item: NeedsYouItem,
  verdict: NeedsYouVerdict,
): Promise<{ readonly notice: string | null; readonly error: string | null }> {
  const url = `/api/w/${workspaceId}/supervisor/decisions/${item.decisionId ?? item.id}`
  if (verdict === 'send_answer') {
    const result = await postDecision(`${url}/decide`, { kind: 'send_answer' })
    if (result.ok) return { notice: result.summary === null ? null : aboutCard(item.title, result.summary), error: null }
    return result.notice !== null ? { notice: aboutCard(item.title, result.notice), error: null } : { notice: null, error: result.error }
  }
  const result = await postControl(`${url}/${verdict}`)
  if (result.ok) return { notice: null, error: null }
  return result.notice !== null ? { notice: aboutCard(item.title, result.notice), error: null } : { notice: null, error: result.error }
}

/**
 * One `needs-you-row` (M61 R7/Task 6, spec erratum E8), pulled out of this bar so Home's own
 * cross-project queue (Task 8) can draw the SAME row rather than a second copy of it: the
 * `data-kind`, the title link, the age and the decision's actions are all exactly what this bar
 * renders.
 *
 * `workspaceName` is the one thing Home's queue needs that this bar never has: this bar is already
 * scoped to one project, so its own callers pass nothing and the chip is absent.
 *
 * Human cards H4 (plan B Task 9): the row names its goal version, says when it blocks that version
 * (`data-blocking`, and in words, not by colour alone), and says how many items merged into it, each
 * one link away. One click only where `oneClick` holds: a machine card keeps Approve and Reject; a
 * question card offers "Send this answer" only when the card offers `send_answer`, never Reject
 * ("dismiss and close" is one of the card's decisions), and always a "decide" link to the card.
 */
export function NeedsYouRow({
  item,
  workspaceName,
  busy,
  onAnswer,
}: {
  readonly item: NeedsYouItem
  /** Home's own addition (Task 8): a chip naming which project this item is on. Absent for
   *  `NeedsYouBar`'s own project-scoped queue. */
  readonly workspaceName?: string
  readonly busy: string | null
  readonly onAnswer: (item: NeedsYouItem, verdict: NeedsYouVerdict) => void
}): React.JSX.Element {
  // Hydration-mismatch fix (final-review wave, T11 minor promoted): `formatAge` reads `Date.now()`,
  // which is a different instant on the server (render time) and the client (hydrate time) --
  // exactly the divergence `useGreeting` in `home/HomeClient.tsx` already avoids the same way. The
  // first client render matches the server's (no age text at all); the real age appears one effect
  // later, same idiom, same reason.
  const [mounted, setMounted] = useState(false)
  useEffect((): void => setMounted(true), [])
  const isDecision = item.kind === 'decision' && item.decisionId !== null
  const disabled = busy !== null && busy === item.decisionId
  const decideLink = (
    <Link
      data-testid="needs-you-open"
      href={item.href}
      title={`decide: ${item.title}`}
      className="type-meta text-t1 underline"
    >
      decide
    </Link>
  )
  return (
    // A `<div>`, not a `<Link>` (review fix round 1, Important 1): a decision row's buttons are
    // real `<button>`s, and nesting a button inside an anchor is invalid HTML. The title is the
    // row's first link; the buttons are its siblings.
    <div
      data-testid="needs-you-row"
      data-kind={item.kind}
      data-blocking={item.blocking ? 'true' : 'false'}
      className="type-meta flex flex-col gap-[2px]"
    >
      <div className="flex items-center gap-2">
        <LiveDot tone={item.blocking ? 'blocked' : 'waiting'} />
        {workspaceName !== undefined && (
          <Chip testId="needs-you-project" tone="waiting">
            {workspaceName}
          </Chip>
        )}
        {item.goalVersion !== null && (
          <Chip testId="needs-you-version" title={`goal version ${String(item.goalVersion)}`}>
            {`v${String(item.goalVersion)}`}
          </Chip>
        )}
        <Link href={item.href} className="min-w-0 flex-1 truncate text-t1 hover:underline">
          {item.title}
        </Link>
        {item.blocking && (
          <span data-testid="needs-you-blocking" className="shrink-0 font-medium text-s-blocked">
            {item.goalVersion === null ? 'blocking' : `blocking v${String(item.goalVersion)}`}
          </span>
        )}
        <span className="shrink-0 text-t3">{mounted ? formatAge(item.since) : ''}</span>
        {isDecision && item.questionCard && (
          <span className="flex flex-none items-center gap-[6px]">
            {item.oneClick && (
              <Button
                variant="primary"
                size="sm"
                data-testid="needs-you-approve"
                data-verdict="send_answer"
                disabled={disabled}
                onClick={() => onAnswer(item, 'send_answer')}
              >
                Send this answer
              </Button>
            )}
            {decideLink}
          </span>
        )}
        {isDecision && !item.questionCard && item.oneClick && (
          <span className="flex flex-none gap-[6px]">
            <Button
              variant="primary"
              size="sm"
              data-testid="needs-you-approve"
              disabled={disabled}
              onClick={() => onAnswer(item, 'approve')}
            >
              Approve
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-testid="needs-you-reject"
              disabled={disabled}
              onClick={() => onAnswer(item, 'reject')}
            >
              Reject
            </Button>
          </span>
        )}
        {isDecision && !item.questionCard && !item.oneClick && <span className="flex flex-none">{decideLink}</span>}
      </div>
      {item.merged.length > 0 && (
        // Merging never hides something a person has to do (spec H4): how many, and each one link away.
        <details data-testid="needs-you-merged" data-count={item.merged.length} className="ml-[14px] text-t2">
          <summary className="cursor-pointer">
            {`+${String(item.merged.length)} more on this subject`}
          </summary>
          <ul className="mt-[2px] flex flex-col gap-[2px]">
            {item.merged.map((member) => (
              <li key={`${member.kind}-${member.id}`} data-kind={member.kind}>
                <Link href={member.href} className="truncate text-t2 hover:underline">
                  {member.title}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

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
 * for up to `NEEDS_YOU_REFETCH_MS`. A question card's one click is `send_answer` on the decide
 * route instead (plan B Task 9, pre-flight F56), and what it did is shown in `needs-you-notice`.
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
  /** A card somebody else settled first (human cards spec §4): information, never the red band. */
  const [noticeText, setNoticeText] = useState<string | null>(null)
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

  /** Copied off the deleted `NeedsYouCard.tsx`'s own `answer` -- "no optimistic removal, the
   *  refusal belongs to the attempt that earned it" -- through {@link answerNeedsYou}. It refetches
   *  right after every settled click: this bar has no stream of its own to ride, so the row it just
   *  answered has to be asked for directly (plan B Task 9 carry: no wait for the next poll). */
  const answer = async (item: NeedsYouItem, verdict: NeedsYouVerdict): Promise<void> => {
    if (item.decisionId === null) return
    setBusy(item.decisionId)
    setErrorText(null)
    setNoticeText(null)
    const result = await answerNeedsYou(workspaceId, item, verdict)
    setBusy(null)
    if (result.error !== null) {
      setErrorText(result.error)
      return
    }
    // Human cards spec §4: somebody else settled it first -- who and when -- or what the decision
    // did; either way named by its card, then a fresh list.
    setNoticeText(result.notice)
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
      {noticeText !== null && (
        <p role="status" data-testid="needs-you-notice" className="type-meta mb-[var(--gap-1)] text-t2">
          {noticeText}
        </p>
      )}
      {/* I2 (final-review wave): unbounded, this list grows past the strip's own `overflow-hidden`
        * frame -- `40dvh` caps it and the list scrolls inside itself instead. */}
      <ScrollArea className="flex flex-col gap-[var(--gap-1)] max-h-[40dvh]">
        {items.map((item) => (
          <NeedsYouRow
            key={`${item.kind}-${item.id}`}
            item={item}
            busy={busy}
            onAnswer={(row, verdict) => void answer(row, verdict)}
          />
        ))}
      </ScrollArea>
    </section>
  )
}
