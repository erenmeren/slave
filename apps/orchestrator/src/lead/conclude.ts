import { prisma, type Prisma } from '@slave-of-ai/db/client'
import type { RunId } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { integrationTargetFor } from '../goalBranch.js'
import { releaseTaskAfterFailure } from '../taskRelease.js'
import { emailLocalPart, taskKeyFor } from '../tick.js'
import { commitUncommittedWork } from '../wipCommit.js'
import { gitIn } from '../worktree.js'
import { noteLead, updateLeadProgress } from './record.js'
import { stopLead } from './stop.js'

const runInclude = { task: { include: { workspace: true } }, slave: { select: { id: true, person: { select: { name: true } } } } } as const
export type LeadRunRow = Prisma.SlaveRunGetPayload<{ include: typeof runInclude }>
export type LeadTaskRow = NonNullable<LeadRunRow['task']>

/**
 * Lead-flow spec B1 (plan A L5): what a concluded lead turn means for its task. Never `advance`:
 * no workspace verify command, no ownership audit, no report block, no review. A succeeded turn's
 * work is integrated ({@link settleLeadWork}) and the goal pass proves it. A failed turn releases
 * the task as any failed implementation run does. Replay-safe: only the run holding the task's
 * claim concludes anything.
 */
export async function concludeLeadTurn(runId: RunId): Promise<void> {
  const run = await prisma.slaveRun.findUnique({ where: { id: runId }, include: runInclude })
  if (run === null || run.task === null || run.leadTurn === null) return
  const task = run.task
  if (task.activeRunId !== run.id) return

  if (run.status === 'failed') {
    const release = await releaseTaskAfterFailure(task, run.id, 'rework', { platform: run.failureClass === 'platform' })
    if (release.exhausted) {
      await appendEvent({ type: 'task.failed', workspaceId: task.workspaceId, taskId: task.id, actor: 'system', payload: { reason: `the lead's turn failed after ${String(release.attempt)} attempt(s)` } })
    }
    return
  }
  if (run.status !== 'succeeded') return
  await settleLeadWork(run, task)
}

/**
 * Task 6 review: moves the goal's work branch to the lead's tip, never throwing. The work branch is
 * the lead's own and the final full verification proves whatever tip is delivered, so a lead tip
 * that does not contain the work branch's tip (the lead amended, rebased or reset commits already
 * integrated) is followed too, and said (`rewritten`). The move is a compare-and-swap on the ref;
 * one that loses is retried once on the re-read tip, then given up (`lost`).
 */
async function followLeadBranch(repoPath: string, branch: string, tip: string, workTip: string): Promise<'moved' | 'rewritten' | 'lost'> {
  let expected = workTip
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (expected === tip) return 'moved'
    // Exit 1 is "not an ancestor"; any other failure reads the same way: the move is said.
    const contains = await gitIn(repoPath, 'merge-base', '--is-ancestor', expected, tip).then(
      () => true,
      () => false,
    )
    const swapped = await gitIn(repoPath, 'update-ref', `refs/heads/${branch}`, tip, expected).then(
      () => true,
      () => false,
    )
    if (swapped) return contains ? 'moved' : 'rewritten'
    const reread = await gitIn(repoPath, 'rev-parse', `refs/heads/${branch}`).catch(() => null)
    if (reread === null) return 'lost'
    expected = reread
  }
  return 'lost'
}

/**
 * Integrates what the lead committed and hands the version to proof: leftover work is committed
 * under the lead's identity, the goal's work branch is moved to the lead's branch tip
 * ({@link followLeadBranch}: a compare-and-swap; a lead that rewrote integrated commits is followed
 * and said), and the task is `done` and integrated -- which is what the goal pass waits for. Both
 * branches still at the commit the goal was cut at is "nothing was built": the version stops and no
 * proof starts. Never throws on what git says about the two branches: a throw here would leave the
 * task holding a finished run's claim, to be sent back and fail the same way, turn after turn.
 */
export async function settleLeadWork(run: LeadRunRow, task: LeadTaskRow): Promise<'settled' | 'nothing_built' | 'unreadable'> {
  const target = await integrationTargetFor(task.id)
  if (target === null || run.worktreePath === null || task.branch === null) {
    console.warn(`[lead] run ${run.id} has no ${target === null ? 'goal version' : run.worktreePath === null ? 'worktree' : 'branch'} recorded: not settling`)
    return 'unreadable'
  }
  const repoPath = task.workspace.repoPath
  const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: target.deliveryId } })

  const wip = await commitUncommittedWork({
    worktreePath: run.worktreePath,
    branch: task.branch,
    taskKey: taskKeyFor(task.id),
    identity: { name: run.slave.person.name, email: `${emailLocalPart({ id: run.slave.id, name: run.slave.person.name })}@slaveofai.local` },
  })
  if (wip.kind === 'committed') console.warn(`[lead] run ${run.id} left uncommitted work; committed it for the lead as ${wip.sha.slice(0, 12)}`)
  if (wip.kind === 'skipped' || wip.kind === 'failed') console.warn(`[lead] run ${run.id} left uncommitted work that could not be committed (${wip.kind}): ${wip.reason}`)

  const tip = await gitIn(repoPath, 'rev-parse', `refs/heads/${task.branch}`)
  const workTip = await gitIn(repoPath, 'rev-parse', `refs/heads/${target.branch}`)
  // Nothing built: the lead's branch AND the work branch are still at the cut. A later turn that
  // reset its branch to the cut while earlier work is on the work branch rewrote its branch instead.
  if (tip === delivery.baseCommit && workTip === delivery.baseCommit) {
    // Spec section 9: the claim goes back first, so nothing holds the task while the version waits.
    await prisma.task.updateMany({ where: { id: task.id, activeRunId: run.id }, data: { status: 'rework', activeRunId: null } })
    await stopLead(delivery.id, 'nothing_built', null)
    return 'nothing_built'
  }
  if (tip !== workTip) {
    const followed = await followLeadBranch(repoPath, target.branch, tip, workTip)
    if (followed === 'lost') {
      // The work branch kept moving under two compare-and-swaps: nothing is integrated, and the
      // turn is not the lead's fault -- the claim goes back with no attempt charged, as for a
      // platform failure, and the next turn settles again.
      console.warn(`[lead] run ${run.id}: the work branch ${target.branch} moved twice while it was being set to ${tip.slice(0, 12)}; released for another turn`)
      await releaseTaskAfterFailure(task, run.id, 'rework', { platform: true })
      return 'unreadable'
    }
    if (followed === 'rewritten') {
      await noteLead({
        workspaceId: task.workspaceId,
        version: target.goalVersion,
        kind: 'branch_rewritten',
        detail: "the lead rewrote commits the work branch already had; the work branch now follows the lead's branch",
        runId: run.id,
      })
    }
  }

  const done = await prisma.task.updateMany({
    where: { id: task.id, activeRunId: run.id },
    data: { status: 'done', integratedAt: new Date(), activeRunId: null, lastRejectionReason: null },
  })
  if (done.count === 0) return 'settled'
  await updateLeadProgress(delivery.id, (progress) => ({ ...progress, nextTurn: null }))
  await appendEvent({ type: 'task.done', workspaceId: task.workspaceId, taskId: task.id, actor: 'system', payload: { branch: task.branch } })
  return 'settled'
}
