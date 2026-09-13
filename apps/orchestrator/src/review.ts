import { randomBytes } from 'node:crypto'
import {
  NON_TERMINAL_RUN_STATUSES,
  slaveId as brandSlaveId,
  runId as brandRunId,
  taskId as brandTaskId,
  parseReviewVerdict,
  REVIEW_RETRY_CAP,
  type GuardrailKind,
  type RunId,
} from '@slave-of-ai/domain'
import {
  admitProvider,
  amendRunOutcome,
  refusalText,
  runFilePaths,
  settleTaskEvidence,
  writePermissionsFile,
} from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { runTokenHash, type SlaveRuntimeAdapter, type RunHandle } from '@slave-of-ai/providers'
import { resolveRuntime, workspaceDefaultProvider } from './model.js'
import { resolveAdapter } from './provider.js'
import { pumpRun } from './pump.js'
import { buildRunContext } from './runContext.js'
import { createRunUnlessArchived } from './runs.js'
import { activePumpRunIds, emailLocalPart, pumps, type TickDeps } from './tick.js'
import { promote } from './memory.js'
import { implementerOf, rejectTask, verifyConcludedRun } from './verify.js'
import { gitIn } from './worktree.js'

/** A single unified diff capped this many characters, past which it is truncated with a marker. */
const DIFF_CHAR_LIMIT = 60_000

/** Task ids already warned about as unreviewable -- once per daemon lifetime, not once per tick
 *  (M15 spec §3 B5): the seeded `reviewing` fixture task made this line the daemon log's loudest
 *  and least informative repetition. Bounded by the number of distinct stuck tasks. */
const warnedUnreviewable = new Set<string>()

/**
 * Conclude a succeeded review run: parse the verdict and move the task.
 *
 * Called only for a `succeeded` run -- `verifyConcludedRun` branches here before its own
 * worktree/branch checks, which a review has no use for, because judging text is not judging a
 * tree.
 *
 * A run that produced no valid verdict is treated as a failed review, not an infrastructure
 * problem: it still feeds `dispatchReview`'s retry cap (Erratum 2), deliberately -- "the process
 * exited zero" is not "the reviewer judged the diff", and a reviewer that keeps saying nothing
 * parseable must not be retried forever.
 */
export async function concludeReview(runId: RunId): Promise<void> {
  const run = await prisma.slaveRun.findUniqueOrThrow({
    where: { id: runId },
    include: { task: { include: { workspace: true } } },
  })
  const { task } = run
  // A review run always has a task (M8b only makes `planning` runs task-less) -- a null one here
  // is data corruption worth failing loudly on, not a case to route around.
  if (task === null) {
    throw new Error(`run ${run.id} of kind ${run.kind} has no task`)
  }

  const rows = await prisma.executionEvent.findMany({
    where: { runId, type: 'run_output' },
    orderBy: { seq: 'asc' },
  })
  const text = rows.map((row) => (row.payload as { text: string }).text).join('\n')
  const parsed = parseReviewVerdict(text)

  if (!parsed.ok) {
    await prisma.slaveRun.updateMany({
      where: { id: runId, status: 'succeeded' },
      data: { status: 'failed' },
    })
    // M53 erratum E26: the third walk-back. A review run's row carries no verdict of its own (the
    // writer refuses to settle one), so this amends exactly one column -- the outcome, which the
    // pump wrote as `succeeded` and this branch has just made `failed`.
    await amendRunOutcome(runId)
    // Hand the claim back (M41 Task 3b) so the next dispatch can take it -- the task deliberately
    // stays `reviewing` (this branch's own policy, below), and a `reviewing` task still pointing at
    // this now-terminal run is one no dispatch could ever claim again. BEFORE the event, not after:
    // `run.failed` is what wakes the daemon's tick, and a tick that arrives before the release
    // simply finds the task still claimed and does nothing.
    //
    // Guarded on the run id: a REPLAYED conclusion (this row legitimately stays terminal, so a
    // restarted daemon can call this again) must not clear a NEWER review run's claim.
    await prisma.task.updateMany({
      where: { id: task.id, activeRunId: runId },
      data: { activeRunId: null },
    })
    await appendEvent({
      type: 'run.failed',
      workspaceId: task.workspaceId,
      taskId: task.id,
      slaveId: run.slaveId,
      runId: run.id,
      actor: 'system',
      payload: { reason: `review run produced no valid verdict: ${parsed.error}` },
    })
    return
  }

  if (parsed.value.verdict === 'approve') {
    // `autoMerge` is NOT consulted here (spec Decision 5) -- the merge pass, not this conclusion,
    // owns whether an approved task merges itself or waits for a human.
    // `activeRunId: null` in the same write as the status (M41 Task 3b): the claim this run took at
    // dispatch is released exactly when the task stops being under review, so the two can never
    // disagree. `unblockTask`/`cancelTask`/`failTask` refuse a task carrying an `activeRunId`, so a
    // claim left behind here would follow the task into `merging` and refuse operator commands on
    // work that is no longer being reviewed at all.
    // `activeRunId: runId` as well (fix round 1): every release is guarded on the run id, and the
    // two that MOVE the task are the two that most need it. A conclusion replayed after this run's
    // claim was released and a REPLACEMENT review claimed the task would otherwise march that live
    // review's task into `merging` on the strength of a verdict about an older run -- and clear the
    // replacement's claim on the way past.
    const updated = await prisma.task.updateMany({
      where: { id: task.id, status: 'reviewing', activeRunId: runId },
      data: { status: 'merging', activeRunId: null },
    })
    if (updated.count === 1) {
      await appendEvent({
        type: 'task.review_approved',
        workspaceId: task.workspaceId,
        taskId: task.id,
        runId: run.id,
        actor: 'system',
        payload: { reason: parsed.value.reason },
      })
      // M53 R4: the reviewer judged the IMPLEMENTER's work, so the verdict settles on the
      // implementer's row -- the pattern M49 already uses to attribute a verified fact to its
      // author, never through `Task.assigneeId`, which nothing in this pipeline writes. INSIDE the
      // `count === 1` guard: an approve that lost the race is an approval nobody will ever see
      // land, and a verdict is a fact about work that moved.
      await settleTaskEvidence(task.id, { kind: 'review', verdict: 'approved', attempt: null })
    } else {
      // Dropped, not silently discarded (fix round 2), the same as the reject branch below: an
      // approve that loses the guard is an approval nobody will ever see land, and an operator
      // needs to know which run's verdict that was and which task/status/claim it collided with.
      const claim = task.activeRunId === null ? 'nothing' : `run ${task.activeRunId}`
      console.warn(
        `[review] dropping an approve verdict for task ${task.id} from run ${runId}, which is ${task.status} and claimed by ${claim}`,
      )
    }
    return
  }

  // Reject: the same rework machinery a failed verify uses, shared via `rejectTask`. Guarded the
  // way `advance()` guards on ADVANCEABLE, and for the same two reasons: a reject landing after an
  // operator cancelled the task must not resurrect it, and a replayed conclusion for the same run
  // (whose row legitimately stays `succeeded`) must not charge a second attempt. The approve and
  // invalid branches get this from their conditioned updates; a bare `rejectTask` would not.
  //
  // The CLAIM is checked here too (fix round 1), not just the status. `rejectTask` writes
  // `activeRunId: null` unconditionally -- deliberately, because `verify.ts`'s other callers reject
  // a task whose claim is an implementation run's -- so the guard that keeps a replayed conclusion
  // off a REPLACEMENT review's task has to live at this call site: a task that is `reviewing` and
  // claimed by a newer run is a task this older run's verdict has no authority over, and charging
  // an attempt for it would spend the budget twice on one rejection while clearing a live
  // reviewer's claim. Checked rather than pushed into `rejectTask`'s signature: this is the only
  // caller that has a run id to guard with.
  if (task.status !== 'reviewing' || task.activeRunId !== runId) {
    const claim = task.activeRunId === null ? 'nothing' : `run ${task.activeRunId}`
    console.warn(
      `[review] ignoring a reject verdict for task ${task.id}, which is ${task.status} and claimed by ${claim}`,
    )
    // The verdict is ignored; the claim is not -- when it is still THIS run's. A task that left
    // `reviewing` while pointing at this run (an operator's stop of the run parks it `blocked` and
    // clears it, but a status move that did not go through a release would not) is a task no
    // dispatch can claim again. Guarded on the run id, so a replay cannot clear a newer run's claim.
    await prisma.task.updateMany({
      where: { id: task.id, activeRunId: runId },
      data: { activeRunId: null },
    })
    return
  }
  const counted = await rejectTask(brandTaskId(task.id), parsed.value.reason)
  await appendEvent({
    type: 'task.review_rejected',
    workspaceId: task.workspaceId,
    taskId: task.id,
    runId: run.id,
    actor: 'system',
    payload: { reason: parsed.value.reason, attempt: counted.attempt },
  })
  // M53 R4, the other half. `counted.attempt` is the same number the event's own payload carries
  // one line above, which is what `reviewRejectedFrom` compares against the implementation run's
  // own derived attempt -- so a rejection that names an OLDER attempt settles `false` rather than
  // charging this run for a verdict about somebody else's work.
  await settleTaskEvidence(task.id, { kind: 'review', verdict: 'rejected', attempt: counted.attempt })
  if (counted.exhausted) {
    await appendEvent({
      type: 'task.failed',
      workspaceId: task.workspaceId,
      taskId: task.id,
      actor: 'system',
      payload: { reason: `review rejected after ${counted.attempt} attempts: ${parsed.value.reason}` },
    })
  }

  // M49 R2(d), plan erratum E2: `run` here is the REVIEWER's, so the lesson is scoped to the
  // worker whose diff was turned down -- the reviewer is the one who CAUGHT it, and handing
  // somebody else's mistake to the person who found it is not knowledge. Last, after both events
  // (the rework and, at the cap, the failure): a lesson is a record of what happened.
  await promote({
    kind: 'work_rejected',
    workspaceId: task.workspaceId,
    taskId: task.id,
    taskTitle: task.title,
    slaveId: await implementerOf(task.id, null),
    runId: run.id,
    reason: parsed.value.reason,
    by: 'review',
    sourceRef: run.id,
    requiredCapabilities: task.requiredCapabilities,
    goalVersion: task.goalVersion,
  })
}

/**
 * One dispatch pass: starts a review run for every `reviewing` task in the workspace that needs
 * one.
 *
 * Ordered by `createdAt` then `id` so two tasks that became reviewable in the same tick are always
 * visited in the same order -- determinism a test can pin, and an operator reading two ticks'
 * worth of `task.review_started` events can trust.
 */
export async function dispatchReviews(deps: TickDeps): Promise<readonly RunId[]> {
  const tasks = await prisma.task.findMany({
    where: { workspaceId: deps.workspaceId, status: 'reviewing' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })

  const started: RunId[] = []
  for (const task of tasks) {
    const runId = await dispatchReview(deps, task)
    if (runId !== null) started.push(runId)
  }
  return started
}

interface ReviewableTask {
  readonly id: string
  readonly workspaceId: string
  readonly title: string
  readonly description: string
  readonly branch: string | null
}

/**
 * Starts one task's review run, or explains -- by an escalation, a warning, or nothing at all --
 * why it did not.
 *
 * Mirrors `tick.ts`'s `startRun` deliberately: same order of checks (is one already live, is the
 * retry cap already spent, is there anyone free to do it), same shape of dispatch (create the row
 * before anything can fail, chain the pump, cancel-and-fail on a spawn error), same reason: a
 * review run's spawn is exactly as capable of dying in the provisioning-adjacent window as an
 * implementation run's is, and only that path already carries the "kill what was spawned before
 * recording anything" discipline.
 */
async function dispatchReview(deps: TickDeps, task: ReviewableTask): Promise<RunId | null> {
  // 1. Skip if a review run is already live for this task -- the ordinary case on every tick after
  // the first, since a review run routinely outlives the tick that started it.
  const liveReviews = await prisma.slaveRun.count({
    where: { taskId: task.id, kind: 'review', status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
  })
  if (liveReviews > 0) return null

  // 2. Retry cap (Erratum 2). A task cannot be in `reviewing` without having had an implementation
  // run once, but nothing enforces that in the schema, so a `null` here means "this task's own
  // state does not support review" rather than "review it later" -- warned, not silent, because an
  // operator needs to know a `reviewing` task is stuck for a reason that has nothing to do with
  // reviewer staffing.
  const latestImpl = await prisma.slaveRun.findFirst({
    where: { taskId: task.id, kind: 'implementation' },
    orderBy: { startedAt: 'desc' },
  })
  if (latestImpl === null || latestImpl.worktreePath === null || task.branch === null) {
    if (!warnedUnreviewable.has(task.id)) {
      warnedUnreviewable.add(task.id)
      console.warn(
        `[review] task ${task.id} is in reviewing but has no usable implementation run to review: ` +
          `latestImpl=${latestImpl?.id ?? 'none'} worktreePath=${latestImpl?.worktreePath ?? 'none'} branch=${task.branch ?? 'none'}`,
      )
    }
    return null
  }

  const reviewAttempts = await prisma.slaveRun.count({
    where: { taskId: task.id, kind: 'review', startedAt: { gt: latestImpl.startedAt } },
  })
  // The cap is reached, not merely one review failing: a single failed review already leaves the
  // task in `reviewing` for the next attempt (`concludeReview`'s invalid-verdict branch, deliberately
  // -- see its own comment), and that intent survives untouched. What this cap being SPENT means is
  // that the same implementation has now had `REVIEW_RETRY_CAP` review runs in a row that could not
  // even produce a parseable verdict for it -- a rejected review moves the task to `rework` and
  // starts a fresh implementation run, which resets this count (it is scoped to `startedAt: { gt:
  // latestImpl.startedAt }`), so reaching the cap here specifically means the *reviewer* keeps
  // failing to say anything usable, not that the *implementation* is bad.
  //
  // Parked `blocked`, not `failed` and not `rework`: `failed` reads as "the work failed", which is
  // not what a reviewer producing no verdict establishes, and `rework` would spend another
  // implementation attempt re-doing work nothing has judged wrong. `blocked` is the same "an
  // operator has to look at this" signal `failToStart` in `tick.ts` parks a task under for a
  // worktree conflict, and `advance()` in `verify.ts` parks it under for a verify misconfiguration
  // -- neither is the slave's fault either, and neither is retried automatically. Guarded on the
  // task still being `reviewing`, the same discipline `concludeReview`'s approve branch uses, so a
  // concurrent sweep or cancel that already moved the task off `reviewing` is not overwritten.
  if (reviewAttempts >= REVIEW_RETRY_CAP) {
    // `activeRunId: null` in the `where` as well (fix round 1). Check 1 above counts NON-terminal
    // review runs, so it does not cover the window this milestone's claim exists for: a review run
    // that is already terminal but whose `concludeReview` has not landed yet still HOLDS the task,
    // and the tick its own `run.succeeded` woke arrives here with the cap counting that very run.
    // Parking then would block a task whose live review is about to approve it. An unclaimed
    // `reviewing` task is the only one with nothing left in flight to wait for, and the next
    // dispatch after the conclusion releases the claim parks it properly.
    const blocked = await prisma.task.updateMany({
      where: { id: task.id, status: 'reviewing', activeRunId: null },
      data: { status: 'blocked', activeRunId: null },
    })
    if (blocked.count === 1) {
      await appendEvent({
        type: 'guardrail.tripped',
        workspaceId: task.workspaceId,
        taskId: task.id,
        actor: 'system',
        payload: {
          guardrail: 'review_retry_cap_exhausted' satisfies GuardrailKind,
          detail:
            `task "${task.title}" could not be reviewed: ${reviewAttempts} review run(s) in a row ` +
            'produced no usable verdict, and the review retry cap is spent. A human needs to look ' +
            'at this task.',
        },
      })
    }
    return null
  }

  // 3. Reviewer staffing. `'reviewer' ∈ runtimeRoles` (M37 §5), not `role === 'reviewer'`: `role`
  // is the profile's TITLE since M37, so a worker whose persona heading reads "Senior Engineer"
  // is staffable here exactly when an operator has said it may be dispatched as a reviewer. The
  // literal spelling is the same convention `decide()` uses for `requiredRole`, and Task 8's seed
  // data uses it too. A worker with an empty `runtimeRoles` set matches nothing and is never
  // staffed.
  // `companySlave -> template` included so `resolveRuntime` (M12 Task 8) can walk the whole override
  // chain for whichever reviewer is actually picked below.
  // `permissions` included alongside `companySlave -> template` (M18 Task 5) -- see `tick.ts`'s
  // own `startRun` for why: the resolved deny list is snapshotted at dispatch, from this run's own
  // slave row.
  const reviewers = await prisma.slave.findMany({
    where: { runtimeRoles: { has: 'reviewer' }, team: { workspaceId: task.workspaceId } },
    orderBy: { id: 'asc' },
    include: { companySlave: { include: { template: true } }, permissions: true },
  })

  if (reviewers.length === 0) {
    // The one-shot escalation (the empty-verify-commands precedent in `verify.ts`): a workspace
    // with no reviewer at all will never staff this task, so this is worth an operator's attention
    // exactly once per task, not once per tick forever.
    const alreadyEscalated = await prisma.executionEvent.findFirst({
      where: {
        workspaceId: task.workspaceId,
        taskId: task.id,
        type: 'guardrail_tripped',
        payload: { path: ['guardrail'], equals: 'no_reviewer' },
      },
      select: { seq: true },
    })
    if (alreadyEscalated === null) {
      await appendEvent({
        type: 'guardrail.tripped',
        workspaceId: task.workspaceId,
        taskId: task.id,
        actor: 'system',
        payload: {
          guardrail: 'no_reviewer' satisfies GuardrailKind,
          detail: `task "${task.title}" is waiting in reviewing: no reviewer-role slave in this workspace`,
        },
      })
    }
    return null
  }

  const busySlaveIds = new Set(
    (
      await prisma.slaveRun.findMany({
        where: { slaveId: { in: reviewers.map((reviewer) => reviewer.id) }, status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
        select: { slaveId: true },
      })
    ).map((run) => run.slaveId),
  )
  const reviewer = reviewers.find((candidate) => !busySlaveIds.has(candidate.id))
  // Every reviewer is busy. Not an escalation -- the workspace is staffed, the task just has to
  // wait its turn -- so this is deliberately as silent as `decide()` leaving a task unstarted
  // because every slave of its required role is busy.
  if (reviewer === undefined) return null

  // 4. Dispatch -- the `startRun` shape, minus worktree provisioning: a review judges the same
  // worktree the implementation run left, so there is nothing to provision.
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: task.workspaceId } })

  // M27 §8 (ruling R15): the insert re-reads `Workspace.archivedAt` under `FOR SHARE`, so an
  // archive that commits between the read just above and this write is seen. `null` is "no review
  // dispatched" -- the same silent outcome as every reviewer being busy, and deliberately not a
  // failure: nothing was attempted, so nothing feeds `REVIEW_RETRY_CAP`.
  const run = await createRunUnlessArchived(workspace.id, { taskId: task.id, slaveId: reviewer.id, kind: 'review', status: 'starting' })
  if (run === null) return null
  const runId = brandRunId(run.id)

  // The claim (M41 Task 3b), mirroring `startRun`'s in `tick.ts` -- same atomic `updateMany`, same
  // reason, and until this landed review was the one dispatch path without it.
  //
  // Check 1 above counts NON-TERMINAL review runs, which leaves a window nothing else closes:
  // `pumpRun` writes the review run terminal and emits `run.succeeded` BEFORE the chained
  // `verifyConcludedRun` -> `concludeReview` moves the task off `reviewing`, and `runDaemon` wakes
  // its tick coalescer on EVERY event in the workspace. So the review's own `run.succeeded` wakes a
  // tick that sees a `reviewing` task with no live review run and dispatches a SECOND reviewer onto
  // the same branch, 16-45 ms later -- measured five times in seven runs of the M41 scenario gate,
  // at one extra provider run per reviewed task. The second verdict is a no-op; the bill is not.
  // Two overlapping passes have the same problem without any pump at all: neither's `SlaveRun` row
  // exists when the other counts.
  //
  // Done in the database rather than in process for `startRun`'s reason: the CLI's `tick` can run
  // against a live daemon, and a mutex in one process says nothing about the other. The invariant
  // it establishes is the one everything below now relies on -- while a review run is non-terminal
  // (or terminal but not yet concluded) `Task.activeRunId` is that run's id, and a `reviewing` task
  // with `activeRunId: null` has no live review.
  const claimed = await prisma.task.updateMany({
    where: { id: task.id, status: 'reviewing', activeRunId: null },
    data: { activeRunId: run.id },
  })
  if (claimed.count === 0) {
    // Lost the race: another pass claimed the task first, or it left `reviewing` (a cancel, the
    // cap's park) between the read at the top of `dispatchReviews` and here. Nothing was attempted,
    // so this must not leave a `failed` row that reads as a review attempt against
    // `REVIEW_RETRY_CAP`, and must not touch the winner's task -- exactly `startRun`'s reasoning.
    await prisma.slaveRun.delete({ where: { id: run.id } })
    return null
  }

  // Declared outside the `try` for the same reason `startRun` does: the catch below needs to tell
  // "never spawned" from "spawned, then something else failed" so it never abandons a live slave.
  let handle: RunHandle | null = null

  // Nullable now that resolving it can itself fail (M12 Task 8: an unconfigured provider) -- the
  // catch below needs to tell "no adapter to cancel with" apart from "spawned, then something
  // else failed" just as it already does for `handle`.
  let adapter: SlaveRuntimeAdapter | null = null

  try {
    // M12 Task 8: resolved first, inside the `try` -- see `tick.ts`'s `startRun` for the full
    // reasoning (a misconfigured provider is an attempted run that failed, not a "nothing to
    // attempt" that would retry silently forever).
    const workspaceDefault = await workspaceDefaultProvider(workspace.id)
    const resolved = resolveRuntime(reviewer, workspaceDefault)
    if (resolved.provider === null) {
      throw new Error(
        'no runtime could be resolved for this run: either this workspace has no configured ' +
          'default provider (ProviderConfiguration), or a level of the model override chain names ' +
          'a model with no provider recorded for it',
      )
    }
    adapter = resolveAdapter(deps.registry, resolved.provider)
    // Spec §6's dispatch-time re-check (M12 Task 9, ruling R9), after the adapter resolves and
    // before anything is spawned. It is a RE-check, not the only one: `packages/control`'s
    // `assignCompany`/`setSlaveModel` already refuse this pairing at write time. It exists anyway
    // because resolution crosses four levels, and a template edit -- or a new
    // `ProviderConfiguration` row -- can change the pair under a workspace that was perfectly
    // valid when it was configured, with no write to this workspace at all for the write-time
    // check to have fired on.
    //
    // Thrown, not returned, so it takes the SAME path the `invalid_provider` refusal above already
    // takes: the existing `catch` records an attempted run that failed (`failToStart`, spec §13).
    // `refusalText` is imported from `@slave-of-ai/control` rather than hand-copied, so the wording
    // an operator sees here and the wording the write surface promises cannot drift apart.
    //
    // AFTER `resolveAdapter`, deliberately: a kind this process has no adapter for is refused as
    // `invalid_provider` first, which is the more specific truth about it today.
    const admission = admitProvider(workspace, resolved.provider)
    if (!admission.ok) throw new Error(refusalText(admission.refusal))
    const runAdapter = adapter
    const model = resolved.model

    // Inside the `try`, not before it: a branch recorded on the task can be gone from git itself
    // (the step-2 null check cannot see that), and a diff failure outside this handler would leave
    // the run wedged non-terminal in `starting` -- counted as live by step 1 on every later tick --
    // while the thrown error aborts the rest of the pass.
    const rawDiff = await gitIn(workspace.repoPath, 'diff', `${workspace.baseBranch}...${task.branch}`)
    const diff = rawDiff.length > DIFF_CHAR_LIMIT ? `${rawDiff.slice(0, DIFF_CHAR_LIMIT)}\n[diff truncated]` : rawDiff

    await appendEvent({
      type: 'task.review_started',
      workspaceId: task.workspaceId,
      taskId: task.id,
      slaveId: reviewer.id,
      runId: run.id,
      actor: 'system',
      payload: { title: task.title },
    })

    // No `settingsPath` here any more (M12 Task 2): `runFilePaths` hands back the run's own
    // scratch directory, and what the adapter keeps inside it is that adapter's business, reported
    // back opaquely on `handle.runFiles` below.
    const { runDir, pauseFlagPath } = runFilePaths(workspace.repoPath, runId)

    // M18 Task 5 / M52 R2 -- see `tick.ts`'s `startRun` for the full reasoning. A review's baseline
    // is `read_repo` + `run_commands`: a reviewer reads and runs the tests, and writes nothing.
    // M52 R4: a fresh 32-byte token per spawn. The HASH goes on the row and into the file the gate
    // reads; the PLAINTEXT goes into the child's environment and nowhere else -- not on the row, not
    // in the checkpoint, not in a file, because a token file in `runDir` would be readable by every
    // sibling run under the same uid.
    const runToken = randomBytes(32).toString('hex')
    await prisma.slaveRun.update({ where: { id: run.id }, data: { runTokenHash: runTokenHash(runToken) } })
    const permissionsFilePath = writePermissionsFile(runDir, {
      rows: reviewer.permissions,
      provider: resolved.provider,
      runKind: 'review',
      runId: run.id,
      runToken,
    })

    const gitIdentity = { name: reviewer.name, email: `${emailLocalPart(reviewer)}@slaveofai.local` }

    // M37 Task 2: the one builder, given the diff this function just computed. Inside the same
    // `try` as the diff itself and for the same reason -- a `RunContextRefused` (a reviewer profile
    // over the cap) is a review that could not be produced, and the catch below is where that is
    // already recorded. Skills are injected into the implementation worktree the reviewer reads.
    const built = await buildRunContext({
      runId,
      kind: 'review',
      slaveId: reviewer.id,
      workspaceId: workspace.id,
      taskId: task.id,
      worktreePath: latestImpl.worktreePath,
      provider: resolved.provider,
      reviewDiff: { text: diff, base: workspace.baseBranch, head: task.branch, capped: rawDiff.length > DIFF_CHAR_LIMIT },
    })

    handle = await runAdapter.start({
      runId,
      prompt: built.prompt,
      // The preserved implementation worktree, not a fresh provision: the review judges what is
      // already sitting there, on the task's own branch.
      worktreePath: latestImpl.worktreePath,
      pauseFlagPath,
      runDir,
      permissionsFilePath,
      runToken,
      gitIdentity,
      ...(model !== undefined ? { model } : {}),
    })

    await prisma.slaveRun.update({
      where: { id: run.id },
      // `provider` (M12 Task 8) -- see `tick.ts`'s own `startRun` for why it is written here,
      // alongside `pid`, rather than at creation.
      // `model` (M51 R5 / plan erratum E10): the other half of the runtime pair, written in the same
      // statement for the same reason -- `resolveRuntime` is consulted at dispatch and the chain can
      // move under a live run, so the run's own row has to say which model it was actually spawned
      // with. `?? null` because `ResolvedRuntime.model` is `undefined` when nothing in the chain
      // named one, and the column's null means exactly that: unpriced, and honestly so.
      data: { pid: handle.pid, worktreePath: latestImpl.worktreePath, provider: resolved.provider, model: resolved.model ?? null },
    })

    // Chained into `tick.ts`'s own `pumps` set, exactly as `startRun` chains its own pump --
    // `drainPumps` only ever waits on that one set, and a review pump living anywhere else would
    // be invisible to it.
    const pump = pumpRun({
      runId,
      taskId: brandTaskId(task.id),
      slaveId: brandSlaveId(reviewer.id),
      workspaceId: deps.workspaceId,
      events: runAdapter.events(runId),
      cancel: () => runAdapter.cancel(runId),
      // `settingsPath`/`hookPath` come from the adapter's own report, not from anything
      // dispatched here (M12 Task 2).
      spawn: {
        ...handle.runFiles,
        pauseFlagPath,
        gitIdentity,
        // M12 Task 6/8: the provider this run actually started with, replayed verbatim on resume.
        provider: resolved.provider,
        ...(model !== undefined ? { model } : {}),
      },
    })
      .then(() => verifyConcludedRun(runId))
      .catch((error: unknown): void => {
        console.error(`[review] pump for run ${runId} failed:`, error)
      })
      .finally((): void => {
        activePumpRunIds.delete(run.id)
        pumps.delete(pump)
      })
    pumps.add(pump)
    activePumpRunIds.add(run.id)

    return runId
  } catch (error) {
    // Kill what was spawned before recording anything -- the same discipline `startRun` applies,
    // for the same reason: a slave nobody can find is worse than a failed run.
    let cancelError: unknown = null
    // `adapter !== null` is implied by `handle !== null`, but a resolution failure (a
    // misconfigured provider, above) is precisely the case where `adapter` is still `null` here.
    if (handle !== null && adapter !== null) {
      try {
        await adapter.cancel(runId)
      } catch (failure) {
        cancelError = failure
      }
    }
    const reason =
      (error instanceof Error ? error.message : String(error)) +
      (cancelError === null
        ? ''
        : ` -- AND THE CANCEL FAILED (${String(cancelError)}): the process may still be running.`)
    const now = new Date()
    await prisma.slaveRun.update({
      where: { id: run.id },
      data: { status: 'failed', terminalAt: now, endedAt: now },
    })
    // The task stays in `reviewing` -- this is infra failing to start, not the slave's work being
    // judged, so `attempt` (the slave-facing counter) is deliberately left untouched. But the claim
    // this dispatch took a few lines up must go back (M41 Task 3b): a task left pointing at a
    // terminal run is a task no later dispatch can ever claim, so the review that failed to start
    // would be the last one this task ever got. Guarded on the run id for the same reason every
    // other release here is -- a cancel or the sweep that already moved the task on must not be
    // overwritten.
    await prisma.task.updateMany({
      where: { id: task.id, activeRunId: run.id },
      data: { activeRunId: null },
    })
    await appendEvent({
      type: 'run.failed',
      workspaceId: task.workspaceId,
      taskId: task.id,
      slaveId: reviewer.id,
      runId: run.id,
      actor: 'system',
      payload: { reason },
    })
    return null
  }
}
