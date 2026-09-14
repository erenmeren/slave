'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { SITUATION_LABEL } from '@slave-of-ai/domain'
import { postControl, postJson } from '../../lib/postControl'
import { useShellFacts } from '../../hooks/useShellFacts'
import type { SupervisorThread } from '../../server/supervisorThreads'

/** Exactly what this panel reads off `GET /api/w/:id/supervisor` — the pending proposals, and
 *  nothing else. The full `SupervisorView` carries a report, recent decisions, questions and two
 *  settings; none of them belongs in a conversation, and a narrow local type is what stops one
 *  drifting in.
 *
 *  EXPORTED because `RightPanelHost` does the fetching (scan finding 22) and hands the list down. */
export interface PendingDecision {
  readonly id: string
  readonly situationKind: string
  readonly situation: { readonly summary?: string }
  /** The whole record, for `supervisor-decision-meta`'s `title` (spec erratum E18) — the four
   *  fields `SupervisorPanel.tsx:557` put there before this panel replaced it. Optional because a
   *  row written by an older build carries none. */
  readonly tier?: string
  readonly status?: string
  readonly decidedBy?: string
}

/** The domain's word for a situation, with the raw member as the runtime fallback — the same guard
 *  `SupervisorPanel.tsx:254` carried: `SITUATION_LABEL` is total over the union the compiler knows,
 *  and a row written by a newer build carries a kind this bundle has never heard of. */
function situationLabel(kind: string): string {
  return SITUATION_LABEL[kind as keyof typeof SITUATION_LABEL] ?? kind
}

/**
 * One proposal, answerable where it is read (M57 R9).
 *
 * Its own component rather than JSX inlined twice, because it is drawn in two places: inside the
 * message that announced it, and — for a proposal this day's conversation never mentions — in the
 * "waiting on you" tail below the thread. One card, one set of testids, one pair of buttons.
 */
function DecisionCard({
  decision,
  busy,
  onAnswer,
}: {
  readonly decision: PendingDecision
  readonly busy: boolean
  readonly onAnswer: (decisionId: string, verdict: 'approve' | 'reject') => void
}): React.JSX.Element {
  return (
    <div
      data-testid="supervisor-decision-card"
      data-decision-id={decision.id}
      // Spec §3 says the CARD carries both; the draft put this one on the inner `<p>`
      // (scan finding 29).
      data-situation-kind={decision.situationKind}
      className="mt-[10px] rounded-panel border border-[color-mix(in_oklab,var(--s-waiting)_45%,var(--line))] bg-card p-3"
    >
      <span className="inline-flex rounded-chip bg-[color-mix(in_oklab,var(--s-waiting)_14%,transparent)] px-[7px] py-[2px] font-mono text-[10.5px] font-medium text-s-waiting">
        DECISION
      </span>
      {/* `supervisor-proposal-kind`, carried over from the panel this task deletes
        * (spec erratum E18): `gate-m44:930` reads this chip's TEXT and its `title`
        * and compares them with the timeline's copy of the same proposal. Same
        * semantics as `SupervisorPanel.tsx:253` — the domain's label, the raw member
        * in `title`, and the member itself as the runtime fallback for a kind this
        * bundle has no label for. */}
      <span data-testid="supervisor-proposal-kind" title={decision.situationKind} className="ml-2 font-mono text-[10.5px] text-t3">
        {situationLabel(decision.situationKind)}
      </span>
      {/* `supervisor-decision-meta`, also carried over (`SupervisorPanel.tsx:557`):
        * the projected sentence, with the WHOLE record one hover away. `gate-m44:921`
        * waits on this element, unscoped. */}
      <span
        data-testid="supervisor-decision-meta"
        title={`${decision.situationKind} · ${decision.tier ?? '—'} · ${decision.status ?? 'pending'} · ${decision.decidedBy ?? '—'}`}
        className="mt-[4px] block text-[10.5px] text-t3"
      >
        {situationLabel(decision.situationKind)} · waiting for you
      </span>
      <p className="mt-[6px] font-medium text-t1">
        {decision.situation.summary ?? 'The Supervisor has proposed something.'}
      </p>
      <div className="mt-[10px] flex gap-[6px]">
        <button
          type="button"
          data-testid="supervisor-decision-approve"
          disabled={busy}
          onClick={() => onAnswer(decision.id, 'approve')}
          className="rounded-card border-0 bg-accent px-3 py-[6px] text-[12.5px] font-semibold text-accent-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Approve
        </button>
        <button
          type="button"
          data-testid="supervisor-decision-decline"
          disabled={busy}
          onClick={() => onAnswer(decision.id, 'reject')}
          className="rounded-card border border-line2 bg-transparent px-3 py-[6px] text-[12.5px] font-medium text-t1 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Decline
        </button>
      </div>
    </div>
  )
}

/**
 * The Supervisor, as a conversation (M57 R9).
 *
 * Everything here is UI over data that already exists. The threads are
 * `server/supervisorThreads.ts`'s grouping of the `workspace.goal_set`/`supervisor.*` events this
 * project already has; the decision cards are the SAME `pending` list `SupervisorPanel.tsx` and
 * the Overview's needs-you queue read; Approve and Decline are the same two routes; and the
 * composer is `POST /api/w/:id/goal/request`, which is what `project/SupervisorRequest.tsx` has
 * posted to since M45. No table, no event type, no migration.
 *
 * `+` starts a conversation for TODAY. It writes nothing — there is no row to create — it clears
 * the composer and scrolls to the end of today's thread, which is what "new conversation" means
 * when a conversation is a day.
 */
export function SupervisorThreadPanel({
  workspaceId,
  pending,
}: {
  readonly workspaceId: string
  /** The pending proposals, fetched ONCE by `RightPanelHost` and handed down (scan finding 22):
   *  the dock's badge and this panel's decision cards are the same list, and fetching it twice per
   *  wake-up was two round trips for one fact. */
  readonly pending: readonly PendingDecision[]
}): React.JSX.Element {
  const facts = useShellFacts(workspaceId)
  const [threads, setThreads] = useState<readonly SupervisorThread[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  /** The SUCCESS line `gate-m45` stage 5 waits for after a send (spec erratum E17). */
  const [resultText, setResultText] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/w/${workspaceId}/supervisor/threads`)
      if (response.ok) setThreads((await response.json()) as readonly SupervisorThread[])
    } catch {
      // Keep what is on screen. A conversation that empties itself because one poll failed is
      // worse than one that is a few seconds behind.
    }
  }, [workspaceId])

  // Two triggers, both existing: the workspace changed, or its stream woke the shell up. No
  // `EventSource` of this panel's own -- `hooks/useShellFacts.ts:18-24` is the rule.
  useEffect((): void => {
    void load()
  }, [load, facts])

  const thread = useMemo(
    () => threads.find((candidate) => candidate.id === selectedId) ?? threads[0] ?? null,
    [threads, selectedId],
  )
  /**
   * Which message draws which proposal's card — the FIRST one that names it, and only that one.
   *
   * A pending decision is announced by TWO events (`decide()` writes `supervisor.decided` and, for
   * a proposal, `supervisor.proposed`), so a naive match on `decisionId` draws the same card twice
   * under one proposal. And the ones no message in THIS day's conversation names are drawn below
   * the thread instead of vanishing: the dock badges `pending.length`, and a badge that counts
   * three while the panel shows none is a badge that lies.
   */
  const { cardFor, loose } = useMemo(() => {
    const taken = new Map<string, PendingDecision>()
    const byId = new Map(pending.map((decision) => [decision.id, decision]))
    const owner = new Map<string, PendingDecision>()
    for (const message of thread?.messages ?? []) {
      if (message.decisionId === null) continue
      const decision = byId.get(message.decisionId)
      if (decision === undefined || taken.has(decision.id)) continue
      taken.set(decision.id, decision)
      owner.set(message.id, decision)
    }
    return { cardFor: owner, loose: pending.filter((decision) => !taken.has(decision.id)) }
  }, [pending, thread])

  // `postJson`, not `postControl`: the route answers `{ok, version, sha256, goal}` and the VERSION
  // is the thing the success line names -- which is what `gate-m45` stage 5 asserts ("expected it
  // to name goal v3"). `postJson` (`apps/web/src/lib/postControl.ts:84`) exists for exactly this
  // route; its own docstring says it was added so `project/SupervisorRequest.tsx` would not grow a
  // second `fetch` idiom, and this panel is that component's successor.
  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (text.length === 0 || busy) return
    setBusy(true)
    setErrorText(null)
    const answerBody = await postJson<{ version: number }>(`/api/w/${workspaceId}/goal/request`, { request: text })
    setBusy(false)
    if (answerBody.ok) {
      setDraft('')
      // The SAME sentence `project/SupervisorRequest.tsx:47` produced, because it is the sentence
      // the gate was written against (spec erratum E17).
      setResultText(`goal v${String(answerBody.data.version)} saved — the next tick re-plans it as a delta`)
      await load()
    } else setErrorText(answerBody.error)
  }

  const answer = async (decisionId: string, verdict: 'approve' | 'reject'): Promise<void> => {
    setBusy(true)
    const result = await postControl(`/api/w/${workspaceId}/supervisor/decisions/${decisionId}/${verdict}`)
    setBusy(false)
    if (result.ok) await load()
    else setErrorText(result.error)
  }
  const onAnswer = (decisionId: string, verdict: 'approve' | 'reject'): void => void answer(decisionId, verdict)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The `≡` / `+` row. `»` is the slot's own, in `RightPanel`'s header bar above this. */}
      <div className="flex flex-none items-center gap-2 border-b border-line px-[16px] py-[8px]">
        <span className="flex-1 truncate text-[12.5px] text-t3">{thread?.title ?? 'No conversation yet'}</span>
        <span className="font-mono text-[11px] font-medium text-t3">{thread?.when ?? ''}</span>
        <button
          type="button"
          data-testid="supervisor-history"
          aria-label="Conversations"
          title="Conversations"
          onClick={() => setHistoryOpen((was) => !was)}
          className="h-[26px] w-[26px] rounded-card border border-line2 bg-card text-[13px] text-t2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          ≡
        </button>
        <button
          type="button"
          data-testid="supervisor-new"
          aria-label="New conversation"
          title="New conversation"
          onClick={() => {
            setSelectedId(threads[0]?.id ?? null)
            setHistoryOpen(false)
            setDraft('')
          }}
          className="h-[26px] w-[26px] rounded-card border border-line2 bg-card text-[15px] text-t2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          +
        </button>
      </div>

      {historyOpen && (
        <div className="flex flex-none flex-col gap-px border-b border-line bg-bg px-3 py-[10px]">
          <div className="px-[6px] pb-[6px] pt-[2px] font-mono text-[10.5px] font-semibold uppercase tracking-[.08em] text-t3">
            Conversations
          </div>
          {threads.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              data-testid="supervisor-thread-row"
              onClick={() => {
                setSelectedId(candidate.id)
                setHistoryOpen(false)
              }}
              className={`flex w-full items-center gap-[10px] rounded-card px-[10px] py-[7px] text-[13px] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${
                candidate.id === thread?.id ? 'bg-sel font-semibold text-t1' : 'text-t2 hover:bg-hover'
              }`}
            >
              <span className="min-w-0 flex-1 truncate text-left">{candidate.title}</span>
              <span className="flex-none font-mono text-[11px] font-medium text-t3">{candidate.when}</span>
            </button>
          ))}
        </div>
      )}

      <div
        data-testid="supervisor-thread"
        data-thread-id={thread?.id ?? ''}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-[16px] text-[13.5px] leading-[1.45]"
      >
        {thread === null && (
          <p data-testid="supervisor-empty" className="text-[13px] text-t2">
            Nothing has been said yet. Tell the Supervisor what you want changed and it will plan
            from there — every message is recorded as an event.
          </p>
        )}
        {thread?.messages.map((message) => {
          const decision = cardFor.get(message.id)
          const mine = message.who === 'operator'
          return (
            <div
              key={message.id}
              data-testid="supervisor-message"
              data-who={message.who}
              className={`flex flex-col gap-1 ${mine ? 'items-end' : 'items-start'}`}
            >
              <div
                className={
                  mine
                    ? 'max-w-[86%] rounded-[12px_12px_4px_12px] bg-[color-mix(in_oklab,var(--accent)_16%,transparent)] px-3 py-2 text-t1'
                    : 'max-w-[92%] rounded-[12px_12px_12px_4px] border border-line bg-card px-3 py-2 text-t1'
                }
              >
                <span className="block">{message.text}</span>
                {decision !== undefined && <DecisionCard decision={decision} busy={busy} onAnswer={onAnswer} />}
                {message.refs.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-[5px]">
                    {message.refs.map((ref) => (
                      <span key={ref} className="rounded-chip border border-line2 px-[7px] py-[2px] font-mono text-[11px] font-medium text-t2">
                        {ref}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <span className="font-mono text-[11px] text-t3">{new Date(message.at).toLocaleTimeString()}</span>
            </div>
          )
        })}
        {loose.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="font-mono text-[10.5px] font-semibold uppercase tracking-[.08em] text-t3">Waiting on you</div>
            {loose.map((decision) => (
              <DecisionCard key={decision.id} decision={decision} busy={busy} onAnswer={onAnswer} />
            ))}
          </div>
        )}
      </div>

      {/* `supervisor-composer` is on the WRAPPER and the two control testids are on the controls,
        * from the moment this file is written (spec erratum E17). An earlier draft put
        * `supervisor-composer` on the `<textarea>` and had Task 6 rename it; a testid that moves
        * mid-milestone is a testid two tasks disagree about. */}
      <div data-testid="supervisor-composer" className="flex flex-none flex-col gap-2 border-t border-line px-[14px] pb-[14px] pt-3">
        {/* TWO lines, not one with two moods. `gate-m45` stage 5 clicks Send *until*
          * `supervisor-request-result` is visible and then asserts its text names `v3` — so that
          * testid has to be the SUCCESS line. The refusal is its own element beside it. */}
        {resultText !== null && (
          <span data-testid="supervisor-request-result" className="text-[12.5px] text-t2">
            {resultText}
          </span>
        )}
        {errorText !== null && (
          <span role="alert" data-testid="supervisor-request-error" className="text-[12.5px] text-s-blocked">
            {errorText}
          </span>
        )}
        <div className="flex items-end gap-2 rounded-[11px] border border-line2 bg-card py-2 pl-3 pr-2">
          <textarea
            data-testid="supervisor-request-input"
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter newlines (README "Supervisor panel" → Composer).
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            placeholder="Ask, instruct, or steer… (Enter to send)"
            aria-label="Message the Supervisor"
            className="min-h-[40px] flex-1 resize-none border-0 bg-transparent py-[2px] text-[13.5px] leading-[1.45] text-t1 outline-none"
          />
          <button
            type="button"
            data-testid="supervisor-request-send"
            disabled={busy || draft.trim().length === 0}
            onClick={() => void send()}
            className="rounded-card border-0 bg-accent px-3 py-[7px] text-[12.5px] font-semibold text-accent-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Send
          </button>
        </div>
        <div className="flex justify-between text-[11.5px] text-t3">
          <span>Every message is recorded as an event.</span>
          <span>
            Scope: <b className="font-medium text-t2">{facts?.workspace.name ?? 'this project'}</b>
          </span>
        </div>
      </div>
    </div>
  )
}
