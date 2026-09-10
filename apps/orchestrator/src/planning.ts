import {
  NON_TERMINAL_RUN_STATUSES,
  slaveId as brandSlaveId,
  runId as brandRunId,
  parsePlanGraph,
  type RunId,
} from '@slave-of-ai/domain'
import { admitProvider, refusalText, resolveDenyList, runFilePaths, writePermissionsFile } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import type { SlaveRuntimeAdapter, RunHandle } from '@slave-of-ai/providers'
import { resolveRuntime, workspaceDefaultProvider } from './model.js'
import { resolveAdapter } from './provider.js'
import { pumpRun } from './pump.js'
import { concludeReplan, replanIntent, replanSectionOf, type ReplanIntent } from './replan.js'
import { buildRunContext } from './runContext.js'
import { createRunUnlessArchived } from './runs.js'
import { activePumpRunIds, emailLocalPart, pumps, type TickDeps } from './tick.js'
import { verifyConcludedRun } from './verify.js'

/** How many planning runs may fail against the current goal before dispatch stops trying (spec Decision 8).
 *  Exported since M40 t4 so the CLI's `replan-status` reports the cap the tick actually enforces
 *  rather than a second copy of the number. */
export const PLANNING_RETRY_CAP = 2

/**
 * Conclude a succeeded planning run: parse the task graph and turn it into the board.
 *
 * Called only for a `succeeded` run -- `verifyConcludedRun` branches here before its own
 * worktree/branch checks, which a planning run has no use for, because a task graph is not a diff.
 *
 * A run that produced no valid graph is treated as a failed planning attempt, not an
 * infrastructure problem: it still feeds `dispatchPlanning`'s retry cap (spec Decision 8),
 * deliberately -- "the process exited zero" is not "the manager decomposed the goal", and a
 * planner that keeps saying nothing parseable must not be retried forever. The goal itself is left
 * untouched; the cap, not a cleared goal, is what eventually stops redispatch.
 */
export async function concludePlanning(runId: RunId): Promise<void> {
  // M40 erratum E4: first plan or re-plan is decided by what this RUN was told, not by `run.kind`
  // (both are `planning`) and not by what the board looks like now. The manifest is the record of
  // the prompt that was actually sent, so a re-plan concludes as a delta even if the goal has moved
  // again since -- and a first plan can never be concluded as one.
  const replan = await replanSectionOf(runId)
  if (replan !== null) {
    await concludeReplan(runId)
    return
  }

  const run = await prisma.slaveRun.findUniqueOrThrow({
    where: { id: runId },
    include: { slave: { include: { team: true } } },
  })
  // A planning run has no task (M8b's task-less run) -- the workspace is only reachable through
  // `slave -> team`, never through `run.task`, which is always null here.
  const workspaceId = run.slave.team.workspaceId

  const rows = await prisma.executionEvent.findMany({
    where: { runId, type: 'run_output' },
    orderBy: { seq: 'asc' },
  })
  const text = rows.map((row) => (row.payload as { text: string }).text).join('\n')
  const parsed = parsePlanGraph(text)

  if (!parsed.ok) {
    await prisma.slaveRun.updateMany({
      where: { id: runId, status: 'succeeded' },
      data: { status: 'failed' },
    })
    await appendEvent({
      type: 'run.failed',
      workspaceId,
      slaveId: run.slaveId,
      runId: run.id,
      actor: 'system',
      payload: { reason: `planning run produced no valid task graph: ${parsed.error}` },
    })
    return
  }

  // An operator (or a hand-seeded fixture) raced the plan: the board is no longer empty by the
  // time this graph is ready to become one. Warned and dropped, the same `advance()` stale-result
  // discipline `concludeReview`'s conditioned updates give the review path -- creating a second
  // board on top of the first would be worse than losing a graph nobody signed off on landing.
  const existingTaskCount = await prisma.task.count({ where: { workspaceId } })
  if (existingTaskCount > 0) {
    console.warn(
      `[planning] ignoring a valid task graph for workspace ${workspaceId}: the board already has ${existingTaskCount} task(s)`,
    )
    return
  }

  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
  if (workspace.goal === null) {
    // Unreachable in practice: `dispatchPlanning` never starts a planning run without a goal, and
    // nothing in this milestone clears one once set. Thrown rather than routed around -- a
    // succeeded planning run against a goal-less workspace is data corruption, not a case this
    // function has an answer for.
    throw new Error(`workspace ${workspaceId} has no goal, but ran planning run ${run.id}`)
  }

  const created = await prisma.$transaction(async (tx) => {
    const idByKey = new Map<string, string>()
    const rows: Array<{ readonly id: string; readonly title: string; readonly role: string }> = []
    for (const planTask of parsed.value.tasks) {
      const task = await tx.task.create({
        data: {
          workspaceId,
          title: planTask.title,
          description: planTask.description,
          status: 'ready',
          // M47 t1 (plan erratum E2): `PlanTask.role` is optional now, and `?? null` is what
          // "the planner named no role" stores. Task 2 replaces this with the DERIVED role -- the
          // role the task's capabilities project to -- and writes `requiredCapabilities` beside
          // it; until then a capability-only graph stores a null role, exactly as a hand-made
          // task with no role does.
          requiredRole: planTask.role ?? null,
          createdBy: 'slave',
          createdByUserId: workspace.goalSetByUserId,
          maxAttempts: workspace.maxAttempts,
          // M40 §1: which requirement produced this task. `workspace.goalVersion` IS the version
          // of the `goal` this run was given (Task 3 adds the delta re-plan, where the version a
          // task is stamped with is the one the re-plan derived from rather than simply the
          // latest).
          //
          // 0 is no longer reachable through any writer (M40 Task 2 made `setGoal` -- the only
          // writer of `goal` -- insert the `GoalVersion` row and move the column in one
          // transaction), but it is still stamped as it is rather than guarded: a workspace whose
          // `goal` was hand-seeded straight into the table sits at 0, and 0 is a truthful "no
          // version was recorded for this". Every reader tolerates it (`summarise`'s stale count
          // needs `goalVersion < world.goalVersion`, which 0 < 0 is not), and inventing a 1 here
          // would name a `GoalVersion` row that does not exist.
          goalVersion: workspace.goalVersion,
        },
      })
      idByKey.set(planTask.key, task.id)
      // Read off the CREATED row, so the event says what was STORED. `?? ''` fails the payload
      // schema's `min(1)`, which is the right way to find out that a task reached the board with
      // no role at all -- E1 and E2 together are what promise it cannot, once Task 2 derives one.
      rows.push({ id: task.id, title: task.title, role: task.requiredRole ?? '' })
    }
    for (const planTask of parsed.value.tasks) {
      const taskId = idByKey.get(planTask.key) as string
      for (const dep of planTask.dependsOn) {
        await tx.taskDependency.create({
          data: { taskId, dependsOnTaskId: idByKey.get(dep) as string },
        })
      }
    }
    return rows
  })

  // Written after the transaction commits, exactly as `concludeReview`'s events follow its own
  // task update: an event describing a task that a rolled-back transaction never created would be
  // a lie in an append-only log.
  for (const task of created) {
    await appendEvent({
      type: 'task.created',
      workspaceId,
      taskId: task.id,
      actor: 'slave',
      payload: { title: task.title, goalVersion: workspace.goalVersion },
    })
  }

  await appendEvent({
    type: 'workspace.plan_created',
    workspaceId,
    slaveId: run.slaveId,
    runId: run.id,
    actor: 'slave',
    payload: {
      goal: workspace.goal,
      goalVersion: workspace.goalVersion,
      tasks: created.map((task) => ({ id: task.id, title: task.title, role: task.role })),
    },
  })
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

  // 2. Which of the two planning runs this would be. An EMPTY board is the first plan, unchanged
  // (spec Decision: planning fires at an empty board). A non-empty one gets a run only when the
  // goal has moved past the board that goal produced -- M40 §1's delta re-plan, whose own
  // preconditions (one per version, retries counted since that version) live in `replanIntent`. A
  // workspace whose board is current still does not get a planning run just because a task later
  // finishes or fails.
  const taskCount = await prisma.task.count({ where: { workspaceId: deps.workspaceId } })
  const replan: ReplanIntent | null =
    taskCount === 0 ? null : await replanIntent(deps.workspaceId, workspace.goalVersion, PLANNING_RETRY_CAP)
  if (taskCount > 0 && replan === null) return null

  // 3. Skip if a planning run is already live -- the ordinary case on every tick after the first,
  // since a planning run routinely outlives the tick that started it. `slave: { team: { workspaceId } }`,
  // not a task relation: a planning run has no task to scope through.
  const livePlanning = await prisma.slaveRun.count({
    where: {
      kind: 'planning',
      status: { in: [...NON_TERMINAL_RUN_STATUSES] },
      slave: { team: { workspaceId: deps.workspaceId } },
    },
  })
  if (livePlanning > 0) return null

  // 4. Retry cap (spec Decision 8). Counted since the goal was last (re)set -- a hand-seeded goal
  // with no `workspace.goal_set` event counts from the epoch, so every planning run against it
  // counts. Silent at the cap: the two `run.failed` events already written are the escalation.
  // The FIRST-plan path only: a re-plan counts its own failures since its own version's
  // `goal_set`, inside `replanIntent`, because "since the latest goal_set" would let a further
  // goal edit reset a cap the version being re-planned had already spent.
  if (replan === null) {
    const latestGoalSet = await prisma.executionEvent.findFirst({
      where: { workspaceId: deps.workspaceId, type: 'workspace_goal_set' },
      orderBy: { seq: 'desc' },
    })
    const since = latestGoalSet?.ts ?? new Date(0)
    const failedSinceGoal = await prisma.slaveRun.count({
      where: {
        kind: 'planning',
        status: 'failed',
        startedAt: { gt: since },
        slave: { team: { workspaceId: deps.workspaceId } },
      },
    })
    if (failedSinceGoal >= PLANNING_RETRY_CAP) return null
  }

  // 5. Staffing. `'manager' ∈ runtimeRoles` (M37 §5) -- the same convention `dispatchReview` uses
  // for `'reviewer'`, and for the same reason: `Slave.role` is the profile's title now, so what
  // may be dispatched as a manager is what an operator put in the runtime role set.
  // `companySlave -> template` included so `resolveRuntime` (M12 Task 8) can walk the whole override
  // chain for whichever manager is actually picked below.
  // `permissions` included alongside `companySlave -> template` (M18 Task 5) -- see `tick.ts`'s
  // own `startRun` for why: the resolved deny list is snapshotted at dispatch, from this run's own
  // slave row.
  const managers = await prisma.slave.findMany({
    where: { runtimeRoles: { has: 'manager' }, team: { workspaceId: deps.workspaceId } },
    orderBy: { id: 'asc' },
    include: { companySlave: { include: { template: true } }, permissions: true },
  })

  if (managers.length === 0) {
    // The one-shot escalation (`dispatchReview`'s `no_reviewer` precedent): a workspace with no
    // manager at all will never staff this, so this is worth an operator's attention exactly once
    // per WORKSPACE, not once per tick forever -- the dedup below has no goal_set bound, so even
    // a re-set goal does not re-escalate (hiring a manager is a one-time fix, unlike a plan).
    // Scoped by workspaceId with no taskId -- this guardrail is never about one task.
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
          detail: 'workspace has a goal and no tasks: no manager-role slave to plan it',
        },
      })
    }
    return null
  }

  const busySlaveIds = new Set(
    (
      await prisma.slaveRun.findMany({
        where: { slaveId: { in: managers.map((manager) => manager.id) }, status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
        select: { slaveId: true },
      })
    ).map((run) => run.slaveId),
  )
  const manager = managers.find((candidate) => !busySlaveIds.has(candidate.id))
  // Every manager is busy. Not an escalation -- the workspace is staffed, planning just has to
  // wait its turn -- so this is deliberately as silent as `dispatchReview` leaving a task waiting
  // because every reviewer is busy.
  if (manager === undefined) return null

  // Dispatch -- the `dispatchReview` shape minus a diff and minus a task: run row first, NO
  // taskId, so a data-corruption null-task check downstream never has to wonder whether this row
  // was supposed to have one.
  // M27 §8 (ruling R15): the insert re-reads `Workspace.archivedAt` under `FOR SHARE`, so an
  // archive that commits between this dispatch's own read of the workspace (above) and the write
  // is seen. `null` is "planning did not start" -- the same silent outcome as every manager being
  // busy, and deliberately not a failure: nothing was attempted, so nothing feeds the retry cap.
  const run = await createRunUnlessArchived(workspace.id, { slaveId: manager.id, kind: 'planning', status: 'starting' })
  if (run === null) return null
  const runId = brandRunId(run.id)

  // Declared outside the `try` for the same reason `dispatchReview` does: the catch below needs to
  // tell "never spawned" from "spawned, then something else failed" so it never abandons a live
  // slave.
  let handle: RunHandle | null = null

  // Nullable now that resolving it can itself fail (M12 Task 8: an unconfigured provider) -- the
  // catch below needs to tell "no adapter to cancel with" apart from "spawned, then something
  // else failed" just as it already does for `handle`.
  let adapter: SlaveRuntimeAdapter | null = null

  try {
    // M12 Task 8: resolved first, inside the `try` -- see `tick.ts`'s `startRun` for the full
    // reasoning (a misconfigured provider is an attempted run that failed, `failToStart`'s spec
    // §13 category, not a "nothing to attempt" that would retry silently forever).
    const workspaceDefault = await workspaceDefaultProvider(workspace.id)
    const resolved = resolveRuntime(manager, workspaceDefault)
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

    // No `settingsPath` here any more (M12 Task 2): `runFilePaths` hands back the run's own
    // scratch directory, and what the adapter keeps inside it is that adapter's business, reported
    // back opaquely on `handle.runFiles` below.
    const { runDir, pauseFlagPath } = runFilePaths(workspace.repoPath, runId)

    // M18 Task 5 -- see `tick.ts`'s `startRun` for the full reasoning.
    const permissionsFilePath = writePermissionsFile(runDir, resolveDenyList(manager.permissions, resolved.provider))

    const gitIdentity = { name: manager.name, email: `${emailLocalPart(manager)}@slaveofai.local` }

    // M37 Task 2: the one builder. `worktreePath: null` because a planning run reads the primary
    // checkout (spec Decision 5) -- skills are never injected there, and the manifest says so
    // (erratum E4). A `RunContextRefused` lands in this function's own catch, its existing
    // dispatch-failure path.
    const built = await buildRunContext({
      runId,
      kind: 'planning',
      slaveId: manager.id,
      workspaceId: workspace.id,
      taskId: null,
      worktreePath: null,
      provider: resolved.provider,
      // M40 §5: present only on a re-plan, and what makes this run one -- the builder renders the
      // `replan` section (both goals and the board) and `renderRunContext` appends the re-plan
      // trailer instead of the task-graph one because that section is there (erratum E2).
      ...(replan === null ? {} : { replan }),
    })

    handle = await runAdapter.start({
      runId,
      prompt: built.prompt,
      // The primary checkout itself, not a fresh worktree (spec Decision 5): the planner reads
      // the repository for context but never commits, so there is nothing to provision.
      worktreePath: workspace.repoPath,
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
      data: { pid: handle.pid, worktreePath: workspace.repoPath, provider: resolved.provider },
    })

    // M40 §1: written once the run is really running, because it is what "this version got its
    // re-plan" MEANS -- the dedup reads it back and asks what became of the run it names. A
    // dispatch that died before this point took the catch below instead, and left nothing for the
    // dedup to find, which is correct: nothing was re-planned.
    if (replan !== null) {
      await appendEvent({
        type: 'workspace.replan_started',
        workspaceId: deps.workspaceId,
        slaveId: manager.id,
        runId: run.id,
        actor: 'system',
        payload: { version: replan.version, runId: run.id },
      })
    }

    // Chained into `tick.ts`'s own `pumps` set, exactly as `dispatchReview` chains its own pump --
    // `drainPumps` only ever waits on that one set.
    const pump = pumpRun({
      runId,
      taskId: null,
      slaveId: brandSlaveId(manager.id),
      workspaceId: deps.workspaceId,
      events: runAdapter.events(runId),
      cancel: () => runAdapter.cancel(runId),
      // `settingsPath`/`hookPath` come from the adapter's own report, not from anything dispatched
      // here (M12 Task 2).
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
        console.error(`[planning] pump for run ${runId} failed:`, error)
      })
      .finally((): void => {
        activePumpRunIds.delete(run.id)
        pumps.delete(pump)
      })
    pumps.add(pump)
    activePumpRunIds.add(run.id)

    return runId
  } catch (error) {
    // Kill what was spawned before recording anything -- the same discipline `dispatchReview`
    // applies, for the same reason: a slave nobody can find is worse than a failed run.
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
    await appendEvent({
      type: 'run.failed',
      workspaceId: deps.workspaceId,
      slaveId: manager.id,
      runId: run.id,
      actor: 'system',
      payload: { reason },
    })
    return null
  }
}
