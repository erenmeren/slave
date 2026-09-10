import {
  NON_TERMINAL_RUN_STATUSES,
  applyCancelPolicy,
  candidates,
  parsePlanDelta,
  runContextManifestSchema,
  type PlanDelta,
  type RunId,
  type SectionSource,
  type Situation,
  type TaskStatus,
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
 * The whole trigger verdict for one workspace (M40 §1), fact by fact.
 *
 * `replanIntent` below is this narrowed to the one question `dispatchPlanning` asks; the CLI's
 * `replan-status` prints the rest, because "no re-plan is coming" is four different situations and
 * an operator staring at a board that has not caught up needs to know WHICH one.
 */
export interface ReplanVerdict {
  /** `Workspace.goalVersion` -- the newest requirement. */
  readonly goalVersion: number
  /** `max(Task.goalVersion)` over EVERY task of the workspace, terminal or not, a null (hand-made)
   *  stamp counting as 0 (spec erratum E8). */
  readonly boardVersion: number
  /** How many tasks the board holds at all. 0 is the FIRST-plan path, where none of the rest of
   *  this applies -- `dispatchPlanning` never asks for a re-plan verdict on an empty board. */
  readonly boardTaskCount: number
  /** Whether the goal has moved past the board that goal produced. */
  readonly goalMoved: boolean
  /** Whether a re-plan for THIS version already ran or is running (the `workspace.replan_started`
   *  dedup). A failed one does not count -- it produced nothing. */
  readonly alreadyReplanned: boolean
  /** Whether a planning run of any kind is live right now. `dispatchPlanning`'s own check 3, which
   *  `replanIntent` deliberately does not make: it is a fact about the moment, not about the
   *  version, and it delays a re-plan rather than cancelling it. */
  readonly livePlanningRun: boolean
  /** Planning runs that FAILED since this version's `workspace.goal_set`. */
  readonly failedAttempts: number
  readonly retryCap: number
  /**
   * The workspace's RECORDED halt (`Workspace.haltedReason`), or `null`. `tick` returns before
   * `dispatchPlanning` while one stands, so a re-plan that is otherwise due does not start.
   *
   * Only the recorded halt: the guardrails that stop scheduling without writing the column
   * (concurrency, the budget, the circuit breaker) are re-evaluated by `decide()` on every tick from
   * a world this read does not load, and claiming to know about them here would be a promise this
   * function cannot keep.
   */
  readonly halted: string | null
  /** `Workspace.archivedAt !== null`. An archived project is invisible to the scheduler (M27 §3.3):
   *  `tick` returns before the world is even loaded. */
  readonly archived: boolean
  /** Whether the next tick would start a re-plan run for this version -- every fact above,
   *  answered together. */
  readonly willReplan: boolean
  /**
   * The FIRST thing stopping a re-plan that the goal move has otherwise made due, or `null`.
   *
   * `null` also covers the two cases where nothing is being stopped at all: a board that is already
   * current, and an empty board (which takes the first-plan path). "Nothing is due" and "something
   * is in the way" are different answers, and an operator asking why the board has not caught up
   * needs to be told which one they have.
   */
  readonly blockedBy: 'archived' | 'halted' | 'dedup' | 'retry_cap' | 'live_planning_run' | null
  /** What `dispatchPlanning` would dispatch, or `null`. Non-null even while a planning run is live,
   *  or while the workspace is halted: those are waits rather than refusals, and `tick` /
   *  `dispatchPlanning` make those checks themselves. */
  readonly intent: ReplanIntent | null
}

/**
 * Whether the workspace's goal has moved past the board that goal produced, and a re-plan for that
 * move may start now (M40 §1).
 *
 * Only ever asked of a NON-EMPTY board -- an empty one is the first-plan path, unchanged. Three
 * things can say no, and they are different questions:
 *
 * 1. **The board is already current.** `max(Task.goalVersion)` over EVERY task of the workspace,
 *    terminal or not, with a null (hand-made) or absent stamp counting as 0 (spec erratum E8).
 *    Terminal tasks were once excluded, on the reasoning that a re-plan may not touch them anyway
 *    -- but that made the max fall to 0 on a board whose every task had finished, so a project
 *    that was simply DONE re-planned spontaneously on its next tick and told the manager the goal
 *    had changed when nothing had. What the exclusion was written for is covered by the per-version
 *    dedup below: a terminal task carries version N only after version N had its re-plan, so a
 *    genuine v(N)->v(N+1) edit still fires, over whatever of the board is still live (which may be
 *    nothing -- an empty live board is a legitimate thing to show a manager).
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
 * Both event reads filter in JS rather than in the query, over the newest {@link RECENT_EVENTS}
 * rows: these are workspace-lifetime events (one per goal edit, one per re-plan), the ones that can
 * name the CURRENT version are by construction the last ones written, and a `payload.path` filter
 * on a JSON NUMBER is a subtlety this does not need to depend on.
 *
 * M40 t4: the three questions are answered by {@link replanVerdict} and read off it here, so the
 * tick and `replan-status` cannot drift into two ideas of when a re-plan fires.
 *
 * **This runs on every tick of every workspace**, so it stops at the first question rather than
 * paying for the diagnosis (final review, Important 2): a board that is already current -- which is
 * every board almost all of the time -- costs ONE query and returns, where `replanVerdict` would
 * have gone on to read the workspace, the runs and two spans of the event log to explain a `null`
 * nobody asked to have explained. The CLI's `replan-status`, which does want all of it, calls
 * {@link replanVerdict} directly.
 */
export async function replanIntent(
  workspaceId: string,
  goalVersion: number,
  retryCap: number,
): Promise<ReplanIntent | null> {
  const boardVersion = boardVersionOf(await goalVersionsOnBoard(workspaceId))
  if (goalVersion <= boardVersion) return null
  return (await replanVerdict(workspaceId, goalVersion, retryCap)).intent
}

/** Every task's stamp, terminal tasks included (spec erratum E8) -- the one read both the
 *  short-circuit above and {@link replanVerdict} compute the board's version from. */
async function goalVersionsOnBoard(workspaceId: string): Promise<{ readonly goalVersion: number | null }[]> {
  return prisma.task.findMany({ where: { workspaceId }, select: { goalVersion: true } })
}

/** `max(Task.goalVersion)`, a null (hand-made) stamp counting as 0. An EMPTY board is 0 too, which
 *  is only ever reached through `replanVerdict` -- `dispatchPlanning` takes the first-plan path
 *  there and never asks. */
function boardVersionOf(tasks: readonly { readonly goalVersion: number | null }[]): number {
  return tasks.reduce((highest, task) => Math.max(highest, task.goalVersion ?? 0), 0)
}

/** How far back the two workspace-lifetime event scans read. Both are looking for the row that
 *  names the CURRENT goal version, and both event types are written in version order, so the row
 *  they want is among the newest few or is not there at all -- while an unbounded scan grows with
 *  the workspace's whole life and was being paid on every tick (final review, Important 2). */
const RECENT_EVENTS = 20

/** {@link ReplanVerdict}, computed. Every fact is read even once an earlier one has already
 *  decided the outcome -- this is a diagnosis, and a caller asking why nothing is happening is owed
 *  all of it, not the first reason the tick would have stopped at. */
export async function replanVerdict(
  workspaceId: string,
  goalVersion: number,
  retryCap: number,
): Promise<ReplanVerdict> {
  // What `tick` decides before `dispatchPlanning` is ever reached (tick.ts: archived first, then
  // the halt). Read here rather than passed in, so the verdict is the same fact whoever asks --
  // `replanIntent` pays one primary-key read it does not use on the runs that get this far, which
  // is what one idea of the trigger costs (and it only gets this far when the goal really has moved,
  // which is rare).
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { haltedReason: true, archivedAt: true },
  })

  // 1. Has the goal actually moved past the board? EVERY task, terminal ones included (erratum
  // E8): a board whose tasks have all finished still carries the version they were derived from,
  // and dropping them made a finished project re-plan itself on its next tick.
  const board = await goalVersionsOnBoard(workspaceId)
  const boardVersion = boardVersionOf(board)
  const boardTaskCount = board.length
  const goalMoved = goalVersion > boardVersion

  // 2. One re-plan per version (M40 §1).
  const startedRunIds = (
    await prisma.executionEvent.findMany({
      where: { workspaceId, type: 'workspace_replan_started' },
      orderBy: { seq: 'desc' },
      take: RECENT_EVENTS,
      select: { payload: true },
    })
  )
    .map((event) => event.payload as { version?: unknown; runId?: unknown })
    .filter((payload) => payload.version === goalVersion)
    .map((payload) => payload.runId)
    .filter((runId): runId is string => typeof runId === 'string')
  const alreadyReplanned =
    startedRunIds.length > 0 &&
    (await prisma.slaveRun.count({
      where: { id: { in: startedRunIds }, status: { in: [...NON_TERMINAL_RUN_STATUSES, 'succeeded'] } },
    })) > 0

  // 3. The cap, counted since this version was set. A version with no `workspace.goal_set` event
  // (a stamp written by something other than `setGoal`) counts from the epoch, so every planning
  // failure the workspace ever had counts -- the same conservative reading the first-plan path
  // gives a hand-seeded goal.
  const goalSet = (
    await prisma.executionEvent.findMany({
      where: { workspaceId, type: 'workspace_goal_set' },
      orderBy: { seq: 'desc' },
      take: RECENT_EVENTS,
      select: { ts: true, payload: true },
    })
  ).find((event) => (event.payload as { version?: unknown }).version === goalVersion)
  const since = goalSet?.ts ?? new Date(0)
  const failedAttempts = await prisma.slaveRun.count({
    where: {
      kind: 'planning',
      status: 'failed',
      startedAt: { gt: since },
      slave: { team: { workspaceId } },
    },
  })

  // `dispatchPlanning`'s own check 3, which is NOT part of the intent: a live planning run makes
  // the tick wait, and the version keeps its claim on a re-plan until one actually starts.
  const livePlanningRun =
    (await prisma.slaveRun.count({
      where: {
        kind: 'planning',
        status: { in: [...NON_TERMINAL_RUN_STATUSES] },
        slave: { team: { workspaceId } },
      },
    })) > 0

  const intent =
    goalMoved && !alreadyReplanned && failedAttempts < retryCap
      ? { previousVersion: goalVersion - 1, version: goalVersion }
      : null

  const archived = workspace.archivedAt !== null
  // An empty board is the first plan, not a re-plan: `dispatchPlanning` never reaches this at all
  // there, and saying "a re-plan will run" about a workspace that has never been planned would be
  // a different promise than the one the tick keeps.
  const due = goalMoved && boardTaskCount > 0
  // In the order `tick` itself would reach them: archived before the world is loaded, the halt
  // before dispatch, then `dispatchPlanning`'s own three.
  const blockedBy = !due
    ? null
    : archived
      ? ('archived' as const)
      : workspace.haltedReason !== null
        ? ('halted' as const)
        : alreadyReplanned
          ? ('dedup' as const)
          : failedAttempts >= retryCap
            ? ('retry_cap' as const)
            : livePlanningRun
              ? ('live_planning_run' as const)
              : null

  return {
    goalVersion,
    boardVersion,
    boardTaskCount,
    goalMoved,
    alreadyReplanned,
    livePlanningRun,
    failedAttempts,
    retryCap,
    halted: workspace.haltedReason,
    archived,
    willReplan: due && blockedBy === null,
    blockedBy,
    intent,
  }
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
 * **Nothing here may throw past this function, with one honest exception** (fix round 1, widened
 * by the final review to the three reads that used to sit outside the containment): {@link failRun}
 * itself writes to the database, so a database that is not there when a pre-commit failure is being
 * RECORDED still throws past this function. That is the one failure this containment cannot absorb,
 * because absorbing it would mean losing the record of the failure as well as the failure. A
 * re-plan is deduped on
 * `workspace.replan_started`, which is written at DISPATCH: a throw that escaped would reach only
 * the pump's `console.error`, leave the run `succeeded`, and leave the version permanently counted
 * as re-planned -- additions on the board, no proposals, no `workspace.replanned`, and nothing for
 * the retry cap to count. So the work is split at the commit:
 *
 * - **Before the additions commit**, anything that goes wrong -- an unparseable delta, a task the
 *   transaction refused, a database that was not there -- is the parse-failure path: the run is
 *   flipped to `failed`, `run.failed` says why, and the CAP governs what happens next.
 * - **After it**, the additions are real and cannot be unmade, so every remaining step is
 *   contained: a proposal that refuses or throws is counted in `failedProposals`, and
 *   `workspace.replanned` is written whatever happened, because the board changed and the log has
 *   to say so.
 *
 * The RUN ROW is read first and alone, because it is the one read with nowhere to route: every
 * failure above reports itself by flipping that row and appending `run.failed` against its slave
 * and its workspace, none of which is known until it has been read. A failure there is logged with
 * `console.error` and returns -- the same information the pump's own handler would have printed for
 * a throw, minus the throw.
 */
export async function concludeReplan(runId: RunId): Promise<void> {
  let run: ConcludingRun
  try {
    run = await prisma.slaveRun.findUniqueOrThrow({
      where: { id: runId },
      include: { slave: { include: { team: true } } },
    })
  } catch (error) {
    console.error(
      `[replan] run ${runId} could not be read at conclusion ` +
        `(${error instanceof Error ? error.message : String(error)}): its delta was not applied, and there is no run ` +
        'row to record the failure against',
    )
    return
  }
  // A planning run has no task (M8b): the workspace is only reachable through `slave -> team`.
  const workspaceId = run.slave.team.workspaceId

  // The manifest read and the double-conclusion read, inside the containment (final review,
  // Important 1). Both are ordinary database reads and both can fail the way any read can; a throw
  // escaping either would leave the run `succeeded`, the version permanently deduped, and nothing on
  // the board -- exactly the outcome the split below exists to prevent -- so they are failures of
  // this planning ATTEMPT, and the cap governs the retry.
  let replan: ReplanSection
  try {
    const section = await replanSectionOf(runId)
    if (section === null) {
      // Unreachable through `concludePlanning`, which routes here only when it found this section.
      // Thrown rather than returned: concluding a first plan as a delta would silently create
      // nothing and cancel nothing, and the catch below turns it into a failed run rather than an
      // exception nobody handles.
      throw new Error(`run ${runId} has no replan section in its recorded context: it is not a re-plan run`)
    }

    // Concluded once already. `concludePlanning`'s own "the board already has tasks" warn-and-drop
    // for a first plan, in the shape a re-plan can be asked about: this run's `workspace.replanned`
    // IS the record that its delta was applied, so a second conclusion (a redelivered pump result,
    // an operator re-running it) would create the additions twice.
    const concluded = await prisma.executionEvent.findFirst({
      where: { runId, type: 'workspace_replanned' },
      select: { seq: true },
    })
    if (concluded !== null) {
      console.warn(
        `[replan] ignoring a second conclusion of run ${runId}: its delta is already on the board ` +
          `(workspace.replanned at seq ${String(concluded.seq)})`,
      )
      return
    }
    replan = section
  } catch (error) {
    await failRun(
      run,
      workspaceId,
      `a re-plan could not be concluded: ${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }

  const applied = await applyDelta(runId, workspaceId, replan.version)
  if (!applied.ok) {
    // The parse-failure path, and now every other pre-commit failure with it: a failed planning
    // attempt, not an infrastructure problem, so it feeds `replanIntent`'s retry cap.
    await failRun(run, workspaceId, applied.reason)
    return
  }

  const version = replan.version

  // After the commit, exactly as `concludePlanning`'s events follow its own transaction: an event
  // describing a task a rolled-back transaction never created would be a lie in an append-only log.
  for (const task of applied.created) {
    await appendEvent({
      type: 'task.created',
      workspaceId,
      taskId: task.id,
      actor: 'slave',
      payload: { title: task.title, goalVersion: version },
    })
  }

  const policy = applyCancelPolicy(applied.delta, applied.board)
  const proposals = await proposeCancellations({
    workspaceId,
    version,
    cancellable: policy.cancellable,
    board: applied.board,
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
      added: applied.created.map((task) => task.id),
      proposedCancellations: proposals.proposed,
      // The status rule's refusals, carried with the status that refused them, so a cancellation
      // the model asked for and did not get is on the record rather than silently forgotten.
      droppedCancellations: policy.dropped.map((entry) => ({ taskId: entry.taskId, status: entry.status })),
      // ...and the ones that were allowed but did not happen anyway (fix round 1). The three lists
      // together account for every id the model asked to cancel.
      failedProposals: proposals.failed,
    },
  })
}

/** The run row {@link concludeReplan} concludes, narrowed to what a conclusion actually uses: the
 *  run to flip, the slave to attribute a failure to, and the workspace both belong to. */
interface ConcludingRun {
  readonly id: string
  readonly slaveId: string
  readonly slave: { readonly team: { readonly workspaceId: string } }
}

/**
 * The one answer to every pre-commit failure of a re-plan: this planning ATTEMPT failed, so the
 * retry cap governs what happens next (M40 §1).
 *
 * `updateMany` rather than `update`, and scoped to `succeeded`, for the reason the parse-failure
 * path always had: the run has already been concluded as a success by the pump, and only that state
 * may be walked back from here.
 *
 * This is the one thing {@link concludeReplan} calls that can still throw past it: both writes here
 * are the database, and a database outage during a pre-commit failure takes the recording of that
 * failure down with it. There is no third place to route it to -- the alternative is a swallowed
 * throw and a run left `succeeded` with no delta and nothing saying why -- so it propagates to the
 * pump's `console.error`, which is where an operator will at least find it.
 */
async function failRun(run: ConcludingRun, workspaceId: string, reason: string): Promise<void> {
  await prisma.slaveRun.updateMany({ where: { id: run.id, status: 'succeeded' }, data: { status: 'failed' } })
  await appendEvent({
    type: 'run.failed',
    workspaceId,
    slaveId: run.slaveId,
    runId: run.id,
    actor: 'system',
    payload: { reason },
  })
}

/** One task on the board a delta is resolved against. */
interface BoardRow {
  readonly id: string
  readonly title: string
  readonly status: TaskStatus
  readonly goalVersion: number | null
}

type AppliedDelta =
  | {
      readonly ok: true
      readonly created: readonly { readonly id: string; readonly title: string }[]
      readonly board: readonly BoardRow[]
      readonly delta: PlanDelta
    }
  | { readonly ok: false; readonly reason: string }

/**
 * Everything a re-plan does that can still be UNDONE by doing nothing: read the output, parse the
 * delta, and create the additions in one transaction.
 *
 * Every failure comes back as a `reason` rather than as a throw, because the caller has exactly one
 * honest response to all of them -- fail the run and let the retry cap decide -- and because a
 * throw from here would strand the version (see {@link concludeReplan}). Nothing outside the
 * transaction has been written when this returns `ok: false`.
 */
async function applyDelta(runId: RunId, workspaceId: string, version: number): Promise<AppliedDelta> {
  try {
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
    // `applyCancelPolicy` then judges each requested cancellation by the status it finds HERE,
    // which is the only status that can be acted on.
    const board = await prisma.task.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, title: true, status: true, goalVersion: true },
    })
    const parsed = parsePlanDelta(
      text,
      board.map((task) => task.id),
    )
    if (!parsed.ok) return { ok: false, reason: `planning run produced no valid re-plan delta: ${parsed.error}` }

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })

    // `status: 'ready'`, `createdBy: 'slave'` and `createdByUserId` are `concludePlanning`'s own
    // choices, mirrored deliberately (the spec's §1 says "backlog", the first plan has always
    // written `ready`, and two paths that create planned tasks differently would be worse than one
    // that disagrees with a sentence). `goalVersion` is the version THIS re-plan derived from --
    // the run's own manifest, not `workspace.goalVersion`, which may have moved again while this
    // run was in flight.
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
          // Plan keys first, then existing ids (spec erratum E1): a new task may depend on work
          // that is already on the board, and `validateDelta` has already established that every
          // entry is one or the other. What it does NOT establish is that the list has no
          // duplicates -- `TaskDependency`'s primary key does, by rejecting the second one, and
          // that rejection arrives here as a rolled-back transaction and a failed run.
          await tx.taskDependency.create({ data: { taskId, dependsOnTaskId: idByKey.get(dep) ?? dep } })
        }
      }
      return added
    })

    return { ok: true, created, board, delta: parsed.value }
  } catch (error) {
    return {
      ok: false,
      reason: `planning run produced a re-plan that could not be applied: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
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
 * **This function never throws** (fix round 1). It is called after the additions have committed,
 * where there is nothing left to undo and nothing a caller could do with an exception except
 * strand the version, so every way a proposal can fail to happen comes back as a COUNT instead:
 *
 * - a refusal (`supervisor_cooldown` -- a human is already looking at this exact task -- or
 *   `supervisor_disabled`, this project having switched the Supervisor off);
 * - a `recordDecision` that THREW (a schema violation, an index violation, a database that went
 *   away mid-write), which is per-id and must not take the other ids with it;
 * - a world that could not be loaded at all, which fails every id at once;
 * - a task the domain offers no `cancel_task` for, because the world moved between the board read
 *   and this one.
 *
 * The `failed` list is written into `workspace.replanned`, so "the model asked to cancel this and
 * nothing came of it" is on the record instead of being a warning in a log nobody kept.
 */
async function proposeCancellations(input: {
  readonly workspaceId: string
  readonly version: number
  readonly cancellable: readonly string[]
  readonly board: readonly { readonly id: string; readonly title: string; readonly goalVersion: number | null }[]
}): Promise<{ readonly proposed: string[]; readonly failed: string[] }> {
  if (input.cancellable.length === 0) return { proposed: [], failed: [] }

  const now = new Date()
  let world: Awaited<ReturnType<typeof loadSupervisorWorld>>['world']
  try {
    world = (await loadSupervisorWorld(input.workspaceId, now)).world
  } catch (error) {
    // No world, no catalogue, so not one of these can be recorded. Counted rather than thrown for
    // the reason at the top: the additions are already on the board.
    console.warn(
      `[replan] the Supervisor world for workspace ${input.workspaceId} could not be loaded ` +
        `(${error instanceof Error ? error.message : String(error)}): ` +
        `${String(input.cancellable.length)} cancellation(s) could not be proposed`,
    )
    return { proposed: [], failed: [...input.cancellable] }
  }

  const proposed: string[] = []
  const failed: string[] = []

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
      failed.push(taskId)
      continue
    }

    try {
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
        failed.push(taskId)
        continue
      }
      proposed.push(taskId)
    } catch (error) {
      // `recordDecision` throws rather than refuses for a programming error or an infrastructure
      // failure. Per id, so one bad proposal cannot take the rest of the re-plan with it.
      console.warn(
        `[replan] the cancellation proposal for task ${taskId} threw: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
      failed.push(taskId)
    }
  }

  return { proposed, failed }
}
