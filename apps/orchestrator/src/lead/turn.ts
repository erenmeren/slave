import { goalSpend, goalWorkedMs, loadLeadRoster } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { buildRosterDefinitions, leadShareUsd, nextLeadLeg, readLeadProgress, type LeadTurn } from '@slave-of-ai/domain'
import { endLead, noteLead, updateLeadProgress } from './record.js'

/** One turn of the lead's session, as `startRun` spawns it. */
export interface LeadTurnRun {
  readonly kind: 'run'
  readonly deliveryId: string
  readonly workspaceId: string
  readonly goalVersion: number
  /** 1-based: the n-th turn of this task. */
  readonly ordinal: number
  readonly turn: LeadTurn
  /** The session this turn continues, or null for a new one. */
  readonly resumeSessionId: string | null
  /** A new session although earlier turns exist: the transcript is gone. */
  readonly continuation: boolean
  readonly note: string | null
  /** This leg's `--max-budget-usd`; null for an unbudgeted goal. */
  readonly capUsd: number | null
  /** This turn is the wrap-up (spec B4). */
  readonly wrapUp: boolean
  /** The `--agents` value; null for an empty roster. */
  readonly definitions: string | null
  readonly roster: readonly { readonly slug: string; readonly description: string }[]
  readonly rosterDropped: readonly string[]
  readonly budget: { readonly totalUsd: number; readonly shareUsd: number; readonly spentUsd: number } | null
  readonly timeLeftMs: number | null
}

export type LeadTurnPlan = { readonly kind: 'hold' } | LeadTurnRun

/**
 * Lead-flow plan A L4/L6: what the lead's next turn is, or `hold`. Held: the version is stopped,
 * abandoned or merged, or the lead is ended. A share or a time limit found spent here ends the lead
 * (`endLead`) and holds. Otherwise: the first turn is `build` with the whole brief; a later one is
 * what was queued for it (`leadProgress.nextTurn`), else `rework` when the task carries a
 * rejection, else `continue` -- and it resumes the newest session of the task, unless the newest
 * turn was a resume that never reached its session line (the transcript is gone).
 */
export async function planLeadTurn(input: {
  readonly task: { readonly id: string; readonly lastRejectionReason: string | null }
  readonly deliveryId: string
}): Promise<LeadTurnPlan> {
  const delivery = await prisma.goalDelivery.findUniqueOrThrow({
    where: { id: input.deliveryId },
    include: { workspace: { select: { budgetUsd: true, goalTimeLimitMs: true, leadRoster: true } } },
  })
  const progress = readLeadProgress(delivery.leadProgress)
  if (delivery.status === 'needs_human' || delivery.status === 'abandoned' || delivery.mergedAt !== null || progress.leadEnded !== null) return { kind: 'hold' }

  const spend = await goalSpend(delivery.workspaceId, delivery.goalVersion)
  // A leg that ended on its cap queues the wrap-up itself (`concludeLeadTurn`): the vendor may stop
  // a few cents short of the mark, and the turn after a capped leg is the wrap-up whatever the sum says.
  const queuedWrapUp = progress.nextTurn?.kind === 'wrap_up' && !progress.wrapUpSent
  // Task 5 review: a leg never eats the proof reserve -- what proof already spent is counted too.
  const leg = nextLeadLeg({ budgetUsd: delivery.workspace.budgetUsd, leadSpentUsd: spend.leadUsd, proofSpentUsd: spend.proofUsd, wrapUpSent: progress.wrapUpSent || queuedWrapUp })
  if (leg.kind === 'spent') {
    // C7: a turn that ended with no cost and no later total of its session is not in the sum.
    const spent = `${spend.unmeasuredRuns > 0 ? 'at least ' : ''}$${spend.leadUsd.toFixed(2)}`
    await endLead(delivery.id, 'budget_spent', `the lead's share of the budget is spent (${spent})`)
    return { kind: 'hold' }
  }
  const limit = delivery.workspace.goalTimeLimitMs
  const timeLeftMs = limit === null ? null : limit - (await goalWorkedMs(delivery.workspaceId, delivery.goalVersion))
  if (timeLeftMs !== null && timeLeftMs <= 0) {
    await endLead(delivery.id, 'time_spent', `the goal's time limit of ${String(Math.round((limit ?? 0) / 60_000))} minutes is reached`)
    return { kind: 'hold' }
  }

  const earlier = await prisma.slaveRun.findMany({
    where: { taskId: input.task.id, leadTurn: { not: null } },
    orderBy: { startedAt: 'desc' },
    select: { sessionId: true, leadResumed: true, status: true, pid: true },
  })
  const newest = earlier[0]
  // A resume that was spawned (it has a pid) and failed before its session line: no transcript.
  const lost = newest !== undefined && newest.leadResumed && newest.sessionId === null && newest.status === 'failed' && newest.pid !== null
  const session = lost ? null : (earlier.find((run) => run.sessionId !== null)?.sessionId ?? null)
  const first = earlier.length === 0
  const queued = progress.nextTurn
  const wrapUp = leg.wrapUp || queuedWrapUp
  const turn: LeadTurn = first ? 'build' : wrapUp ? 'wrap_up' : (queued?.kind ?? (input.task.lastRejectionReason !== null ? 'rework' : 'continue'))
  // What came back for this turn: what was queued, else the rejection the task carries (a
  // verifier's evidence survives a turn that crashed before it could act on it).
  const note = first ? null : queued !== null && queued.note !== '' ? queued.note : input.task.lastRejectionReason

  const built = buildRosterDefinitions(await loadLeadRoster(delivery.workspace.leadRoster))
  const definitions = built.json === null ? {} : (JSON.parse(built.json) as Record<string, { readonly description: string }>)
  const total = delivery.workspace.budgetUsd
  return {
    kind: 'run',
    deliveryId: delivery.id,
    workspaceId: delivery.workspaceId,
    goalVersion: delivery.goalVersion,
    ordinal: earlier.length + 1,
    turn,
    resumeSessionId: session,
    continuation: !first && session === null,
    note,
    capUsd: leg.capUsd,
    wrapUp,
    definitions: built.json,
    roster: [...built.slugs.keys()].map((slug) => ({ slug, description: definitions[slug]?.description ?? '' })),
    rosterDropped: built.dropped,
    budget: total === null ? null : { totalUsd: total, shareUsd: leadShareUsd(total), spentUsd: spend.leadUsd },
    timeLeftMs,
  }
}

/**
 * The turn was spawned: what was queued for it is consumed, a wrap-up is marked sent, and the turn
 * is recorded -- which session it runs on is the record spec B6 asks for.
 */
export async function noteLeadTurnStarted(plan: LeadTurnRun, runId: string): Promise<void> {
  await updateLeadProgress(plan.deliveryId, (progress) => ({ ...progress, nextTurn: null, wrapUpSent: progress.wrapUpSent || plan.wrapUp }))
  const session =
    plan.resumeSessionId !== null ? 'the same session was resumed' : plan.continuation ? 'a new session was started; the earlier transcript is gone' : 'a new session was started'
  const at = { workspaceId: plan.workspaceId, version: plan.goalVersion, runId }
  await noteLead({ ...at, kind: 'turn', detail: `turn ${String(plan.ordinal)} (${plan.turn}): ${session}` })
  if (plan.wrapUp) await noteLead({ ...at, kind: 'wrap_up', detail: 'the lead reached four fifths of its share of the budget and was told to wrap up' })
  if (plan.rosterDropped.length > 0) await noteLead({ ...at, kind: 'roster_dropped', detail: `not passed to the lead, the definitions did not fit: ${plan.rosterDropped.join(', ')}` })
}
