import { prisma, type Prisma } from '@slave-of-ai/db/client'
import { type Result, err, ok } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { settleTaskEvidence } from './evidence.js'
import { gitIn } from './git.js'
import type { Principal } from './principal.js'
import type { ControlRefusal } from './refusal.js'
import { resolveSettledDecisions } from './supervisor.js'

/**
 * Plan 4a D4: the integration verdict of every package task of a goal version, settled when the
 * version's branch reaches the base branch -- by the goal pass, or by a person's confirmed hand
 * merge. "Integrated" in the ranker means "reached the base branch", which a package merged into
 * its integration branch has not yet done.
 */
export async function settleGoalEvidence(workspaceId: string, goalVersion: number): Promise<void> {
  const tasks = await prisma.task.findMany({
    where: { workspaceId, workPackage: { goalVersion }, integratedAt: { not: null } },
    select: { id: true },
  })
  for (const task of tasks) await settleTaskEvidence(task.id, { kind: 'integration', integrated: true })
}

/**
 * Serialises everything that decides a delivery's once-only facts (`goal_accepted`, the final
 * merge, `goal_merged`, the abandonment) across overlapping callers -- a CLI `tick` beside a live
 * daemon, two ticks of one daemon, or a person's `confirm-goal-merge` / `abandon-goal` racing the
 * goal pass.
 *
 * A Postgres TRANSACTION advisory lock keyed on the delivery (the daemon already relies on a
 * session advisory lock for "one daemon per database"). The events themselves cannot be written in
 * this transaction -- `appendEvent` is the log's only writer and commits on its own -- so the rule
 * is: under the lock, look for the event, write it if it is missing, THEN move the row. An event
 * `appendEvent` returned is committed before the lock is released, so the next holder sees it; a
 * crash anywhere releases the lock with the connection and leaves the row unmoved, so the next
 * pass comes back and finds the event already there. Exactly once, and nothing lost.
 *
 * Lives here, not in the orchestrator's goal pass, because the person's verbs below must take the
 * SAME lock under the same key, and `packages/control` cannot import from `apps/orchestrator`.
 */
export async function withDeliveryLock<T>(deliveryId: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`slaveofai:goal-delivery:${deliveryId}`}))`
      return work(tx)
    },
    // The final merge runs git under the lock, and a waiter waits out the holder's whole merge.
    { maxWait: 10_000, timeout: 120_000 },
  )
}

/** Whether the workspace's log already has `type` for this goal version -- read in the lock's
 *  transaction, which sees every event committed before the lock was granted. */
export async function goalEventSaid(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  type: 'workspace_goal_accepted' | 'workspace_goal_merged',
  version: number,
): Promise<boolean> {
  const row = await tx.executionEvent.findFirst({
    where: { workspaceId, type, payload: { path: ['version'], equals: version } },
    select: { seq: true },
  })
  return row !== null
}

/**
 * Conductor Plan 4b: whether the workspace's log already has `type` with every one of `fields` in
 * its payload -- {@link goalEventSaid} for the events a version can see more than once (one
 * `workspace.verified` per run, one `workspace.goal_retried` per round, one `task.rework` per task
 * and round). `since` narrows it to events after a sequence number. Read in the lock's
 * transaction, for the same reason.
 */
export async function goalEventWith(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  type: 'workspace_verified' | 'workspace_goal_retried' | 'workspace_goal_needs_human' | 'task_rework',
  fields: Readonly<Record<string, string | number>>,
  options: { readonly taskId?: string; readonly since?: bigint } = {},
): Promise<boolean> {
  const row = await tx.executionEvent.findFirst({
    where: {
      workspaceId,
      type,
      ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
      ...(options.since === undefined ? {} : { seq: { gt: options.since } }),
      AND: Object.entries(fields).map(([key, value]) => ({ payload: { path: [key], equals: value } })),
    },
    select: { seq: true },
  })
  return row !== null
}

/**
 * Conductor Plan 4b: one verification round's verdict as a person (`goal-status`) and the
 * Supervisor's world (Task 7) read it -- the counts, and the keys that failed.
 */
export interface LatestVerification {
  readonly round: number
  readonly pass: number
  readonly fail: number
  readonly unverifiable: number
  readonly failedKeys: readonly string[]
}

/**
 * The latest verification of each delivery that has one: its highest round's rows, from the run
 * that wrote them last (an unusable run writes none, so a round has one writer in practice; the
 * latest wins if it ever had two). The one loader both readers use, so they cannot disagree.
 * `client` is the Supervisor's world snapshot (a `RepeatableRead` transaction), so the verdict is
 * read from the same instant as the delivery rows it belongs to.
 */
export async function latestVerifications(
  deliveryIds: readonly string[],
  client: Prisma.TransactionClient = prisma,
): Promise<ReadonlyMap<string, LatestVerification>> {
  if (deliveryIds.length === 0) return new Map()
  const rows = await client.verificationResult.findMany({
    where: { goalDeliveryId: { in: [...deliveryIds] } },
    orderBy: [{ round: 'desc' }, { createdAt: 'desc' }, { key: 'asc' }],
    select: { goalDeliveryId: true, round: true, runId: true, key: true, status: true },
  })
  const chosen = new Map<string, { readonly round: number; readonly runId: string }>()
  for (const row of rows) {
    if (!chosen.has(row.goalDeliveryId)) chosen.set(row.goalDeliveryId, { round: row.round, runId: row.runId })
  }
  const out = new Map<string, LatestVerification>()
  for (const [deliveryId, { round, runId }] of chosen) {
    const mine = rows.filter((row) => row.goalDeliveryId === deliveryId && row.runId === runId).toSorted((a, b) => a.key.localeCompare(b.key))
    out.set(deliveryId, {
      round,
      pass: mine.filter((row) => row.status === 'pass').length,
      fail: mine.filter((row) => row.status === 'fail').length,
      unverifiable: mine.filter((row) => row.status === 'unverifiable').length,
      failedKeys: mine.filter((row) => row.status === 'fail').map((row) => row.key),
    })
  }
  return out
}

export interface GoalDeliveryView {
  readonly goalVersion: number
  // Conductor Plan 4b: widened with the verification loop's two states -- `verifying` while a
  // round is in flight, `needs_human` where a cap or an unverifiable item ends it without
  // acceptance (plan D6/D7).
  readonly status: 'integrating' | 'verifying' | 'accepted' | 'needs_human' | 'abandoned'
  readonly integrationBranch: string
  readonly baseCommit: string
  readonly acceptedAt: string | null
  readonly mergedAt: string | null
  readonly mergeError: string | null
  /** Plan 4b: the verification round the version is on (0 before the first). */
  readonly round: number
  /** Plan 4b (D6/D7): why the loop stopped, while the version is `needs_human`. */
  readonly needsHumanReason: string | null
  /** Plan 4b: the latest concluded round's verdict, or null before any. */
  readonly latestVerification: LatestVerification | null
  readonly packages: readonly { readonly taskId: string; readonly key: string; readonly status: string; readonly integrated: boolean }[]
}

/**
 * What a person reads before acting on a goal version (`goal-status`): each conducted version of
 * the workspace, oldest first, with where its delivery stands and each package task's status and
 * whether it is on the integration branch yet. `goalVersion` narrows it to one.
 */
export async function goalDeliveries(
  workspaceId: string,
  goalVersion?: number,
): Promise<Result<readonly GoalDeliveryView[], ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  const rows = await prisma.goalDelivery.findMany({
    where: { workspaceId, ...(goalVersion === undefined ? {} : { goalVersion }) },
    orderBy: { goalVersion: 'asc' },
  })
  const tasks = await prisma.task.findMany({
    where: { workspaceId, workPackage: { goalVersion: { in: rows.map((row) => row.goalVersion) } } },
    select: { id: true, status: true, integratedAt: true, workPackage: { select: { key: true, goalVersion: true } } },
  })
  const latest = await latestVerifications(rows.map((row) => row.id))
  return ok(
    rows.map((row) => ({
      goalVersion: row.goalVersion,
      status: row.status,
      integrationBranch: row.integrationBranch,
      baseCommit: row.baseCommit,
      acceptedAt: row.acceptedAt?.toISOString() ?? null,
      mergedAt: row.mergedAt?.toISOString() ?? null,
      mergeError: row.mergeError,
      round: row.round,
      needsHumanReason: row.needsHumanReason,
      latestVerification: latest.get(row.id) ?? null,
      packages: tasks
        .filter((task) => task.workPackage?.goalVersion === row.goalVersion)
        .map((task) => ({ taskId: task.id, key: task.workPackage?.key ?? '', status: task.status, integrated: task.integratedAt !== null }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    })),
  )
}

/**
 * Conductor Plan 4b (fix round 1, I1): the person acted on this goal version, which answers the
 * Supervisor's `goal_needs_human` escalation about it -- every stop's and the failed merge's
 * (`<workspaceId>:v<n>:...`), and no other version's. After the verb's commit, like
 * `adoptRunbook`'s own call: an act that was refused resolves nothing.
 */
async function resolveGoalEscalations(workspaceId: string, goalVersion: number, reason: string, principal?: Principal): Promise<void> {
  await resolveSettledDecisions({
    workspaceId,
    situationKind: 'goal_needs_human',
    subjectIdPrefix: `${workspaceId}:v${String(goalVersion)}:`,
    reason,
    ...(principal === undefined ? {} : { principal }),
  })
}

/** The statuses a package task can be cancelled from when its version is abandoned: never
 *  started, parked for a person, or sent back and not yet picked up again. */
const ABANDONABLE_TASK_STATUSES: readonly string[] = ['backlog', 'ready', 'blocked', 'rework']
/** Already over; abandoning the version leaves them as they are. */
const FINISHED_TASK_STATUSES: readonly string[] = ['done', 'failed', 'cancelled']

/** Carries a refusal out of the transaction: thrown, so nothing the transaction wrote commits. */
class Refused extends Error {
  constructor(readonly refusal: ControlRefusal) {
    super(refusal.kind)
  }
}

/**
 * The person moves on from a goal version (plan D10, spec R9: "or the person moves on"): every
 * unfinished package task of it is cancelled and the version is `abandoned`, which frees the next
 * version to be conducted (D6). The integration branch and its worktree stay for inspection.
 *
 * All in ONE transaction under the delivery's lock (controller ruling P1). Not through
 * `cancelTask`, which refuses `rework` -- an attempt already spent is still work nobody wants once
 * the version is abandoned -- and which would commit task by task, so a refusal half way would
 * leave the version in neither state. Refused while any package task is in flight (a run or a
 * merge: `assigned` through `merging`, `waiting`, an `activeRunId` or a merge claim): that work
 * would finish into a version nobody wants, so the person stops it first. The task rows are locked
 * `FOR UPDATE` before their status is read, so a dispatch claiming one meanwhile either lands
 * before (and is seen as busy) or finds it `cancelled` (its claim is guarded on the status).
 *
 * The events follow the commit (`cancelTask`'s own order): one `task.cancelled` per task, then
 * `workspace.goal_abandoned`.
 */
export async function abandonGoal(
  workspaceId: string,
  goalVersion: number,
  principal?: Principal,
): Promise<Result<{ readonly cancelled: readonly string[] }, ControlRefusal>> {
  const found = await prisma.goalDelivery.findUnique({ where: { workspaceId_goalVersion: { workspaceId, goalVersion } }, select: { id: true } })
  if (found === null) return err({ kind: 'goal_version_not_found', workspaceId, goalVersion })
  const reason = `goal v${String(goalVersion)} abandoned`

  let outcome: { readonly cancelled: readonly { readonly id: string; readonly goalVersion: number | null }[] }
  try {
    outcome = await withDeliveryLock(found.id, async (tx) => {
      const delivery = await tx.goalDelivery.findUniqueOrThrow({ where: { id: found.id } })
      if (delivery.status === 'abandoned' || delivery.mergedAt !== null) {
        throw new Refused({ kind: 'goal_version_closed', goalVersion, status: delivery.mergedAt !== null ? 'merged' : delivery.status })
      }
      // Plan 4b: a verification run in flight would conclude into a version nobody wants -- and its
      // conclusion may rework a package this call just cancelled. Stop it first, like a task's run.
      if (delivery.activeRunId !== null) {
        throw new Refused({ kind: 'goal_version_busy', goalVersion, holder: `verification run ${delivery.activeRunId}` })
      }
      const ids = (await tx.task.findMany({ where: { workspaceId, workPackage: { goalVersion } }, select: { id: true } })).map((task) => task.id)
      if (ids.length > 0) await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ANY(${ids}::text[]) FOR UPDATE`
      const tasks = await tx.task.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true, activeRunId: true, mergeClaimedAt: true, goalVersion: true },
        orderBy: { createdAt: 'asc' },
      })
      const busy = tasks.find(
        (task) =>
          task.activeRunId !== null ||
          task.mergeClaimedAt !== null ||
          !(ABANDONABLE_TASK_STATUSES.includes(task.status) || FINISHED_TASK_STATUSES.includes(task.status)),
      )
      if (busy !== undefined) throw new Refused({ kind: 'goal_version_busy', goalVersion, holder: `task ${busy.id}` })

      const cancelled = tasks.filter((task) => ABANDONABLE_TASK_STATUSES.includes(task.status))
      await tx.task.updateMany({
        where: { id: { in: cancelled.map((task) => task.id) } },
        data: { status: 'cancelled', lastRejectionReason: reason },
      })
      await tx.goalDelivery.update({ where: { id: found.id }, data: { status: 'abandoned' } })
      return { cancelled: cancelled.map((task) => ({ id: task.id, goalVersion: task.goalVersion })) }
    })
  } catch (error) {
    if (error instanceof Refused) return err(error.refusal)
    throw error
  }

  const userId = principal?.userId ?? null
  for (const task of outcome.cancelled) {
    await appendEvent({
      type: 'task.cancelled',
      workspaceId,
      taskId: task.id,
      actor: 'human',
      payload: { reason, goalVersion: task.goalVersion },
      userId,
    })
  }
  const ids = outcome.cancelled.map((task) => task.id)
  await appendEvent({
    type: 'workspace.goal_abandoned',
    workspaceId,
    actor: 'human',
    // The event's list is bounded; the task rows (and their own events) are the whole record.
    payload: { version: goalVersion, cancelled: ids.slice(0, 50) },
    userId,
  })
  await resolveGoalEscalations(workspaceId, goalVersion, `goal v${String(goalVersion)} was abandoned`, principal)
  return ok({ cancelled: ids })
}

/**
 * The person sends a goal version the verification loop stopped on (`needs_human`) round again
 * (Plan 4b D9): back to `integrating`, with a fresh round window -- `roundBase = round`, so the
 * round cap counts from here, and the rounds already spent stay in the report -- the round's
 * unusable-run count reset and the reason cleared. A stop leaves its packages as they were (a
 * stopped loop spends nothing while the person decides), so the goal pass first verifies the
 * unchanged tree again in a new round; what still fails there is reworked as in any round, now
 * inside the fresh window.
 *
 * Under the delivery's lock, in the 4a order: `workspace.goal_retried` written if missing (one per
 * round: a version cannot need a person twice in one round, because every later stop is in a
 * later round), THEN the guarded move. A crash between the two is finished by the next retry,
 * which finds the event.
 */
export async function retryGoal(
  workspaceId: string,
  goalVersion: number,
  principal?: Principal,
): Promise<Result<{ readonly round: number }, ControlRefusal>> {
  const found = await prisma.goalDelivery.findUnique({ where: { workspaceId_goalVersion: { workspaceId, goalVersion } }, select: { id: true } })
  if (found === null) return err({ kind: 'goal_version_not_found', workspaceId, goalVersion })

  // The refusal below is reached before anything is written, so returning it commits nothing.
  const retried = await withDeliveryLock(found.id, async (tx): Promise<Result<{ readonly round: number }, ControlRefusal>> => {
    const delivery = await tx.goalDelivery.findUniqueOrThrow({ where: { id: found.id } })
    if (delivery.status !== 'needs_human') return err({ kind: 'goal_not_needs_human', goalVersion, status: delivery.status })
    const round = delivery.round
    if (!(await goalEventWith(tx, workspaceId, 'workspace_goal_retried', { version: goalVersion, round }))) {
      await appendEvent({
        type: 'workspace.goal_retried',
        workspaceId,
        actor: 'human',
        payload: { version: goalVersion, round },
        userId: principal?.userId ?? null,
      })
    }
    await tx.goalDelivery.updateMany({
      where: { id: delivery.id, status: 'needs_human' },
      data: { status: 'integrating', roundBase: round, roundRunFailures: 0, needsHumanReason: null },
    })
    return ok({ round })
  })
  if (retried.ok) await resolveGoalEscalations(workspaceId, goalVersion, `goal v${String(goalVersion)} was sent round again`, principal)
  return retried
}

/**
 * The person merged an accepted goal version into the base branch by hand, and says so (plan D9):
 * after a merge git refused (`mergeError`), after the base branch moved since the cut (the goal
 * pass's wait, `mergeError` null), or with `autoMerge` off.
 *
 * The person's word is checked against git: confirming a merge that did not happen would let the
 * next goal version be cut from a base branch without this one's work (plan D6). Then, under the
 * SAME delivery lock and in the SAME order as the goal pass's own landing -- evidence settled,
 * `goal_merged { by: 'human' }` written if it is missing, the guarded stamp LAST -- so a crash in
 * the middle is finished by the next confirm, and the goal pass's recovery (which only reads
 * stamped rows) never announces this merge as its own. `commit` is the base branch's tip: the
 * commit the person's merge made, which contains the integration branch.
 *
 * The integration worktree is left for the goal pass, which removes it once the row is stamped.
 *
 * Idempotent on a version already stamped whose branch is in the base branch (final wave I1): the
 * goal pass may have recorded the person's hand merge first.
 */
export async function confirmGoalMerge(
  workspaceId: string,
  goalVersion: number,
  principal?: Principal,
): Promise<Result<{ readonly commit: string }, ControlRefusal>> {
  const found = await prisma.goalDelivery.findUnique({ where: { workspaceId_goalVersion: { workspaceId, goalVersion } }, select: { id: true } })
  if (found === null) return err({ kind: 'goal_version_not_found', workspaceId, goalVersion })

  // Every refusal below is reached before anything is written, so returning it commits nothing.
  const confirmed = await withDeliveryLock(found.id, async (tx): Promise<Result<{ readonly commit: string }, ControlRefusal>> => {
    const delivery = await tx.goalDelivery.findUniqueOrThrow({
      where: { id: found.id },
      include: { workspace: { select: { repoPath: true, baseBranch: true } } },
    })
    if (delivery.status === 'abandoned') return err({ kind: 'goal_version_closed', goalVersion, status: delivery.status })
    if (delivery.mergedAt === null && delivery.status !== 'accepted') {
      return err({ kind: 'goal_not_accepted', goalVersion, status: delivery.status })
    }
    const { repoPath, baseBranch } = delivery.workspace
    const merged = await gitIn(repoPath, 'merge-base', '--is-ancestor', delivery.integrationBranch, `refs/heads/${baseBranch}`).then(
      () => true,
      () => false,
    )
    if (delivery.mergedAt !== null) {
      // Final wave I1: already recorded -- by the goal pass, which finds a hand merge contained on
      // its next tick and records it as the person's, often before the person gets to confirm, or
      // by an earlier confirm. The person did what they were told, so the confirm is idempotent:
      // it answers with the commit already recorded, and writes nothing. A stamp whose branch is
      // NOT in the base branch (somebody rewrote it since) is not something to confirm.
      if (!merged) return err({ kind: 'goal_version_closed', goalVersion, status: 'merged' })
      const recorded = await recordedMergeCommit(tx, workspaceId, goalVersion)
      return ok({ commit: recorded ?? (await gitIn(repoPath, 'rev-parse', `refs/heads/${baseBranch}`)) })
    }
    if (!merged) return err({ kind: 'goal_not_merged', goalVersion, branch: delivery.integrationBranch, into: baseBranch })
    const commit = await gitIn(repoPath, 'rev-parse', `refs/heads/${baseBranch}`)

    if (!(await goalEventSaid(tx, workspaceId, 'workspace_goal_merged', goalVersion))) {
      await settleGoalEvidence(workspaceId, goalVersion)
      await appendEvent({
        type: 'workspace.goal_merged',
        workspaceId,
        actor: 'human',
        payload: { version: goalVersion, branch: delivery.integrationBranch, into: baseBranch, commit, by: 'human' },
        userId: principal?.userId ?? null,
      })
    }
    await tx.goalDelivery.updateMany({ where: { id: delivery.id, mergedAt: null }, data: { mergedAt: new Date(), mergeError: null } })
    return ok({ commit })
  })
  if (confirmed.ok) await resolveGoalEscalations(workspaceId, goalVersion, `goal v${String(goalVersion)} was merged by hand`, principal)
  return confirmed
}

/** The commit a version's `goal_merged` recorded, if the log has one. */
async function recordedMergeCommit(tx: Prisma.TransactionClient, workspaceId: string, version: number): Promise<string | null> {
  const row = await tx.executionEvent.findFirst({
    where: { workspaceId, type: 'workspace_goal_merged', payload: { path: ['version'], equals: version } },
    select: { payload: true },
  })
  return (row?.payload as { readonly commit?: string } | undefined)?.commit ?? null
}
