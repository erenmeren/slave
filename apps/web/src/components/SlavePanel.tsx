'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  PERMISSION_LABEL,
  PERMISSION_PROVIDERS,
  TOOLS_BY_KIND,
  userSlaveStatus,
  type PermissionKind,
  type PermissionRunKind,
} from '@slave-of-ai/domain'
import type { SlaveFeedEvent } from '../lib/feedSummary'
import { formatUsd } from '../lib/realMoney'
import { providerLabel } from '../lib/providerLabel'
import type { SlaveCardData, SlaveGrant } from '../server/overview'
import { sendControl } from '../lib/postControl'
import { RuntimeRoleChips } from './RuntimeRoleChips'
import { DOT } from './SlaveCard'
import { ShellOnlyMark } from './ShellOnlyMark'
import { Button } from './ui/Button'
import { Chip } from './ui/Chip'
import { DetailsGroup } from './ui/DetailsGroup'

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

/**
 * What a runtime's GATE means for the worker that runs on it (spec §8 / Decision 8), in words.
 *
 * The header keeps `ShellOnlyMark`, which marks the one gate spec §8 asks to be marked and nothing
 * else; this line is the whole fact, and it lives inside the Model group, where the raw value
 * belongs -- `title` carries `all-tools`/`shell-only`/`none` verbatim.
 */
const GATE_TEXT: Record<'all-tools' | 'shell-only' | 'none', string> = {
  'all-tools': 'every tool this runtime has',
  'shell-only': 'a shell, and nothing else',
  none: 'no tools at all',
}

/**
 * The three marks the matrix has drawn since M14 -- one vocabulary, two surfaces (M52 R7).
 *
 * Spelled here rather than imported from `PermissionMatrix`: that component is the SETTINGS grid,
 * it owns a button per cell and a write per click, and a panel that imported it to borrow two
 * `Record`s would be importing a writer to draw a read.
 */
const GLYPH: Record<'allow' | 'deny' | 'unset', string> = { allow: '\u2713', deny: '\u2715', unset: '\u2013' }

const GLYPH_CLASS: Record<'allow' | 'deny' | 'unset', string> = {
  allow: 'text-tone-working',
  deny: 'text-tone-blocked',
  unset: 'text-text-3',
}

/**
 * The same three answers IN WORDS, for a reader who cannot see a glyph (fix round 1, review
 * Important 3).
 *
 * `refused` rather than the matrix's `denied` on purpose: a matrix cell shows the stored ROW, whose
 * mode really is `deny`, and this line shows the effective ANSWER, whose `GrantSource` really is
 * `refused` -- and the sentence one disclosure below already says "Refused by <name>". Two words
 * for two facts, not two spellings of one.
 */
const MODE_WORD: Record<'allow' | 'deny' | 'unset', string> = {
  allow: 'allowed',
  deny: 'refused',
  unset: 'not set',
}

/** A BASELINE is a ✓ (the run really may do it) and `never` is a `–`. Three glyphs, the same three
 *  `PermissionMatrix` has drawn since M14 -- one vocabulary, two surfaces. */
function glyphFor(grant: SlaveGrant): 'allow' | 'deny' | 'unset' {
  if (grant.mode === 'deny') return 'deny'
  return grant.mode === 'allow' || grant.source === 'baseline' ? 'allow' : 'unset'
}

/**
 * A kind that names NO vendor tool on either provider is a BROKER grant rather than a tool grant
 * (M52 R3): what it permits is the orchestrator acting for this worker, in its own process, and the
 * worker never holds the credential.
 *
 * DERIVED from `TOOLS_BY_KIND` rather than a second list of the two, so a third broker grant says
 * so here by construction instead of quietly reading as a tool nobody granted.
 */
function isBrokeredGrant(kind: PermissionKind): boolean {
  return PERMISSION_PROVIDERS.every((provider) => TOOLS_BY_KIND[kind][provider].length === 0)
}

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `2026-09-12T10:00:00.000Z` -> `12 Sep 2026`, read off the ISO STRING rather than through a
 *  `Date`: `grantedAt` crosses the server/client boundary as UTC, and a `toLocaleDateString` in a
 *  browser west of Greenwich would print the day before the one the event log records. */
function onDate(at: string | null): string {
  const [year, month, day] = (at ?? '').slice(0, 10).split('-')
  const name = MONTH[Number(month) - 1]
  if (year === undefined || day === undefined || name === undefined) return 'an unrecorded date'
  return `${String(Number(day))} ${name} ${year}`
}

/**
 * WHO decided, in words (fix round 1, review Important 1).
 *
 * Three answers, and the two nulls are not the same null. `byName` is the username
 * `buildOverviewSnapshot` resolved; `by === null` means nobody was named at the write at all (the
 * CLI and the daemon carry no `Principal`); `by !== null` with no name means the account was
 * deleted since. The raw id is never what this returns -- it rides the sentence's `title`.
 */
function granterName(grant: SlaveGrant): string {
  if (grant.byName !== null) return grant.byName
  return grant.by === null ? 'somebody unrecorded' : 'a person no longer on record'
}

/**
 * The policy sentence, and the one place this panel says anything a person did not do (M52 R7).
 *
 * The two broker grants say what they are, because a ✕ on a row that names no tool would otherwise
 * read as a tool this worker cannot use.
 */
function sourceSentence(grant: SlaveGrant, runKind: PermissionRunKind): string {
  const brokered = isBrokeredGrant(grant.kind) ? ' \u2014 a brokered operation, not a tool' : ''
  switch (grant.source) {
    case 'baseline':
      return `Baseline (${runKind} runs)${brokered}`
    case 'granted':
      return `Granted by ${granterName(grant)} on ${onDate(grant.at)}${brokered}`
    case 'refused':
      return `Refused by ${granterName(grant)} on ${onDate(grant.at)}${brokered}`
    case 'never':
      return `Never granted${brokered}`
  }
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

      {/* ===========================================================================================
        * M45 R4. Above this line is what a simple row shows: who this worker is, what it is doing
        * in the domain's own word, and the three controls. Below it, every raw value -- the
        * provider kind, the gate, the profile's origin, the runtime-role members, the feed -- is
        * folded into a group, and a closed group renders nothing at all. The live feed is the
        * reason that matters here: it is the longest list on the page and nobody arriving to press
        * `pause` needs it rendered.
        * ======================================================================================= */}

      {/* The one group this panel leads with: what the current run is doing right now. The money
        * moved one group down, to Cost, so this line answers one question rather than two. */}
      <DetailsGroup group="run" title="Run" defaultOpen>
        <div className="flex items-center gap-3 font-mono text-xs text-text-2">
          <span data-testid="run-tool-calls">{slave.toolCalls} calls</span>
          {status === 'paused' && waitingFor === null && slave.pausedAtStep !== null && (
            <span data-testid="run-paused-step">paused at step {slave.pausedAtStep}</span>
          )}
          {waitingFor !== null && <span data-testid="run-waiting-step">waiting at step {slave.pausedAtStep ?? 0}</span>}
        </div>
      </DetailsGroup>

      {/* The provider chip in the header, expanded: the runtime's WORD, its raw kind in `title`,
        * and what its gate actually permits (spec §8 / Decision 8) with the raw gate in `title`.
        * `ShellOnlyMark` stays in the header rather than moving here -- spec §8 asks for that one
        * fact to be marked "wherever a worker's runtime is shown", and a mark behind a click is
        * not a mark. */}
      <DetailsGroup group="model" title="Model">
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
          <dt className="text-text-3">runtime</dt>
          <dd data-testid="model-provider" title={slave.provider ?? undefined} className="text-text-2">
            {providerLabel(slave.provider)}
          </dd>
          <dt className="text-text-3">tools</dt>
          <dd data-testid="model-gate" title={slave.gate ?? undefined} className="text-text-2">
            {slave.gate === null ? '—' : GATE_TEXT[slave.gate]}
          </dd>
        </dl>
      </DetailsGroup>

      {/* M37 §6. The persona a run is given, written only by its control verb, through the route
        * below. */}
      <DetailsGroup group="profile" title="Profile">
        <section data-testid="profile-block" className="flex flex-col gap-1">
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
      </DetailsGroup>

      {/* The card's own latest-skill chip, said in full. This is a LIVE fact about this run -- the
        * `summary` of its most recent `Skill` tool call (`server/overview.ts`) -- and not a list of
        * what this worker may use; that catalog is its own page. */}
      <DetailsGroup group="skills" title="Skills">
        <p className="text-xs text-text-2">
          <span data-testid="panel-skill" className="font-mono">{slave.skill ?? '—'}</span>
        </p>
        <p className="text-[10.5px] text-text-3">
          the latest skill this run used; the catalog is on{' '}
          <Link data-testid="panel-skill-catalog" href="/workforce?tab=skills" className="underline decoration-dotted hover:text-text-1">
            Workforce → Skills
          </Link>
        </p>
      </DetailsGroup>

      {/* M52 R7. The list is what a person needs at a glance; WHO decided and WHEN is a raw value,
        * so it lives under Advanced -- `docs/ia.md` rule 5, and `OverviewAdvanced`'s own rule that
        * a closed disclosure must cost nothing. NESTED rather than a sibling group, because the
        * sentences are about these six lines and nothing else on this panel.
        *
        * Every glyph here is `grantsFor`'s answer, computed server-side by the same function the
        * gate's own `permissions.json` is built by: this surface cannot claim a permission the hook
        * does not honour, because it is not deciding anything. */}
      <DetailsGroup group="permissions" title="Permissions">
        <ul className="flex flex-col gap-1">
          {slave.permissions.map((grant) => (
            <li
              key={grant.kind}
              data-testid={`panel-permission-${grant.kind}`}
              data-kind={grant.kind}
              data-mode={grant.mode ?? 'unset'}
              data-source={grant.source}
              title={grant.kind}
              className="flex items-baseline gap-2 text-xs"
            >
              <span aria-hidden className={GLYPH_CLASS[glyphFor(grant)]}>
                {GLYPH[glyphFor(grant)]}
              </span>
              {/* The glyph is `aria-hidden` -- a ✓ read aloud is noise -- so without this word all
                * six lines would have the SAME accessible name, the operation and nothing about
                * the answer. `PermissionMatrix` solves the identical problem on its cell with an
                * `aria-label`, for the identical reason: the visible content is one mark. */}
              <span data-testid="permission-mode-word" className="sr-only">
                {MODE_WORD[glyphFor(grant)]}
              </span>
              <span className="text-text-2">{PERMISSION_LABEL[grant.kind]}</span>
            </li>
          ))}
        </ul>
        <DetailsGroup group="advanced" title="Advanced">
          <ul className="flex flex-col gap-1">
            {slave.permissions.map((grant) => (
              <li key={grant.kind} className="flex flex-col text-[10.5px] text-text-3">
                <span className="text-text-2">{PERMISSION_LABEL[grant.kind]}</span>
                {/* The granter's `User.id` in `title`, never in the sentence (`docs/ia.md` rule 3
                  * -- the raw value stays reachable and no surface prints it as its visible text). */}
                <span
                  data-testid={`panel-permission-source-${grant.kind}`}
                  data-source={grant.source}
                  title={grant.by ?? undefined}
                >
                  {sourceSentence(grant, slave.permissionsRunKind)}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-[10.5px] text-text-3">
            an edit reaches this worker the next time a run starts or resumes, never one already in
            flight
          </p>
        </DetailsGroup>
      </DetailsGroup>

      {/* Messages holds BOTH writes, and the runtime roles belong here rather than ungrouped above:
        * an empty role set is precisely what makes a worker unreachable by a role-addressed message
        * (spec §7), so the mailbox and the roles that fill it read as one thing. */}
      <DetailsGroup group="messages" title="Messages">
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
      </DetailsGroup>

      {/* `—`, the mark the Roster already uses for unknown -- never `$0.00`, which claims a
        * measurement this run never made (spec Decision 6; M12 Task 9, ruling R3). */}
      <DetailsGroup group="cost" title="Cost">
        <span data-testid="run-cost" className="font-mono text-xs text-text-2">
          {formatUsd(slave.costUsd)}
        </span>
      </DetailsGroup>

      {/* The longest list on the page, and the one nobody arriving to press `pause` needs: a closed
        * group renders none of it. */}
      <DetailsGroup group="events" title="Events">
        <section className="flex flex-1 flex-col gap-1 overflow-y-auto">
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
      </DetailsGroup>
    </aside>
  )
}
