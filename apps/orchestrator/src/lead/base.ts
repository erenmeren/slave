import { existsSync } from 'node:fs'
import { withDeliveryLock } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { LEAD_BASE_MERGES_MAX, readLeadProgress, type LeadProgress } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { emailLocalPart } from '../tick.js'
import { gitIn } from '../worktree.js'
import { noteLead, noteLeadOnce, progressJson, updateLeadProgress } from './record.js'

const isAncestor = (repoPath: string, ancestor: string, of: string): Promise<boolean> =>
  gitIn(repoPath, 'merge-base', '--is-ancestor', ancestor, of).then(
    () => true,
    () => false,
  )

/** The first line of what a failed git call said: its stderr, else the error's own message. */
function gitError(error: unknown): string {
  const stderr = typeof error === 'object' && error !== null ? (error as { readonly stderr?: unknown }).stderr : undefined
  const text = typeof stderr === 'string' && stderr.trim() !== '' ? stderr : error instanceof Error ? error.message : String(error)
  return text.trim().split('\n')[0] ?? ''
}

/** `git rev-parse` of `ref` in `cwd`, or null when git cannot name it. */
const revParse = (cwd: string, ref: string): Promise<string | null> => gitIn(cwd, 'rev-parse', '--verify', '--quiet', ref).catch(() => null)

/**
 * What a reopened version checks again: the whole set. A base taken in changes the tree, so what an
 * earlier round failed, or what waited for the confirmer, is no longer the question (task 9 review).
 */
const reopened = (progress: LeadProgress): LeadProgress => ({ ...progress, recheckKeys: [], failing: [], confirm: null })

/**
 * Lead-flow spec D3 (plan A L15): an accepted lead-flow version whose base branch moved since the
 * cut. The final merge is a fast-forward of exactly the verified commit, so the base must be INSIDE
 * the work branch first -- and the merged tree must be verified in full.
 *
 * - `unmoved`: nothing to do here (the base did not move, the version is already in it, it was
 *   accepted as it is, or the bound is spent) -- the existing merge step decides, and for a moved
 *   base that is its "merge by hand" wait.
 * - `taken`: the base merged into the lead's branch cleanly, in the lead's worktree and under the
 *   lead's name; the work branch was fast-forwarded and `baseCommit` moved. The next pass finds the
 *   tip past the verified commit and sends the version round again (`reopenIfMovedInLock`).
 * - `turn`: the merge conflicted and was aborted; the lead's task went back with the turn `base`.
 * - `waiting`: that turn is pending or running.
 *
 * At most `LEAD_BASE_MERGES_MAX` per version, clean or not. An ended lead gets no base turn.
 *
 * Called from the goal pass, so it never throws on what git says: a branch git cannot read, a
 * worktree that is gone, not on the lead's branch or not clean, a merge that failed for any reason
 * but a conflict, a work branch that moved under the fast-forward -- each is `unmoved`, and the
 * merge step's own wait tells the person; the next pass tries again. Each such cause is one line
 * for the report, said once per version (task 10 review), not a log line every pass.
 */
export async function leadTakeBaseIn(deliveryId: string): Promise<'unmoved' | 'taken' | 'turn' | 'waiting'> {
  const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { workspace: { select: { repoPath: true, baseBranch: true } } } })
  if (delivery.status !== 'accepted' || delivery.mergedAt !== null || delivery.stopReason === 'accepted_as_is') return 'unmoved'
  const { repoPath, baseBranch } = delivery.workspace
  const at = { workspaceId: delivery.workspaceId, version: delivery.goalVersion }
  const notTaken = async (cause: string): Promise<'unmoved'> => {
    await noteLeadOnce({ ...at, kind: 'base_taken', detail: `${baseBranch} was not taken into the work branch: ${cause}; the version waits for a hand merge` })
    return 'unmoved'
  }
  const baseTip = await revParse(repoPath, `refs/heads/${baseBranch}^{commit}`)
  const workTip = await revParse(repoPath, `refs/heads/${delivery.integrationBranch}^{commit}`)
  if (baseTip === null || workTip === null) return notTaken(`${baseTip === null ? baseBranch : delivery.integrationBranch} cannot be read`)
  if (baseTip === delivery.baseCommit) return 'unmoved'
  // Already in the base branch: the merge step records it.
  if (await isAncestor(repoPath, workTip, baseTip)) return 'unmoved'

  const task = await prisma.task.findFirst({ where: { workspaceId: delivery.workspaceId, workPackage: { goalVersion: delivery.goalVersion } } })
  if (task === null || task.branch === null) return 'unmoved'
  const progress = readLeadProgress(delivery.leadProgress)
  // A lead whose base turn ran out of attempts, or a task taken off the board: the verified work stands.
  if (task.status === 'failed' || task.status === 'cancelled') return 'unmoved'
  if (task.status !== 'done') {
    if (task.activeRunId !== null || progress.leadEnded === null) return 'waiting'
    // The lead was ended before it could take the base in: its verified work stands, and a person merges by hand.
    await prisma.task.updateMany({ where: { id: task.id, activeRunId: null, status: { in: ['ready', 'rework'] } }, data: { status: 'done', integratedAt: new Date(), lastRejectionReason: null } })
    return 'unmoved'
  }
  if (progress.baseMerges >= LEAD_BASE_MERGES_MAX || progress.leadEnded !== null) return 'unmoved'

  const run = await prisma.slaveRun.findFirst({
    where: { taskId: task.id, leadTurn: { not: null }, worktreePath: { not: null } },
    orderBy: { startedAt: 'desc' },
    select: { worktreePath: true, slave: { select: { id: true, person: { select: { name: true } } } } },
  })
  if (run === null || run.worktreePath === null) return 'unmoved'
  const worktree = run.worktreePath
  // The merge lands on the lead's branch only if its worktree is there and on that branch.
  const head = existsSync(worktree) ? await gitIn(worktree, 'symbolic-ref', '--quiet', 'HEAD').catch(() => null) : null
  if (head !== `refs/heads/${task.branch}`) return notTaken(`the lead's worktree ${worktree} is gone or not on its branch ${task.branch}`)
  // A tree with changes nobody committed is not merged into: the merge could take them in, or refuse.
  const status = await gitIn(worktree, 'status', '--porcelain').catch(() => null)
  if (status === null) return notTaken(`the lead's worktree ${worktree} cannot be read`)
  if (status !== '') return notTaken(`the lead's worktree ${worktree} has changes nobody committed`)
  const name = run.slave.person.name
  const email = `${emailLocalPart({ id: run.slave.id, name })}@slaveofai.local`

  let failure: unknown = null
  try {
    await gitIn(worktree, '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'merge', '--no-stat', '--no-edit', '--no-verify', `refs/heads/${baseBranch}`)
  } catch (error) {
    failure = error
  }

  if (failure !== null) {
    // A conflict leaves the merge in progress (MERGE_HEAD); any other failure (a lock, a full disk,
    // a dirty tree git refused to touch) is not the lead's to resolve.
    const conflicted = (await revParse(worktree, 'MERGE_HEAD')) !== null
    await gitIn(worktree, 'merge', '--abort').catch(() => {})
    if (!conflicted) return notTaken(`merging it failed without a conflict (${gitError(failure)})`)
    const reason = `the base branch ${baseBranch} moved and no longer merges cleanly into the work branch`
    const sent = await prisma.task.updateMany({ where: { id: task.id, status: 'done' }, data: { status: 'rework', integratedAt: null, lastRejectionReason: reason } })
    if (sent.count === 0) return 'waiting'
    await updateLeadProgress(delivery.id, (p) => ({ ...reopened(p), baseMerges: p.baseMerges + 1, nextTurn: { kind: 'base', note: '' } }))
    await appendEvent({ type: 'task.rework', workspaceId: delivery.workspaceId, taskId: task.id, actor: 'system', payload: { reason, attempt: task.attempt } })
    await noteLead({ ...at, kind: 'base_taken', detail: `${baseBranch} moved and conflicts with the work branch; the lead takes it in` })
    return 'turn'
  }

  const tip = await revParse(repoPath, `refs/heads/${task.branch}^{commit}`)
  // Compare-and-swap: only the lead writes the work branch, so a lost swap is a pass that raced
  // this one; the merge commit stays on the lead's branch and the next pass swaps it in.
  if (tip === null) return notTaken(`the lead's branch ${task.branch} cannot be read`)
  const swapFailed = await gitIn(repoPath, 'update-ref', `refs/heads/${delivery.integrationBranch}`, tip, workTip).then(
    () => null,
    (error: unknown) => gitError(error),
  )
  if (swapFailed !== null) return notTaken(`the work branch could not be moved to the merged tip (${swapFailed})`)
  // One write, under the lock: the new base and the reopened progress land together.
  await withDeliveryLock(delivery.id, async (tx) => {
    const row = await tx.goalDelivery.findUniqueOrThrow({ where: { id: delivery.id }, select: { leadProgress: true } })
    const current = readLeadProgress(row.leadProgress)
    await tx.goalDelivery.update({ where: { id: delivery.id }, data: { baseCommit: baseTip, leadProgress: progressJson({ ...reopened(current), baseMerges: current.baseMerges + 1 }) } })
  })
  await noteLead({ ...at, kind: 'base_taken', detail: `${baseBranch} moved; it was merged into the work branch cleanly, and the merged tree is verified in full` })
  return 'taken'
}
