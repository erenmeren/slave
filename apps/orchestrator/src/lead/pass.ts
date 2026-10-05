import { everyPackageIntegrated, goalWorkedMs, isAlive, signalRun } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { STOP_REASONS, leadStateOf, readLeadProgress, runId as brandRunId, type StopReason } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { resolveAdapter } from '../provider.js'
import type { TickDeps } from '../tick.js'
import { settleLeadWork } from './conclude.js'
import { endLead } from './record.js'
import { stopLead } from './stop.js'

const asStopReason = (value: string | null): StopReason | null => ((STOP_REASONS as readonly string[]).includes(value ?? '') ? (value as StopReason) : null)

/**
 * Lead-flow spec section 3 (plan A L14): the state word of every lead-flow version of a project,
 * derived from its row (`leadStateOf`) and stored when it changed, with one `workspace.lead_state`
 * per change. Also where a stop reason is completed: a version that merged with none is `proven`, a
 * stop with none (the existing cap on unusable verification runs) is `proof_unusable`, an abandoned
 * one is `left`; a version sent round again loses its old reason. Nothing for a project that is not
 * in the lead flow: its finished lead versions were final when it left.
 */
export async function syncLeadStates(workspaceId: string): Promise<void> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { flow: true, autoMerge: true } })
  if (workspace?.flow !== 'lead') return
  const deliveries = await prisma.goalDelivery.findMany({
    where: {
      workspaceId,
      OR: [{ leadState: { notIn: ['delivered', 'stopped'] } }, { leadState: null, mergedAt: null, status: { not: 'abandoned' } }],
    },
    select: { id: true, goalVersion: true, status: true, mergedAt: true, mergeError: true, leadState: true, stopReason: true },
  })
  for (const delivery of deliveries) {
    const state = leadStateOf({
      status: delivery.status,
      merged: delivery.mergedAt !== null,
      integrated: await everyPackageIntegrated(workspaceId, delivery.goalVersion),
      autoMerge: workspace.autoMerge,
      mergeFailed: delivery.mergeError !== null,
    })
    const reason =
      state === 'building' || state === 'proving'
        ? delivery.status === 'accepted'
          ? delivery.stopReason
          : null
        : state === 'delivered'
          ? (delivery.stopReason ?? 'proven')
          : state === 'stopped'
            ? (delivery.stopReason ?? 'left')
            : delivery.status === 'needs_human'
              ? (delivery.stopReason ?? 'proof_unusable')
              : delivery.stopReason
    if (state === delivery.leadState && reason === delivery.stopReason) continue
    // Compare-and-set on both columns (task 10 review): a reason written meanwhile -- `left` by a
    // person's Reject, `accepted_as_is` by their Approve -- is not overwritten by this pass's read.
    const moved = await prisma.goalDelivery.updateMany({ where: { id: delivery.id, leadState: delivery.leadState, stopReason: delivery.stopReason }, data: { leadState: state, stopReason: reason } })
    if (moved.count > 0 && state !== delivery.leadState) {
      await appendEvent({ type: 'workspace.lead_state', workspaceId, actor: 'system', payload: { version: delivery.goalVersion, state, reason: asStopReason(reason) } })
    }
  }
}

/** The run statuses a live process can be in (the sweep's own set, less `stopping`). */
const LIVE = ['starting', 'working', 'pause_requested', 'resuming'] as const

/**
 * Lead-flow spec B4 (plan A L6/L7): the goal's own limits, checked on every goal pass for a version
 * still `integrating` or `verifying`.
 *
 * - The lead's task ran out of attempts where no conclusion saw it (a spawn that never worked): the
 *   version stops `lead_failed`.
 * - The goal's working time is past its limit: the lead is ended (`time_spent`).
 * - An ended lead (time here, the budget share in `planLeadTurn` / `concludeLeadTurn`) gets no
 *   further turn: a live turn is cancelled, the sweep's way -- claimed `stopping`, then the
 *   adapter's cancel, the pid if that fails -- and its conclusion settles what is committed; a task
 *   holding no claim is settled here, from its newest turn's worktree; a lead that never ran built
 *   nothing, and the version stops with the reason it was ended for.
 *
 * A paused turn (a person's stop) is left alone: its claim stands until the person continues it.
 *
 * An accepted version is checked too while its lead's task is not done (task 10 review): a base
 * turn (plan A L15) pending or running. Past the limit the lead is ended and a live base turn is
 * cancelled; a pending one is never started, and `leadTakeBaseIn` leaves the version to the hand
 * merge.
 */
export async function enforceLeadLimits(deps: TickDeps, deliveryId: string): Promise<void> {
  const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { workspace: { select: { goalTimeLimitMs: true } } } })
  // Task 10 review: an accepted version still waiting to merge is held by the limits too, while its
  // lead has a base turn pending or running (plan A L15).
  const accepted = delivery.status === 'accepted' && delivery.mergedAt === null
  if (delivery.status !== 'integrating' && delivery.status !== 'verifying' && !accepted) return
  const task = await prisma.task.findFirst({ where: { workspaceId: delivery.workspaceId, workPackage: { goalVersion: delivery.goalVersion } } })
  if (task === null) return
  if (accepted && (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled')) return

  let ended = readLeadProgress(delivery.leadProgress).leadEnded
  const limit = delivery.workspace.goalTimeLimitMs
  if (ended === null && task.status !== 'failed' && limit !== null && (await goalWorkedMs(delivery.workspaceId, delivery.goalVersion)) >= limit) {
    await endLead(delivery.id, 'time_spent', `the goal's time limit of ${String(Math.round(limit / 60_000))} minutes is reached`)
    ended = 'time_spent'
  }
  // A task out of attempts stops the version -- under the reason the lead was ended for when it was
  // (task 8 review): a turn the limit cut short is not why the goal stopped.
  if (task.status === 'failed') {
    await stopLead(delivery.id, ended ?? 'lead_failed', task.lastRejectionReason)
    return
  }
  if (ended === null) return

  if (task.activeRunId !== null) {
    const live = await prisma.slaveRun.findUnique({ where: { id: task.activeRunId }, select: { id: true, leadTurn: true, pid: true, provider: true } })
    if (live === null || live.leadTurn === null) return
    // `platform`, as the sweep's clock-jump claim is (task 8 review): the goal's limit cut the turn
    // short, not the lead, so whoever concludes it -- the pump, or the sweep's stopping arm when the
    // process is gone -- charges no attempt.
    const claimed = await prisma.slaveRun.updateMany({ where: { id: live.id, status: { in: [...LIVE] } }, data: { status: 'stopping', failureClass: 'platform' } })
    if (claimed.count === 0) return
    try {
      await resolveAdapter(deps.registry, live.provider ?? 'claude_code').cancel(brandRunId(live.id))
    } catch {
      // Another process spawned it: the pid on the row is what is left to stop it by.
      if (live.pid !== null && live.pid !== process.pid && isAlive(live.pid)) signalRun(live.pid, 'SIGKILL')
    }
    return
  }
  // An accepted version's pending base turn is left to `leadTakeBaseIn`: with the lead ended it
  // marks the task done, and the verified work waits for the hand merge.
  if (accepted || (task.status !== 'ready' && task.status !== 'rework')) return

  const last = await prisma.slaveRun.findFirst({
    where: { taskId: task.id, leadTurn: { not: null }, worktreePath: { not: null } },
    orderBy: { startedAt: 'desc' },
    include: { task: { include: { workspace: true } }, slave: { select: { id: true, person: { select: { name: true } } } } },
  })
  if (last === null || last.task === null) {
    await stopLead(delivery.id, ended, 'the lead never started a turn')
    return
  }
  await settleLeadWork(last, last.task, { idle: true })
}
