import {
  NON_TERMINAL_RUN_STATUSES,
  agentId as brandAgentId,
  runId as brandRunId,
  type RunId,
} from '@ai-team-os/domain'
import { runFilePaths } from '@ai-team-os/control'
import { prisma } from '@ai-team-os/db/client'
import { appendEvent } from '@ai-team-os/events'
import { writeSettingsFile } from '@ai-team-os/providers'
import { pumpRun } from './pump.js'
import { emailLocalPart, pumps, type TickDeps } from './tick.js'
import { verifyConcludedRun } from './verify.js'

/** How many planning runs may fail against the current goal before dispatch stops trying (spec Decision 8). */
const PLANNING_RETRY_CAP = 2

/**
 * The prompt a planning run starts from.
 *
 * The literal substring `"task graph"` is load-bearing beyond this prompt's own readability:
 * Task 5's fake CLI (`m8-flow` mode) keys on it to tell a planning run from a review or work run
 * when neither carries any other marker the fake can see. A prompt that rephrased this away would
 * silently break the fixture the whole M8b gate is driven through. It must also never contain the
 * substring `"verdict"` -- the same fake selects the review arm on that literal, and a planning
 * prompt that accidentally carried it would be misrouted to the review fixture instead.
 */
export function buildPlanningPrompt(goal: string): string {
  return [
    'You are the engineering manager. Decompose the GOAL below into a "task graph" for your team.',
    'Read the repository for context, but do NOT modify, create, or commit any file.',
    '',
    `GOAL: ${goal}`,
    '',
    'Your final message must contain exactly one JSON object and nothing else on its line:',
    '{"tasks":[{"key":"short-unique-key","title":"...","description":"...","role":"backend","dependsOn":["other-key"]}]}',
    'Between 1 and 20 tasks. Keys are plan-local. dependsOn lists keys, no cycles.',
  ].join('\n')
}

/**
 * One dispatch pass: starts the workspace's planning run when its goal is set and its board is
 * empty, and staffing and the retry cap both allow it.
 *
 * Mirrors `dispatchReview`'s shape (`review.ts`) minus a diff and minus a task: same order of
 * checks (is one already live, is the retry cap already spent, is there anyone free to do it),
 * same shape of dispatch (create the row before anything can fail, chain the pump, cancel-and-fail
 * on a spawn error) -- a planning run's spawn is exactly as capable of dying in the
 * provisioning-adjacent window as a review's or an implementation's is.
 */
export async function dispatchPlanning(deps: TickDeps): Promise<RunId | null> {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: deps.workspaceId } })

  // 1. No goal, nothing to plan toward.
  if (workspace.goal === null) return null

  // 2. Any task at all -- any status -- means the board is not empty (spec Decision: planning
  // fires only at an empty board). A workspace with a goal and existing tasks does not get a
  // planning run just because a task later finishes or fails.
  const taskCount = await prisma.task.count({ where: { workspaceId: deps.workspaceId } })
  if (taskCount > 0) return null

  // 3. Skip if a planning run is already live -- the ordinary case on every tick after the first,
  // since a planning run routinely outlives the tick that started it. `agent: { team: { workspaceId } }`,
  // not a task relation: a planning run has no task to scope through.
  const livePlanning = await prisma.agentRun.count({
    where: {
      kind: 'planning',
      status: { in: [...NON_TERMINAL_RUN_STATUSES] },
      agent: { team: { workspaceId: deps.workspaceId } },
    },
  })
  if (livePlanning > 0) return null

  // 4. Retry cap (spec Decision 8). Counted since the goal was last (re)set -- a hand-seeded goal
  // with no `workspace.goal_set` event counts from the epoch, so every planning run against it
  // counts. Silent at the cap: the two `run.failed` events already written are the escalation.
  const latestGoalSet = await prisma.executionEvent.findFirst({
    where: { workspaceId: deps.workspaceId, type: 'workspace_goal_set' },
    orderBy: { seq: 'desc' },
  })
  const since = latestGoalSet?.ts ?? new Date(0)
  const failedSinceGoal = await prisma.agentRun.count({
    where: {
      kind: 'planning',
      status: 'failed',
      startedAt: { gt: since },
      agent: { team: { workspaceId: deps.workspaceId } },
    },
  })
  if (failedSinceGoal >= PLANNING_RETRY_CAP) return null

  // 5. Staffing. `role === 'manager'` is an exact match -- the same convention `dispatchReview`
  // uses for `role === 'reviewer'`.
  const managers = await prisma.agent.findMany({
    where: { role: 'manager', team: { workspaceId: deps.workspaceId } },
    orderBy: { id: 'asc' },
  })

  if (managers.length === 0) {
    // The one-shot escalation (`dispatchReview`'s `no_reviewer` precedent): a workspace with no
    // manager at all will never staff this, so this is worth an operator's attention exactly once
    // per goal, not once per tick forever. Scoped by workspaceId with no taskId -- this guardrail
    // is never about one task.
    const alreadyEscalated = await prisma.executionEvent.findFirst({
      where: {
        workspaceId: deps.workspaceId,
        type: 'guardrail_tripped',
        payload: { path: ['guardrail'], equals: 'no_planner' },
      },
      select: { seq: true },
    })
    if (alreadyEscalated === null) {
      await appendEvent({
        type: 'guardrail.tripped',
        workspaceId: deps.workspaceId,
        actor: 'system',
        payload: {
          guardrail: 'no_planner',
          detail: 'workspace has a goal and no tasks: no manager-role agent to plan it',
        },
      })
    }
    return null
  }

  const busyAgentIds = new Set(
    (
      await prisma.agentRun.findMany({
        where: { agentId: { in: managers.map((manager) => manager.id) }, status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
        select: { agentId: true },
      })
    ).map((run) => run.agentId),
  )
  const manager = managers.find((candidate) => !busyAgentIds.has(candidate.id))
  // Every manager is busy. Not an escalation -- the workspace is staffed, planning just has to
  // wait its turn -- so this is deliberately as silent as `dispatchReview` leaving a task waiting
  // because every reviewer is busy.
  if (manager === undefined) return null

  // Dispatch -- the `dispatchReview` shape minus a diff and minus a task: run row first, NO
  // taskId, so a data-corruption null-task check downstream never has to wonder whether this row
  // was supposed to have one.
  const run = await prisma.agentRun.create({
    data: { agentId: manager.id, kind: 'planning', status: 'starting' },
  })
  const runId = brandRunId(run.id)

  // Declared outside the `try` for the same reason `dispatchReview` does: the catch below needs to
  // tell "never spawned" from "spawned, then something else failed" so it never abandons a live
  // agent.
  let handle: { readonly pid: number } | null = null

  try {
    const { settingsPath, pauseFlagPath } = runFilePaths(workspace.repoPath, runId)
    writeSettingsFile({ settingsPath, hookPath: deps.hookPath })

    const gitIdentity = { name: manager.name, email: `${emailLocalPart(manager)}@aiteamos.local` }

    handle = await deps.adapter.start({
      runId,
      prompt: buildPlanningPrompt(workspace.goal),
      // The primary checkout itself, not a fresh worktree (spec Decision 5): the planner reads
      // the repository for context but never commits, so there is nothing to provision.
      worktreePath: workspace.repoPath,
      pauseFlagPath,
      settingsPath,
      hookPath: deps.hookPath,
      gitIdentity,
    })

    await prisma.agentRun.update({
      where: { id: run.id },
      data: { pid: handle.pid, worktreePath: workspace.repoPath },
    })

    // Chained into `tick.ts`'s own `pumps` set, exactly as `dispatchReview` chains its own pump --
    // `drainPumps` only ever waits on that one set.
    const pump = pumpRun({
      runId,
      taskId: null,
      agentId: brandAgentId(manager.id),
      workspaceId: deps.workspaceId,
      events: deps.adapter.events(runId),
      cancel: () => deps.adapter.cancel(runId),
      spawn: { settingsPath, pauseFlagPath, hookPath: deps.hookPath, gitIdentity },
    })
      .then(() => verifyConcludedRun(runId))
      .catch((error: unknown): void => {
        console.error(`[planning] pump for run ${runId} failed:`, error)
      })
      .finally((): void => {
        pumps.delete(pump)
      })
    pumps.add(pump)

    return runId
  } catch (error) {
    // Kill what was spawned before recording anything -- the same discipline `dispatchReview`
    // applies, for the same reason: an agent nobody can find is worse than a failed run.
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
    await appendEvent({
      type: 'run.failed',
      workspaceId: deps.workspaceId,
      agentId: manager.id,
      runId: run.id,
      actor: 'system',
      payload: { reason },
    })
    return null
  }
}
