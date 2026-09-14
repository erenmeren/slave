'use client'

import Link from 'next/link'
import { useState } from 'react'
import { postControl } from '../../lib/postControl'
import type { NeedsYouItem } from '../../server/needsYou'
import { Chip } from '../ui/Chip'
import type { StatusTone } from '../ui/StatusPill'

/** The word and the TONE for each kind. `ui/Chip` owns the fill and the border (it takes a
 *  `StatusTone` and paints it with the same `1a`/`3d` alphas `StatusPill` uses), so there is no
 *  class string here at all -- which is also why Tailwind's static-scan problem does not arise.
 *  The raw `kind` stays on the row's `data-kind` and in the chip's `title` (`docs/ia.md` rule 3).
 *  `integrate` is amber rather than green: finished work nobody will merge is waiting, not done. */
const KIND: Record<NeedsYouItem['kind'], { readonly label: string; readonly tone: StatusTone }> = {
  decision: { label: 'DECISION', tone: 'waiting' },
  blocked_task: { label: 'BLOCKED', tone: 'blocked' },
  question: { label: 'QUESTION', tone: 'planning' },
  integrate: { label: 'READY', tone: 'waiting' },
}

/**
 * What is waiting on a person, first on the page (M57, README "Overview" → Needs you).
 *
 * It is `server/needsYou.ts`'s existing queue, drawn as the README's card: a header with the count,
 * one row per item, and an answer in place for the one kind that HAS an answer in place. It
 * replaces the brief's `needs-you` tile, which showed a five-row slice and could answer nothing.
 *
 * Only a DECISION gets buttons. A blocked task needs a person to look at it, a question needs an
 * answer typed somewhere, and finished work needs `confirmIntegration` -- which has no web route
 * and inventing one is not this milestone's decision to make (`server/needsYou.ts:21-24` records
 * that, and it is still true). EVERY row gets a link to the surface that can resolve it, the two
 * buttons included.
 *
 * IT TAKES NO `onRefresh` (ruling P18). `useOverview` returns
 * `{snapshot, actionLines, liveEvents, connection, error, latencyMs}` and exposes no refetch, and
 * `router.refresh()` is a full server re-render rather than the snapshot refetch this would want.
 * It does not need one: approving or rejecting a decision APPENDS AN EVENT, the page's own
 * `EventSource` wakes on it, and `useOverview` refetches the snapshot 250 ms later -- which is the
 * same path every other control on this page relies on, and the one `postControl`'s own docstring
 * calls "the event-driven refetch loop owning truth".
 */
export function NeedsYouCard({
  workspaceId,
  items,
}: {
  readonly workspaceId: string
  readonly items: readonly NeedsYouItem[]
}): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [errorText, setErrorText] = useState<string | null>(null)

  const answer = async (decisionId: string, verdict: 'approve' | 'reject'): Promise<void> => {
    setBusy(decisionId)
    // The refusal belongs to the attempt that earned it, the way `SlaveCard.run()` clears its own:
    // a stale red line over a row that has since been answered is a lie about the current state.
    setErrorText(null)
    const result = await postControl(`/api/w/${workspaceId}/supervisor/decisions/${decisionId}/${verdict}`)
    setBusy(null)
    // No local refetch and no optimistic removal: the POST appended an event, the page's stream
    // wakes on it, and the snapshot this component's `items` come from is refetched 250 ms later.
    if (!result.ok) setErrorText(result.error)
  }

  if (items.length === 0) {
    return (
      <section className="px-[24px] pt-[18px]">
        <p data-testid="needs-you-empty" className="rounded-panel-card border border-dashed border-line2 px-4 py-3 text-[13.5px] text-t2">
          Nothing needs you right now. The team is working; you will see it here first when
          something does.
        </p>
      </section>
    )
  }

  return (
    <section className="px-[24px] pt-[18px]">
      <div
        data-testid="needs-you-card"
        className="overflow-hidden rounded-panel-card border border-[color-mix(in_oklab,var(--s-waiting)_40%,var(--line))] bg-card"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <span className="flex items-center gap-[10px] font-semibold text-t1">
            <span aria-hidden className="h-2 w-2 rounded-full bg-s-waiting" />
            Needs you <span className="font-mono text-[12px] font-medium text-t3">{items.length}</span>
          </span>
          <span className="text-[13px] text-t3">Answer here, or open the item</span>
        </div>
        {errorText !== null && (
          <p role="alert" data-testid="needs-you-error" className="border-b border-line px-4 py-2 text-[12.5px] text-s-blocked">
            {errorText}
          </p>
        )}
        {items.map((item) => {
          const kind = KIND[item.kind]
          return (
            <div
              key={`${item.kind}-${item.id}`}
              data-testid="needs-you-row"
              data-kind={item.kind}
              className="flex items-center gap-[14px] border-b border-line px-4 py-3 last:border-b-0"
            >
              {/* `ui/Chip` with `title={item.kind}`, NOT a bare span (ruling P10). `gate-m45`
                * stage 3 reads every needs-you row as
                * `{kind: row.querySelector('[data-testid="chip"]')?.getAttribute('title'), href: row.querySelector('a')?.getAttribute('href')}`
                * and asserts the four kinds sort to `['blocked_task','decision','integrate','question']`
                * with a working link on each. The brief's old rows were `<Chip tone title>` +
                * `<Link>`, which is where that shape came from -- so the card inherits it rather
                * than inventing one, and that stage needs no edit. */}
              <Chip tone={kind.tone} title={item.kind}>
                {kind.label}
              </Chip>
              <span className="min-w-0 flex-1">
                {/* Another party's sentence, as JSX children -- data, never elements (spec §1). */}
                <span className="block truncate font-medium text-t1">{item.title}</span>
                <span className="block text-[12.5px] text-t3">
                  waiting since {new Date(item.since).toLocaleString()}
                </span>
              </span>
              {/* EVERY row carries a link, decision rows included (ruling P10): `gate-m45` stage 3
                * asserts `row.querySelector('a')` resolves on all four kinds and then NAVIGATES to
                * each href. A decision row gets its two buttons AND an `Open →` beside them --
                * which is also what the README draws ("Answer here, or open the item"). */}
              <Link
                data-testid="needs-you-open"
                href={item.href}
                className="flex-none rounded-card border border-line2 px-3 py-[6px] text-[13px] text-t1 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Open →
              </Link>
              {item.decisionId !== null && (
                <span className="flex flex-none gap-[6px]">
                  <button
                    type="button"
                    data-testid="needs-you-approve"
                    disabled={busy === item.decisionId}
                    onClick={() => void answer(item.decisionId ?? '', 'approve')}
                    className="rounded-card border-0 bg-accent px-3 py-[6px] text-[13px] font-semibold text-accent-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    data-testid="needs-you-decline"
                    disabled={busy === item.decisionId}
                    onClick={() => void answer(item.decisionId ?? '', 'reject')}
                    className="rounded-card border border-line2 bg-transparent px-3 py-[6px] text-[13px] text-t1 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    Decline
                  </button>
                </span>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
