import {
  NON_TERMINAL_RUN_STATUSES,
  slaveId as brandSlaveId,
  runId as brandRunId,
  taskId as brandTaskId,
  parseReviewVerdict,
  type RunId,
} from '@slave-of-ai/domain'
import { admitProvider, refusalText, resolveDenyList, runFilePaths, writePermissionsFile } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import type { SlaveRuntimeAdapter, RunHandle } from '@slave-of-ai/providers'
import { resolveRuntime, workspaceDefaultProvider } from './model.js'
import { resolveAdapter } from './provider.js'
import { pumpRun } from './pump.js'
import { activePumpRunIds, emailLocalPart, pumps, type TickDeps } from './tick.js'
import { rejectTask, verifyConcludedRun } from './verify.js'
import { gitIn } from './worktree.js'

/** A single unified diff capped this many characters, past which it is truncated with a marker. */
const DIFF_CHAR_LIMIT = 60_000

/** How many review runs a task may burn before its cycle is escalated rather than retried (Erratum 2). */
const REVIEW_RETRY_CAP = 2

/** Task ids already warned about as unreviewable -- once per daemon lifetime, not once per tick
 *  (M15 spec §3 B5): the seeded `reviewing` fixture task made this line the daemon log's loudest
 *  and least informative repetition. Bounded by the number of distinct stuck tasks. */
const warnedUnreviewable = new Set<string>()

/**
 * The prompt a review run starts from.
 *
 * The literal substring `"verdict"` is load-bearing beyond this prompt's own readability: Task 4's
 * fake CLI (`m8a-flow` mode) keys on it to tell a review run from a work run when neither carries
 * any other marker the fake can see. A prompt that rephrased this away would silently break the
 * fixture the whole M8a gate is driven through.
 */
export function buildReviewPrompt(
  task: { readonly title: string; readonly description: string },
  diff: string,
): string {
  return [
    'You are the QA reviewer for this task. Judge the DIFF against the task — do not rebuild or re-run it.',
    '',
    `Task: ${task.title}`,
    '',
    task.description,
    '',
    'DIFF (base...branch):',
    '```diff',
    diff,
    '```',
    '',
    'Your final message must contain exactly one JSON object and nothing else on its line:',
    '{"verdict":"approve","reason":"one paragraph"} or {"verdict":"reject","reason":"one paragraph"}',
  ].join('\n')
}

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
    const updated = await prisma.task.updateMany({
      where: { id: task.id, status: 'reviewing' },
      data: { status: 'merging' },
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
    }
    return
  }

  // Reject: the same rework machinery a failed verify uses, shared via `rejectTask`. Guarded the
  // way `advance()` guards on ADVANCEABLE, and for the same two reasons: a reject landing after an
  // operator cancelled the task must not resurrect it, and a replayed conclusion for the same run
  // (whose row legitimately stays `succeeded`) must not charge a second attempt. The approve and
  // invalid branches get this from their conditioned updates; a bare `rejectTask` would not.
  if (task.status !== 'reviewing') {
    console.warn(`[review] ignoring a reject verdict for task ${task.id}, which is ${task.status}`)
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
  if (counted.exhausted) {
    await appendEvent({
      type: 'task.failed',
      workspaceId: task.workspaceId,
      taskId: task.id,
      actor: 'system',
      payload: { reason: `review rejected after ${counted.attempt} attempts: ${parsed.value.reason}` },
    })
  }
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
  // Silent: the two `run.failed` events those review attempts already wrote are the escalation.
  // A third guardrail here would say nothing an operator cannot already see from the run history.
  if (reviewAttempts >= REVIEW_RETRY_CAP) return null

  // 3. Reviewer staffing. `role === 'reviewer'` is an exact match -- the same convention
  // `decide()` uses for `requiredRole`, and Task 8's seed data uses the same spelling.
  // `companySlave -> template` included so `resolveRuntime` (M12 Task 8) can walk the whole override
  // chain for whichever reviewer is actually picked below.
  // `permissions` included alongside `companySlave -> template` (M18 Task 5) -- see `tick.ts`'s
  // own `startRun` for why: the resolved deny list is snapshotted at dispatch, from this run's own
  // slave row.
  const reviewers = await prisma.slave.findMany({
    where: { role: 'reviewer', team: { workspaceId: task.workspaceId } },
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
          guardrail: 'no_reviewer',
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

  const run = await prisma.slaveRun.create({
    data: { taskId: task.id, slaveId: reviewer.id, kind: 'review', status: 'starting' },
  })
  const runId = brandRunId(run.id)

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

    // M18 Task 5 -- see `tick.ts`'s `startRun` for the full reasoning.
    const permissionsFilePath = writePermissionsFile(runDir, resolveDenyList(reviewer.permissions, resolved.provider))

    const gitIdentity = { name: reviewer.name, email: `${emailLocalPart(reviewer)}@slaveofai.local` }

    handle = await runAdapter.start({
      runId,
      prompt: buildReviewPrompt(task, diff),
      // The preserved implementation worktree, not a fresh provision: the review judges what is
      // already sitting there, on the task's own branch.
      worktreePath: latestImpl.worktreePath,
      pauseFlagPath,
      runDir,
      permissionsFilePath,
      gitIdentity,
      ...(model !== undefined ? { model } : {}),
    })

    await prisma.slaveRun.update({
      where: { id: run.id },
      // `provider` (M12 Task 8) -- see `tick.ts`'s own `startRun` for why it is written here,
      // alongside `pid`, rather than at creation.
      data: { pid: handle.pid, worktreePath: latestImpl.worktreePath, provider: resolved.provider },
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
    // judged, so `attempt` (the slave-facing counter) is deliberately left untouched.
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
