import { join } from 'node:path'
import { settleTaskEvidence } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import {
  isOwned,
  nextMergeCandidate,
  taskId as brandTaskId,
  type GuardrailKind,
  type MergeCandidate,
  type WorkspaceId,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { ensureIntegrationWorktree, integrationTargetFor } from './goalBranch.js'
import { mergeOrAbort, primaryCheckoutReady } from './gitMerge.js'
import { ownershipRuleForTask } from './ownership.js'
import { logSetAside, setAsideDirFor, setAsideForeignChanges } from './setAside.js'
import { rejectTask, runVerify, stageGatesFor } from './verify.js'
import { gitIn } from './worktree.js'

/**
 * The task's stable identity in a path and a branch name (spec §4, and the merge commit message).
 *
 * Duplicated from `tick.ts`'s private `taskKeyFor` rather than imported: that one is not exported,
 * and re-deriving the same one-line convention here is cheaper than exporting a helper across a
 * module boundary for a single call site. Both must agree, and both are built from the same rule
 * -- `T-` plus the id's first 8 hex characters -- so they cannot drift silently.
 */
const taskKeyFor = (id: string): string => `T-${id.slice(0, 8)}`

/**
 * The branch a task was worked on. `Task.branch` is nullable in the schema, but a task cannot
 * reach `merging` without having passed verify once (`advance()` sets it there), so a `null` here
 * is a caller bug -- surfaced loudly rather than merging a task onto no branch at all.
 */
/** A thrown value as the text a `task.merge_failed` reason carries, cut to what a payload holds. */
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 2000)

function requireBranch(task: { readonly id: string; readonly branch: string | null }): string {
  if (task.branch === null) {
    throw new Error(`task ${task.id} reached the merge pass with no branch recorded`)
  }
  return task.branch
}

/**
 * Emits `task.merge_failed`, escalates a second failure on the same task, and otherwise sends the
 * task back to rework and releases the merge claim.
 *
 * The escalation depends on where the task was merging (Conductor Plan 4a, D7). A task with no
 * integration target (planned delivery, or a package of a version from before goal deliveries)
 * halts the workspace (spec §4 step 4), and still goes back to rework. A package of a goal version
 * is blocked alone (spec §5): the task goes `blocked`, a person is told, and the workspace goes on.
 *
 * The escalation check counts this task's `task.merge_failed` events *after* appending the current
 * one: a count greater than one means a prior failure already existed, without a separate
 * "before/after" query pair that a crash between them could leave inconsistent.
 */
async function failMerge(input: {
  readonly taskId: string
  readonly workspaceId: string
  readonly taskKey: string
  readonly reason: string
  /**
   * M53 R4, fix round 1: did somebody JUDGE the work, or did the pass simply fail to run?
   *
   * `true` only where the branch itself is what went wrong -- it would not rebase, it would not
   * merge, or the post-rebase gate RAN and said no. `false` for a verify that could not run at all
   * (`not_configured` / `could_not_run`) and for a primary checkout somebody left dirty: those are
   * the orchestrator's problems and the project's, and `verify.ts`'s own failed arm refuses to
   * charge a task an attempt for exactly them. Charging the WORKER's record would be the same
   * mistake in a new column -- and a worse one, because `integrated` feeds the ranker's third rate,
   * so a workspace with no verify commands would mark down every worker whose task reached this
   * pass.
   *
   * Required rather than defaulted: the callers are the whole question, and a default is how
   * a fifth one would get it wrong silently.
   *
   * A JUDGEMENT IS NOT YET A VERDICT (erratum E24, final wave): being judged is necessary for
   * `integrated: false` and no longer sufficient -- see the settle below.
   */
  readonly judged: boolean
  /**
   * Conductor Plan 4a (D7): the goal version whose integration branch this task was merging into,
   * or `null` when it was merging into the base branch. A version decides how a second failure
   * escalates, and names the version in what the person reads.
   */
  readonly goalVersion: number | null
}): Promise<void> {
  await appendEvent({
    type: 'task.merge_failed',
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    actor: 'system',
    payload: { reason: input.reason },
  })

  const failureCount = await prisma.executionEvent.count({
    where: { taskId: input.taskId, type: 'task_merge_failed' },
  })
  if (input.goalVersion !== null) {
    if (failureCount > 1) {
      // Spec §5: a conducted workspace is not halted by one package that will not merge. The
      // package is escalated alone -- `blocked` is "a person must look at this" (`unblock-task`
      // leaves it; the Supervisor's `task_blocked_human` picks it up) -- and every other package
      // keeps going. No attempt is charged: the person, not another run, decides what happens next.
      // Conditioned on `merging`, like every claim release here: a task something else moved on
      // is not dragged back.
      await prisma.task.updateMany({
        where: { id: input.taskId, status: 'merging' },
        data: { status: 'blocked', mergeClaimedAt: null, lastRejectionReason: input.reason },
      })
      await appendEvent({
        type: 'guardrail.tripped',
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        actor: 'system',
        payload: {
          guardrail: 'merge_failure' satisfies GuardrailKind,
          detail:
            `package task ${input.taskKey} failed to merge into goal v${String(input.goalVersion)}'s ` +
            `integration branch twice; blocked for a person: ${input.reason}`,
        },
      })
      return
    }
  } else if (failureCount > 1) {
    // Conditioned: the first halt reason stands, matching the halt precedent in `verify.ts`'s
    // `not_configured` path.
    await prisma.workspace.updateMany({
      where: { id: input.workspaceId, haltedReason: null },
      data: { haltedReason: `repeated merge failure on task ${input.taskKey}`, haltedAt: new Date() },
    })
    await appendEvent({
      type: 'guardrail.tripped',
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      actor: 'system',
      payload: {
        guardrail: 'merge_failure' satisfies GuardrailKind,
        detail: `task ${input.taskKey} failed to merge twice: ${input.reason}`,
      },
    })
  }

  // The same rework machinery a failed verify or a rejected review uses: attempt counted, reason
  // on the slave-facing channel the next run's prompt reads from.
  const rejected = await rejectTask(brandTaskId(input.taskId), input.reason)

  // M53 R4 + erratum E24: `integrated: false` is settled where the INTEGRATION ENDS, and nowhere
  // else.
  //
  // R4 said "`false` on `task.merge_failed`" and this pass did exactly that until the final wave.
  // The defect was in the rule: `verifiedFirstPass` and `reviewRejected` are one-per-run verdicts,
  // and integration is not. Every failure here sends the task back to `rework` with its attempts
  // still on it -- a conflicted rebase, a gate that was flaky this once, a merge git refused while
  // the base branch moved -- and the work is then re-done and merged again. A `false` written at
  // the first failure could never be taken back (E1: a judgement column moves off null exactly
  // once), so the implementer's row would say "this never reached the base branch" about work that
  // later did, and that column is the ranker's third rate.
  //
  // So two things must both be true. `judged`: somebody looked at the branch and it is the branch
  // that is wrong (a verify that could not run and a dirty shared checkout are neither). AND
  // `rejected.exhausted`: this failure spent the task's last attempt, so the task is `failed` now
  // and nothing will merge this work -- which is what makes `false` a fact rather than a guess
  // about the next attempt. Anything else leaves the column NULL, which reads as "not judged yet"
  // everywhere and lets a later successful merge settle `true` over it as a FIRST settle.
  //
  // The workspace halt above is deliberately NOT one of the two: a halt can be cleared, and the
  // task keeps every attempt it has left.
  if (input.judged && rejected.exhausted) {
    await settleTaskEvidence(input.taskId, { kind: 'integration', integrated: false })
  }

  // `rejectTask` does not know this column -- it is Task 3's, added after `verify.ts` was written.
  await prisma.task.update({ where: { id: input.taskId }, data: { mergeClaimedAt: null } })
}

/**
 * One merge-pass step: claim and process at most ONE merging task (spec §4 serialization).
 *
 * Called once per tick, after the review pass. Merges are strictly serial by design (spec §10):
 * concurrent merges are exactly the case where two independently green branches can break the base
 * branch together, so this never starts a second merge while one -- observable only across a crash,
 * since claim and merge happen in the same pass here -- is already in flight.
 */
export async function runMergePass(workspaceId: WorkspaceId): Promise<void> {
  const merging = await prisma.task.findMany({ where: { workspaceId, status: 'merging' } })
  // A non-null claim among them means a previous pass crashed mid-merge (or, before this pass
  // exists at all in a running process, is impossible -- claim and process happen in the same
  // call). Recovery is `reconcileOrphans`' job, at startup; this pass simply refuses to start a
  // second merge on top of one it cannot see the end of.
  if (merging.some((task) => task.mergeClaimedAt !== null)) return
  if (merging.length === 0) return

  // FIFO by the `review_approved` event's seq (spec §4). Rework cycles re-approve, so a task can
  // have more than one; only the latest counts as when it became eligible to merge *now*.
  const ids = merging.map((task) => task.id)
  const approvals = await prisma.executionEvent.findMany({
    where: { workspaceId, type: 'task_review_approved', taskId: { in: ids } },
    orderBy: { seq: 'asc' },
  })
  const latestApprovalSeq = new Map<string, bigint>()
  for (const event of approvals) {
    // Ascending order means the last write for a given task is its latest approval.
    if (event.taskId !== null) latestApprovalSeq.set(event.taskId, event.seq)
  }

  const candidates: MergeCandidate[] = merging
    .filter((task) => latestApprovalSeq.has(task.id))
    .map((task) => ({
      taskId: brandTaskId(task.id),
      branch: requireBranch(task),
      enqueuedAt: Number(latestApprovalSeq.get(task.id) as bigint),
      blockedUntilRebase: false,
    }))

  // The domain helper owns the FIFO-with-tiebreak ordering; `mergeInProgress` is always `false`
  // here because the in-flight case was already handled above.
  const next = nextMergeCandidate(candidates, false)
  if (next === null) return

  const claimed = await prisma.task.updateMany({
    where: { id: next.taskId, status: 'merging', mergeClaimedAt: null },
    data: { mergeClaimedAt: new Date() },
  })
  if (claimed.count === 0) return // an overlapping call won the claim race

  const task = await prisma.task.findUniqueOrThrow({ where: { id: next.taskId } })
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
  const branch = requireBranch(task)
  const taskKey = taskKeyFor(task.id)

  // Conductor Plan 4a (spec R9, D5): a package of a goal version with a `GoalDelivery` merges into
  // that version's integration branch; everything else into the base branch, as before. The same
  // `integrationTargetFor` dispatch, the ownership audit and review read, so all four judge the
  // task against one branch (D12).
  //
  // Seam for Plan 4a Task 6 (P1): a task whose goal version is abandoned must be refused here,
  // once the target is known and before anything is rebased or merged.
  const target = await integrationTargetFor(task.id)
  const into = target?.branch ?? workspace.baseBranch
  const goalVersion = target?.goalVersion ?? null

  // spec Decision 5: `autoMerge` is consulted here, not at review time -- a workspace that does not
  // trust auto-merge still wants the task marked done and out of the queue, with the branch and
  // worktree left for a human to merge by hand.
  //
  // Plan 4a D3: only for a merge into the base branch. The integration branch is Slave's staging
  // area, and `autoMerge` governs the goal version's one final merge into the base branch instead.
  if (target === null && !workspace.autoMerge) {
    await prisma.task.update({
      where: { id: task.id },
      // M35 t2: no git merge happened here, on purpose -- `integratedAt` stays null (explicit,
      // not just the column's default) so `world.ts`'s dependency gate keeps this task's
      // dependents, if any, waiting until a human runs `confirmIntegration` after merging the
      // branch by hand.
      data: { status: 'done', mergeClaimedAt: null, lastRejectionReason: null, integratedAt: null },
    })
    await appendEvent({
      type: 'task.done',
      workspaceId,
      taskId: task.id,
      actor: 'system',
      payload: { branch },
    })
    return
  }

  // The preserved worktree from the task's own latest implementation run -- the same one review
  // judged, not a fresh provision. Mirrors `dispatchReview`'s `latestImpl` lookup.
  const latestImpl = await prisma.slaveRun.findFirst({
    where: { taskId: task.id, kind: 'implementation' },
    orderBy: { startedAt: 'desc' },
  })
  if (latestImpl === null || latestImpl.worktreePath === null) {
    throw new Error(`task ${task.id} reached the merge pass with no usable implementation worktree`)
  }
  const worktreePath = latestImpl.worktreePath

  // Rebase onto the current base branch in the preserved worktree -- the real gate is the re-verify
  // below, but a branch that no longer applies cleanly cannot even be judged.
  //
  // Conductor Plan 3, fix round 3 (controller Ruling 7): a governed package task's worktree can
  // still hold changes to files its package does not own -- a verify command that generated a
  // file, anything that dirtied the tree after the leftover commit set the rest aside. None of them
  // is on the branch, and `git rebase` refuses a dirty tree: they are set aside the same way
  // (saved under the implementation run's state directory, removed from the worktree), so the
  // rebase and the re-verify below see exactly the branch that lands. Never `git stash`:
  // `refs/stash` is shared by every worktree of the repository. A task with no package, and a
  // package's own uncommitted changes, meet the rebase exactly as before.
  //
  // Round 4 (re-review m2): this whole check runs INSIDE the same try as the rebase itself, not
  // before it. A worktree gone or broken used to throw straight out of these calls and out of
  // `runMergePass`, with the merge claim still set -- every later merge on the workspace stalled
  // until the stale-merge sweep found it. Caught here, it fails exactly the way a broken worktree
  // already failed the rebase call below: judged, rejected, claim released.
  try {
    if (task.workPackageId !== null && (await gitIn(worktreePath, 'status', '--porcelain', '--untracked-files=all')) !== '') {
      const rule = await ownershipRuleForTask(task.id)
      if (rule !== null) {
        const aside = await setAsideForeignChanges({
          worktreePath,
          owns: (path: string): boolean => isOwned(rule, path),
          saveDir: setAsideDirFor(latestImpl.id, 'merge'),
        })
        // Round 4 (re-review m3): `failed` means nothing was removed (`setAside.ts`'s own
        // contract -- nothing goes unless everything is saved first), so the tree is still dirty
        // and the plain rebase below would refuse it, turning a SAVE failure into a JUDGED, charged
        // rework about a conflict that never happened. `judged: false`, exactly like the
        // primary-checkout-dirty failure further down: `rejectTask` runs either way, so the
        // attempt is still spent and this is bounded the same way -- never a free retry loop -- but
        // no false verdict is ever settled on the worker for the orchestrator's own save failing.
        if (aside.kind === 'failed') {
          await failMerge({
            taskId: task.id,
            workspaceId,
            taskKey,
            reason: `could not set aside changes to files this package does not own: ${aside.reason}`,
            judged: false,
            goalVersion,
          })
          return
        }
        logSetAside(`[merge] ${taskKey}`, aside)
      }
    }

    await gitIn(worktreePath, 'rebase', into)
  } catch (error) {
    await gitIn(worktreePath, 'rebase', '--abort').catch(() => {})
    await failMerge({
      taskId: task.id,
      workspaceId,
      taskKey,
      reason: `rebase onto ${into} conflicted: ${errorText(error)}`,
      // The branch no longer applies to the branch it merges into (`into`: the goal version's
      // integration branch, or the base branch). That is the work -- so it is JUDGED. It
      // still settles nothing unless this failure spent the task's last attempt (E24): the task
      // goes back to rework, the conflict is resolved and the work merges, and a `false` written
      // here could never be taken back.
      judged: true,
      goalVersion,
    })
    return
  }

  // Re-verify the rebased result: the real gate. A rebase can silently change behaviour even
  // without a textual conflict, so the branch is judged again exactly as the first implementation
  // run's result was -- the stage's own gates included (M48 R6, controller ruling). What a stage's
  // gate proves is exactly as true of the REBASED tree as of the tree review read, and a gate that
  // only ever ran before the rebase would be a check this pass could silently invalidate. It does
  // mean a gate runs twice for a clean merge, once at verify and once here; that is the cost of
  // judging the tree that actually lands.
  const stage = await stageGatesFor(workspaceId, task.stage, workspace.verifyCommands)
  const result = await runVerify({
    taskId: brandTaskId(task.id),
    worktreePath,
    // A sibling namespace under the task's artifact dir, never `.../artifacts/task.id` itself:
    // that is where `verifyConcludedRun` already writes the implementation attempt's own
    // `attempt-NN` logs (verify.ts), and this pass's post-rebase re-verify reuses the same
    // attempt number. Without the `merge` segment the two writers collide on the same paths and
    // this pass's log silently overwrites the implementation attempt's.
    artifactDir: join(workspace.repoPath, '.slaveofai', 'artifacts', task.id, 'merge'),
    commands: [...workspace.verifyCommands, ...(stage?.gates ?? [])],
    stage,
    timeoutMs: workspace.runTimeoutMs,
  })
  if (result.kind !== 'passed') {
    // Which check said no, in the words the person reading `task.merge_failed` needs: a gate's
    // failure is about the PHASE the work is in, and a reason that named only the command would
    // send an operator looking through the workspace's own verify list for a command that is not
    // in it.
    const failed =
      result.stage === null ? String(result.failedCommand) : `stage "${result.stage}" gate ${String(result.failedCommand)}`
    const reason =
      result.kind === 'failed' ? `post-rebase verify failed: ${failed} exited ${String(result.exitCode)}` : result.output
    // `failed` is a gate that RAN and said no -- a verdict on the rebased tree. `not_configured`
    // and `could_not_run` are this project's configuration and this machine's, and are not a
    // judgement at all (the same two kinds `verify.ts`'s `advance` refuses to charge an attempt
    // for). Even `failed` settles nothing while the task can still be re-done and merged again
    // (E24): a gate that fails once and passes the second time is the ordinary case this rule is
    // about.
    await failMerge({ taskId: task.id, workspaceId, taskKey, reason, judged: result.kind === 'failed', goalVersion })
    return
  }

  if (target !== null) {
    // Plan 4a (spec R9, D2): into the goal version's integration branch, in the worktree kept on
    // it. The primary checkout is neither read nor touched: it is the person's, and the base branch
    // changes only when the goal version is accepted (spec §5). `--no-ff` and `--no-verify` for the
    // base-branch merge's reasons below.
    //
    // Two failures, told apart (controller ruling T4-1). A worktree that cannot be prepared is this
    // machine's fault -- a stale directory, a registration `worktree add` refuses -- so it is NOT
    // judged: charging the worker would, on a second occurrence, block every package of the
    // version for something no worker did. A merge git refuses is the branch not fitting, which is
    // judged like the rebase above; `mergeOrAbort` aborts it so the next package's merge is not
    // refused by this one's leftovers.
    let integrationPath: string
    try {
      integrationPath = await ensureIntegrationWorktree(workspace.repoPath, target, workspaceId)
    } catch (error) {
      await failMerge({
        taskId: task.id,
        workspaceId,
        taskKey,
        reason: `could not prepare the integration worktree for ${target.branch}: ${errorText(error)}`,
        judged: false,
        goalVersion,
      })
      return
    }
    const merged = await mergeOrAbort(integrationPath, ['--no-ff', '--no-verify', branch, '-m', `merge(${taskKey}): ${task.title}`])
    if (!merged.ok) {
      await failMerge({
        taskId: task.id,
        workspaceId,
        taskKey,
        reason: `merge of ${branch} into ${target.branch} failed: ${merged.error}`,
        judged: true,
        goalVersion,
      })
      return
    }
    // Plan D4: on a package task `integratedAt` means "on its goal's integration branch" -- what
    // the dependency gate needs, since a dependent package is cut from that branch. The integration
    // EVIDENCE waits for the final merge into the base branch: that is what "integrated" means in
    // the ranker.
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'done', mergeClaimedAt: null, lastRejectionReason: null, integratedAt: new Date() },
    })
    await appendEvent({ type: 'task.done', workspaceId, taskId: task.id, actor: 'system', payload: { branch } })
    return
  }

  // Guard the primary checkout before touching it: it is shared by every task in this workspace
  // (`primaryCheckoutReady` is the one rule, shared with the goal pass's final merge).
  if (!(await primaryCheckoutReady(workspace.repoPath, workspace.baseBranch))) {
    await failMerge({
      taskId: task.id,
      workspaceId,
      taskKey,
      reason: `primary checkout is not clean on ${workspace.baseBranch}`,
      // Somebody left the shared repository dirty, or it is on the wrong branch. Nothing here is
      // about the work, and no worker did it.
      judged: false,
      goalVersion,
    })
    return
  }

  // `--no-ff`: the merge commit is what a `git revert -m 1` undoes as one unit, and what makes this
  // task's contribution visible in `git log` as one entry rather than disappearing into a
  // fast-forward. A merge can still fail here -- `main` moved between the rebase and this command,
  // or a lock collision with concurrent provisioning -- and `mergeOrAbort` aborts it: a primary
  // checkout wedged mid-merge would stall the whole workspace's merge queue. `--no-verify`, for the
  // WIP commit's reason (`wipCommit.ts`): the repository's own commit hooks are the worker's to
  // satisfy on its own commits, and a `commit-msg` hook enforcing a message convention (commitlint
  // installed by `npm ci`) would otherwise refuse this commit's subject on every task, forever.
  const merged = await mergeOrAbort(workspace.repoPath, ['--no-ff', '--no-verify', branch, '-m', `merge(${taskKey}): ${task.title}`])
  if (!merged.ok) {
    await failMerge({
      taskId: task.id,
      workspaceId,
      taskKey,
      reason: `merge of ${branch} onto ${workspace.baseBranch} failed: ${merged.error}`,
      // The same class as the rebase above: the branch would not go onto the base branch, and the
      // same E24 rule applies -- `main` moving under a task is not a verdict on the worker.
      judged: true,
      goalVersion,
    })
    return
  }

  // M35 t2: the commits genuinely reached `workspace.baseBranch` above -- `integratedAt` says so,
  // and `world.ts`'s dependency gate reads it before letting a dependent start.
  await prisma.task.update({
    where: { id: task.id },
    data: { status: 'done', mergeClaimedAt: null, lastRejectionReason: null, integratedAt: new Date() },
  })
  await appendEvent({
    type: 'task.done',
    workspaceId,
    taskId: task.id,
    actor: 'system',
    payload: { branch },
  })

  // M53 R4: the commits genuinely reached `workspace.baseBranch`, which is what `integratedAt` says
  // a few lines above. The `!autoMerge` path gets NO call at all -- it writes `integratedAt: null`
  // on purpose, and `confirmIntegration` is the verdict for that task, whenever a person gets to it.
  await settleTaskEvidence(task.id, { kind: 'integration', integrated: true })
}
