import {
  NON_TERMINAL_RUN_STATUSES,
  TERMINAL,
  applyCancelPolicy,
  candidates,
  parsePlanDelta,
  runContextManifestSchema,
  type RunId,
  type SectionSource,
  type Situation,
} from '@slave-of-ai/domain'
import { loadSupervisorWorld, recordDecision, refusalText } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'

/** The `replan` entry of a run's recorded manifest -- the only thing that tells a re-plan run from
 *  a first-plan run, since both are `kind: 'planning'` (spec erratum E2/E4). */
type ReplanSection = Extract<SectionSource, { kind: 'replan' }>

/** What `dispatchPlanning` needs to start a re-plan: which version this run is answering, and
 *  which one it is answering it FROM. */
export interface ReplanIntent {
  readonly previousVersion: number
  readonly version: number
}

/**
 * Whether the workspace's goal has moved past the board that goal produced, and a re-plan for that
 * move may start now (M40 §1).
 *
 * Only ever asked of a NON-EMPTY board -- an empty one is the first-plan path, unchanged. Three
 * things can say no, and they are different questions:
 *
 * 1. **The board is already current.** `max(Task.goalVersion)` over the non-terminal tasks, with a
 *    null (hand-made) or absent stamp counting as 0. Terminal tasks are excluded because they are
 *    what a re-plan may not touch anyway: a finished task cannot be cancelled and does not need
 *    re-deriving, so leaving it in the max would suppress a re-plan the live board still needs.
 * 2. **A re-plan for this version already happened, or is happening.** `workspace.replan_started`
 *    names the run it started; a run that is non-terminal or `succeeded` is a re-plan this version
 *    got. A FAILED one is not -- it produced nothing -- so it falls through to the cap below,
 *    which is the thing that eventually stops retrying.
 * 3. **The retries for this version are spent.** `PLANNING_RETRY_CAP` failures since THIS
 *    version's `workspace.goal_set`, exactly as the first-plan path counts since the latest one.
 *    Silent at the cap, also exactly as the first-plan path is (`dispatchPlanning`'s check 4): the
 *    `run.failed` events already written are the escalation, and inventing a `guardrail.tripped`
 *    here would make a re-plan louder than the first plan whose failure leaves a workspace with no
 *    board at all.
 *
 * Both event reads filter in JS rather than in the query: these are workspace-lifetime events (one
 * per goal edit, one per re-plan), so there are a handful of them, and a `payload.path` filter on a
 * JSON NUMBER is a subtlety this does not need to depend on.
 */
export async function replanIntent(
  workspaceId: string,
  goalVersion: number,
  retryCap: number,
): Promise<ReplanIntent | null> {
  // 1. Has the goal actually moved past the board?
  const board = await prisma.task.findMany({
    where: { workspaceId, status: { notIn: [...TERMINAL] } },
    select: { goalVersion: true },
  })
  const boardVersion = board.reduce((highest, task) => Math.max(highest, task.goalVersion ?? 0), 0)
  if (goalVersion <= boardVersion) return null

  // 2. One re-plan per version (M40 §1).
  const startedRunIds = (
    await prisma.executionEvent.findMany({
      where: { workspaceId, type: 'workspace_replan_started' },
      select: { payload: true },
    })
  )
    .map((event) => event.payload as { version?: unknown; runId?: unknown })
    .filter((payload) => payload.version === goalVersion)
    .map((payload) => payload.runId)
    .filter((runId): runId is string => typeof runId === 'string')
  if (startedRunIds.length > 0) {
    const alive = await prisma.slaveRun.count({
      where: { id: { in: startedRunIds }, status: { in: [...NON_TERMINAL_RUN_STATUSES, 'succeeded'] } },
    })
    if (alive > 0) return null
  }

  // 3. The cap, counted since this version was set. A version with no `workspace.goal_set` event
  // (a stamp written by something other than `setGoal`) counts from the epoch, so every planning
  // failure the workspace ever had counts -- the same conservative reading the first-plan path
  // gives a hand-seeded goal.
  const goalSet = (
    await prisma.executionEvent.findMany({
      where: { workspaceId, type: 'workspace_goal_set' },
      orderBy: { seq: 'desc' },
      select: { ts: true, payload: true },
    })
  ).find((event) => (event.payload as { version?: unknown }).version === goalVersion)
  const since = goalSet?.ts ?? new Date(0)
  const failedSinceVersion = await prisma.slaveRun.count({
    where: {
      kind: 'planning',
      status: 'failed',
      startedAt: { gt: since },
      slave: { team: { workspaceId } },
    },
  })
  if (failedSinceVersion >= retryCap) return null

  return { previousVersion: goalVersion - 1, version: goalVersion }
}

/** The `replan` section of a run's recorded manifest, or `null` when it has none -- which is what
 *  makes a planning run a FIRST plan. A row that will not parse is treated as "no replan section":
 *  a manifest nothing can read cannot be evidence that this run was a re-plan. */
export async function replanSectionOf(runId: RunId): Promise<ReplanSection | null> {
  const row = await prisma.runContext.findUnique({ where: { runId }, select: { sections: true } })
  if (row === null) return null
  const manifest = runContextManifestSchema.safeParse(row.sections)
  if (!manifest.success) return null
  return (manifest.data.sections.find((section) => section.kind === 'replan') as ReplanSection | undefined) ?? null
}

/**
 * Conclude a succeeded RE-plan run: the delta the manager returned becomes new tasks at once, and
 * proposals for the rest (M40 §5).
 *
 * The asymmetry is ruling R1 and it is the whole point: **additions apply, cancellations are
 * proposed.** A wrong addition costs one backlog row a human can cancel; a wrong cancellation
 * costs real planned work, so every one of them goes through `recordDecision` as a `stale_task`
 * proposal a human approves, and `cancelTask` is never called from here.
 *
 * A run that produced no valid delta is a failed planning attempt rather than an infrastructure
 * problem, treated exactly as `concludePlanning` treats an unparseable graph: the run is marked
 * failed, `run.failed` says why, and that failure feeds the retry cap in {@link replanIntent}.
 */
export async function concludeReplan(runId: RunId): Promise<void> {
  const replan = await replanSectionOf(runId)
  if (replan === null) {
    // Unreachable through `concludePlanning`, which routes here only when it found this section.
    // Thrown rather than routed around: concluding a first plan as a delta would silently create
    // nothing and cancel nothing.
    throw new Error(`run ${runId} has no replan section in its recorded context: it is not a re-plan run`)
  }

  const run = await prisma.slaveRun.findUniqueOrThrow({
    where: { id: runId },
    include: { slave: { include: { team: true } } },
  })
  // A planning run has no task (M8b): the workspace is only reachable through `slave -> team`.
  const workspaceId = run.slave.team.workspaceId

  const rows = await prisma.executionEvent.findMany({
    where: { runId, type: 'run_output' },
    orderBy: { seq: 'asc' },
  })
  const text = rows.map((row) => (row.payload as { text: string }).text).join('\n')

  // EVERY task, not only the non-terminal ones the prompt showed. The prompt's board is what the
  // manager may name; this is what the names are RESOLVED against, and the two are deliberately
  // not the same set:
  //
  // - Spec §1 says a cancellation of a done, failed or cancelled task is "dropped and recorded".
  //   That outcome is only reachable if the parse ACCEPTS the id -- with the non-terminal board
  //   here, the same request would fail the whole delta instead, and a re-plan whose additions
  //   were fine would be thrown away over a cancellation that was never going to happen.
  // - A run takes minutes. A task the prompt showed as `running` can be `done` by the time this
  //   reads the board, and a delta that dutifully `keep`s it must not become unparseable because
  //   the work finished while the manager was thinking.
  //
  // `applyCancelPolicy` then judges each requested cancellation by the status it finds HERE, which
  // is the only status that can be acted on.
  const board = await prisma.task.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, title: true, status: true, goalVersion: true },
  })
  const parsed = parsePlanDelta(
    text,
    board.map((task) => task.id),
  )

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
      payload: { reason: `planning run produced no valid re-plan delta: ${parsed.error}` },
    })
    return
  }

  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
  const version = replan.version

  // `status: 'ready'`, `createdBy: 'slave'` and `createdByUserId` are `concludePlanning`'s own
  // choices, mirrored deliberately (the spec's §1 says "backlog", the first plan has always
  // written `ready`, and two paths that create planned tasks differently would be worse than one
  // that disagrees with a sentence). `goalVersion` is the version THIS re-plan derived from --
  // `replan.version`, off the run's own manifest, not `workspace.goalVersion`, which may have
  // moved again while this run was in flight.
  const created = await prisma.$transaction(async (tx) => {
    const idByKey = new Map<string, string>()
    const added: Array<{ readonly id: string; readonly title: string }> = []
    for (const planTask of parsed.value.add) {
      const task = await tx.task.create({
        data: {
          workspaceId,
          title: planTask.title,
          description: planTask.description,
          status: 'ready',
          requiredRole: planTask.role,
          createdBy: 'slave',
          createdByUserId: workspace.goalSetByUserId,
          maxAttempts: workspace.maxAttempts,
          goalVersion: version,
        },
      })
      idByKey.set(planTask.key, task.id)
      added.push({ id: task.id, title: task.title })
    }
    for (const planTask of parsed.value.add) {
      const taskId = idByKey.get(planTask.key) as string
      for (const dep of planTask.dependsOn) {
        // Plan keys first, then existing ids (spec erratum E1): a new task may depend on work that
        // is already on the board, and `validateDelta` has already established that every entry is
        // one or the other.
        await tx.taskDependency.create({ data: { taskId, dependsOnTaskId: idByKey.get(dep) ?? dep } })
      }
    }
    return added
  })

  // After the commit, exactly as `concludePlanning`'s events follow its own transaction: an event
  // describing a task a rolled-back transaction never created would be a lie in an append-only log.
  for (const task of created) {
    await appendEvent({
      type: 'task.created',
      workspaceId,
      taskId: task.id,
      actor: 'slave',
      payload: { title: task.title, goalVersion: version },
    })
  }

  const policy = applyCancelPolicy(parsed.value, board)
  const proposedCancellations = await proposeCancellations({
    workspaceId,
    version,
    cancellable: policy.cancellable,
    board,
  })

  await appendEvent({
    type: 'workspace.replanned',
    workspaceId,
    slaveId: run.slaveId,
    runId: run.id,
    actor: 'slave',
    payload: {
      version,
      runId: run.id,
      added: created.map((task) => task.id),
      proposedCancellations,
      // The status rule's refusals, carried with the status that refused them, so a cancellation
      // the model asked for and did not get is on the record rather than silently forgotten.
      droppedCancellations: policy.dropped.map((entry) => ({ taskId: entry.taskId, status: entry.status })),
    },
  })
}

/**
 * One `stale_task` proposal per cancellable id, through `recordDecision` and nothing else (M40 §5,
 * ruling R1).
 *
 * `stale_task` is the one situation `observe` never emits (spec §3): it is a JUDGEMENT the
 * manager's own run made, not a predicate over the world, so it is recorded here with the delta in
 * hand. The catalogue still comes from the domain -- `candidates(situation, world)`, whose index 0
 * for this kind is `cancel_task` (spec erratum E6) -- so the row a human approves offers the same
 * alternatives every other decision offers.
 *
 * Returns the ids that actually became proposals. A refusal is counted and skipped, never thrown:
 * `supervisor_cooldown` means a human is already looking at this exact task (or has just
 * answered about it), and `supervisor_disabled` means this project switched the Supervisor off --
 * neither is a reason to abandon a re-plan whose additions have already landed.
 */
async function proposeCancellations(input: {
  readonly workspaceId: string
  readonly version: number
  readonly cancellable: readonly string[]
  readonly board: readonly { readonly id: string; readonly title: string; readonly goalVersion: number | null }[]
}): Promise<string[]> {
  if (input.cancellable.length === 0) return []

  const now = new Date()
  const { world } = await loadSupervisorWorld(input.workspaceId, now)
  const proposed: string[] = []

  for (const taskId of input.cancellable) {
    const task = input.board.find((entry) => entry.id === taskId)
    if (task === undefined) continue
    const situation: Situation = {
      kind: 'stale_task',
      subjectId: taskId,
      summary: `the re-plan for goal v${String(input.version)} no longer needs "${task.title}"`,
      facts: {
        // 0 for a hand-made task: it was derived from no version at all, and a null in `facts`
        // would read as "unknown" rather than "none".
        goalVersion: task.goalVersion ?? 0,
        currentVersion: input.version,
        reason: 'replan_cancel',
      },
    }
    const catalogue = candidates(situation, world)
    const chosen = catalogue[0]
    if (chosen === undefined || chosen.action.kind !== 'cancel_task') {
      // The world moved between the board read and this one (the task finished, or was cancelled
      // by a human), so the domain has no cancellation to offer for it. Recording index 0 anyway
      // would propose whatever the fallback tail happens to start with -- an escalation nobody
      // asked for.
      console.warn(
        `[replan] no cancel_task candidate for task ${taskId} in workspace ${input.workspaceId}: skipping the proposal`,
      )
      continue
    }

    const recorded = await recordDecision({
      workspaceId: input.workspaceId,
      situation,
      candidates: catalogue,
      chosenIndex: 0,
      rationale: situation.summary,
      // The MANAGER decided this, in its re-plan run -- but no model call was made to decide it
      // here, and the Supervisor's spend must not gain a call that never happened (M38 §1).
      decidedBy: 'model',
      modelCalled: false,
      modelCostUsd: null,
      now,
    })
    if (!recorded.ok) {
      console.warn(
        `[replan] the cancellation proposal for task ${taskId} was not recorded: ${refusalText(recorded.error)}`,
      )
      continue
    }
    proposed.push(taskId)
  }

  return proposed
}
