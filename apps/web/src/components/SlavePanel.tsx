'use client'

import { useEffect, useMemo, useState } from 'react'
import { userSlaveStatus } from '@slave-of-ai/domain'
import type { SlaveFeedEvent } from '../lib/feedSummary'
import { providerLabel } from '../lib/providerLabel'
import type { SlaveCardData } from '../server/overview'
import { sendControl } from '../lib/postControl'
import { RuntimeRoleChips } from './RuntimeRoleChips'
import { DOT } from './SlaveCard'
import { ShellOnlyMark } from './ShellOnlyMark'
import { Button } from './ui/Button'
import { Chip } from './ui/Chip'

type ControlAction = 'pause' | 'resume' | 'stop' | 'message' | 'answer' | 'profile' | 'runtime-roles'

/**
 * What the Profile block says about where the text in its box came from, and what saving over it
 * will do (M37 §6).
 *
 * The origin is the whole point of showing it: only a `slave` text is this worker's OWN, and
 * saving over an inherited one writes a worker-level override rather than editing the roster row
 * or the template -- which is what those two routes would need, and this panel is not addressed at
 * them (spec erratum E3: the catalog levels have no workspace to be scoped by).
 */
const PROFILE_ORIGIN_TEXT: Record<'slave' | 'company' | 'template', string> = {
  slave: "this worker's own profile",
  company: 'inherited from its roster row — saving writes an override on this worker',
  template: 'inherited from its template — saving writes an override on this worker',
}

/** The one parse of a typed role set, mirroring `set-runtime-roles`'s own (`cli.ts`): an empty
 *  field is the PARKED state (spec §7), not one blank role the verb would refuse. The pieces stay
 *  untrimmed -- `setRuntimeRoles` trims entry by entry, and a second, differently-worded trim in a
 *  component is how the two surfaces drift apart. */
function parseRoles(typed: string): readonly string[] {
  return typed.trim() === '' ? [] : typed.split(',')
}

/** Seed (`slave.recentEvents`, last 20 from the DB) merged with the live buffer
 *  (`liveEvents[slave.id]`), deduplicated by seq, ascending — newest at the bottom. */
function mergeFeed(seed: readonly SlaveFeedEvent[], live: readonly SlaveFeedEvent[]): readonly SlaveFeedEvent[] {
  const bySeq = new Map<number, SlaveFeedEvent>()
  for (const event of seed) bySeq.set(event.seq, event)
  for (const event of live) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

export function SlavePanel({
  slave,
  liveEvents,
  workspaceId,
  haltedReason,
  onClose,
}: {
  readonly slave: SlaveCardData
  readonly liveEvents: readonly SlaveFeedEvent[]
  readonly workspaceId: string
  /** The workspace's current halt reason, if any — drives the "resume disabled + halt reason"
   *  cell of the enable/disable matrix (spec §6). */
  readonly haltedReason: string | null
  readonly onClose: () => void
}): React.JSX.Element {
  const [pending, setPending] = useState<ReadonlySet<ControlAction>>(new Set())
  const [errorText, setErrorText] = useState<string | null>(null)
  const [draft, setDraft] = useState(slave.queuedMessage ?? '')
  // The effective text, so the box shows what the next dispatch will actually send -- inherited or
  // not. `profileText`/`rolesText` are strings rather than the objects they come from, so the
  // resync effects below fire on a CHANGED value instead of on every snapshot's fresh object
  // identity, which would wipe what an operator is halfway through typing.
  const profileText = slave.profile?.text ?? ''
  const rolesText = slave.runtimeRoles.join(', ')
  const [profileDraft, setProfileDraft] = useState(profileText)
  const [rolesDraft, setRolesDraft] = useState(rolesText)

  // Resync the draft from the snapshot's queued message whenever it changes for this slave — a
  // resume consuming it, or another client overwriting it. Not optimistic UI: this reads what the
  // snapshot already carried in, it never reads a POST's response body. `slave.id` no longer
  // needs to be a dependency: `OverviewClient` keys the `<SlavePanel>` element on the slave id
  // (fix round 2, Finding 2), so switching slaves unmounts this instance rather than re-rendering
  // it with a new `slave` prop — every render of a given instance is the same slave throughout
  // its lifetime, by construction.
  useEffect((): void => {
    setDraft(slave.queuedMessage ?? '')
  }, [slave.queuedMessage])

  // The same resync rule as the message box above, for the same reason: what the snapshot carried
  // in is the truth, and a write from the CLI or another client must reach this box.
  useEffect((): void => {
    setProfileDraft(profileText)
  }, [profileText])

  useEffect((): void => {
    setRolesDraft(rolesText)
  }, [rolesText])

  const runId = slave.runId
  const status = slave.status
  const pauseEnabled = runId !== null && (status === 'starting' || status === 'working' || status === 'resuming')
  const stopEnabled = runId !== null && status !== 'idle'
  const workspaceHalted = haltedReason !== null
  // While a recorded intent is still waiting for the daemon/CLI to claim it, another click would
  // just record a second intent on top of the first (`requestResume` has no idempotency beyond
  // the single `resumeRequestedAt` column) — disabled here keeps that double-click a no-op.
  const resumeRequestedWhilePaused = status === 'paused' && slave.resumeRequestedAt !== null
  const resumeEnabled = runId !== null && status === 'paused' && !workspaceHalted && !resumeRequestedWhilePaused
  const showMessageBox = status !== 'idle'
  const messageWritable = status === 'paused'
  // M36 t2: `paused` with `waiting_for_answer` -- the slave asked another slave and stopped, and
  // nobody asked it to pause. The controls stay reachable (typing here and pressing the button IS
  // how a human answers), but they are not labelled as continuing an operator's pause, and the
  // "paused at step N" detail gives way to what the slave is actually waiting on.
  const waitingFor = slave.waitingFor
  // Fix round 1, finding 1: the button used to POST the run's `resume` route, which wrote NO
  // message -- the asker resumed, but the question stayed unanswered forever, was re-injected into
  // the recipient's every later run under "cannot continue until you reply", and never reached the
  // thread or the communication graph. It now writes a real `answer` against the question, and
  // `deliverAnswers` resumes the asker on the next tick. `messageId` is null only when the question
  // row is gone, and then there is nothing to reply to -- the plain resume is the honest fallback.
  const answerMessageId = waitingFor?.messageId ?? null
  // The halt check is the resume button's, for the same reason: `deliverAnswers` calls
  // `requestResume`, which refuses in a halted workspace -- so an answer written now would sit
  // undelivered with nothing on screen saying why. `resumeRequestedWhilePaused` blocks the second
  // click: an intent is already recorded, and a second answer would only be superseded.
  const answerEnabled = !workspaceHalted && !resumeRequestedWhilePaused && draft.trim() !== ''

  const feed = useMemo(() => mergeFeed(slave.recentEvents, liveEvents), [slave.recentEvents, liveEvents])

  /** The one place this panel writes: mark the control busy, clear the last refusal, dial the
   *  shared `sendControl`, and show whatever it refused with. Every button below goes through it,
   *  so the pending set and the error band cannot get out of step per control. */
  const send = async (
    action: ControlAction,
    url: string,
    options: { method: 'POST' | 'PATCH'; body?: Record<string, unknown> },
  ): Promise<void> => {
    setPending((current) => new Set(current).add(action))
    setErrorText(null)
    const error = await sendControl(url, options)
    if (error !== null) setErrorText(error)
    setPending((current) => {
      const next = new Set(current)
      next.delete(action)
      return next
    })
  }

  const post = (action: ControlAction, url: string, body?: Record<string, unknown>): Promise<void> =>
    send(action, url, body === undefined ? { method: 'POST' } : { method: 'POST', body })

  /** The two M37 writes: PATCH, because each replaces ONE field of a worker that has many. */
  const patch = (action: ControlAction, url: string, body: Record<string, unknown>): Promise<void> =>
    send(action, url, { method: 'PATCH', body })

  const run = async (action: ControlAction, path: string, body?: Record<string, unknown>): Promise<void> => {
    if (runId === null) return
    await post(action, `/api/w/${workspaceId}/runs/${runId}/${path}`, body)
  }

  /** Answers the question this run is waiting on -- addressed to the QUESTION, not to the run. */
  const answer = async (): Promise<void> => {
    if (answerMessageId === null) return
    await post('answer', `/api/w/${workspaceId}/messages/${answerMessageId}/answer`, { answer: draft })
  }

  return (
    <aside
      aria-label="Slave detail"
      // Slide-in (spec §8): this panel is mounted fresh per slave (`OverviewClient` keys it by
      // slave id), so the animation replays on every open/switch by construction.
      className="fixed inset-y-0 right-0 z-10 flex w-96 flex-col gap-4 overflow-y-auto border-l border-line bg-bg-1 p-4 motion-safe:animate-[panel-in_160ms_ease-out]"
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            data-testid="status-dot"
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[slave.status]} ${slave.status === 'working' ? 'animate-pulse' : ''}`}
          />
          <div>
            <h2 className="text-sm font-medium text-text-1">{slave.name}</h2>
            <span className="text-xs text-text-3">{slave.role}</span>
          </div>
          {/* R5 leak 2: this printed the raw `SlaveStatus`. The projected word is what a person
            * reads; `data-status` and `title` keep the raw value on the node. */}
          <span
            data-testid="status-label"
            data-status={slave.status}
            title={slave.status}
            className="ml-1 text-xs text-text-2"
          >
            {userSlaveStatus(slave.status).label}
          </span>
          {/* The runtime's WORD (M44 R4, final review item I3), `—` when no run has resolved
            *  one (M12 Task 9, ruling R10), raw kind in `title`. The shell-only gate mark (spec
            *  §8) is `ShellOnlyMark` (M12 Task 13 fix round 1, finding 4a). */}
          <Chip>
            <span data-testid="provider-chip" title={slave.provider ?? undefined}>
              {providerLabel(slave.provider)}
            </span>
          </Chip>
          <ShellOnlyMark gate={slave.gate} />
        </div>
        <Button variant="ghost" onClick={onClose} aria-label="Close slave detail">
          close
        </Button>
      </header>

      <div className="text-sm text-text-1">{slave.taskTitle ?? <span className="text-text-3">idle</span>}</div>

      <div className="flex items-center gap-3 font-mono text-xs text-text-2">
        {/* `—`, the mark the Roster already uses for unknown -- never `$0.00`, which claims a
          *  measurement this run never made (spec Decision 6; M12 Task 9, ruling R3). */}
        <span data-testid="run-cost">{slave.costUsd === null ? '—' : `$${slave.costUsd.toFixed(2)}`}</span>
        <span data-testid="run-tool-calls">{slave.toolCalls} calls</span>
        {status === 'paused' && waitingFor === null && slave.pausedAtStep !== null && (
          <span data-testid="run-paused-step">paused at step {slave.pausedAtStep}</span>
        )}
        {waitingFor !== null && <span data-testid="run-waiting-step">waiting at step {slave.pausedAtStep ?? 0}</span>}
      </div>

      {errorText !== null && (
        <div role="alert" data-testid="panel-error" className="rounded border border-tone-blocked/40 bg-tone-blocked/10 px-2 py-1.5 text-xs text-tone-blocked">
          {errorText}
        </div>
      )}

      <section className="flex gap-2">
        <Button variant="ghost" data-testid="pause-button" disabled={!pauseEnabled || pending.has('pause')} onClick={() => void run('pause', 'pause')}>
          pause
        </Button>
        {answerMessageId !== null ? (
          <Button
            variant="ghost"
            data-testid="answer-button"
            // A blank answer is refused by `answerQuestion` anyway (`invalid_message_body`);
            // disabling it here means the operator is told to type something by the control, not by
            // an error after the round trip.
            disabled={!answerEnabled || pending.has('answer')}
            onClick={() => void answer()}
          >
            answer
          </Button>
        ) : (
          <Button variant="ghost" data-testid="resume-button" disabled={!resumeEnabled || pending.has('resume')} onClick={() => void run('resume', 'resume')}>
            resume
          </Button>
        )}
        <Button variant="ghost" data-testid="stop-button" disabled={!stopEnabled || pending.has('stop')} onClick={() => void run('stop', 'stop')}>
          stop
        </Button>
      </section>

      {waitingFor !== null && (
        <section data-testid="waiting-for" className="flex flex-col gap-1 rounded border border-tone-waiting/40 bg-tone-waiting/10 px-2 py-1.5">
          <h3 className="text-xs uppercase tracking-wide text-tone-waiting">waiting for {waitingFor.recipient}</h3>
          <p data-testid="waiting-question" className="whitespace-pre-wrap text-xs text-text-2">
            {waitingFor.question ?? 'the question is no longer on record'}
          </p>
          <p className="text-[10.5px] text-text-3">
            it is not waiting for you — but what you type below is written as the answer, and the
            slave is resumed with it on the next tick.
          </p>
        </section>
      )}

      {resumeRequestedWhilePaused && (
        <p data-testid="resume-requested" className="text-xs text-text-3">
          resume requested — waiting for the daemon
        </p>
      )}

      {status === 'paused' && workspaceHalted && (
        <p data-testid="resume-halt-reason" className="text-xs text-tone-blocked">
          workspace halted: {haltedReason}
        </p>
      )}

      {showMessageBox && (
        <section data-testid="message-box" className="flex flex-col gap-1">
          <h3 className="text-xs uppercase tracking-wide text-text-3">Message</h3>
          {messageWritable ? (
            <>
              <textarea
                data-testid="message-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="rounded border border-line bg-bg-0 p-2 text-xs text-text-1"
                rows={3}
              />
              <Button
                variant="ghost"
                data-testid="message-save"
                disabled={pending.has('message')}
                onClick={() => void run('message', 'message', { message: draft })}
                className="self-end"
              >
                save
              </Button>
            </>
          ) : (
            <p data-testid="message-hint" className="text-xs text-text-3">
              pause to send an instruction
            </p>
          )}
        </section>
      )}

      {/* M37 §6. The persona a run is given, and the roles it can be dispatched as -- both written
        * only by their control verbs, through the two routes below. */}
      <section data-testid="profile-block" className="flex flex-col gap-1">
        <h3 className="text-xs uppercase tracking-wide text-text-3">Profile</h3>
        <p data-testid="profile-origin" className="text-[10.5px] text-text-3">
          {slave.profile === null ? 'no profile — this worker is sent no persona' : PROFILE_ORIGIN_TEXT[slave.profile.origin]}
        </p>
        {/* A textarea, so another party's Markdown is characters in a form control and never
          * elements (spec §1: another party's text is data). */}
        <textarea
          data-testid="profile-input"
          value={profileDraft}
          onChange={(event) => setProfileDraft(event.target.value)}
          className="rounded border border-line bg-bg-0 p-2 text-xs text-text-1"
          rows={6}
        />
        <Button
          variant="ghost"
          data-testid="profile-save"
          disabled={pending.has('profile')}
          // A blank box means "clear my override", which only an explicit `null` expresses: an
          // empty string would win the `??` chain and render nothing, leaving the roster row and
          // the template unable to show through again.
          onClick={() =>
            void patch('profile', `/api/w/${workspaceId}/slaves/${slave.id}/profile`, {
              profile: profileDraft.trim() === '' ? null : profileDraft,
            })
          }
          className="self-end"
        >
          save
        </Button>
      </section>

      <section data-testid="runtime-roles-block" className="flex flex-col gap-1">
        <h3 className="text-xs uppercase tracking-wide text-text-3">Runtime roles</h3>
        {/* The same chips and the same warning the card and the Slaves table show -- an empty set
          * means this worker is never a scheduler candidate, never staffed onto a review or a
          * plan, and never a role-addressed message's recipient (spec §7). */}
        <div className="flex flex-wrap items-center gap-[5px]">
          <RuntimeRoleChips roles={slave.runtimeRoles} />
        </div>
        <input
          data-testid="runtime-roles-input"
          value={rolesDraft}
          onChange={(event) => setRolesDraft(event.target.value)}
          aria-label="Runtime roles, comma separated"
          placeholder="backend, reviewer"
          className="rounded border border-line bg-bg-0 p-2 text-xs text-text-1"
        />
        <Button
          variant="ghost"
          data-testid="runtime-roles-save"
          disabled={pending.has('runtime-roles')}
          onClick={() =>
            void patch('runtime-roles', `/api/w/${workspaceId}/slaves/${slave.id}/runtime-roles`, {
              roles: parseRoles(rolesDraft),
            })
          }
          className="self-end"
        >
          save
        </Button>
      </section>

      <section className="flex flex-1 flex-col gap-1 overflow-y-auto">
        <h3 className="text-xs uppercase tracking-wide text-text-3">Live feed</h3>
        {feed.length === 0 ? (
          <p className="text-xs text-text-3">no events yet</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {feed.map((event) => (
              <li key={event.seq} data-testid="feed-event" className="font-mono text-xs text-text-2">
                {event.summary}
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  )
}
