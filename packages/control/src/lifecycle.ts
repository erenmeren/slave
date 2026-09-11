import { prisma } from '@slave-of-ai/db/client'
import { TERMINAL, err, ok, type Result, type SlaveLifecycle } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { collectTaskWorktree } from './collect.js'
import { lockSlave } from './org.js'
import type { Principal } from './principal.js'
import { refusalText, type ControlRefusal } from './refusal.js'
import { liveRunCount } from './workspace.js'

/** How much of a release reason is stored. The three callers all supply a sentence -- the
 *  Supervisor's own situation summary, an operator's `--reason`, the route's `z.string().min(1)` --
 *  so this is a cap, not a validation (plan decision D4). */
const RELEASE_REASON_MAX = 500

/** What a release is recorded with when the caller's sentence is blank. NOT a refusal (D4 stands):
 *  the release itself is the fact, and `slave.released`'s payload schema is `z.string().min(1)` --
 *  a blank reason committed to the column would leave the write done and the EVENT refused, which
 *  is the one outcome this verb must never produce (fix round 1, Important 1). */
const RELEASE_REASON_FALLBACK = 'released'

/**
 * The end of one worker's engagement (M50 R3). NEVER a deletion.
 *
 * Four refusals, every one of them returned BEFORE the first write in the transaction, so all four
 * are values rather than thrown rollbacks: the worker is gone, the worker is not `ephemeral`, the
 * engagement is already over, or a run is still live.
 *
 * What it writes is exactly three columns: `releasedAt`, `releaseReason`, and `runtimeRoles = []`.
 * That empty set is the WHOLE of how a released worker stops being dispatched -- `decide()` is
 * untouched by this milestone and `loadSlaveRows` still loads every row in the workspace, because a
 * second filter would be a second rule to keep in step with the first (spec R3). Everything else
 * the worker has is left: its capabilities are what it did here, its rationale is why it came, and
 * its runs, contexts, checkpoints, messages and memories are the record (R5).
 *
 * The worktrees are collected AFTER the transaction commits, one `collectTaskWorktree` call per
 * terminal task, each inside its own `try` (plan decision D10). Two reasons, and both matter:
 * `collectTaskWorktree` opens its own transaction and the two must never nest (ADR 0003), and this
 * verb is carried out by a TICK -- `tierOf` makes `release_worker` `applied` -- so a tree `git`
 * refused to remove must be a line in the log and a number in the payload, never an exception out
 * of the Supervisor's apply path.
 *
 * `origin` is the event ENVELOPE actor, the same closed pair `setRuntimeRoles` takes
 * (`profile.ts:201`) and for the same reason: `principal` says WHICH person, when one can be named,
 * and is a different fact from whether a person is behind the change at all. `carryOut` passes the
 * decision's own origin -- `system` on a tick, `human` only when somebody approved a proposal a
 * halt had demoted -- and the CLI and the route take the default.
 */
export async function releaseWorker(
  slaveId: string,
  reason: string,
  principal?: Principal,
  origin: 'human' | 'system' = 'human',
): Promise<Result<{ readonly worktreesCollected: number }, ControlRefusal>> {
  // Normalised BEFORE the transaction, so the column and the event carry the SAME text and neither
  // can be written without the other (fix round 1, Important 1).
  const trimmed = reason.trim()
  const recorded = (trimmed === '' ? RELEASE_REASON_FALLBACK : trimmed).slice(0, RELEASE_REASON_MAX)

  const plan = await prisma.$transaction(async (tx) => {
    const slave = await lockSlave(tx, slaveId)
    if (slave === null) return { refusal: { kind: 'slave_not_found', slaveId } as ControlRefusal }
    if (slave.lifecycle !== 'ephemeral') {
      return { refusal: { kind: 'not_ephemeral', slaveId, lifecycle: slave.lifecycle } as ControlRefusal }
    }
    if (slave.releasedAt !== null) {
      return { refusal: { kind: 'already_released', slaveId, at: slave.releasedAt.toISOString() } as ControlRefusal }
    }
    const live = await liveRunCount(tx, { slaveId })
    if (live > 0) {
      return { refusal: { kind: 'live_runs', entity: 'slave', id: slaveId, runs: live } as ControlRefusal }
    }

    await tx.slave.update({
      where: { id: slaveId },
      data: { releasedAt: new Date(), releaseReason: recorded, runtimeRoles: [] },
    })

    // The tasks whose worktrees this worker's runs are still holding: terminal, with a path on the
    // row. Read inside the lock so the list cannot grow under the release; collected outside it.
    const runs = await tx.slaveRun.findMany({
      where: { slaveId, worktreePath: { not: null }, task: { status: { in: [...TERMINAL] } } },
      select: { taskId: true },
      orderBy: { id: 'asc' },
    })
    return {
      workspaceId: slave.team.workspaceId,
      name: slave.name,
      taskIds: [...new Set(runs.flatMap((run) => (run.taskId === null ? [] : [run.taskId])))],
    }
  })
  if ('refusal' in plan) return err(plan.refusal)

  let worktreesCollected = 0
  for (const taskId of plan.taskIds) {
    try {
      const collected = await collectTaskWorktree(taskId, 'released', principal)
      if (collected.ok) worktreesCollected += 1
      else console.warn(`releaseWorker: leaving task ${taskId}'s worktree in place: ${refusalText(collected.error)}`)
    } catch (error) {
      console.warn(
        `releaseWorker: leaving task ${taskId}'s worktree in place: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  await appendEvent({
    type: 'slave.released',
    workspaceId: plan.workspaceId,
    slaveId,
    actor: origin,
    payload: { slaveId, name: plan.name, reason: recorded, worktreesCollected },
    userId: principal?.userId ?? null,
  })

  return ok({ worktreesCollected })
}

/**
 * A person moves a worker between lifecycles (M50 R4). The ONLY path that changes the column after
 * creation: nothing promotes a worker automatically, and a tick that did would be the Supervisor
 * deciding who works here.
 *
 * Human-only by construction (plan decision D11): no `origin`, no `carryOut` arm, no Supervisor
 * action, `actor: 'human'` on the event -- the shape `renameSlave` and `setSlaveRole` already have.
 *
 * Leaving `ephemeral` clears the engagement AND the release with it: a worker that is no longer
 * temporary has no one assignment to be over, and a `releasedAt` left behind would keep it off every
 * roster while its lifecycle said it belonged there. Nothing is restored -- the runtime roles are a
 * person's own call through `set-runtime-roles`, which is exactly what R4 says.
 *
 * Moving INTO `ephemeral` writes no engagement, deliberately (fix round 1, Minor 4): such a worker
 * never raises `engagement_over` -- the rule needs a terminal engagement task -- and the person who
 * labelled it releases it themselves with `release-worker`, which asks for no engagement.
 */
export async function setLifecycle(
  slaveId: string,
  lifecycle: SlaveLifecycle,
  principal?: Principal,
): Promise<Result<{ readonly from: SlaveLifecycle; readonly to: SlaveLifecycle }, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    const slave = await lockSlave(tx, slaveId)
    if (slave === null) return { refusal: { kind: 'slave_not_found', slaveId } as ControlRefusal }
    const live = await liveRunCount(tx, { slaveId })
    if (live > 0) {
      return { refusal: { kind: 'live_runs', entity: 'slave', id: slaveId, runs: live } as ControlRefusal }
    }
    // The no-move BEFORE the roster check (fix round 1, Minor 1): `companySlaveId` is `SetNull`, so
    // a permanent worker whose roster row was deleted is still permanent -- and asking for the
    // lifecycle it already has must be the no-op it is, never a refusal about a change nobody made.
    const from = slave.lifecycle
    if (from === lifecycle) return { workspaceId: slave.team.workspaceId, from, changed: false as const }
    // `permanent` is not a label somebody may apply: it MEANS "this worker exists in the company
    // roster", and the roster link is the only thing that can say so.
    if (lifecycle === 'permanent' && slave.companySlaveId === null) {
      return { refusal: { kind: 'not_in_roster', slaveId } as ControlRefusal }
    }
    await tx.slave.update({
      where: { id: slaveId },
      data: {
        lifecycle,
        ...(from === 'ephemeral' ? { engagementTaskId: null, releasedAt: null, releaseReason: null } : {}),
      },
    })
    return { workspaceId: slave.team.workspaceId, from, changed: true as const }
  })
  if ('refusal' in outcome) return err(outcome.refusal)

  if (outcome.changed) {
    await appendEvent({
      type: 'org.changed',
      workspaceId: outcome.workspaceId,
      slaveId,
      actor: 'human',
      payload: { entity: 'slave', id: slaveId, field: 'lifecycle', from: outcome.from, to: lifecycle },
      userId: principal?.userId ?? null,
    })
  }

  return ok({ from: outcome.from, to: lifecycle })
}
