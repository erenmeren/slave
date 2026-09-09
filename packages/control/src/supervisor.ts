import { createHash } from 'node:crypto'
import { type Prisma, prisma } from '@slave-of-ai/db/client'
import {
  COOLDOWN_MS,
  PENDING_TTL_MS,
  PROFILE_MAX_CHARS,
  actionSchema,
  candidateSchema,
  situationSchema,
  type Action,
  type Candidate,
  type Decider,
  type DecisionStatus,
  type Result,
  type Situation,
  type SituationKind,
  type Tier,
  err,
  ok,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { setRuntimeRoles } from './profile.js'
import type { Principal } from './principal.js'
import { refusalText, type ControlRefusal } from './refusal.js'
import { failTask } from './task.js'
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

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

export interface RecordDecisionInput {
  readonly workspaceId: string
  readonly situation: Situation
  readonly candidates: readonly Candidate[]
  readonly chosenIndex: number
  readonly rationale: string
  readonly decidedBy: Decider
  /** `null` is UNMEASURED (charged at `SUPERVISOR_PER_CALL_CAP_USD` when spend is summed), and is
   *  also what a `rules` decision always carries -- it makes no call at all. */
  readonly modelCostUsd: number | null
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

  const tier = chosen.tier
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
        rationale: input.rationale,
        tier,
        status,
        decidedBy: input.decidedBy,
        modelCostUsd: input.modelCostUsd,
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
 * its `supervisor.decided` event already say everything that happened. `nudge_answer` is the one
 * action whose whole effect IS the event (M38 detects stale questions; M39 answers them).
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
    select: { workspaceId: true, action: true },
  })
  if (row === null) return err({ kind: 'decision_not_found', decisionId })
  const action = parsedOrThrow(actionSchema.safeParse(row.action), `SupervisorDecision ${decisionId}.action`)

  const outcome = await carryOut(action, origin, principal)
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

/** The whole map from the Supervisor's catalogue to this package's verbs. Every arm is an EXISTING
 *  verb: nothing here spawns a run, edits a repository or writes a prompt (spec §1). */
async function carryOut(
  action: Action,
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
      return reached(await setRuntimeRoles(action.slaveId, [...action.roles], SUPERVISOR_ACTOR, origin))
    case 'mark_task_failed':
      return reached(await failTask(action.taskId, action.reason, origin, principal))
    case 'nudge_answer':
      // No verb: M38 escalates a stale question, it does not answer or re-route one (spec §8).
      // The `supervisor.applied` event IS the nudge -- the record that the question was noticed.
      return ok('applied')
    case 'escalate_to_human':
    case 'no_action':
      return ok('none')
  }
}

const reached = (result: Result<void, ControlRefusal>): Result<Reach, ControlRefusal> =>
  result.ok ? ok('applied') : result

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
 * `system` (fix round 1): a person resolved this, and that is what the log should say. The verb the
 * approval applies already runs with `origin: 'human'` for the same reason. `expirePendingDecisions`
 * keeps `system`, because nobody acted there.
 */
export async function approveDecision(
  decisionId: string,
  principal: Principal,
): Promise<Result<void, ControlRefusal>> {
  const claim = await claimPending(decisionId, {
    status: 'approved',
    resolvedAt: new Date(),
    resolvedByUserId: principal.userId,
  })
  if (!claim.ok) return claim

  const applied = await applyDecision(decisionId, 'human', principal)
  if (!applied.ok) return applied

  await appendEvent({
    type: 'supervisor.resolved',
    workspaceId: claim.value.workspaceId,
    // `human`, unlike the rest of the `supervisor.*` events (fix round 1). An approval is a
    // PERSON's act -- the one moment in a proposal's life the Supervisor did not author -- and the
    // envelope actor is what every reader of the log filters on. `userId` names which person, and
    // `resolvedByUserId` keeps the same fact on the row. Only an EXPIRY stays `system`: nobody
    // acted there, which is the whole fact it records.
    actor: 'human',
    payload: { decisionId, outcome: 'approved', reason: null },
    userId: principal.userId,
  })
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
  principal: Principal,
  reason?: string,
): Promise<Result<void, ControlRefusal>> {
  const trimmed = reason?.trim()
  const claim = await claimPending(decisionId, {
    status: 'rejected',
    resolvedAt: new Date(),
    resolvedByUserId: principal.userId,
  })
  if (!claim.ok) return claim

  await appendEvent({
    type: 'supervisor.resolved',
    workspaceId: claim.value.workspaceId,
    // A person's act, like an approval -- see {@link approveDecision} for why this one event
    // departs from the `system` actor the other `supervisor.*` events carry.
    actor: 'human',
    payload: { decisionId, outcome: 'rejected', reason: trimmed === undefined || trimmed === '' ? null : trimmed },
    userId: principal.userId,
  })
  return ok(undefined)
}

/** The one atomic "take this pending decision" both {@link approveDecision} and
 *  {@link rejectDecision} open with: the read is only for the refusal's wording, the `updateMany`
 *  conditional on `status: 'pending'` is what actually decides who won. */
async function claimPending(
  decisionId: string,
  data: { readonly status: DecisionStatus; readonly resolvedAt: Date; readonly resolvedByUserId: string },
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
  readonly rationale: string
  readonly tier: Tier
  readonly status: DecisionStatus
  readonly decidedBy: Decider
  readonly modelCostUsd: number | null
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
    take: opts?.limit ?? DEFAULT_DECISION_LIMIT,
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
    rationale: row.rationale,
    tier: row.tier,
    status: row.status,
    decidedBy: row.decidedBy,
    modelCostUsd: row.modelCostUsd,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  }))
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
