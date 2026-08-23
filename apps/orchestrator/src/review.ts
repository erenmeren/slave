import {
  NON_TERMINAL_RUN_STATUSES,
  agentId as brandAgentId,
  runId as brandRunId,
  taskId as brandTaskId,
  type RunId,
} from '@ai-team-os/domain'
import { runFilePaths } from '@ai-team-os/control'
import { prisma } from '@ai-team-os/db/client'
import { appendEvent } from '@ai-team-os/events'
import { writeSettingsFile } from '@ai-team-os/providers'
import { pumpRun } from './pump.js'
import { emailLocalPart, pumps, type TickDeps } from './tick.js'
import { verifyConcludedRun } from './verify.js'
import { gitIn } from './worktree.js'

/** A single unified diff capped this many characters, past which it is truncated with a marker. */
const DIFF_CHAR_LIMIT = 60_000

/** How many review runs a task may burn before its cycle is escalated rather than retried (Erratum 2). */
const REVIEW_RETRY_CAP = 2

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
  const liveReviews = await prisma.agentRun.count({
    where: { taskId: task.id, kind: 'review', status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
  })
  if (liveReviews > 0) return null

  // 2. Retry cap (Erratum 2). A task cannot be in `reviewing` without having had an implementation
  // run once, but nothing enforces that in the schema, so a `null` here means "this task's own
  // state does not support review" rather than "review it later" -- warned, not silent, because an
  // operator needs to know a `reviewing` task is stuck for a reason that has nothing to do with
  // reviewer staffing.
  const latestImpl = await prisma.agentRun.findFirst({
    where: { taskId: task.id, kind: 'implementation' },
    orderBy: { startedAt: 'desc' },
  })
  if (latestImpl === null || latestImpl.worktreePath === null || task.branch === null) {
    console.warn(
      `[review] task ${task.id} is in reviewing but has no usable implementation run to review: ` +
        `latestImpl=${latestImpl?.id ?? 'none'} worktreePath=${latestImpl?.worktreePath ?? 'none'} branch=${task.branch ?? 'none'}`,
    )
    return null
  }

  const reviewAttempts = await prisma.agentRun.count({
    where: { taskId: task.id, kind: 'review', startedAt: { gt: latestImpl.startedAt } },
  })
  // Silent: the two `run.failed` events those review attempts already wrote are the escalation.
  // A third guardrail here would say nothing an operator cannot already see from the run history.
  if (reviewAttempts >= REVIEW_RETRY_CAP) return null

  // 3. Reviewer staffing. `role === 'reviewer'` is an exact match -- the same convention
  // `decide()` uses for `requiredRole`, and Task 8's seed data uses the same spelling.
  const reviewers = await prisma.agent.findMany({
    where: { role: 'reviewer', team: { workspaceId: task.workspaceId } },
    orderBy: { id: 'asc' },
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
          detail: `task "${task.title}" is waiting in reviewing: no reviewer-role agent in this workspace`,
        },
      })
    }
    return null
  }

  const busyAgentIds = new Set(
    (
      await prisma.agentRun.findMany({
        where: { agentId: { in: reviewers.map((reviewer) => reviewer.id) }, status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
        select: { agentId: true },
      })
    ).map((run) => run.agentId),
  )
  const reviewer = reviewers.find((candidate) => !busyAgentIds.has(candidate.id))
  // Every reviewer is busy. Not an escalation -- the workspace is staffed, the task just has to
  // wait its turn -- so this is deliberately as silent as `decide()` leaving a task unstarted
  // because every agent of its required role is busy.
  if (reviewer === undefined) return null

  // 4. Dispatch -- the `startRun` shape, minus worktree provisioning: a review judges the same
  // worktree the implementation run left, so there is nothing to provision.
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: task.workspaceId } })

  const run = await prisma.agentRun.create({
    data: { taskId: task.id, agentId: reviewer.id, kind: 'review', status: 'starting' },
  })
  const runId = brandRunId(run.id)

  const rawDiff = await gitIn(workspace.repoPath, 'diff', `${workspace.baseBranch}...${task.branch}`)
  const diff = rawDiff.length > DIFF_CHAR_LIMIT ? `${rawDiff.slice(0, DIFF_CHAR_LIMIT)}\n[diff truncated]` : rawDiff

  await appendEvent({
    type: 'task.review_started',
    workspaceId: task.workspaceId,
    taskId: task.id,
    agentId: reviewer.id,
    runId: run.id,
    actor: 'system',
    payload: { title: task.title },
  })

  // Declared outside the `try` for the same reason `startRun` does: the catch below needs to tell
  // "never spawned" from "spawned, then something else failed" so it never abandons a live agent.
  let handle: { readonly pid: number } | null = null

  try {
    const { settingsPath, pauseFlagPath } = runFilePaths(workspace.repoPath, runId)
    writeSettingsFile({ settingsPath, hookPath: deps.hookPath })

    const gitIdentity = { name: reviewer.name, email: `${emailLocalPart(reviewer)}@aiteamos.local` }

    handle = await deps.adapter.start({
      runId,
      prompt: buildReviewPrompt(task, diff),
      // The preserved implementation worktree, not a fresh provision: the review judges what is
      // already sitting there, on the task's own branch.
      worktreePath: latestImpl.worktreePath,
      pauseFlagPath,
      settingsPath,
      hookPath: deps.hookPath,
      gitIdentity,
    })

    await prisma.agentRun.update({
      where: { id: run.id },
      data: { pid: handle.pid, worktreePath: latestImpl.worktreePath },
    })

    // Chained into `tick.ts`'s own `pumps` set, exactly as `startRun` chains its own pump --
    // `drainPumps` only ever waits on that one set, and a review pump living anywhere else would
    // be invisible to it.
    const pump = pumpRun({
      runId,
      taskId: brandTaskId(task.id),
      agentId: brandAgentId(reviewer.id),
      workspaceId: deps.workspaceId,
      events: deps.adapter.events(runId),
      cancel: () => deps.adapter.cancel(runId),
      spawn: { settingsPath, pauseFlagPath, hookPath: deps.hookPath, gitIdentity },
    })
      .then(() => verifyConcludedRun(runId))
      .catch((error: unknown): void => {
        console.error(`[review] pump for run ${runId} failed:`, error)
      })
      .finally((): void => {
        pumps.delete(pump)
      })
    pumps.add(pump)

    return runId
  } catch (error) {
    // Kill what was spawned before recording anything -- the same discipline `startRun` applies,
    // for the same reason: an agent nobody can find is worse than a failed run.
    let cancelError: unknown = null
    if (handle !== null) {
      try {
        await deps.adapter.cancel(runId)
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
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: 'failed', terminalAt: now, endedAt: now },
    })
    // The task stays in `reviewing` -- this is infra failing to start, not the agent's work being
    // judged, so `attempt` (the agent-facing counter) is deliberately left untouched.
    await appendEvent({
      type: 'run.failed',
      workspaceId: task.workspaceId,
      taskId: task.id,
      agentId: reviewer.id,
      runId: run.id,
      actor: 'system',
      payload: { reason },
    })
    return null
  }
}
