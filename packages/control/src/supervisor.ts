import { createHash } from 'node:crypto'
import { type Prisma, prisma } from '@slave-of-ai/db/client'
import {
  ANSWER_MAX_CHARS,
  CARD_EXPIRED_NOTE,
  CLOSED_BY_SYSTEM,
  COOLDOWN_BY_KIND,
  COOLDOWN_MS,
  DECIDED_WITHOUT_ANSWER,
  DECISION_RETENTION_MS,
  HALT_CLEAR_INTERVAL_MS,
  MANAGER_ROLE,
  PENDING_TTL_MS,
  PERMISSION_KINDS,
  PROFILE_MAX_CHARS,
  PRUNE_BATCH,
  QUESTION_SITUATION_KINDS,
  READDRESSING_ACTION_KINDS,
  actionSchema,
  candidateSchema,
  cardOffers,
  dismissResumeMessage,
  draftSchema,
  isQuestionSituation,
  neutraliseMarkers,
  personDecisionSchema,
  promotionFor,
  questionCloseOnVerdict,
  readsAsPlatform,
  sanitisePersonText,
  situationSchema,
  type Action,
  type ActionKind,
  type Candidate,
  type CardVerdict,
  type Decider,
  type DecisionStatus,
  type Draft,
  type PermissionKind,
  type PersonDecision,
  type QuestionCloseReason,
  type Result,
  type Situation,
  type SituationKind,
  type Tier,
  err,
  ok,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import type { ProviderKind } from '@slave-of-ai/providers'
import { steerRun } from './breaker.js'
import { hireFromTemplate, seatMember, mergeRuntimeRoles } from './capability.js'
import { applyConductorOutcome } from './conductorAnswer.js'
import { clearHalt } from './emergency.js'
import { requestChange } from './goal.js'
import { releasePerson } from './persons.js'
import { discardStaleCandidates, recordMemory } from './memory.js'
import { answerQuestion, reassignQuestion } from './messaging.js'
import { announceQuestionClosed, closeQuestionIn, closedByOf, loadQuestionCards, lockCardQuestion, retireQuestionCards, type CardQuestion, type CloseQuestionInput, type QuestionCard } from './questions.js'
import { isProviderKind } from './org.js'
import { setRuntimeRoles } from './profile.js'
import { setSlavePermission } from './permission.js'
import type { Principal } from './principal.js'
import { refusalText, type ControlRefusal } from './refusal.js'
import { adoptRunbook } from './runbook.js'
import { MODEL_ID_PATTERN, MODEL_SHAPE_DETAIL } from './staffing.js'
import { breakerCountedFailures, workspaceStats } from './stats.js'
import { appendPlannerNote } from './supervisorUploads.js'
import { cancelTask, failTask } from './task.js'
import { retryTask, unblockTask } from './unblock.js'
import { setWorkspaceProvider } from './workspace.js'

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
 * its kind's cooldown (`COOLDOWN_BY_KIND`, else `COOLDOWN_MS`), as `filterFresh` does, from
 * `resolvedAt ?? createdAt` -- the `createdAt` fallback is what stops an
 * auto-applied row (which never gets a `resolvedAt`) from being re-decided on the very next tick.
 * Exactly the cooldown old is STILL cooling, closed at that end, so a fixed clock cannot straddle
 * the boundary. `filterFresh` is the cheap first pass over a world already in memory; this is the
 * one that actually holds, because it reads and writes in the same transaction.
 *
 * Human cards H1 (plan A D2): a card on a question -- any of `QUESTION_SITUATION_KINDS` -- is a
 * card on that question, so an open card of ANY question kind about the same message blocks a new
 * one, and a closed question (`question_closed`) is never decided again.
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
    const onQuestion = isQuestionSituation(situation.kind)
    if (onQuestion) {
      // Human cards H1: a closed question is never decided again. Refused before any write.
      const message = await tx.slaveMessage.findUnique({ where: { id: situation.subjectId }, select: { closedAt: true, closedReason: true, closedBy: true } })
      if (message?.closedAt != null && message.closedReason !== null) {
        return { ok: false as const, error: { kind: 'question_closed', messageId: situation.subjectId, reason: message.closedReason, by: message.closedBy ?? CLOSED_BY_SYSTEM, at: message.closedAt.toISOString() } as ControlRefusal }
      }
      // Self-heal of the crash window (ruling F8): a verb-carried approval closes its question after
      // the verb, outside the claim. A question whose latest card a person approved, and which that
      // verdict closes, is closed here -- under the Workspace lock already held -- and refused. This
      // return deliberately COMMITS the close; it writes nothing else.
      const healed = await healApprovedClose(tx, input.workspaceId, situation.subjectId, now)
      if (healed !== null) return { ok: false as const, healed, error: questionClosedOf(healed) }
    }
    // Plan A D2: one open card per question, whatever kind raised it; per situation key otherwise.
    const cooldownMs = COOLDOWN_BY_KIND[situation.kind] ?? COOLDOWN_MS
    const open = await tx.supervisorDecision.findFirst({
      where: onQuestion
        ? { workspaceId: input.workspaceId, subjectId: situation.subjectId, situationKind: { in: [...QUESTION_SITUATION_KINDS] }, status: 'pending' }
        : { ...key, status: 'pending' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, expiresAt: true },
    })
    if (open !== null) {
      // A human is already looking at this key. "Free again" is when the proposal stops being
      // open -- its own deadline -- rather than a cooldown that has not started counting yet.
      const until = open.expiresAt ?? new Date(open.createdAt.getTime() + cooldownMs)
      return { ok: false as const, error: cooldown(situation, until) }
    }
    // Final wave, finding 2: a question cools as one key -- its latest card of ANY question kind,
    // under that card's own kind's cooldown -- so a re-addressed `unanswerable_question` card does
    // not let `waiting_stale` raise a card on the same question on the next tick (`filterFresh`
    // reads the same latest row).
    const last = await tx.supervisorDecision.findFirst({
      where: onQuestion ? { workspaceId: input.workspaceId, subjectId: situation.subjectId, situationKind: { in: [...QUESTION_SITUATION_KINDS] } } : key,
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, resolvedAt: true, situationKind: true },
    })
    if (last !== null) {
      const anchor = last.resolvedAt ?? last.createdAt
      const lastCooldownMs = COOLDOWN_BY_KIND[last.situationKind] ?? COOLDOWN_MS
      if (now.getTime() - anchor.getTime() <= lastCooldownMs) {
        return { ok: false as const, error: cooldown(situation, new Date(anchor.getTime() + lastCooldownMs)) }
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
  if (!outcome.ok) {
    if ('healed' in outcome && outcome.healed !== undefined) await afterCardClose(input.workspaceId, outcome.healed.input.decisionId ?? '', outcome.healed, now)
    return err(outcome.error)
  }

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

/**
 * How long an approval must have been resolved before {@link healApprovedClose} treats its open
 * question as a crashed close rather than a verb still running (or about to be refused, which must
 * close nothing). Far past any verb's run time; a crash heals on the first record after it.
 */
export const HEAL_APPROVED_CLOSE_AFTER_MS = 5 * 60_000

/**
 * Inside `recordDecision`'s transaction: closes a question its latest card's approval should have
 * closed (a crash between a verb and {@link closeAfterApply}). Null when there is nothing to heal:
 * the approval is younger than {@link HEAL_APPROVED_CLOSE_AFTER_MS} on the tick's clock, or it
 * re-addressed the question -- left open on purpose while its task was live (ruling F18, amended),
 * so a later record must not close it over the new holder.
 */
async function healApprovedClose(tx: Prisma.TransactionClient, workspaceId: string, messageId: string, now: Date): Promise<CardClose | null> {
  const latest = await tx.supervisorDecision.findFirst({
    where: { workspaceId, subjectId: messageId, situationKind: { in: [...QUESTION_SITUATION_KINDS] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, situationKind: true, action: true, resolvedAt: true, resolvedByUserId: true },
  })
  if (latest?.status !== 'approved' || latest.resolvedAt === null) return null
  if (latest.resolvedAt.getTime() > now.getTime() - HEAL_APPROVED_CLOSE_AFTER_MS) return null
  const action = parsedOrThrow(actionSchema.safeParse(latest.action), `SupervisorDecision ${latest.id}.action`)
  if (READDRESSING_ACTION_KINDS.includes(action.kind)) return null
  const question = await lockCardQuestion(tx, workspaceId, messageId)
  if (question === null || question.closedAt !== null) return null
  const principal = latest.resolvedByUserId === null ? undefined : { userId: latest.resolvedByUserId }
  const close = await closeForVerdict(tx, question, { id: latest.id, situationKind: latest.situationKind, actionKind: action.kind }, 'approved', null, principal, now)
  return close?.closed === true ? close : null
}

const questionClosedOf = (close: CardClose): ControlRefusal => ({
  kind: 'question_closed',
  messageId: close.input.messageId,
  reason: close.input.reason,
  by: close.input.by,
  at: close.at.toISOString(),
})

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
      payload: { decisionId, action, reason },
      userId: principal?.userId ?? null,
    })
    return outcome
  }
  if (outcome.value === 'none') return ok(undefined)

  await appendEvent({
    type: 'supervisor.applied',
    workspaceId: row.workspaceId,
    actor: 'system',
    payload: { decisionId, action },
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
   *  fetched rather than looked up again: `hireFromTemplate` and `seatMember` are
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
      // Spec erratum E9: a row stored before M58 names a `CompanySlave` that this milestone's
      // migration DROPPED, and there is nothing left to resolve it to -- the roster row is gone and
      // its person, if it had one, is not named here. Refused rather than guessed at, with the
      // refusal M27 already had for a roster id nothing carries. The row still PARSES, which is the
      // point: the Supervisor view renders it and an operator can reject it by hand.
      if (action.personId === undefined) {
        return { ok: false as const, error: { kind: 'company_slave_not_found', companySlaveId: action.companySlaveId ?? '' } }
      }
      // The rationale the rules wrote, verbatim -- `formTeam`'s sentence names the capability in
      // the taxonomy's WORDS ("Application security"), and that sentence is what the Organization
      // view shows beside the worker months later (fix round 1, Minor 5).
      return reached(await seatMember(decision.workspaceId, action.personId, { rationale: action.rationale }))
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
          // Catalog Person Pool Task 4: this is the AUTOMATIC path -- a pool the sync/retry still
          // finds nothing in fails the hire outright rather than growing the roster by an
          // unmanaged person nobody, human or model, chose to add.
          requirePool: true,
        }),
      )
    case 'mark_task_failed':
      return reached(await failTask(action.taskId, action.reason, origin, principal))
    case 'answer_question': {
      const sent = await sendDraftedAnswer(action.messageId, decision, origin, principal)
      // Supervisor-as-conductor plan B D7: a conductor answer's decision and hand-off follow the
      // answer out -- unless a person replaced the model's words (an edit), which applies neither
      // (plan-writer ruling). Outside any lock: the routing takes the delivery's, which is not
      // re-entrant. A failure here is said and swallowed: the answer is already out, and the goal
      // pass routes a hand-off that never landed (`routeStoredHandOffs`, F4).
      const conductor = decision.draft?.conductor
      if (sent.ok && conductor !== undefined && decision.draft?.editedBody === undefined) {
        try {
          await applyConductorOutcome({ workspaceId: decision.workspaceId, decisionId: decision.id, messageId: action.messageId, conductor })
        } catch (error) {
          console.error(`[supervisor] decision ${decision.id}: the conductor answer's decision or hand-off was not recorded:`, error)
        }
      }
      // Human cards H1 (plan A D5): any answer that went out closed its question (`answerQuestion`),
      // and a closed question has no open card -- every other card about it is retired here (the
      // tick's conductor path calls the same verb after it applies; a second call finds nothing).
      // Said and swallowed: the answer is out, and the tick's backstop retires what this missed.
      if (sent.ok) {
        try {
          await retireQuestionCards(decision.workspaceId, action.messageId, 'The question was answered.', new Date(), decision.id)
        } catch (error) {
          console.error(`[supervisor] decision ${decision.id}: the other cards of its question were not retired:`, error)
        }
      }
      return reached(sent)
    }
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
    case 'release_worker': {
      // M58 R10: a release is a fact about a PERSON and closes every seat they hold.
      // Stored actions still name a seat (`slaveId`); resolve whoever sits there when the
      // action has no personId of its own.
      const seat = await prisma.slave.findUnique({ where: { id: action.slaveId }, select: { personId: true } })
      if (seat === null) return err({ kind: 'slave_not_found', slaveId: action.slaveId })
      const actionPersonId = 'personId' in action && typeof action.personId === 'string' ? action.personId : undefined
      return reached(await releasePerson(actionPersonId ?? seat.personId, action.reason, principal, origin))
    }
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
    case 'request_permission': {
      // M52 R5. `setSlavePermission` re-validates the kind against `PERMISSION_KINDS` and re-reads
      // the worker, so a proposal that waited a day and named a worker who has since been released
      // is refused rather than written.
      //
      // AN OPERATOR'S `deny` IS NEVER OVERTURNED (final review, Important 2). `setSlavePermission`
      // is an upsert, and without this read an approved proposal -- or, under `act`, a decision
      // nobody approved -- flipped a person's explicit refusal to `allow`. A `deny` row is the one
      // thing in the permission matrix that is a decision rather than an absence, and the verb
      // whose job is to POINT at a wall has nothing to do when a person built it on purpose.
      // `Action.permissionKind` is a `string` -- the stored row is whatever the rules wrote a year
      // ago -- so the vocabulary check comes first and a word it does not hold falls straight
      // through to `setSlavePermission`, which is where `invalid_tool` is decided and always was.
      const asked = action.permissionKind
      const denied = (PERMISSION_KINDS as readonly string[]).includes(asked)
        ? await prisma.slavePermission.findUnique({
            where: { slaveId_kind: { slaveId: action.slaveId, kind: asked as PermissionKind } },
            select: { mode: true },
          })
        : null
      if (denied?.mode === 'deny') {
        return err({
          kind: 'permission_denied_by_operator',
          slaveId: action.slaveId,
          permissionKind: action.permissionKind,
        })
      }
      // WHO GRANTED IT, in both of this arm's two cases (spec erratum E13, extended by the final
      // review's Important 3). `tierOf` pinned this action to `proposed` on every branch until R1
      // made `act` apply everything the halted checks do not demote -- so the old reading, "the
      // only way here is a person approving", stopped being true and the `origin` this function
      // was already handed stopped being passed on. An approved proposal still records the
      // APPROVER as the granter: `principal` lands on the row and in the event, and that is the
      // true answer to "who granted this" -- the Supervisor only ever asked. A tick under `act`
      // has no approver, so `origin` carries `system` / `by: 'supervisor'` exactly as the grant a
      // `retry_task` bundles does, rather than naming a person who was never asked.
      return reached(
        await setSlavePermission(action.slaveId, action.permissionKind, 'allow', principal, { origin }),
      )
    }
    case 'retry_task':
      // E R3: the exit from `failed`, the one status nothing in this product could leave. ONE
      // decision, TWO verbs, in that order: `retryTask` grants the permission the diagnosis named
      // before it moves the task, so a grant that is refused leaves the task failed rather than
      // retried into the same wall.
      //
      // WHO GRANTED IT is the one place this differs from the `request_permission` arm above
      // (spec erratum E13). That arm is always reached through a person's approval, so the approver
      // is the granter. This one is applied by a tick under `act` with nobody to approve it, so
      // `origin` travels with the grant and the `permission.changed` it appends says `system` /
      // `by: 'supervisor'`. A human approving this same decision passes a `principal`, and the
      // event names them, exactly as it always did.
      //
      // `action.reason` is the note the next run READS -- it lands on `Task.lastRejectionReason`,
      // which `runContext` renders on the implementation order, and a `rework` run is an
      // implementation run. It was written by `candidates.ts` from the task's own facts, which is
      // what lets `tierOf` apply this under `act`: no model's words reach the worker.
      return reached(
        await retryTask(action.taskId, { grant: action.grant, reason: action.reason }, principal, { origin }),
      )
    case 'retry_review':
      // E R3: the SAME verb the routine unblock uses, told where to send it. The reviewer never
      // judged this work -- its run broke -- so the attempts the cap counted were not reviews, and
      // another review costs one review attempt and no rework. `reviewWindowFrom` is stamped in the
      // same write, which is what stops `dispatchReview` re-parking it on the next tick (Task 5).
      return reached(await unblockTask(action.taskId, { retryReview: true, origin }, principal))
    case 'clear_halt': {
      // E R4: the one halt the Supervisor may retract, and the bound it is retracted under.
      //
      // `candidates.ts` already refuses to OFFER this inside the hour, and this is the second half
      // of the same rule rather than a duplicate of it: an offer and an apply are two moments, a
      // proposal can be approved by a person long after it was made, and the window is a bound on
      // SPEND at the moment the project starts running again. Both read the same column, so they
      // cannot disagree.
      //
      // WHICH HALT IT IS, re-read at apply time (final review, Important 4). The rules offer this
      // for `circuit_breaker` alone, and that was taken to be the whole guard -- but the offer and
      // the apply are two moments, and between them a person can hit the emergency stop on a
      // project whose breaker proposal is still pending. Approving it then retracted the stop.
      //
      // A STORED reason is the test, because the breaker's is not stored: `haltOf` derives
      // `circuit_breaker` from the failure streak while `Workspace.haltedReason` stays null
      // (`supervisorWorld.ts`), and the column is only ever written by an emergency stop, a pause
      // gate, a verify halt or a merge halt -- every one of them somebody or something else's
      // decision that this project should not be moving. So anything stored that is not the
      // breaker's own name is refused, and `clearHalt` keeps its idempotence for the derived case
      // it was written for.
      const workspace = await prisma.workspace.findUnique({
        where: { id: action.workspaceId },
        select: { haltClearedAt: true, haltedReason: true },
      })
      if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId: action.workspaceId })
      if (workspace.haltedReason !== null && workspace.haltedReason !== 'circuit_breaker') {
        return err({
          kind: 'halt_not_breaker',
          workspaceId: action.workspaceId,
          reason: workspace.haltedReason,
        })
      }
      const clearedAt = workspace.haltClearedAt
      if (clearedAt !== null && Date.now() - clearedAt.getTime() < HALT_CLEAR_INTERVAL_MS) {
        return err({
          kind: 'halt_recently_cleared',
          workspaceId: action.workspaceId,
          clearedAt: clearedAt.toISOString(),
        })
      }
      return reached(await clearHalt(action.workspaceId))
    }
    case 'request_goal_change':
      // Supervisor chat R3: the verb the composer called directly until now, reached by typing a
      // sentence instead of opening a form. `requestChange` AMENDS the standing goal and M40's
      // trigger re-plans it on the next tick -- nothing here writes a goal, which is the whole of
      // why the action carries the person's REQUEST rather than a replacement document.
      //
      // No `origin`: `ExternalOrigin` is provenance for something OUTSIDE this installation (a
      // GitHub issue, a commit), and `externalOriginSchema` will not parse anything else. A
      // request made in the conversation came from the person who owns the project, which is what
      // `GoalVersion.request` already records and what the version's own `setByUserId` names.
      return reached(await requestChange(decision.workspaceId, action.request, principal))
    case 'note_for_planner':
      // Supervisor chat R3: a dated line in `docs/inbox/NOTES.md`, committed. The one arm whose
      // effect is a FILE, and `appendPlannerNote` owns every part of that -- the heading a new file
      // is born with, the append, the commit with the orchestrator's identity, and the refusal
      // (`inbox_write_failed`) for a repository that would not take it. Returned rather than
      // thrown, like every other arm: a disk that is full is a `failed` decision a person can read,
      // not a crashed pass.
      return reached(await appendPlannerNote(decision.workspaceId, action.text))
    case 'configure_runtime':
      // H4a: the project gets a runtime, so a model call can be made at all. `setWorkspaceProvider`
      // owns the whole of that -- the delete-then-insert under the workspace lock that keeps
      // "exactly one row or nothing" true, and the `workspace.settings_changed` event beside it, so
      // the change reads in the Activity feed exactly as an operator's own `set-provider` does.
      //
      // Nothing is checked first. The verb refuses a workspace that is gone and a provider that is
      // not a kind, which is every way this can fail; a project that already HAS a runtime is not
      // an error here, because the rules only offer this when it has none and a person approving a
      // day-old proposal is entitled to replace whatever arrived meanwhile.
      return reached(await setWorkspaceProvider(decision.workspaceId, action.provider, principal))
    case 'retry_planning': {
      // H4a: the planning retry cap, counted from zero again -- ONE event and no row anywhere.
      // `dispatchPlanning` is what reads it and starts the next planning run, on its own next tick.
      //
      // The version is read HERE rather than off the situation's facts (`clear_halt`'s precedent):
      // a proposal can be approved a day after it was made, and the version dispatch will count
      // against is the one the project has NOW, not the one the rules were looking at.
      const workspace = await prisma.workspace.findUnique({
        where: { id: decision.workspaceId },
        select: { goalVersion: true },
      })
      if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId: decision.workspaceId })
      // ONCE PER VERSION, the second half of the rule `candidates.ts` states at the offer. The cap
      // exists to stop a planner being asked the same thing for ever, and a reset that could be
      // applied again and again would have removed the cap rather than answered it.
      const already = await prisma.executionEvent.count({
        where: {
          workspaceId: decision.workspaceId,
          type: 'workspace_planning_reset',
          payload: { path: ['version'], equals: workspace.goalVersion },
        },
      })
      if (already > 0) {
        return err({
          kind: 'planning_already_reset',
          workspaceId: decision.workspaceId,
          version: workspace.goalVersion,
        })
      }
      await appendEvent({
        type: 'workspace.planning_reset',
        workspaceId: decision.workspaceId,
        actor: 'system',
        // WHO gave the attempts back. `origin` is already the answer -- `human` when a person
        // approved the proposal, `system` when the tick applied it by itself -- and the envelope
        // cannot carry it, because the `Actor` enum has no `supervisor` member (M38 erratum E4).
        payload: { version: workspace.goalVersion, by: origin === 'human' ? 'human' : 'supervisor' },
        userId: principal?.userId ?? null,
      })
      return ok('applied')
    }
    case 'escalate_to_human':
      // H9c (F5b): a person saying yes to a BREAKER escalation lifts the halt when there is no
      // runaway to answer -- every failure the breaker counted was the platform's. Anything else
      // is still a question only the person can act on, and the summary says how.
      if (origin === 'human' && decision.situation.kind === 'workspace_halted' && decision.situation.facts['reason'] === 'circuit_breaker') {
        return liftPlatformBreakerHalt(decision.workspaceId)
      }
      return ok('none')
    case 'no_action':
      return ok('none')
    case 'conduct':
      // Conductor R2 (plan decision D7): recorded already applied, by the conductor, in the one
      // transaction that also wrote its packages and tasks. There is nothing left to carry out, and
      // a second `supervisor.applied` would announce a change `workspace.conducted` already did.
      return ok('none')
  }
}

/**
 * H9c (F5b): an approved breaker escalation clears the halt when every failure the breaker still
 * counts reads as the PLATFORM's (`readsAsPlatform`: the row's `failureClass`, or an infrastructure
 * marker on a row written before the column could say so).
 *
 * Re-read at approval time, never taken off the situation's facts: a proposal can be approved long
 * after it was made, and by then a real failure may have joined the streak -- or the halt may be
 * gone, in which case there is nothing to lift. A STORED halt that is not the breaker's (an
 * emergency stop pressed since) is never touched: `clear_halt`'s own rule. The once-an-hour bound
 * is not applied: it bounds the Supervisor's OWN clears, and this one is a person's, exactly as
 * their `clear-halt` is.
 *
 * A breaker with a worker's failure in it is left standing and the approval reaches nothing
 * (`'none'`): the summary the person approved already named the command that clears it.
 */
async function liftPlatformBreakerHalt(workspaceId: string): Promise<Result<Reach, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { haltedReason: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  if (workspace.haltedReason !== null && workspace.haltedReason !== 'circuit_breaker') return ok('none')
  const counted = await breakerCountedFailures(workspaceId)
  const snapshot = await workspaceStats(workspaceId)
  const tripped = snapshot.stats.consecutiveFailures >= snapshot.limits.consecutiveFailureLimit
  if (!tripped || counted.length === 0 || !counted.every(readsAsPlatform)) return ok('none')
  return reached(await clearHalt(workspaceId))
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
  // Controller ruling F8: the conductor's own words are defused whole -- markers and routing
  // literals -- whatever wrote the stored draft (the judging already did; both defuses are
  // idempotent, so nothing is escaped twice). A person's edit is a person's, as on every answer.
  const body = decision.draft?.conductor !== undefined && decision.draft.editedBody === undefined ? sanitisePersonText(written) : neutraliseMarkers(written)
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
 * writes `facts.role` for `no_reviewer` and `ready_unstaffed`), so that is what is
 * added and nothing else: approving "give Maya reviewer" grants reviewer, never re-grants backend.
 *
 * H4a: `planning_stalled { reason: 'no_planner' }` is the one situation that names a role WITHOUT a
 * `facts.role`. Its facts are the reason and the goal version, because the situation is about a
 * PROJECT rather than about a role -- and the role is `MANAGER_ROLE` by construction, since that
 * reason IS "no seat holds it" and `candidates` offers the staffing path on exactly that string.
 * Named here rather than added to the facts, so the precision survives the fold; a stored
 * `no_planner` row from before it still carries `facts.role` and reads through the clause above.
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
  if (typeof role === 'string' && role !== '') return [role]
  if (situation.kind === 'planning_stalled' && situation.facts['reason'] === 'no_planner') return [MANAGER_ROLE]
  return action.roles
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
    // M58 R1: whether the engagement is over is the PERSON's fact.
    select: { runtimeRoles: true, person: { select: { releasedAt: true } } },
  })
  if (slave === null) return err({ kind: 'slave_not_found', slaveId })
  if (slave.person.releasedAt !== null) {
    return err({ kind: 'already_released', slaveId, at: slave.person.releasedAt.toISOString() })
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

  const claim = await claimPending(
    decisionId,
    { status: 'approved', resolvedAt: new Date(), resolvedByUserId: principal?.userId ?? null },
    { verdict: 'approved', reason: null, principal },
  )
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

  // Human cards H1: the approval closes the card's question. An escalation was closed inside the
  // claim (ruling F8); an action carried out by a verb is closed right after it went through, with
  // the claim as the guard -- the verbs own their transactions, so the close cannot join them.
  if (claim.value.closedInClaim) await afterCardClose(claim.value.workspaceId, decisionId, claim.value.close, new Date())
  else await closeAfterApply(decisionId, principal, new Date())

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
  const said = trimmed === undefined || trimmed === '' ? null : trimmed
  // Human cards H1: a rejection dismisses the card's question with the person's reason, inside the
  // claim (ruling F8).
  const claim = await claimPending(
    decisionId,
    { status: 'rejected', resolvedAt: new Date(), resolvedByUserId: principal?.userId ?? null },
    { verdict: 'rejected', reason: said, principal },
  )
  if (!claim.ok) return claim

  await appendEvent({
    type: 'supervisor.resolved',
    workspaceId: claim.value.workspaceId,
    // A person's act, like an approval -- see {@link approveDecision} for why this one event
    // departs from the `system` actor the other `supervisor.*` events carry, and for why `userId`
    // may honestly be null (fix round 2).
    actor: 'human',
    payload: { decisionId, outcome: 'rejected', reason: said },
    userId: principal?.userId ?? null,
  })
  await afterCardClose(claim.value.workspaceId, decisionId, claim.value.close, new Date())

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

/**
 * The one atomic "take this pending decision" both {@link approveDecision} and
 * {@link rejectDecision} open with: the `updateMany` conditional on `status: 'pending'` is what
 * actually decides who won.
 *
 * Human cards H1, ruling F8: for every verdict on a question card the question is locked -- the
 * Workspace row first, then the question row, the order every closer keeps -- and a question closed
 * meanwhile (other than `timed_out`, whose card stays open, spec H3) refuses the verdict with who
 * closed it and when, before anything is written (spec §4): no verb acts on a closed question. For a
 * rejection, and for an approval that carries nothing out (`escalate_to_human`, `no_action`), the
 * question is also closed in this same transaction (`closedInClaim`). Every refusal here is
 * returned before the first write, so returning commits nothing.
 */
async function claimPending(
  decisionId: string,
  data: { readonly status: DecisionStatus; readonly resolvedAt: Date; readonly resolvedByUserId: string | null },
  verdict: { readonly verdict: 'approved' | 'rejected'; readonly reason: string | null; readonly principal: Principal | undefined },
): Promise<Result<{ readonly workspaceId: string; readonly closedInClaim: boolean; readonly close: CardClose | null }, ControlRefusal>> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.supervisorDecision.findUnique({
      where: { id: decisionId },
      select: { workspaceId: true, status: true, situationKind: true, subjectId: true, action: true, resolvedAt: true, resolvedByUserId: true },
    })
    if (row === null) return err({ kind: 'decision_not_found', decisionId })
    if (row.status !== 'pending') return err(notPending(decisionId, row))

    const action = parsedOrThrow(actionSchema.safeParse(row.action), `SupervisorDecision ${decisionId}.action`)
    const onQuestion = isQuestionSituation(row.situationKind)
    const closedInClaim = onQuestion && (verdict.verdict === 'rejected' || action.kind === 'escalate_to_human' || action.kind === 'no_action')
    const question = onQuestion ? await lockCardQuestion(tx, row.workspaceId, row.subjectId) : null
    if (question?.closedAt != null && question.closedReason !== null && question.closedReason !== 'timed_out') {
      return err({ kind: 'question_closed', messageId: question.id, reason: question.closedReason, by: question.closedBy ?? CLOSED_BY_SYSTEM, at: question.closedAt.toISOString() })
    }

    const claimed = await tx.supervisorDecision.updateMany({ where: { id: decisionId, status: 'pending' }, data })
    if (claimed.count === 0) {
      // Lost the race to another approve, another reject, or the expiry sweep. Re-read rather than
      // guess which, the way `unblockTask` re-reads its own lost claim. Nothing was written.
      const current = await tx.supervisorDecision.findUnique({ where: { id: decisionId }, select: { status: true, resolvedAt: true, resolvedByUserId: true } })
      if (current === null) return err({ kind: 'decision_not_found', decisionId })
      return err(notPending(decisionId, current))
    }
    const close =
      question === null || !closedInClaim
        ? null
        : await closeForVerdict(tx, question, { id: decisionId, situationKind: row.situationKind, actionKind: action.kind }, verdict.verdict, verdict.reason, verdict.principal, data.resolvedAt)
    return ok({ workspaceId: row.workspaceId, closedInClaim, close })
  })
}

/** Spec §4: a card somebody else took first says who and when. */
const notPending = (
  decisionId: string,
  row: { readonly status: DecisionStatus; readonly resolvedAt: Date | null; readonly resolvedByUserId: string | null },
): ControlRefusal => ({
  kind: 'decision_not_pending',
  decisionId,
  status: row.status,
  resolvedAt: row.resolvedAt?.toISOString() ?? null,
  resolvedByUserId: row.resolvedByUserId,
})

/** A close a verdict made, to be announced and followed by its retirements after the commit. */
interface CardClose {
  readonly question: CardQuestion
  readonly input: CloseQuestionInput
  /** This verdict closed it (false: it was closed already, first close wins). */
  readonly closed: boolean
  readonly actor: 'human' | 'system'
  readonly userId: string | null
  /** When it was closed. */
  readonly at: Date
}

/**
 * Human cards H1 (plan A D4): closes a locked question for a card's verdict, inside `tx`, as
 * {@link questionCloseOnVerdict} says -- `decided`, `dismissed` with the person's reason, or
 * `timed_out` -- with the turn the asker continues with. Null when the verdict leaves it open.
 */
async function closeForVerdict(
  tx: Prisma.TransactionClient,
  question: CardQuestion,
  card: { readonly id: string; readonly situationKind: SituationKind; readonly actionKind: ActionKind },
  verdict: CardVerdict,
  reason: string | null,
  principal: Principal | undefined,
  now: Date,
): Promise<CardClose | null> {
  const closeReason = questionCloseOnVerdict({
    situationKind: card.situationKind,
    actionKind: card.actionKind,
    verdict,
    askerTaskLive: question.askerTaskLive,
    askerParked: question.askerParked,
  })
  if (closeReason === null) return null
  const human = verdict !== 'expired'
  const input: CloseQuestionInput = {
    messageId: question.id,
    reason: closeReason,
    by: human ? closedByOf(principal) : CLOSED_BY_SYSTEM,
    decisionId: card.id,
    note:
      closeReason === 'decided'
        ? DECIDED_WITHOUT_ANSWER
        : closeReason === 'dismissed'
          ? dismissResumeMessage(reason)
          : // Only an expiry times a question out here, and never while its asker is parked: no run
            // continues past it, and the marker says so to the report and the card (finding 7).
            CARD_EXPIRED_NOTE,
  }
  const closed = await closeQuestionIn(tx, input, now)
  return { question, input, closed, actor: human ? 'human' : 'system', userId: human ? (principal?.userId ?? null) : null, at: now }
}

/** The words a card retired by another card's verdict gives, by how the question closed. */
const RETIRED_BY_VERDICT: Readonly<Partial<Record<QuestionCloseReason, string>>> = {
  decided: 'A person decided the question on another card.',
  dismissed: 'A person closed the question without an answer.',
  timed_out: 'The question timed out with its card.',
}

/**
 * After the commit that closed a card's question: its one `slave.question_closed` event (only when
 * this verdict closed it), and every other open card about it retired (plan A D5). Said and
 * swallowed: the verdict already committed, and the tick's backstop retires what this missed.
 */
async function afterCardClose(workspaceId: string, decisionId: string, close: CardClose | null, now: Date): Promise<void> {
  if (close === null) return
  try {
    if (close.closed) await announceQuestionClosed(close.question, close.input, close.actor, close.userId)
    await retireQuestionCards(workspaceId, close.input.messageId, RETIRED_BY_VERDICT[close.input.reason] ?? 'The question was closed.', now, decisionId)
  } catch (error) {
    console.error(`[supervisor] decision ${decisionId}: its question's close was not announced or its other cards not retired:`, error)
  }
}

/**
 * Human cards H1, ruling F8: an approved action a verb carried out closes the card's question right
 * after the verb went through -- the claim is the guard, since the verbs own their transactions.
 * The close is conditional, so a question the verb (an answer) or anybody else closed meanwhile is
 * left as it is. Said and swallowed, like {@link afterCardClose}.
 */
async function closeAfterApply(decisionId: string, principal: Principal | undefined, now: Date): Promise<void> {
  try {
    const row = await prisma.supervisorDecision.findUnique({ where: { id: decisionId }, select: { workspaceId: true, situationKind: true, subjectId: true, action: true } })
    if (row === null || !isQuestionSituation(row.situationKind)) return
    const action = parsedOrThrow(actionSchema.safeParse(row.action), `SupervisorDecision ${decisionId}.action`)
    const close = await prisma.$transaction(async (tx) => {
      const question = await lockCardQuestion(tx, row.workspaceId, row.subjectId)
      return question === null
        ? null
        : closeForVerdict(tx, question, { id: decisionId, situationKind: row.situationKind, actionKind: action.kind }, 'approved', null, principal, now)
    })
    await afterCardClose(row.workspaceId, decisionId, close, now)
  } catch (error) {
    console.error(`[supervisor] decision ${decisionId}: its question was not closed:`, error)
  }
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
  /** Only decisions whose subject starts with this (Conductor Plan 4b: one goal version's
   *  `<workspaceId>:v<n>:` escalations, not a sibling version's). Omitted: every one of the kind. */
  readonly subjectIdPrefix?: string
}): Promise<number> {
  const open = await prisma.supervisorDecision.findMany({
    where: {
      workspaceId: input.workspaceId,
      situationKind: input.situationKind,
      status: 'pending',
      ...(input.subjectIdPrefix === undefined ? {} : { subjectId: { startsWith: input.subjectIdPrefix } }),
    },
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
    select: { id: true, situationKind: true, subjectId: true, action: true },
  })

  let expired = 0
  for (const row of due) {
    const claimed = await prisma.$transaction(async (tx) => {
      // Human cards H1 (plan A D4): a question card's expiry times its question out in the same
      // transaction -- unless its asker is parked on it, whose wait the timeout pass owns (F6).
      const question = isQuestionSituation(row.situationKind) ? await lockCardQuestion(tx, workspaceId, row.subjectId) : null
      // Final wave, finding 3: nor does the card expire while its asker is parked on the open
      // question. The question timeout can run to 72 hours (and a halt holds the wait longer), so a
      // card that expired at 24 hours would be raised again and expire again every day of one wait.
      // Its deadline moves on instead; the timeout pass, an answer or a person ends the wait.
      if (question !== null && question.askerParked && question.closedAt === null) {
        await tx.supervisorDecision.updateMany({ where: { id: row.id, status: 'pending' }, data: { expiresAt: new Date(now.getTime() + PENDING_TTL_MS) } })
        return { taken: false as const }
      }
      const taken = await tx.supervisorDecision.updateMany({
        where: { id: row.id, status: 'pending' },
        data: { status: 'expired', resolvedAt: now },
      })
      if (taken.count === 0) return { taken: false as const }
      if (question === null) return { taken: true as const, close: null }
      // Final wave, finding 1: a question with a live answer is not timed out by its card's expiry --
      // the answer settled it, even one stored before an answer closed its question.
      if ((await tx.slaveMessage.count({ where: { replyToId: question.id, kind: 'answer', supersededAt: null } })) > 0) return { taken: true as const, close: null }
      const action = parsedOrThrow(actionSchema.safeParse(row.action), `SupervisorDecision ${row.id}.action`)
      return { taken: true as const, close: await closeForVerdict(tx, question, { id: row.id, situationKind: row.situationKind, actionKind: action.kind }, 'expired', null, undefined, now) }
    })
    if (!claimed.taken) continue
    expired += 1
    await appendEvent({
      type: 'supervisor.resolved',
      workspaceId,
      actor: 'system',
      // No `resolvedByUserId` and no `userId`: nobody resolved this one, which is the whole fact
      // an expiry records.
      payload: { decisionId: row.id, outcome: 'expired', reason: null },
    })
    await afterCardClose(workspaceId, row.id, claimed.close, now)
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
  /** Human cards plan A D13: the question a question card is about; null for every other card (and
   *  for a question that is gone). Optional, so a view built elsewhere keeps compiling. */
  readonly card?: QuestionCard | null
  /** Human cards plan B D3: what a person decided on the card (`decideCard`); null when nobody did.
   *  Optional, so a view built elsewhere keeps compiling. */
  readonly personDecision?: PersonDecision | null
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
  // One read for every question card on the page, not one per card.
  const cards = await loadQuestionCards(workspaceId, rows.filter((row) => isQuestionSituation(row.situationKind)).map((row) => row.subjectId))
  return rows.map((row) => {
    const action = parsedOrThrow(actionSchema.safeParse(row.action), `SupervisorDecision ${row.id}.action`)
    const draft = storedDraft(row.draft, `SupervisorDecision ${row.id}.draft`)
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      situationKind: row.situationKind,
      subjectId: row.subjectId,
      situation: parsedOrThrow(situationSchema.safeParse(row.situation), `SupervisorDecision ${row.id}.situation`),
      candidates: storedCandidates(row.candidates, `SupervisorDecision ${row.id}.candidates`),
      chosenIndex: row.chosenIndex,
      action,
      draft,
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
      card: isQuestionSituation(row.situationKind) ? withOffers(cards.get(row.subjectId) ?? null, action, draft) : null,
      personDecision: row.personDecision === null ? null : parsedOrThrow(personDecisionSchema.safeParse(row.personDecision), `SupervisorDecision ${row.id}.personDecision`),
    }
  })
}

/**
 * Plan B D7: a card's question with the decisions it offers, from the card's own action and draft
 * -- and, for a question its run continued past, where a late answer would go (ruling F37: an answer
 * no run would read is not offered).
 */
export function withOffers(card: QuestionCard | null, action: Action, draft: Draft | null): QuestionCard | null {
  if (card === null) return null
  return {
    ...card,
    offers: cardOffers({
      actionKind: action.kind,
      hasDraftBody: sendableBody(draft) !== null,
      closedReason: card.closed?.reason ?? null,
      hasPackages: card.packages.length > 0,
      lateAnswerFate: card.lateAnswerFate,
    }),
  }
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
 * `provider`/`model` (F R4) are the pair that says WHICH runtime answers this project's
 * CONVERSATION. TODAY THAT IS ALL THEY GOVERN (erratum E10): `tickSupervisorChat` is the one pass
 * that reads these columns, and the decision and answer passes still take the runtime the daemon
 * was started with. Both nullable, both meaning "the installation default" when null, and both
 * validated before anything is written: a patch carrying one good field and one bad one writes
 * neither.
 *
 * One `workspace.settings_changed` per field that actually MOVED, and none at all when nothing
 * did, so the timeline does not fill with re-saves of an unchanged form. The profile's event
 * carries a sha256, never the text: the persona can be long, and a hash is what lets a reader
 * match "the profile changed here" against a decision made under it.
 */
export async function setSupervisorSettings(
  workspaceId: string,
  patch: {
    readonly enabled?: boolean
    readonly profile?: string | null
    /**
     * E R1: the one switch. `propose` is today's behaviour -- the Supervisor records a decision and
     * a person approves it -- and `act` makes `tierOf` apply everything the escalate/noop/halted
     * checks do not already answer. It does not WIDEN what the Supervisor may do: the per-kind
     * rules are code and this only says whether their verdict waits for a person.
     */
    readonly autonomy?: 'propose' | 'act'
    /**
     * F R4 (E10): WHICH runtime answers this project's conversation with the Supervisor -- today
     * the conversation alone. `null` is the installation default (`claude_code`), which is what an
     * unset column has always meant, so clearing is an explicit null rather than an omission.
     */
    readonly provider?: ProviderKind | null
    /** F R4: the model that provider is asked for, or `null` for the installation default
     *  (`SLAVEOFAI_SUPERVISOR_MODEL`, else `SUPERVISOR_DEFAULT_MODEL`). Held to `MODEL_ID_PATTERN`,
     *  the same shape check a staffing preference's model passes -- this product does not own the
     *  list of model names and must not pretend to, but "one word" it can insist on. */
    readonly model?: string | null
  },
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      supervisorEnabled: true,
      supervisorProfile: true,
      supervisorAutonomy: true,
      supervisorProvider: true,
      supervisorModel: true,
    },
  })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

  // BOTH validations before anything is written, and before the "did it move" arithmetic below:
  // a patch carrying one good field and one bad one must write neither, which is the rule the
  // profile cap already states for itself.
  if (patch.provider !== undefined && patch.provider !== null && !isProviderKind(patch.provider)) {
    return err({ kind: 'invalid_provider', provider: patch.provider })
  }
  const model = patch.model === undefined ? undefined : patch.model === null ? null : patch.model.trim()
  if (model !== undefined && model !== null && model !== '' && !MODEL_ID_PATTERN.test(model)) {
    return err({ kind: 'invalid_model', detail: MODEL_SHAPE_DETAIL })
  }
  // An emptied box clears the override, `profile`'s own normalisation: "cleared" is a real state
  // and only `null` says it.
  const nextModel = model === undefined ? undefined : model === '' ? null : model

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
  // E R1, and the same rule as the two above: a re-save of the switch it already carries writes
  // nothing and says nothing, so the timeline does not fill with re-saves of an unchanged form.
  // `undefined` when the patch did not carry it OR carried the value already stored, so the one
  // constant is the whole test -- there is no second state where it is defined and did not move.
  const autonomy = patch.autonomy !== undefined && patch.autonomy !== workspace.supervisorAutonomy ? patch.autonomy : undefined
  const autonomyMoved = autonomy !== undefined
  // F R4, and `profileMoved`'s rule exactly: `null` is a real new value on both halves (the
  // override was cleared back to the installation default), so "moved" is "the patch carried it
  // AND it differs from what is stored".
  const providerMoved = patch.provider !== undefined && patch.provider !== workspace.supervisorProvider
  const modelMoved = nextModel !== undefined && nextModel !== workspace.supervisorModel
  if (!enabledMoved && !profileMoved && !autonomyMoved && !providerMoved && !modelMoved) return ok(undefined)

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      ...(enabledMoved ? { supervisorEnabled: enabled } : {}),
      ...(profileMoved ? { supervisorProfile: nextProfile ?? null } : {}),
      ...(autonomyMoved ? { supervisorAutonomy: autonomy } : {}),
      ...(providerMoved ? { supervisorProvider: patch.provider ?? null } : {}),
      ...(modelMoved ? { supervisorModel: nextModel ?? null } : {}),
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
  if (autonomyMoved) {
    // The EXISTING event, like `supervisorEnabled` before it (M38 t2): this is project
    // configuration, it moves through the same kind of verb, and an operator reading "what changed
    // about this project" wants one stream.
    await appendEvent({
      type: 'workspace.settings_changed',
      workspaceId,
      actor: 'human',
      payload: { field: 'supervisorAutonomy', from: workspace.supervisorAutonomy, to: autonomy },
      userId: principal?.userId ?? null,
    })
  }
  // The pair, in the order a person sets it: a provider, then the model it is asked for. Two
  // events rather than one, because a settings_changed is ONE field's move -- which is what lets
  // the Activity card say "the Supervisor's model changed" without a reader decoding a bag.
  if (providerMoved) {
    await appendEvent({
      type: 'workspace.settings_changed',
      workspaceId,
      actor: 'human',
      payload: { field: 'supervisorProvider', from: workspace.supervisorProvider, to: patch.provider ?? null },
      userId: principal?.userId ?? null,
    })
  }
  if (modelMoved) {
    await appendEvent({
      type: 'workspace.settings_changed',
      workspaceId,
      actor: 'human',
      payload: { field: 'supervisorModel', from: workspace.supervisorModel, to: nextModel ?? null },
      userId: principal?.userId ?? null,
    })
  }
  return ok(undefined)
}
