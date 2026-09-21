'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { SITUATION_LABEL, TIER_LABEL, type ChatAttachment, type Tier } from '@slave-of-ai/domain'
import { postControl, postForm, sendControl } from '../../lib/postControl'
import { useShellFacts } from '../../hooks/useShellFacts'
import { plural } from '../../lib/plural'
import { formatUsd } from '../../lib/realMoney'
import type { ProviderKind } from '../../lib/providerLabel'
import type { SupervisorThread } from '../../server/supervisorThreads'
import { ModelSelect } from '../ModelSelect'
import { ProviderSelect } from '../ProviderSelect'
import { Kbd } from '../ui/Kbd'

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
  /** WHICH verb this proposal would run. Read for one reason (ruling T5-3): an `answer_question`
   *  proposal carries a drafted answer a person has to READ before it is sent in their name, and
   *  this card has no room to show one -- so it sends them to the surface that does instead of
   *  offering a one-click Approve over words nobody has seen. Optional, and a proposal that
   *  somehow arrives without it keeps the buttons, which is every other kind's behaviour. */
  readonly action?: { readonly kind?: string }
  /** The whole record, for `supervisor-decision-meta`'s `title` (spec erratum E18) — the four
   *  fields `SupervisorPanel.tsx:557` put there before this panel replaced it. Optional because a
   *  row written by an older build carries none. */
  readonly tier?: string
  readonly status?: string
  readonly decidedBy?: string
}

/** One action a reply asked for (F R3), as the thread view carries it: the decision it became,
 *  the tier that decided whether it was applied or is waiting, and the verb's own name. */
interface AskedAction {
  readonly decisionId: string
  readonly tier: Tier
  readonly kind: string
}

/** The situation every decision a CONVERSATION causes is recorded under (F R3). Named here
 *  because a card drawn for an action whose decision has already settled has no decision row to
 *  read it off, and the chip must still say what kind of thing it is. */
const OPERATOR_REQUEST = 'operator_request'

/** How often the thread is re-read while a reply is still being written (F R2/R8).
 *
 * The panel's own refresh is the shell's wake-up (`useShellFacts`'s identity), which fires when
 * the project's stream says something happened — and a model call in flight is NOT a happening:
 * nothing is written until it settles. So a conversation with a turn out would sit on "thinking"
 * until something else in the project moved. This is the only clock in this file, it runs ONLY
 * while a row is `answering`, and it stops the moment the reply lands. */
const ANSWER_POLL_MS = 2_000

/** The three reasons the chat tick records itself, in the words a person reads (F R8).
 *
 * The RAW member is what the row stores and what `title` keeps (docs/ia.md rule 3), because a
 * reason recorded months ago must still be readable by whatever renders it then. The three keys
 * are `NO_DECIDER_REASON`, `BUDGET_EXHAUSTED_REASON` and `TURN_UNREADABLE_REASON` in
 * `@slave-of-ai/control`, spelled out here rather than imported: control value-imports Prisma,
 * and this is a client component. */
const FAILURE_SENTENCE: Readonly<Record<string, string>> = {
  no_decider_for_provider: 'No runtime can answer for this provider on this daemon.',
  budget_exhausted: "The project's budget is spent; the conversation waits for more.",
  turn_unreadable: 'The message could not be read back; send it again.',
}

/** A failed turn's reason as a sentence. Anything the table does not hold is the PROVIDER's own
 *  words (a failed outcome's reason), and they are shown verbatim: this panel does not know what
 *  a runtime meant, and paraphrasing it would be inventing a diagnosis. */
function failureSentence(reason: string | null): string {
  if (reason === null || reason === '') return 'The Supervisor could not answer this one.'
  return FAILURE_SENTENCE[reason] ?? reason
}

/** An action kind as words rather than the identifier the row stores (docs/ia.md rule 3).
 *
 * There is no label table for action kinds anywhere in the domain — `ProposalRow`'s
 * `actionSentence` builds its sentence from the WHOLE action, and a thread row carries the kind
 * alone — so the member's own words are unpicked here and the raw member rides in `title`, which
 * is the second half of the same rule. */
function actionWords(kind: string): string {
  return kind.split('_').join(' ')
}

/** `1400` → `1.4 kB`. Decimal units, because that is what a file manager and an upload limit
 *  ("20 MB each") both mean, and a chip beside a filename is not the place to explain kibibytes. */
function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${String(bytes)} B`
  const kb = bytes / 1000
  return kb < 1000 ? `${kb.toFixed(1)} kB` : `${(kb / 1000).toFixed(1)} MB`
}

/** The domain's word for a situation, with the raw member as the runtime fallback — the same guard
 *  `SupervisorPanel.tsx:254` carried: `SITUATION_LABEL` is total over the union the compiler knows,
 *  and a row written by a newer build carries a kind this bundle has never heard of. */
function situationLabel(kind: string): string {
  return SITUATION_LABEL[kind as keyof typeof SITUATION_LABEL] ?? kind
}

const CHIP_CLASS = 'rounded-chip border border-line2 px-[7px] py-[2px] font-mono text-[11px] font-medium text-t2'

/**
 * One proposal, answerable where it is read (M57 R9), or one action a reply asked for (F R3).
 *
 * Its own component rather than JSX inlined twice, because it is drawn in three places: inside the
 * message that announced it, under the reply that asked for it, and — for a proposal this day's
 * conversation never mentions — in the "waiting on you" tail below the thread. One card, one set
 * of testids, one pair of buttons.
 *
 * `decision` is null for an action whose decision the view no longer holds: it was carried out in
 * the same settlement (tier `applied`) or somebody has already answered it. There is nothing open
 * to approve then, so the card is the kind and the tier and nothing to press — offering Approve
 * over a settled decision would be a button whose only possible answer is a refusal.
 */
function DecisionCard({
  decision,
  asked,
  workspaceId,
  busy,
  onAnswer,
}: {
  readonly decision: PendingDecision | null
  /** What the reply asked for, on a card drawn under one. Null on the two older call sites: an
   *  event announced that proposal, and no action list came with it. */
  readonly asked: AskedAction | null
  /** For the one link this card can render -- see `needsReading` below. */
  readonly workspaceId: string
  readonly busy: boolean
  readonly onAnswer: (decisionId: string, verdict: 'approve' | 'reject') => void
}): React.JSX.Element {
  // Ruling T5-3: a drafted answer goes out to another worker IN THE OPERATOR'S NAME, and this card
  // shows the situation summary, not the draft. Approving from here would be approving words
  // nobody has read. The six-lane timeline's DECISION REQUIRED lane renders `ProposalRow`, which
  // shows the question, the draft in an editable box, its confidence and every source behind it --
  // so this card sends a person there rather than growing a second, smaller copy of it.
  const needsReading = decision?.action?.kind === 'answer_question'
  const situationKind = decision?.situationKind ?? OPERATOR_REQUEST
  return (
    <div
      data-testid="supervisor-decision-card"
      data-decision-id={decision?.id ?? asked?.decisionId ?? ''}
      // Spec §3 says the CARD carries both; the draft put this one on the inner `<p>`
      // (scan finding 29).
      data-situation-kind={situationKind}
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
      <span data-testid="supervisor-proposal-kind" title={situationKind} className="ml-2 font-mono text-[10.5px] text-t3">
        {situationLabel(situationKind)}
      </span>
      {/* `supervisor-decision-meta`, also carried over (`SupervisorPanel.tsx:557`):
        * the projected sentence, with the WHOLE record one hover away. `gate-m44:921`
        * waits on this element, unscoped. A card with no decision row behind it has a
        * different set of raw values to offer, and offers those. */}
      <span
        data-testid="supervisor-decision-meta"
        title={
          decision !== null
            ? `${decision.situationKind} · ${decision.tier ?? '—'} · ${decision.status ?? 'pending'} · ${decision.decidedBy ?? '—'}`
            : `${situationKind} · ${asked?.tier ?? '—'} · ${asked?.kind ?? '—'}`
        }
        className="mt-[4px] block text-[10.5px] text-t3"
      >
        {situationLabel(situationKind)} ·{' '}
        {decision === null && asked !== null ? TIER_LABEL[asked.tier] : 'waiting for you'}
      </span>
      {decision === null ? (
        <p data-testid="supervisor-decision-asked" title={asked?.kind ?? ''} className="mt-[6px] font-medium text-t1">
          {actionWords(asked?.kind ?? '')}
        </p>
      ) : (
        <>
          <p className="mt-[6px] font-medium text-t1">
            {decision.situation.summary ?? 'The Supervisor has proposed something.'}
          </p>
          <div className="mt-[10px] flex gap-[6px]">
            {needsReading ? (
              <Link
                data-testid="supervisor-decision-review"
                href={`/w/${workspaceId}`}
                className="rounded-card border border-line2 px-3 py-[6px] text-[12.5px] font-medium text-t1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Review the draft →
              </Link>
            ) : (
              <>
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
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** One card drawn under one message: the proposal the view still holds, the action a reply asked
 *  for, or both. `key` is the decision's id, which is unique across a thread by construction. */
interface ThreadCard {
  readonly key: string
  readonly decision: PendingDecision | null
  readonly asked: AskedAction | null
}

/**
 * The Supervisor, as a conversation (M57 R9, F R1/R8).
 *
 * The threads are `server/supervisorThreads.ts`'s merge of the conversation's own
 * `SupervisorMessage` rows with the six `workspace.goal_set`/`supervisor.*` event families around
 * them; the decision cards are the SAME `pending` list the Overview's needs-you queue reads; and
 * Approve and Decline are the same two routes.
 *
 * The composer sends to `POST /api/w/:id/supervisor/messages` (F R2). It posted `{ request }` to
 * `/goal/request` until this milestone, which re-planned the whole board for a question that
 * wanted an answer — asking for the goal to change is a `request_goal_change` action the REPLY may
 * propose now, through the same decision card every other proposal is answered on (R3). The goal
 * route itself is untouched and still serves the CLI.
 *
 * `+` writes nothing — there is no row to create. It selects `threads[0]`, the NEWEST thread
 * (threads sort newest-first, so that is today's once anything addressed to a person has happened
 * today), closes the history dropdown, and clears the composer. It does not scroll anywhere: the
 * newly-selected thread simply replaces whatever was showing.
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
  /** What is waiting to be uploaded when the next message goes (F R6). Files, not paths: nothing
   *  is written to the repository until somebody presses Send, so a person who attaches the wrong
   *  thing and takes it back off has committed nothing. */
  const [files, setFiles] = useState<readonly File[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  // R1/R8 (Task 7): the scope line's own switch. `null` until the view answers once -- `useShellFacts`
  // carries none of the Supervisor's settings (`hooks/useShellFacts.ts`'s own `sameFacts` list), so
  // this panel reads them off `GET /api/w/:id/supervisor` itself rather than growing a field onto a
  // store every OTHER workspace page publishes to.
  const [autonomy, setAutonomy] = useState<'propose' | 'act' | null>(null)
  const [autonomyPending, setAutonomyPending] = useState(false)
  // F R4: the pair the header's two selects are bound to. `''` on either is the INSTALLATION
  // DEFAULT, which is what the unset column means, and `runtimeRead` is what keeps the selects
  // disabled until the view has said so once -- an empty select a person could change before the
  // first read would PATCH "default" over a project that had chosen something.
  const [provider, setProvider] = useState<ProviderKind | ''>('')
  const [model, setModel] = useState('')
  const [runtimeRead, setRuntimeRead] = useState(false)
  const [runtimePending, setRuntimePending] = useState(false)
  /** F R8's "cost so far": the measured money and the turns nobody could price, side by side and
   *  never folded together (erratum E2). `null` until the view answers once. */
  const [cost, setCost] = useState<{ readonly usd: number; readonly unmeasured: number } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/w/${workspaceId}/supervisor/threads`)
      if (response.ok) setThreads((await response.json()) as readonly SupervisorThread[])
    } catch {
      // Keep what is on screen. A conversation that empties itself because one poll failed is
      // worse than one that is a few seconds behind.
    }
  }, [workspaceId])

  const loadSettings = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/w/${workspaceId}/supervisor`)
      if (!response.ok) return
      const view = (await response.json()) as {
        settings?: { autonomy?: 'propose' | 'act'; provider?: ProviderKind | null; model?: string | null }
        conversationCostUsd?: number
        conversationUnmeasuredTurns?: number
      }
      if (view.settings?.autonomy !== undefined) setAutonomy(view.settings.autonomy)
      if (view.settings !== undefined) {
        setProvider(view.settings.provider ?? '')
        setModel(view.settings.model ?? '')
        setRuntimeRead(true)
      }
      if (view.conversationCostUsd !== undefined) {
        setCost({ usd: view.conversationCostUsd, unmeasured: view.conversationUnmeasuredTurns ?? 0 })
      }
    } catch {
      // Same rule as `load` above: leave the controls where they were rather than blank them.
    }
  }, [workspaceId])

  // Two triggers, both existing: the workspace changed, or its stream woke the shell up. No
  // `EventSource` of this panel's own -- `hooks/useShellFacts.ts:18-24` is the rule.
  useEffect((): void => {
    void load()
  }, [load, facts])

  useEffect((): void => {
    // Disabled again whenever the PROJECT changes, not only on the first mount: this component is
    // not remounted between projects (`RightPanelHost` renders it without a key), so for the
    // length of one round trip the two selects would otherwise show the last project's runtime,
    // enabled -- and a change made in that window would PATCH the new project with the old one's
    // pair. `autonomy`'s own `null` guard is the same rule, said for the switch.
    setRuntimeRead(false)
    void loadSettings()
  }, [loadSettings])

  const thread = useMemo(
    () => threads.find((candidate) => candidate.id === selectedId) ?? threads[0] ?? null,
    [threads, selectedId],
  )

  // F R2: a turn in flight writes nothing until it settles, so the shell's wake-up cannot report
  // it. This is the panel's ONE clock and it runs only while a reply is still being written.
  const waitingOnReply = (thread?.messages ?? []).some((message) => message.status === 'answering')
  useEffect((): (() => void) | undefined => {
    if (!waitingOnReply) return undefined
    const timer = setInterval((): void => {
      void load()
    }, ANSWER_POLL_MS)
    return (): void => {
      clearInterval(timer)
    }
  }, [waitingOnReply, load])

  const toggleAutonomy = async (checked: boolean): Promise<void> => {
    setAutonomyPending(true)
    // The last refusal is about the last act, like `answer` below: a band that outlived what it
    // described reads as being about the switch somebody just flipped.
    setErrorText(null)
    const error = await sendControl(`/api/w/${workspaceId}/supervisor/settings`, {
      method: 'PATCH',
      body: { autonomy: checked ? 'act' : 'propose' },
    })
    setAutonomyPending(false)
    // A REFUSAL IS SAID OUT LOUD (final review, Minor 6). It was swallowed: the checkbox sprang
    // back to where it had been -- `loadSettings` is not called, so the state never moved -- and
    // the one switch that decides whether this project runs itself silently disagreed with the
    // person holding it. `errorText` is the panel's own band, which every other refusal here uses.
    if (error === null) await loadSettings()
    else setErrorText(error)
  }

  /**
   * F R4: the runtime pair, written the moment a select moves.
   *
   * OPTIMISTIC, unlike the autonomy switch beside it, and for the shape of the control rather than
   * a change of mind: a `<select>` shows the option somebody just picked whatever this component
   * does, so "leave the state alone until the server confirms" would put the control and the state
   * at odds for the length of a round trip. `revert` is what puts it back when the PATCH is
   * refused, and the refusal is said out loud in the same band every other one here uses.
   */
  const setRuntime = async (body: Record<string, unknown>, revert: () => void): Promise<void> => {
    setRuntimePending(true)
    setErrorText(null)
    const error = await sendControl(`/api/w/${workspaceId}/supervisor/settings`, { method: 'PATCH', body })
    setRuntimePending(false)
    if (error === null) await loadSettings()
    else {
      revert()
      setErrorText(error)
    }
  }

  const chooseProvider = (next: ProviderKind | ''): void => {
    const wasProvider = provider
    const wasModel = model
    setProvider(next)
    // A model id is a name ONE vendor knows, so it goes with the runtime it belonged to: keeping
    // `claude-sonnet-5` across a switch to Cursor would ask Cursor for a Claude model, which is a
    // turn that fails at the far end for a reason nothing here would explain.
    setModel('')
    void setRuntime({ provider: next === '' ? null : next, model: null }, (): void => {
      setProvider(wasProvider)
      setModel(wasModel)
    })
  }

  const chooseModel = (next: string): void => {
    const was = model
    setModel(next)
    void setRuntime({ model: next === '' ? null : next }, (): void => {
      setModel(was)
    })
  }

  /**
   * Which message draws which card — and never the same decision twice.
   *
   * A pending decision is announced by TWO events (`decide()` writes `supervisor.decided` and, for
   * a proposal, `supervisor.proposed`), so a naive match on `decisionId` draws the same card twice
   * under one proposal. F R3 adds a second way to be drawn twice: a reply carries its actions on
   * `actions`, and `supervisorThreads.ts` ALSO puts the first of them on `decisionId` so an older
   * reader still finds one — so a reply's cards come from `actions` and that field is not read
   * again for the same row.
   *
   * The ones no message in THIS day's conversation names are drawn below the thread instead of
   * vanishing: the dock badges `pending.length`, and a badge that counts three while the panel
   * shows none is a badge that lies.
   */
  const { cardsFor, loose } = useMemo(() => {
    const taken = new Set<string>()
    const byId = new Map(pending.map((decision) => [decision.id, decision]))
    const owner = new Map<string, readonly ThreadCard[]>()
    for (const message of thread?.messages ?? []) {
      const asked = message.actions ?? []
      if (asked.length > 0) {
        owner.set(
          message.id,
          asked.map((one): ThreadCard => {
            taken.add(one.decisionId)
            return { key: one.decisionId, decision: byId.get(one.decisionId) ?? null, asked: one }
          }),
        )
        continue
      }
      if (message.decisionId === null) continue
      const decision = byId.get(message.decisionId)
      if (decision === undefined || taken.has(decision.id)) continue
      taken.add(decision.id)
      owner.set(message.id, [{ key: decision.id, decision, asked: null }])
    }
    return { cardsFor: owner, loose: pending.filter((decision) => !taken.has(decision.id)) }
  }, [pending, thread])

  const addFiles = (chosen: FileList | readonly File[] | null): void => {
    if (chosen === null) return
    const added = [...chosen]
    if (added.length === 0) return
    // NOT capped here, and not checked against the allow-list here: `storeSupervisorUploads` owns
    // both, and it names the file that broke the rule in a sentence this panel shows. A second
    // copy of the policy in a browser is a second place for it to go stale.
    setFiles((was) => [...was, ...added])
  }

  /**
   * The composer's send (F R2/R6).
   *
   * THE ORDER IS THE CONTRACT: whatever is attached is uploaded FIRST, and the message names the
   * paths that upload answered with. `sendSupervisorMessage` refuses a path that is not already in
   * `docs/inbox/`, so a message can only ever name a file that is really in the repository — and a
   * refused upload stops here, with the words and the files still on screen, rather than sending a
   * message about a brief nobody can open.
   */
  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (text.length === 0 || busy) return
    setBusy(true)
    setErrorText(null)
    let attachments: readonly ChatAttachment[] = []
    if (files.length > 0) {
      const form = new FormData()
      // One field name for every file: the route takes every `File` value in the form whatever the
      // control that produced it called them.
      for (const file of files) form.append('files', file)
      const stored = await postForm<{ attachments: readonly ChatAttachment[] }>(
        `/api/w/${workspaceId}/supervisor/uploads`,
        form,
      )
      if (!stored.ok) {
        setBusy(false)
        setErrorText(stored.error)
        return
      }
      attachments = stored.data.attachments
    }
    const sent = await postControl(`/api/w/${workspaceId}/supervisor/messages`, {
      text,
      ...(attachments.length === 0 ? {} : { attachments }),
    })
    setBusy(false)
    if (sent.ok) {
      setDraft('')
      setFiles([])
      // The control keeps the last selection otherwise, and picking the SAME file again would then
      // fire no `change` event at all.
      if (fileInput.current !== null) fileInput.current.value = ''
      await load()
    } else setErrorText(sent.error)
  }

  const answer = async (decisionId: string, verdict: 'approve' | 'reject'): Promise<void> => {
    setBusy(true)
    // The last refusal is about the last act, not this one: a band that outlives what it described
    // is a band a person reads as being about the button they just pressed.
    setErrorText(null)
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

      {/* R14/I3 (final-review wave): the scope line, promoted from the composer's footer to the
        * panel's own subtitle -- it is a fact about the WHOLE conversation ("who this thread is
        * with"), not a note that belongs beside the send button. R1/R8 (Task 7) adds the autonomy
        * switch beside it -- the same fact `RuntimePanel`'s `runtime-autonomy` checkbox writes,
        * reachable from the conversation an operator is already reading rather than only from
        * Settings. */}
      <div className="flex flex-none items-center justify-between gap-2 px-[16px] py-[6px] text-[11.5px] text-t3">
        <span>
          Scope: <b className="font-medium text-t2">{facts?.workspace.name ?? 'this project'}</b>
        </span>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            data-testid="supervisor-autonomy"
            aria-label="act on its own"
            checked={autonomy === 'act'}
            onChange={(event) => void toggleAutonomy(event.target.checked)}
            disabled={autonomyPending || autonomy === null}
          />
          act on its own
        </label>
      </div>

      {/* F R4/R8: WHO answers this conversation, and what it has cost. The pair governs every
        * Supervisor call for the project -- decisions and answers to workers as much as this
        * thread -- which is why it sits on the conversation's own chrome rather than in Settings
        * alone: it is the thing a person changes when the answers are not good enough. */}
      <div className="flex flex-none items-center gap-[6px] px-[16px] pb-[8px] text-[11px] text-t3">
        <ProviderSelect
          testId="supervisor-provider"
          ariaLabel="Supervisor runtime"
          value={provider}
          onChange={chooseProvider}
          disabled={runtimePending || !runtimeRead}
          placeholder="default runtime"
          className="rounded-card border border-line2 bg-card px-[6px] py-[3px] text-[11px] text-t1"
        />
        <ModelSelect
          provider={provider}
          value={model}
          onChange={chooseModel}
          disabled={runtimePending || !runtimeRead}
          ariaLabel="Supervisor model"
          testId="supervisor-model"
          inputTestId="supervisor-model-input"
          className="max-w-[128px] px-[6px] py-[3px] text-[11px]"
        />
        {cost !== null && (
          <span data-testid="supervisor-cost" className="ml-auto whitespace-nowrap">
            {formatUsd(cost.usd)} so far
            {cost.unmeasured > 0 ? `, ${plural(cost.unmeasured, 'turn')} unpriced` : ''}
          </span>
        )}
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
          const cards = cardsFor.get(message.id) ?? []
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
                    ? 'max-w-[86%] rounded-sheet bg-[color-mix(in_oklab,var(--accent)_16%,transparent)] px-3 py-2 text-t1'
                    : 'max-w-[92%] rounded-sheet border border-line bg-card px-3 py-2 text-t1'
                }
              >
                {/* F R2: the placeholder row carries no text -- there is no reply yet, and an
                  * invented one would be a sentence a reader months later has to know was never
                  * said. The waiting is the panel's word, not the row's. */}
                {message.status === 'answering' && (
                  <span data-testid="supervisor-thinking" className="block text-t3">
                    thinking…
                  </span>
                )}
                {message.text !== '' && <span className="block">{message.text}</span>}
                {message.status === 'failed' && (
                  <span
                    data-testid="supervisor-failed"
                    title={message.failureReason ?? ''}
                    className="block text-[12.5px] text-s-blocked"
                  >
                    {failureSentence(message.failureReason ?? null)}
                  </span>
                )}
                {message.sourced === true && (
                  <span
                    data-testid="supervisor-sourced"
                    title="every citation in this reply was found in what it cited"
                    className="mt-2 inline-flex rounded-chip bg-[color-mix(in_oklab,var(--s-done)_14%,transparent)] px-[7px] py-[2px] font-mono text-[10.5px] font-medium text-s-done"
                  >
                    sourced
                  </span>
                )}
                {cards.map((card) => (
                  <DecisionCard
                    key={card.key}
                    decision={card.decision}
                    asked={card.asked}
                    workspaceId={workspaceId}
                    busy={busy}
                    onAnswer={onAnswer}
                  />
                ))}
                {(message.attachments ?? []).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-[5px]">
                    {(message.attachments ?? []).map((attachment) => (
                      // The PATH is the whole identity of an attachment (R6) -- it is how the
                      // Supervisor quotes it and how a worker opens it -- so it is what `title`
                      // carries, under the name and size a person recognises it by.
                      <span key={attachment.path} data-testid="supervisor-attachment" title={attachment.path} className={CHIP_CLASS}>
                        {attachment.name} · {formatBytes(attachment.bytes)}
                      </span>
                    ))}
                  </div>
                )}
                {message.refs.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-[5px]">
                    {message.refs.map((ref) => (
                      <span key={ref} className={CHIP_CLASS}>
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
              <DecisionCard
                key={decision.id}
                decision={decision}
                asked={null}
                workspaceId={workspaceId}
                busy={busy}
                onAnswer={onAnswer}
              />
            ))}
          </div>
        )}
      </div>

      {/* `supervisor-composer` is on the WRAPPER and the two control testids are on the controls,
        * from the moment this file is written (spec erratum E17). An earlier draft put
        * `supervisor-composer` on the `<textarea>` and had Task 6 rename it; a testid that moves
        * mid-milestone is a testid two tasks disagree about. */}
      <div data-testid="supervisor-composer" className="flex flex-none flex-col gap-2 border-t border-line px-[14px] pb-[14px] pt-3">
        {errorText !== null && (
          <span role="alert" data-testid="supervisor-request-error" className="text-[12.5px] text-s-blocked">
            {errorText}
          </span>
        )}
        {/* R14/I3: `rounded-[11px]` was the one hand-rolled radius left on this panel -- the field
          * is a `--radius-surface` surface like every other input now, and `Kbd` names the Enter
          * key beside the button it triggers instead of leaving it to be guessed. F R6 makes the
          * whole field a DROP ZONE: a brief dragged anywhere onto the box a person is typing in
          * is attached to the message they are typing. */}
        <div
          data-testid="supervisor-attach"
          onDragOver={(event) => {
            // Without this the browser opens the file instead, which navigates away from the
            // conversation somebody was in the middle of writing.
            event.preventDefault()
          }}
          onDrop={(event) => {
            event.preventDefault()
            addFiles(event.dataTransfer.files)
          }}
          className="flex flex-col gap-2 rounded-surface border border-line2 bg-card py-2 pl-3 pr-2"
        >
          {files.length > 0 && (
            <div className="flex flex-wrap gap-[5px]">
              {files.map((file, index) => (
                <span key={`${file.name}-${String(index)}`} data-testid="supervisor-attach-chip" className={CHIP_CLASS}>
                  {file.name} · {formatBytes(file.size)}
                  <button
                    type="button"
                    data-testid="supervisor-attach-remove"
                    aria-label={`Take ${file.name} back off`}
                    title={`Take ${file.name} back off`}
                    onClick={() => setFiles((was) => was.filter((_, at) => at !== index))}
                    className="ml-1 border-0 bg-transparent text-t3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
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
            {/* The control itself is never shown: a bare file input carries the browser's own
              * wording ("No file chosen") and cannot be styled to look like anything else here. */}
            <input
              ref={fileInput}
              type="file"
              multiple
              data-testid="supervisor-attach-input"
              aria-label="Files to attach"
              onChange={(event) => addFiles(event.target.files)}
              className="hidden"
            />
            <button
              type="button"
              data-testid="supervisor-attach-button"
              aria-label="Attach files"
              title="Attach a document or an image"
              onClick={() => fileInput.current?.click()}
              className="rounded-card border border-line2 bg-transparent px-2 py-[6px] text-[11.5px] font-medium text-t2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Attach
            </button>
            <Kbd>⏎</Kbd>
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
        </div>
      </div>
    </div>
  )
}
