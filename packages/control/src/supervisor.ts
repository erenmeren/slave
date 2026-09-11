import { createHash } from 'node:crypto'
import { type Prisma, prisma } from '@slave-of-ai/db/client'
import {
  ANSWER_MAX_CHARS,
  COOLDOWN_MS,
  DECISION_RETENTION_MS,
  PENDING_TTL_MS,
  PROFILE_MAX_CHARS,
  PRUNE_BATCH,
  actionSchema,
  candidateSchema,
  draftSchema,
  neutraliseMarkers,
  promotionFor,
  situationSchema,
  type Action,
  type Candidate,
  type Decider,
  type DecisionStatus,
  type Draft,
  type Result,
  type Situation,
  type SituationKind,
  type Tier,
  err,
  ok,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { steerRun } from './breaker.js'
import { hireFromTemplate, materialiseCompanySlave, mergeRuntimeRoles } from './capability.js'
import { releaseWorker } from './lifecycle.js'
import { discardStaleCandidates, recordMemory } from './memory.js'
import { answerQuestion, reassignQuestion } from './messaging.js'
import { setRuntimeRoles } from './profile.js'
import type { Principal } from './principal.js'
import { refusalText, type ControlRefusal } from './refusal.js'
import { adoptRunbook } from './runbook.js'
import { cancelTask, failTask } from './task.js'
import { unblockTask } from './unblock.js'

/**
 * The name the Supervisor acts under inside a verb's PAYLOAD (`setRuntimeRoles`'s `actor`).
 *
 * Not the envelope actor, which is the closed `Actor` enum and has no `supervisor` member (spec
 * erratum E4): a Supervisor-applied verb stamps `'system'` there and this string in the payload,
 * so "who asked" survives without every reader of the log learning a fourth actor.
 */
const SUPERVISOR_ACTOR = 'supervisor'

/** How many decisions {@link listDecisions} returns when the caller names no limit -- a panel's
 *  worth of history, not the whole table. */
export const DEFAULT_DECISION_LIMIT = 50

/** The most {@link listDecisions} will return however large a `limit` a caller names (final review
 *  Minor 10). The CLI validates its `--limit`, but the web route and any other caller pass a number
 *  straight through, and an uncapped `take` turns one request into a read of the whole table. Ten
 *  panels' worth: far past anything a human scrolls, far short of a workspace's whole history. */
export const MAX_DECISION_LIMIT = 500

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

export interface RecordDecisionInput {
  readonly workspaceId: string
  readonly situation: Situation
  readonly candidates: readonly Candidate[]
  readonly chosenIndex: number
  readonly rationale: string
  readonly decidedBy: Decider
  /** `null` is UNMEASURED: charged at `SUPERVISOR_PER_CALL_CAP_USD` when spend is summed, but only
   *  when {@link RecordDecisionInput.modelCalled} says a call was actually made. */
  readonly modelCostUsd: number | null
  /**
   * Whether a model call was actually made for this decision (spec erratum E6).
   *
   * Optional, and it defaults to `decidedBy === 'model'` -- a model decision cannot have happened
   * without a call. The reason it is a separate input at all is the case that default gets WRONG:
   * a call that came back unusable (failed, an isolation breach, an answer that would not parse)
   * falls back to the rules, so the row honestly reads `decidedBy: 'rules'` while the money was
   * still spent. The orchestrator passes it explicitly for exactly that case.
   */
  readonly modelCalled?: boolean
  /**
   * The answer this decision drafted (M39 §2) -- `answer_question` only, and the thing a human
   * approves, edits or refuses. Validated with `draftSchema` before it is stored, the same
   * treatment the situation and the catalogue get: a `Json` column must never hold a shape the
   * panel, the CLI or {@link carryOut} cannot read.
   */
  readonly draft?: Draft
  /**
   * The FINAL tier, overriding the chosen candidate's (M39 §5).
   *
   * For `answer_question` alone. The catalogue stamps that action `proposed` -- the safe default a
   * rules-only pass would store, since a pass with no model wired has no draft to send -- and the
   * real tier is `answerTier({ sourced, critical, halted })`, which cannot be known until the
   * second model call has come back and its citations have been checked. `status` derives from the
   * override exactly as it derives from a candidate's tier, so an overridden `applied` is carried
   * out at birth and an overridden `escalated` waits for a human like any other proposal.
   *
   * Passing it for any other action THROWS (final review Minor 12) -- "answer_question only" is a
   * rule about which tiers may be bypassed, and a rule nothing checks is a comment.
   */
  readonly tier?: Tier
  /** The tick's clock. Injected so the cooldown window and `expiresAt` are computed against the
   *  same instant the caller observed the world at, rather than drifting a few milliseconds. */
  readonly now?: Date
}

/**
 * Writes one Supervisor decision down (M38 §4).
 *
 * The ONE way a `SupervisorDecision` row is born. Everything the decision was made on -- the
 * situation snapshot, the whole candidate catalogue, the index chosen and why -- is stored with
 * it, because a decision a human is asked to approve months later has to be readable without
 * re-deriving the world that produced it.
 *
 * `status` follows the TIER, which the rules fixed (spec §1, "tiers are fixed in code"):
 * `applied` and `noop` are terminal at birth -- the orchestrator carries the first out through
 * {@link applyDecision} immediately, the second is a deliberate nothing -- while `proposed` and
 * `escalated` become the one OPEN state, `pending`, with a deadline `PENDING_TTL_MS` out that
 * {@link expirePendingDecisions} retires it at.
 *
 * Idempotent and quiet (spec §1) by the same predicate `filterFresh` uses on the domain side, so
 * the two can never disagree about which keys are free: an open `pending` row for the key blocks a
 * new decision outright, and a decision that has stopped being open cools its key for
 * `COOLDOWN_MS` from `resolvedAt ?? createdAt` -- the `createdAt` fallback is what stops an
 * auto-applied row (which never gets a `resolvedAt`) from being re-decided on the very next tick.
 * Exactly `COOLDOWN_MS` old is STILL cooling, closed at that end, so a fixed clock cannot straddle
 * the boundary. `filterFresh` is the cheap first pass over a world already in memory; this is the
 * one that actually holds, because it reads and writes in the same transaction.
 */
export async function recordDecision(
  input: RecordDecisionInput,
): Promise<Result<{ readonly id: string; readonly tier: Tier; readonly status: DecisionStatus }, ControlRefusal>> {
  const now = input.now ?? new Date()
  // Validated against the domain's own schemas before anything is stored, so a `Json` column can
  // never hold a shape the readers (`listDecisions`, the world loader, the web panel) will choke
  // on. A failure here is a CALLER bug -- the orchestrator builds these from `observe`/`candidates`
  // -- not an operator's input, so it throws rather than becoming a refusal kind nobody can act on.
  const situation = parsedOrThrow(situationSchema.safeParse(input.situation), 'situation')
  const candidates = input.candidates.map((candidate, index) =>
    parsedOrThrow(candidateSchema.safeParse(candidate), `candidates[${String(index)}]`),
  )
  const chosen = candidates[input.chosenIndex]
  if (chosen === undefined) {
    throw new RangeError(
      `recordDecision: chosenIndex ${String(input.chosenIndex)} is outside a catalogue of ${String(candidates.length)}`,
    )
  }

  const draft = input.draft === undefined ? null : parsedOrThrow(draftSchema.safeParse(input.draft), 'draft')
  // The override is documented as `answer_question` only (M39 §5) and now enforced as such (final
  // review Minor 12). It is the ONE input that can turn a catalogue's `proposed` into a row that is
  // carried out at birth, and `answerTier` -- with the sourced check behind it -- is the only thing
  // entitled to do that. A caller that passed `tier: 'applied'` beside a `mark_task_failed` would
  // silently route around every tier the rules fixed, so this is loud, like the schema violations
  // above it: a programming error, not an operator's input.
  if (input.tier !== undefined && chosen.action.kind !== 'answer_question') {
    throw new TypeError(
      `recordDecision: a tier override is for answer_question only, not ${chosen.action.kind}`,
    )
  }
  const tier = input.tier ?? chosen.tier
  const status: DecisionStatus = tier === 'proposed' || tier === 'escalated' ? 'pending' : 'applied'
  const expiresAt = status === 'pending' ? new Date(now.getTime() + PENDING_TTL_MS) : null

  const outcome = await prisma.$transaction(async (tx) => {
    // ONE WRITER AT A TIME, on the project row (`setWorkspaceProvider`'s idiom). The uniqueness
    // this verb promises -- at most one open decision per situation key -- is a read followed by
    // an insert, and under READ COMMITTED nothing else serialises that pair: two overlapping ticks
    // would both read "no pending row" and both insert one, and the human would be asked the same
    // question twice. The lock is taken on `Workspace` because the row being serialised does not
    // exist yet, so there is nothing else to lock.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Workspace" WHERE id = ${input.workspaceId} FOR UPDATE`
    // A missing project is `workspace_not_found`, not `supervisor_disabled`: "there is no such
    // project" and "this project switched its Supervisor off" are different facts, and only the
    // second is something an operator can undo.
    if (locked.length === 0) {
      return { ok: false as const, error: { kind: 'workspace_not_found', workspaceId: input.workspaceId } as ControlRefusal }
    }
    const workspace = await tx.workspace.findUniqueOrThrow({
      where: { id: input.workspaceId },
      select: { supervisorEnabled: true },
    })
    if (!workspace.supervisorEnabled) {
      return { ok: false as const, error: { kind: 'supervisor_disabled', workspaceId: input.workspaceId } as ControlRefusal }
    }

    const key = { workspaceId: input.workspaceId, situationKind: situation.kind, subjectId: situation.subjectId }
    const open = await tx.supervisorDecision.findFirst({
      where: { ...key, status: 'pending' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, expiresAt: true },
    })
    if (open !== null) {
      // A human is already looking at this key. "Free again" is when the proposal stops being
      // open -- its own deadline -- rather than a cooldown that has not started counting yet.
      const until = open.expiresAt ?? new Date(open.createdAt.getTime() + COOLDOWN_MS)
      return { ok: false as const, error: cooldown(situation, until) }
    }
    const last = await tx.supervisorDecision.findFirst({
      where: key,
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, resolvedAt: true },
    })
    if (last !== null) {
      const anchor = last.resolvedAt ?? last.createdAt
      if (now.getTime() - anchor.getTime() <= COOLDOWN_MS) {
        return { ok: false as const, error: cooldown(situation, new Date(anchor.getTime() + COOLDOWN_MS)) }
      }
    }

    const row = await tx.supervisorDecision.create({
      data: {
        ...key,
        situation: situation as unknown as Prisma.InputJsonValue,
        candidates: candidates as unknown as Prisma.InputJsonValue,
        chosenIndex: input.chosenIndex,
        action: chosen.action as unknown as Prisma.InputJsonValue,
        // Omitted rather than written as a JSON null when there is no draft: the column is
        // nullable and `Prisma.DbNull` would need a value import of `Prisma` this module
        // deliberately does not take.
        ...(draft === null ? {} : { draft: draft as unknown as Prisma.InputJsonValue }),
        rationale: input.rationale,
        tier,
        status,
        decidedBy: input.decidedBy,
        modelCostUsd: input.modelCostUsd,
        modelCalled: input.modelCalled ?? input.decidedBy === 'model',
        // Written explicitly rather than left to the column default: `createdAt` is the cooldown
        // ANCHOR for a row that never resolves, so it has to be the clock the caller decided on.
        createdAt: now,
        expiresAt,
      },
      select: { id: true },
    })
    return { ok: true as const, id: row.id }
  })
  if (!outcome.ok) return err(outcome.error)

  // After the commit, not inside it: `appendEvent` owns its own transaction on the shared client
  // (it has to -- it serialises every append in the process onto one chain and NOTIFYs on commit),
  // so it cannot join the one above. Every verb in this package appends the same way.
  await appendEvent({
    type: 'supervisor.decided',
    workspaceId: input.workspaceId,
    actor: 'system',
    payload: {
      decisionId: outcome.id,
      situationKind: situation.kind,
      subjectId: situation.subjectId,
      tier,
      decidedBy: input.decidedBy,
      action: { kind: chosen.action.kind },
    },
  })
  if (status === 'pending' && expiresAt !== null) {
    // A second event for the pending ones only, so "what is waiting on me" is one filtered read of
    // the log rather than a scan of every decision the Supervisor has ever made.
    await appendEvent({
      type: 'supervisor.proposed',
      workspaceId: input.workspaceId,
      actor: 'system',
      payload: {
        decisionId: outcome.id,
        situationKind: situation.kind,
        subjectId: situation.subjectId,
        action: { kind: chosen.action.kind },
        expiresAt: expiresAt.toISOString(),
      },
    })
  }
  return ok({ id: outcome.id, tier, status })
}

const cooldown = (situation: Situation, until: Date): ControlRefusal => ({
  kind: 'supervisor_cooldown',
  situationKind: situation.kind,
  subjectId: situation.subjectId,
  untilTs: until.toISOString(),
})

/**
 * Carries a decision out through the existing control verbs (M38 §4).
 *
 * Called by the orchestrator for a decision whose tier is `applied`, and by
 * {@link approveDecision} for one a human said yes to. `origin` becomes the ENVELOPE actor of
 * whatever event the verb behind the action emits -- `'system'` for the Supervisor acting on its
 * own, `'human'` for an approval, which is what makes an approved staffing change read as a
 * person's act in the timeline rather than the machine's.
 *
 * NEVER throws on a refusal, and never leaves the row lying about what happened: a verb that says
 * no is recorded as `status: failed` with the refusal's own text and a `supervisor.failed` event,
 * and the refusal is then RETURNED. Both halves matter. The caller (a tick, or a human's approve)
 * has to see the refusal to report it; the row has to keep it so tomorrow's reader knows the
 * decision was made, attempted, and turned down by the world rather than never tried.
 *
 * `escalate_to_human` and `no_action` reach the world not at all, so they emit no
 * `supervisor.applied` either -- there is nothing to say was applied, and the decision row plus
 * its `supervisor.decided` event already say everything that happened. The two mailbox actions
 * (`answer_question`, `reassign_question`) are in the same position until M39 Task 2 gives them
 * their verbs.
 *
 * Deliberately does not check the row's status. A pending decision is claimed by
 * {@link approveDecision} before this is called, and the orchestrator calls it only for a row it
 * just recorded as `applied`; adding a second status gate here would duplicate that claim without
 * closing anything it does not already close.
 */
export async function applyDecision(
  decisionId: string,
  origin: 'human' | 'system',
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  const row = await prisma.supervisorDecision.findUnique({
    where: { id: decisionId },
    select: { workspaceId: true, action: true, situation: true, draft: true },
  })
  if (row === null) return err({ kind: 'decision_not_found', decisionId })
  const action = parsedOrThrow(actionSchema.safeParse(row.action), `SupervisorDecision ${decisionId}.action`)

  // The whole row the action came from, not the action alone: the mailbox arms need the drafted
  // answer and the decision's own id, and the staffing arm needs the situation the decision was
  // made on -- see {@link CarriedDecision}.
  const outcome = await carryOut(
    action,
    {
      id: decisionId,
      workspaceId: row.workspaceId,
      situation: parsedOrThrow(situationSchema.safeParse(row.situation), `SupervisorDecision ${decisionId}.situation`),
      draft: storedDraft(row.draft, `SupervisorDecision ${decisionId}.draft`),
    },
    origin,
    principal,
  )
  if (!outcome.ok) {
    const reason = refusalText(outcome.error)
    await prisma.supervisorDecision.update({ where: { id: decisionId }, data: { status: 'failed', failureReason: reason } })
    await appendEvent({
      type: 'supervisor.failed',
      workspaceId: row.workspaceId,
      actor: 'system',
      payload: { decisionId, action: { kind: action.kind }, reason },
      userId: principal?.userId ?? null,
    })
    return outcome
  }
  if (outcome.value === 'none') return ok(undefined)

  await appendEvent({
    type: 'supervisor.applied',
    workspaceId: row.workspaceId,
    actor: 'system',
    payload: { decisionId, action: { kind: action.kind } },
    userId: principal?.userId ?? null,
  })
  return ok(undefined)
}

/** Whether the action reached the world at all -- `'none'` is the pair (`escalate_to_human`,
 *  `no_action`) that deliberately does nothing, and gets no `supervisor.applied`. */
type Reach = 'applied' | 'none'

/**
 * The parts of the decision row an action is carried out FROM -- everything beyond the action
 * itself that a verb behind it needs.
 *
 * `situation` is what the staffing arm's delta-union reads its one role out of; `draft` is the
 * answer an `answer_question` decision sends and `id` is what its `draft_missing` refusal names.
 * Passed as the row rather than fetched again inside {@link carryOut} so there is exactly one read
 * of the decision per apply, and so the draft carried out is the draft
 * {@link approveDecision}'s edit just wrote.
 */
interface CarriedDecision {
  readonly id: string
  /** The project the decision was made for (M47). Read off the row {@link applyDecision} already
   *  fetched rather than looked up again: `hireFromTemplate` and `materialiseCompanySlave` are
   *  workspace-scoped verbs, and a second read would be a second chance for the two to disagree
   *  about which project a worker is joining. */
  readonly workspaceId: string
  readonly situation: Situation
  readonly draft: Draft | null
}

/** The whole map from the Supervisor's catalogue to this package's verbs. Every arm is an EXISTING
 *  verb: nothing here spawns a run, edits a repository or writes a prompt (spec §1). */
async function carryOut(
  action: Action,
  decision: CarriedDecision,
  origin: 'human' | 'system',
  principal?: Principal,
): Promise<Result<Reach, ControlRefusal>> {
  switch (action.kind) {
    case 'unblock_task':
      return reached(await unblockTask(action.taskId, { origin }, principal))
    case 'raise_max_attempts':
      // The same verb with its own escape hatch: `allowAnotherAttempt` raises the ceiling to
      // exactly `attempt + 1` in the same write that unblocks. There is no separate cap verb.
      return reached(await unblockTask(action.taskId, { allowAnotherAttempt: true, origin }, principal))
    case 'set_runtime_roles':
      return reached(await addRuntimeRoles(action.slaveId, roleDelta(action, decision.situation), origin))
    case 'assign_capability':
      // The UNION, like `set_runtime_roles` (spec §4): the worker keeps every role it holds and
      // gains the one this capability projects to. A proposal can wait a day, and a role granted
      // meanwhile must not be taken back by an approval.
      //
      // Through `mergeRuntimeRoles`, not M38's `addRuntimeRoles` (fix round 1, Important 1): this
      // is the first runtime-role write a TICK makes by itself, and the read has to be inside the
      // lock the write takes or a concurrent `setSlaveCapabilities` loses a role to it.
      return reached(await mergeRuntimeRoles(action.slaveId, [action.role], SUPERVISOR_ACTOR, origin))
    case 'materialise_company_worker':
      // The rationale the rules wrote, verbatim -- `formTeam`'s sentence names the capability in
      // the taxonomy's WORDS ("Application security"), and that sentence is what the Organization
      // view shows beside the worker months later (fix round 1, Minor 5).
      return reached(
        await materialiseCompanySlave(decision.workspaceId, action.companySlaveId, { rationale: action.rationale }),
      )
    case 'hire_from_catalog':
      // M50 R2, fix round 1 (Minor 8). `actionOf` never produces this pair, so a temporary hire
      // with no assignment is a decision recorded by an older build or edited by hand. It is
      // carried out as an ORDINARY hire rather than refused -- the capability gap is real either
      // way -- and the downgrade says so out loud, because the worker it makes is one
      // `engagement_over` can never raise.
      if (action.temporary && action.engagementTaskId === null) {
        console.warn('[supervisor] temporary hire without an engagement -- hired as a project worker')
      }
      return reached(
        await hireFromTemplate(decision.workspaceId, action.templateId, {
          capabilities: [action.capability],
          rationale: action.rationale,
          // M50 R2: both together or neither. A temporary hire without its assignment is a worker
          // nothing can release, which is the promise this milestone exists to keep.
          ...(action.temporary && action.engagementTaskId !== null
            ? { temporary: true, engagementTaskId: action.engagementTaskId }
            : {}),
        }),
      )
    case 'mark_task_failed':
      return reached(await failTask(action.taskId, action.reason, origin, principal))
    case 'answer_question':
      return reached(await sendDraftedAnswer(action.messageId, decision, origin, principal))
    case 'reassign_question':
      return reached(
        await reassignQuestion(action.messageId, action.toSlaveId, SUPERVISOR_ACTOR, origin, principal, decision.id),
      )
    case 'cancel_task':
      // M40 §4. `tierOf` pins this to `proposed` on every branch (ruling R1), so the only way here
      // is a human approving the proposal `concludeReplan` recorded -- a cancellation is never
      // automatic. `cancelTask` re-checks the status under its own row lock, so a task the pipeline
      // picked up while the proposal waited is refused rather than cancelled out from under a run.
      return reached(await cancelTask(action.taskId, action.reason, origin, principal))
    case 'adopt_runbook': {
      // `tierOf` pins this to `proposed` on every branch (R5), so the only way here is a human
      // approving the proposal -- which is the whole ruling: the Supervisor recommends, a person
      // adopts. Addressed by KEY rather than by id, so a decision that waited a day through a
      // re-seed still names the runbook a person read the name of.
      //
      // A DIFFERENT runbook already adopted is a refusal, not an overwrite (M48 final wave, Task 4
      // ruling). A proposal may wait a day, and in that day somebody can choose a way of working
      // for this project; `adoptRunbook` would cheerfully replace it, so a stale Approve would undo
      // a person's own decision with no record of what it displaced. Refused, which
      // {@link applyDecision} turns into `status: 'failed'` with both keys in `failureReason` and a
      // `supervisor.failed` event -- the outcome a reader can act on. Re-adopting the SAME key is
      // not refused: that is the proposal being carried out, and `adoptRunbook` answers
      // `changed: false` for it.
      const current = await prisma.workspace.findUnique({
        where: { id: decision.workspaceId },
        select: { runbook: { select: { key: true } } },
      })
      const adopted = current?.runbook?.key ?? null
      if (adopted !== null && adopted !== action.key) {
        return err({ kind: 'runbook_already_adopted', adopted, proposed: action.key })
      }
      return reached(await adoptRunbook(decision.workspaceId, action.key, { origin }, principal))
    }
    case 'discard_stale_candidates':
      // M49 R2. `tierOf` pins this to `proposed` on every branch, so the only way here is a human
      // approving the proposal -- which is the ruling: workers report, and a person decides what
      // counts. Nothing is deleted; every row keeps the words it was written with and the reason
      // it was withdrawn, and each move is a `memory.changed` on the timeline.
      //
      // `action.count` is what the world counted when the proposal was RECORDED and is not passed
      // on: the verb withdraws whatever is stale at the moment it runs, which after a day's wait
      // is the honest set.
      return reached(ok(await discardStaleCandidates(action.workspaceId, new Date(), principal)))
    case 'release_worker':
      // M50 R3, the routine the milestone is named for. `tierOf` makes this `applied` on an
      // unhalted project, so this arm runs inside a TICK -- which is exactly why `releaseWorker`
      // skips and counts a worktree it could not remove instead of throwing.
      return reached(await releaseWorker(action.slaveId, action.reason, principal, origin))
    case 'steer_run':
      // M51 R3. `tierOf` makes this `applied` on an unhalted project, so this arm runs inside a
      // TICK -- which is why `steerRun` returns a refusal for a run that moved under it rather than
      // throwing, and why that refusal is an ordinary `failed` decision a person can read rather
      // than a crashed pass.
      //
      // `action.text` verbatim: it was built by `candidates.ts` from `steerTextFor(trip)`, a
      // constant with one integer in it, and it is stored on the decision so a reader months later
      // can see what was actually said. Nothing re-derives it here -- re-deriving would mean a row
      // could claim one sentence and the worker receive another.
      //
      // The `try` (fix round 1, Important 6) is the same promise the sweep makes around its own
      // breaker call, made at the other caller: `steerRun` -> `requestPause` -> `runFilePaths`
      // THROWS when the workspace's repo path cannot be stat'd or a run directory cannot be created
      // under it, and neither `applyDecision` nor the orchestrator's call site has a `try`. An
      // escape here takes the whole Supervisor pass down and leaves this decision reading `applied`
      // with no `supervisor.applied` event to match it. `pause_unsignalled` is the honest kind: the
      // pause is exactly what could not be performed, and its `refusalText` carries the error's own
      // message onto `failureReason`, where a person can act on it.
      try {
        return reached(await steerRun(action.runId, action.text, principal))
      } catch (error) {
        return err({
          kind: 'pause_unsignalled',
          runId: action.runId,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    case 'escalate_to_human':
    case 'no_action':
      return ok('none')
  }
}

/** `unknown` rather than `void` because the mailbox verbs return what they wrote: what `carryOut`
 *  needs from any of them is only whether the world moved. */
const reached = (result: Result<unknown, ControlRefusal>): Result<Reach, ControlRefusal> =>
  result.ok ? ok('applied') : err(result.error)

/**
 * The ONE place a model's words reach a worker (spec §1), and the three things that stand between
 * them and it.
 *
 * A human's EDIT wins over the model's text whenever there is one: that is what approving with an
 * edit means, and the model's original stays on the row beside it so a reader can see both.
 *
 * `draft_missing` only when there is NOTHING to send -- no draft at all, or a draft whose two
 * bodies are both absent. The order matters (fix round 1): erratum E2's escalated draft is exactly
 * `{ body: null, … }`, written when the critical lexicon matched and no answer call was ever made,
 * and a human MAY answer a critical question by typing into that draft. Testing `body` before
 * consulting `editedBody` would refuse the one shape this path exists for, after the approval had
 * already claimed the row.
 *
 * Then `neutraliseMarkers` and the cap, in that order. Neutralising is what stops an answer from
 * carrying the section markers a run context is assembled from into a worker's prompt, and it can
 * make the text no shorter, so the cap is measured on what would actually be sent. Over it, the
 * answer is REFUSED rather than truncated: a half-sentence answer to a worker that cannot continue
 * without one is worse than the refusal a human can act on. `ANSWER_MAX_CHARS` also bounds both
 * bodies in `draftSchema`, so only a human edit written straight into the column, or a neutralising
 * that grew the text past the line, can reach this.
 */
async function sendDraftedAnswer(
  messageId: string,
  decision: CarriedDecision,
  origin: 'human' | 'system',
  principal?: Principal,
): Promise<Result<unknown, ControlRefusal>> {
  const written = sendableBody(decision.draft)
  if (written === null) return err({ kind: 'draft_missing', decisionId: decision.id })
  const body = neutraliseMarkers(written)
  if (body.length > ANSWER_MAX_CHARS) return err({ kind: 'invalid_message_body' })
  return answerQuestion(
    messageId,
    { body, answeredBy: SUPERVISOR_ACTOR, ...(principal === undefined ? {} : { principal }) },
    origin,
  )
}

/** The text a draft would actually send, or null when it would send nothing -- a human's edit
 *  first, the model's own body behind it. The ONE definition of "this answer decision has a body",
 *  shared by {@link sendDraftedAnswer} and {@link approveDecision}'s pre-claim check so the two can
 *  never disagree about a row (fix round 1). */
const sendableBody = (draft: Draft | null): string | null => draft?.editedBody ?? draft?.body ?? null

/**
 * The roles a `set_runtime_roles` decision actually adds (spec §4, the M38 residual).
 *
 * The stored `roles` array is the whole set the rules computed AT DECISION TIME -- the slave's own
 * roles plus the missing one. {@link addRuntimeRoles} unions it with what the slave holds now, so
 * nothing granted meanwhile is lost; what the union CANNOT undo is a role the operator deliberately
 * REVOKED while the proposal waited, because the stale array still carries it and the union puts it
 * straight back. The situation names the one role the decision was actually about (`observe.ts`
 * writes `facts.role` for `no_reviewer`, `no_planner` and `ready_unstaffed`), so that is what is
 * added and nothing else: approving "give Maya reviewer" grants reviewer, never re-grants backend.
 *
 * The stored array is the fallback, unchanged M38 behaviour, for a situation that names no role --
 * there is nothing more precise to use, and dropping the arm entirely would make the approval a
 * no-op.
 */
function roleDelta(
  action: Extract<Action, { kind: 'set_runtime_roles' }>,
  situation: Situation,
): readonly string[] {
  const role = situation.facts['role']
  return typeof role === 'string' && role !== '' ? [role] : action.roles
}

/**
 * `set_runtime_roles`, applied as a UNION rather than the replacement `setRuntimeRoles` performs
 * (spec §4 clarification, final review Important 1).
 *
 * The decision row stores the roles the rules computed AT DECISION TIME -- `[...slave.runtimeRoles,
 * role]` in `candidates.ts`. A proposal may then sit `pending` for up to `PENDING_TTL_MS` (a day),
 * and `setRuntimeRoles` is documented as "a replacement, not a merge": writing that stale array
 * verbatim silently takes back every role an operator granted in the meantime. Approving "give
 * Maya reviewer" must never be able to remove `frontend` from her.
 *
 * So the slave is RE-READ here and the write is its CURRENT set first, then whatever the proposal
 * adds that it does not already hold. Every other arm re-validates at apply time through the verb
 * it calls; this is that check for this one. The read is outside `setRuntimeRoles`' own locked
 * transaction, so a role granted in the microseconds between the two could still be lost -- a
 * proposal that is a day old is the case that matters, and closing the last microsecond would mean
 * a merge mode on the operator-facing verb whose whole contract is that it replaces.
 *
 * `slave_not_found` when the worker is gone, which is the same refusal `setRuntimeRoles` would
 * have produced for the same row.
 *
 * `already_released` when the engagement ended while the proposal waited (M50 final review,
 * Important 1). This is the same staleness the union exists for, one step further on: a release
 * writes `runtimeRoles = []` and is PERMANENT, so an approval landing after it would put a
 * released worker back on the board with nothing able to take the role off again. The guard sits
 * HERE, on the Supervisor's own path, and not inside `setRuntimeRoles`: re-arming a released worker
 * by hand is deliberate (`lifecycle.ts`), and the operator-facing verb must keep doing it.
 * `mergeRuntimeRoles` makes the same refusal under its row lock for `assign_capability`.
 */
async function addRuntimeRoles(
  slaveId: string,
  adds: readonly string[],
  origin: 'human' | 'system',
): Promise<Result<void, ControlRefusal>> {
  const slave = await prisma.slave.findUnique({
    where: { id: slaveId },
    select: { runtimeRoles: true, releasedAt: true },
  })
  if (slave === null) return err({ kind: 'slave_not_found', slaveId })
  if (slave.releasedAt !== null) {
    return err({ kind: 'already_released', slaveId, at: slave.releasedAt.toISOString() })
  }
  const union = [...slave.runtimeRoles]
  for (const role of adds) if (!union.includes(role)) union.push(role)
  return setRuntimeRoles(slaveId, union, SUPERVISOR_ACTOR, origin)
}

/**
 * A human says yes to a pending proposal (M38 §4).
 *
 * The row is CLAIMED before the action is carried out -- one `updateMany` conditional on the
 * status still being `pending`, which is the only thing that makes a double-approve impossible.
 * Applying first and marking after would leave the row `pending` for the whole length of the verb,
 * and a second approver arriving in that window would run the same action twice (raise the cap
 * twice, fail an already-failed task). The observable end states are the ones the spec asks for
 * either way: `approved` when the verb went through, and `failed` with the refusal text when it
 * did not -- {@link applyDecision} writes that over this claim -- with `resolvedAt` and
 * `resolvedByUserId` recorded in both cases, because a human DID resolve it either way.
 *
 * No `supervisor.resolved` on a refusal: `supervisor.failed` is the truer event there, and saying
 * "resolved: approved" about an action the world turned down would be the log's only lie.
 *
 * The `supervisor.resolved` this emits is the ONE `supervisor.*` event whose envelope actor is not
 * `system` (fix round 1): a person resolved this, and that is what the log should say -- whether
 * or not the caller could name WHICH person. `principal?` follows the M23 F6 convention every
 * other verb in this package uses (`unblockTask`, `setRuntimeRoles`, …): accepted, optional, and
 * its `userId`, if any, rides the event (fix round 2 -- a CLI call, which has no session, passes
 * none, and the row's `resolvedByUserId` and the event's `userId` are honestly `null` rather than
 * a name borrowed from a local account that did not actually act). The verb the approval applies
 * already runs with `origin: 'human'` for the same reason. `expirePendingDecisions` keeps
 * `system`, because nobody acted there.
 *
 * `edit` (M39 §4) is the answer path's one addition: a human approving an `answer_question`
 * proposal may send their own words instead of the model's, recorded on the row as
 * `draft.editedBody` before the apply reads it back. It is how a human answers a question the
 * Supervisor would not answer itself -- a critical one, whose draft (erratum E2) has no body at all
 * until somebody types one. Every reason an approval could be refused is established BEFORE
 * {@link claimPending} runs, so a refused approval leaves the proposal exactly as open as it found
 * it (fix round 1).
 */
export async function approveDecision(
  decisionId: string,
  principal?: Principal,
  edit?: { readonly body: string },
): Promise<Result<void, ControlRefusal>> {
  // Everything this approval can be refused for is checked BEFORE the row is claimed -- with an
  // edit AND without one (fix round 1): a refusal must not consume the one pending decision a human
  // was about to resolve properly, and an answer decision with nothing to send would otherwise be
  // claimed, marked `approved`, and then rewritten `failed` by the apply.
  const loaded = await answerDraft(decisionId)
  if (!loaded.ok) return loaded

  let edited: Draft | null = null
  if (edit !== undefined) {
    // An edit only means anything on an answer decision that has a draft to edit: there is no
    // rewriting an `unblock_task`. A draft whose `body` is null is editable -- that is E2's
    // escalated shape, and typing into it is exactly how a human answers a critical question.
    if (loaded.value === 'not_an_answer' || loaded.value === null) return err({ kind: 'draft_missing', decisionId })
    if (edit.body.trim() === '' || edit.body.length > ANSWER_MAX_CHARS) return err({ kind: 'invalid_message_body' })
    edited = { ...loaded.value, editedBody: edit.body }
  } else if (loaded.value !== 'not_an_answer' && sendableBody(loaded.value) === null) {
    // A plain yes to an answer decision that carries no text to send: nothing would reach the
    // worker, so the proposal stays open for a human who has something to type.
    return err({ kind: 'draft_missing', decisionId })
  }

  const claim = await claimPending(decisionId, {
    status: 'approved',
    resolvedAt: new Date(),
    resolvedByUserId: principal?.userId ?? null,
  })
  if (!claim.ok) return claim

  if (edited !== null) {
    // Written after the claim and before the apply, so the draft {@link applyDecision} reads back
    // is the edited one -- and so a human who lost the race to another approver has not rewritten a
    // draft somebody else already sent. `body` is left exactly as the model wrote it: the row keeps
    // both texts, which is what makes "the Supervisor said this, the human sent that" readable.
    await prisma.supervisorDecision.update({
      where: { id: decisionId },
      data: { draft: edited as unknown as Prisma.InputJsonValue },
    })
  }

  const applied = await applyDecision(decisionId, 'human', principal)
  if (!applied.ok) return applied

  await appendEvent({
    type: 'supervisor.resolved',
    workspaceId: claim.value.workspaceId,
    // `human`, unlike the rest of the `supervisor.*` events (fix round 1). An approval is a
    // PERSON's act -- the one moment in a proposal's life the Supervisor did not author -- and the
    // envelope actor is what every reader of the log filters on, whether or not `userId` can name
    // which person (fix round 2). `resolvedByUserId` keeps the same fact on the row. Only an
    // EXPIRY stays `system`: nobody acted there, which is the whole fact it records.
    actor: 'human',
    payload: { decisionId, outcome: 'approved', reason: null },
    userId: principal?.userId ?? null,
  })

  // M49 R2(c): a person decided something, and what they decided is knowledge this project keeps.
  // AFTER the apply and after the event, and never inside them: a memory that could not be written
  // must not undo an approval that already reached the world (plan decision D9).
  await rememberDecision(decisionId, 'approved', null, principal)
  return ok(undefined)
}

/**
 * A human says no (M38 §4). The action is never carried out -- the whole point of a proposal is
 * that it does not reach the world until someone agrees. `reason` is the rejecting human's words,
 * trimmed, and `null` when there are none; it is what makes a rejection readable later, and (from
 * M39 on) what a Supervisor can learn a project's preferences from.
 */
export async function rejectDecision(
  decisionId: string,
  principal?: Principal,
  reason?: string,
): Promise<Result<void, ControlRefusal>> {
  const trimmed = reason?.trim()
  const claim = await claimPending(decisionId, {
    status: 'rejected',
    resolvedAt: new Date(),
    resolvedByUserId: principal?.userId ?? null,
  })
  if (!claim.ok) return claim

  await appendEvent({
    type: 'supervisor.resolved',
    workspaceId: claim.value.workspaceId,
    // A person's act, like an approval -- see {@link approveDecision} for why this one event
    // departs from the `system` actor the other `supervisor.*` events carry, and for why `userId`
    // may honestly be null (fix round 2).
    actor: 'human',
    payload: { decisionId, outcome: 'rejected', reason: trimmed === undefined || trimmed === '' ? null : trimmed },
    userId: principal?.userId ?? null,
  })

  // M49 R2(c), the same hook as an approval's: a rejection is a decision too, and the reason a
  // person gave for it is the part a later plan most needs to read.
  await rememberDecision(decisionId, 'rejected', trimmed === undefined || trimmed === '' ? null : trimmed, principal)
  return ok(undefined)
}

/**
 * Records what a person decided (M49 R2c).
 *
 * Only {@link approveDecision} and {@link rejectDecision} call it -- {@link resolveSettledDecisions}
 * does NOT (plan erratum E3): it claims every pending row of one situation kind for a SINGLE human
 * act and carries the caller's sentence rather than any decision's own rationale, so promoting
 * there would write N identical memories for one click.
 *
 * Never throws: a decision that reached the world is a decision, whatever the memory write did.
 */
async function rememberDecision(
  decisionId: string,
  outcome: 'approved' | 'rejected',
  reason: string | null,
  principal?: Principal,
): Promise<void> {
  try {
    const row = await prisma.supervisorDecision.findUnique({
      where: { id: decisionId },
      select: { workspaceId: true, rationale: true, situation: true, workspace: { select: { goalVersion: true } } },
    })
    if (row === null) return
    const situation = situationSchema.safeParse(row.situation)
    const fact = situation.success ? situation.data.facts['taskId'] : null
    const taskId = typeof fact === 'string' && fact !== '' ? fact : null
    const draft = promotionFor({
      kind: 'decision_resolved',
      workspaceId: row.workspaceId,
      decisionId,
      outcome,
      rationale: row.rationale,
      reason,
      userId: principal?.userId ?? null,
      taskId,
      goalVersion: row.workspace.goalVersion,
    })
    if (draft === null) return
    const written = await recordMemory(draft, principal)
    if (!written.ok) console.warn(`[memory] a resolved decision was not remembered: ${refusalText(written.error)}`)
  } catch (error) {
    console.warn(`[memory] a resolved decision was not remembered: ${String(error)}`)
  }
}

/**
 * What an approval of this decision would be answering FROM: the row's draft, `null` when it is an
 * answer decision carrying none, and `'not_an_answer'` for every other action -- which is not a
 * problem at all, only a decision an edit means nothing to.
 *
 * One read, three answers, so {@link approveDecision} can decide both of its branches before it
 * claims anything. `decision_not_found` is the only refusal it raises: whether the row is still
 * open is {@link claimPending}'s question, asked separately and answered with its own kind.
 */
async function answerDraft(decisionId: string): Promise<Result<Draft | null | 'not_an_answer', ControlRefusal>> {
  const row = await prisma.supervisorDecision.findUnique({
    where: { id: decisionId },
    select: { action: true, draft: true },
  })
  if (row === null) return err({ kind: 'decision_not_found', decisionId })
  const action = parsedOrThrow(actionSchema.safeParse(row.action), `SupervisorDecision ${decisionId}.action`)
  if (action.kind !== 'answer_question') return ok('not_an_answer')
  return ok(storedDraft(row.draft, `SupervisorDecision ${decisionId}.draft`))
}

/** The one atomic "take this pending decision" both {@link approveDecision} and
 *  {@link rejectDecision} open with: the read is only for the refusal's wording, the `updateMany`
 *  conditional on `status: 'pending'` is what actually decides who won. */
async function claimPending(
  decisionId: string,
  data: { readonly status: DecisionStatus; readonly resolvedAt: Date; readonly resolvedByUserId: string | null },
): Promise<Result<{ readonly workspaceId: string }, ControlRefusal>> {
  const row = await prisma.supervisorDecision.findUnique({
    where: { id: decisionId },
    select: { workspaceId: true, status: true },
  })
  if (row === null) return err({ kind: 'decision_not_found', decisionId })
  if (row.status !== 'pending') return err({ kind: 'decision_not_pending', decisionId, status: row.status })

  const claimed = await prisma.supervisorDecision.updateMany({ where: { id: decisionId, status: 'pending' }, data })
  if (claimed.count === 0) {
    // Lost the race to another approve, another reject, or the expiry sweep. Re-read rather than
    // guess which, the way `unblockTask` re-reads its own lost claim.
    const current = await prisma.supervisorDecision.findUnique({ where: { id: decisionId }, select: { status: true } })
    if (current === null) return err({ kind: 'decision_not_found', decisionId })
    return err({ kind: 'decision_not_pending', decisionId, status: current.status })
  }
  return ok({ workspaceId: row.workspaceId })
}

/**
 * Retires every OPEN decision about one situation kind because a person has settled the question
 * somewhere else (M48 final wave, Task 4 ruling).
 *
 * A proposal waits `PENDING_TTL_MS` -- a whole day -- and in that day the thing it asks about can
 * be decided by hand. `adoptRunbook` is the case this exists for: the Supervisor proposes "follow
 * Feature delivery", the operator adopts Bug fix from the CLI or the Overview picker, and without
 * this the proposal sits there for another twenty-three hours with an Approve button that would
 * silently swap the project's way of working out from under the choice a person just made.
 *
 * `rejected`, not `approved`, and the wording of the reason is what makes that honest: the action
 * on the row was never carried out -- {@link applyDecision} was not called, and whatever happened
 * to the world happened through the verb a person used directly. "The proposal was not taken up"
 * is exactly what `rejected` means here, and `reason` says who took the question away from it.
 *
 * Claimed conditionally per row, {@link claimPending}'s rule: a human approving in the same instant
 * wins the row and is not counted here. Returns how many were retired, for a caller that reports it.
 */
export async function resolveSettledDecisions(input: {
  readonly workspaceId: string
  readonly situationKind: SituationKind
  readonly reason: string
  readonly principal?: Principal
}): Promise<number> {
  const open = await prisma.supervisorDecision.findMany({
    where: { workspaceId: input.workspaceId, situationKind: input.situationKind, status: 'pending' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })

  let resolved = 0
  for (const row of open) {
    const claimed = await prisma.supervisorDecision.updateMany({
      where: { id: row.id, status: 'pending' },
      data: { status: 'rejected', resolvedAt: new Date(), resolvedByUserId: input.principal?.userId ?? null },
    })
    if (claimed.count === 0) continue
    resolved += 1
    await appendEvent({
      type: 'supervisor.resolved',
      workspaceId: input.workspaceId,
      // A PERSON's act, exactly as an approval or a rejection is (see {@link approveDecision} for
      // why this one event departs from the `system` actor): they answered the question by doing
      // the thing, and the log should say a human closed it.
      actor: 'human',
      payload: { decisionId: row.id, outcome: 'rejected', reason: input.reason },
      userId: input.principal?.userId ?? null,
    })
  }
  return resolved
}

/**
 * Retires the proposals nobody answered (M38 §5), at the top of every tick.
 *
 * A proposal that sat for `PENDING_TTL_MS` is not a question anyone is going to answer, and
 * leaving it open would block its situation key forever -- the Supervisor would never look at that
 * task again. Expiring it re-opens the key after the ordinary cooldown, so the situation, if it is
 * still real, is decided afresh.
 *
 * Returns how many it retired, for the tick's report. Each row is claimed conditionally, so a
 * human approving in the same instant wins the row and is not counted here.
 */
export async function expirePendingDecisions(workspaceId: string, now: Date): Promise<number> {
  const due = await prisma.supervisorDecision.findMany({
    where: { workspaceId, status: 'pending', expiresAt: { lte: now } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })

  let expired = 0
  for (const row of due) {
    const claimed = await prisma.supervisorDecision.updateMany({
      where: { id: row.id, status: 'pending' },
      data: { status: 'expired', resolvedAt: now },
    })
    if (claimed.count === 0) continue
    expired += 1
    await appendEvent({
      type: 'supervisor.resolved',
      workspaceId,
      actor: 'system',
      // No `resolvedByUserId` and no `userId`: nobody resolved this one, which is the whole fact
      // an expiry records.
      payload: { decisionId: row.id, outcome: 'expired', reason: null },
    })
  }
  return expired
}

/**
 * Deletes the decisions nobody will read again (M39 §2), on every supervised tick.
 *
 * A `SupervisorDecision` is an audit record, and a FREE audit record that is older than
 * `DECISION_RETENTION_MS` (thirty days) has outlived every question it can answer: the situation it
 * describes has long since moved, and the panel and the CLI both read a window far shorter than
 * that. Left alone the table grows without limit -- the Supervisor writes one row per stuck
 * situation per cooldown, forever.
 *
 * THREE boundaries this never crosses, and the third is the one the final review found missing
 * (erratum E7):
 * - PENDING rows are never pruned however old they are: a proposal still waiting on a human is the
 *   one thing in this table that is not history, and {@link expirePendingDecisions} -- which runs
 *   first on every tick -- is what retires those.
 * - The age is measured from `resolvedAt ?? createdAt`, the same anchor the cooldown uses, so a row
 *   that was applied at birth (and therefore never resolved) ages from when it was written.
 * - **A row with `modelCalled` is never pruned, whatever its status or age.** These rows ARE the
 *   Supervisor's spend: `workspaceSpend` (`./spend.ts`) sums `modelCostUsd` and counts the
 *   unmeasured calls over every decision row in the project with NO time window, so deleting one
 *   erases money that was really spent. A workspace halted by its budget guardrail would have
 *   watched its recorded spend fall month by month until the halt lifted itself. Storage is not the
 *   argument against keeping them: a call costs money, so cost-bearing rows are exactly the ones a
 *   workspace produces slowly.
 *
 * Bounded to `PRUNE_BATCH` rows per call, oldest first, and deleted by id in one `deleteMany`: a
 * tick must not turn into an unbounded delete over a table nobody has pruned for a year. A backlog
 * simply takes several ticks to drain. Returns how many rows actually went, for the tick's report.
 */
export async function pruneDecisions(workspaceId: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - DECISION_RETENTION_MS)
  const due = await prisma.supervisorDecision.findMany({
    where: {
      workspaceId,
      status: { not: 'pending' },
      modelCalled: false,
      // Ruling R2: BOTH columns, not just the flag. `modelCalled` and `modelCostUsd` are written
      // together, so a row with a cost and no call is hand-edited or wrong -- and the money on it
      // is still money `workspaceSpend` sums with no time window. Reading the cost too means a
      // recorded cost survives retention whatever the flag beside it says.
      modelCostUsd: null,
      OR: [{ resolvedAt: { lt: cutoff } }, { resolvedAt: null, createdAt: { lt: cutoff } }],
    },
    orderBy: { createdAt: 'asc' },
    take: PRUNE_BATCH,
    select: { id: true },
  })
  if (due.length === 0) return 0

  // By id, and conditional on the status AND `modelCalled` again: a human approving one of these
  // in the microseconds between the read and the delete keeps their row, and so does a row that
  // somehow acquired a cost in the same window.
  const deleted = await prisma.supervisorDecision.deleteMany({
    where: {
      id: { in: due.map((row) => row.id) },
      status: { not: 'pending' },
      modelCalled: false,
      modelCostUsd: null,
    },
  })
  return deleted.count
}

/** One decision as a reader sees it: every `Json` column parsed back into its domain shape, every
 *  instant an ISO string, so a web route can serialise it unchanged. */
export interface DecisionView {
  readonly id: string
  readonly workspaceId: string
  readonly situationKind: SituationKind
  readonly subjectId: string
  readonly situation: Situation
  readonly candidates: readonly Candidate[]
  readonly chosenIndex: number
  readonly action: Action
  /** The drafted answer an `answer_question` decision carries (M39 §2) -- the body, its citations,
   *  the critical signals, and a human's edit once there is one. Null for every other action. */
  readonly draft: Draft | null
  readonly rationale: string
  readonly tier: Tier
  readonly status: DecisionStatus
  readonly decidedBy: Decider
  readonly modelCostUsd: number | null
  /** Whether a model call was made -- true even on a rules row whose call came back unusable
   *  (erratum E6). `modelCalled && modelCostUsd === null` is what `workspaceSpend` charges at the
   *  per-call cap. */
  readonly modelCalled: boolean
  readonly failureReason: string | null
  readonly createdAt: string
  readonly expiresAt: string | null
  readonly resolvedAt: string | null
}

/** The project's decisions, newest first -- the web panel's and the CLI's read side. `pending`
 *  narrows it to what is waiting on a human. */
export async function listDecisions(
  workspaceId: string,
  opts?: { readonly pending?: boolean; readonly limit?: number },
): Promise<readonly DecisionView[]> {
  const rows = await prisma.supervisorDecision.findMany({
    where: { workspaceId, ...(opts?.pending === true ? { status: 'pending' as const } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(opts?.limit ?? DEFAULT_DECISION_LIMIT, MAX_DECISION_LIMIT),
  })
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspaceId,
    situationKind: row.situationKind,
    subjectId: row.subjectId,
    situation: parsedOrThrow(situationSchema.safeParse(row.situation), `SupervisorDecision ${row.id}.situation`),
    candidates: storedCandidates(row.candidates, `SupervisorDecision ${row.id}.candidates`),
    chosenIndex: row.chosenIndex,
    action: parsedOrThrow(actionSchema.safeParse(row.action), `SupervisorDecision ${row.id}.action`),
    draft: storedDraft(row.draft, `SupervisorDecision ${row.id}.draft`),
    rationale: row.rationale,
    tier: row.tier,
    status: row.status,
    decidedBy: row.decidedBy,
    modelCostUsd: row.modelCostUsd,
    modelCalled: row.modelCalled,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  }))
}

/** A `draft` column read back into its domain shape, or null when the row carries none -- which is
 *  every action but `answer_question`. A stored draft that will not parse is the same caller bug
 *  {@link parsedOrThrow} exists for: only `recordDecision` and {@link approveDecision} write it. */
function storedDraft(value: unknown, what: string): Draft | null {
  if (value === null || value === undefined) return null
  return parsedOrThrow(draftSchema.safeParse(value), what)
}

/** `candidateSchema` one entry at a time rather than `z.array(...)`: this package does not depend
 *  on zod, so the array combinator is not reachable here -- only the schemas the domain exports. */
function storedCandidates(value: unknown, what: string): Candidate[] {
  if (!Array.isArray(value)) throw new TypeError(`supervisor: ${what} is not an array`)
  return value.map((entry, index) => parsedOrThrow(candidateSchema.safeParse(entry), `${what}[${String(index)}]`))
}

/**
 * Reads a validated value or fails loudly.
 *
 * On the way IN this catches a caller bug before it becomes a stored shape nothing can read. On
 * the way OUT it catches a row that is no longer the shape this verb wrote -- only `recordDecision`
 * writes these columns, and it validates first, so a row that will not parse has been hand-edited
 * or predates a schema change. Failing beats a half-understood action being carried out against
 * somebody's repository.
 */
function parsedOrThrow<T>(
  parsed: { success: true; data: T } | { success: false; error: { message: string } },
  what: string,
): T {
  if (!parsed.success) throw new TypeError(`supervisor: ${what} is not the shape the domain defines: ${parsed.error.message}`)
  return parsed.data
}

/**
 * The project's two Supervisor settings (M38 §4).
 *
 * `enabled` is the ONE narrowing a project may apply (spec §1): off means the Supervisor still
 * reports but records no decision and applies nothing. There is no setting that WIDENS what it may
 * do by itself -- tiers are code.
 *
 * `profile` is the persona and house rules the decision prompt carries, under M37's cap and
 * `neutraliseMarkers` (applied where the prompt is built, not here -- what is stored is what the
 * operator wrote). Trimmed, and an emptied text becomes `null` rather than `''`, exactly as
 * `setProfile` normalises a worker's: "cleared" is a real state and only `null` says it.
 *
 * One `workspace.settings_changed` per field that actually MOVED, and none at all when nothing
 * did, so the timeline does not fill with re-saves of an unchanged form. The profile's event
 * carries a sha256, never the text: the persona can be long, and a hash is what lets a reader
 * match "the profile changed here" against a decision made under it.
 */
export async function setSupervisorSettings(
  workspaceId: string,
  patch: { readonly enabled?: boolean; readonly profile?: string | null },
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { supervisorEnabled: true, supervisorProfile: true },
  })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

  let profile: string | null | undefined
  if (patch.profile !== undefined) {
    const trimmed = patch.profile === null ? null : patch.profile.trim()
    if (trimmed !== null && trimmed.length > PROFILE_MAX_CHARS) {
      return err({ kind: 'profile_too_long', limit: PROFILE_MAX_CHARS, length: trimmed.length })
    }
    profile = trimmed === '' ? null : trimmed
  }

  const enabled = patch.enabled !== undefined && patch.enabled !== workspace.supervisorEnabled ? patch.enabled : undefined
  const nextProfile = profile !== undefined && profile !== workspace.supervisorProfile ? profile : undefined
  const enabledMoved = enabled !== undefined
  // `null` is a real new value here (the profile was cleared), so "moved" cannot be `!== undefined`
  // on the value alone -- it is whether the field was in the patch AND differs from what is stored.
  const profileMoved = profile !== undefined && profile !== workspace.supervisorProfile
  if (!enabledMoved && !profileMoved) return ok(undefined)

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      ...(enabledMoved ? { supervisorEnabled: enabled } : {}),
      ...(profileMoved ? { supervisorProfile: nextProfile ?? null } : {}),
    },
  })

  if (enabledMoved) {
    await appendEvent({
      type: 'workspace.settings_changed',
      workspaceId,
      actor: 'human',
      payload: { field: 'supervisorEnabled', from: workspace.supervisorEnabled, to: enabled },
      userId: principal?.userId ?? null,
    })
  }
  if (profileMoved) {
    await appendEvent({
      type: 'workspace.settings_changed',
      workspaceId,
      actor: 'human',
      payload: {
        field: 'supervisorProfile',
        from: workspace.supervisorProfile === null ? null : sha256(workspace.supervisorProfile),
        to: nextProfile === null || nextProfile === undefined ? null : sha256(nextProfile),
      },
      userId: principal?.userId ?? null,
    })
  }
  return ok(undefined)
}
