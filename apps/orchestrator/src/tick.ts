import { admitProvider, claimResume, pauseActiveRuns, refusalText, runFilePaths } from '@ai-team-os/control'
import { prisma } from '@ai-team-os/db/client'
import {
  decide,
  evaluateGuardrails,
  runId as brandRunId,
  taskId as brandTaskId,
  agentId as brandAgentId,
  type AgentId,
  type RunId,
  type TaskId,
  type WorkspaceId,
} from '@ai-team-os/domain'
import { appendEvent } from '@ai-team-os/events'
import type { AdapterRegistry, AgentRuntimeAdapter, RunHandle } from '@ai-team-os/providers'
import { runMergePass } from './merge.js'
import { resolveRuntime, workspaceDefaultProvider } from './model.js'
import { dispatchPlanning } from './planning.js'
import { resolveAdapter } from './provider.js'
import { pumpRun } from './pump.js'
import { executeResume } from './resume.js'
import { dispatchReviews } from './review.js'
import { noteTickRan } from './sweep.js'
import { verifyConcludedRun } from './verify.js'
import { loadWorld } from './world.js'
import { WorktreeExistsError, adoptWorktree, provisionWorktree, type WorktreeHandle } from './worktree.js'

export interface TickDeps {
  readonly workspaceId: WorkspaceId
  /**
   * M12 Task 2: the hook path (the orchestrator's own `scripts/pause-gate.sh`, not the workspace
   * repo's) no longer travels here -- it is a `ClaudeCodeAdapterOptions` constructor option now
   * (`cli.ts`'s `buildAdapterRegistry()`), a fact about the adapter instance, not a per-tick
   * dependency. Decision of Record #1 (M12): no caller outside `packages/providers` may know a
   * provider keeps a hook script at all.
   *
   * M12 Task 5: a registry, not a single `AgentRuntimeAdapter`, now that a run's provider is a
   * real choice rather than a hardcoded fact -- M12 Task 8 makes each lookup against it resolve
   * to whatever `resolveRuntime` (`model.ts`) actually decided for that run.
   */
  readonly registry: AdapterRegistry
}

export interface TickReport {
  readonly started: readonly RunId[]
  readonly halted: string | null
  readonly skippedNoRole: number
  /** The planning run this tick started, or `null` when none did (M8b). */
  readonly planningStarted: RunId | null
  readonly reviewsStarted: readonly RunId[]
}

/**
 * Whether the previous tick already observed this workspace halted.
 *
 * `decide()` returns the `halt` command on *every* tick the condition holds (spec §3.2), but the
 * news is the transition: at the default 1000ms period a halt waiting for an operator would
 * otherwise write one `guardrail.tripped` per second, forever, into an append-only log. In memory
 * is enough — the state that has to survive a restart is `Workspace.haltedReason` itself, and a
 * daemon that restarts and re-announces one halt is not the failure this guards against.
 *
 * Keyed by workspace so one workspace's halt says nothing about another's.
 */
const haltAnnounced = new Map<string, boolean>()

/**
 * Pumps in flight. They outlive the tick that started them by design (spec §5.6), so something has
 * to hold them: an unawaited promise that rejects takes the process down, and a daemon shutting
 * down needs to know when the last one has finished writing.
 *
 * Exported so `dispatchReviews` (`review.ts`) can register its own runs' pumps here rather than in
 * a set of its own -- `drainPumps` below only ever waits on this one, and a review pump living
 * anywhere else would be invisible to it, exactly the failure mode the doc comment above describes.
 */
export const pumps = new Set<Promise<unknown>>()

/**
 * The run ids whose pumps are live IN THIS PROCESS. The daemon's guardrail sweep consults this
 * before treating a dead pid as an orphan: a process being gone is the ordinary end of every run,
 * and the pump trailing it by a stream-drain is not abandonment -- concluding such a run "dead"
 * races the pump's own terminal write (the failure the M9 sweep wiring surfaced in the measured
 * gates). A run leaves this set when its pump settles: normally after the terminal row is written
 * (the run is no longer sweepable), and on a pump crash without one -- exactly the case the
 * sweep's dead-pid arm exists to recover.
 */
export const activePumpRunIds = new Set<string>()

/** Waits for every in-flight pump. For a graceful shutdown, and for tests that truncate tables. */
export async function drainPumps(): Promise<void> {
  await Promise.allSettled([...pumps])
}

/**
 * The task's stable identity in a path and a branch name.
 *
 * Derived from the id, never from the title: the key has to be reproducible on the task's *second*
 * run so a rework can find its own previous worktree, and a title can be edited between attempts.
 * Hex, so it satisfies `provisionWorktree`'s segment rule by construction. A collision is ~4e9
 * apart and is not silent — it surfaces as a `WorktreeExistsError` whose branch does not match,
 * which is escalated rather than adopted.
 */
const taskKeyFor = (id: string): string => `T-${id.slice(0, 8)}`

/** Title to branch-safe slug. Bounded, because the whole thing becomes a git ref. */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug === '' ? 'task' : slug
}

/**
 * An agent's git email local part. Falls back to the id rather than to `slugify`'s generic default,
 * which would put the same address on commits by two different agents whose names carry no ASCII.
 *
 * Exported for Task 5's review dispatch, which gives a reviewer agent the same git identity
 * convention a run's implementation agent gets -- duplicating this would be a second place the
 * convention could drift from this one.
 */
export function emailLocalPart(agent: { readonly id: string; readonly name: string }): string {
  const slug = slugify(agent.name)
  return slug === 'task' ? `agent-${agent.id.slice(0, 8)}` : slug
}

/**
 * The prompt a run starts from. On a rework this carries the previous attempt's rejection, which
 * is the whole point of spec §8's loop: the next run is supposed to act on why the last one failed,
 * and a rework that arrives without it is just a retry.
 */
function buildPrompt(task: {
  readonly title: string
  readonly description: string
  readonly lastRejectionReason: string | null
}): string {
  const base = `${task.title}\n\n${task.description}`
  return task.lastRejectionReason === null
    ? base
    : `${base}\n\nA previous attempt was rejected. Address this before anything else:\n${task.lastRejectionReason}`
}

/**
 * Provisions the task's worktree, adopting the one its own previous attempt left when that is what
 * the leftovers are.
 *
 * Adopt requires all three: the refusal is a `WorktreeExistsError`, both halves are present, and
 * the task is in `rework`. That combination is the only one that means "this task's last run left
 * this here". A stray directory, an orphaned branch, or a `ready` task that should never have had a
 * worktree at all is wreckage §7.4 preserved deliberately for an operator, and handing it to an
 * agent gives the run someone else's tree.
 */
async function acquireWorktree(input: {
  readonly repoPath: string
  readonly baseBranch: string
  readonly taskKey: string
  readonly slug: string
  readonly branch: string
  readonly setupCommands: readonly string[]
  readonly isRework: boolean
}): Promise<WorktreeHandle> {
  try {
    return await provisionWorktree({
      repoPath: input.repoPath,
      baseBranch: input.baseBranch,
      taskKey: input.taskKey,
      slug: input.slug,
      setupCommands: input.setupCommands,
    })
  } catch (error) {
    const adoptable = error instanceof WorktreeExistsError && error.reason === 'both' && input.isRework
    if (!adoptable) throw error
    return adoptWorktree({
      repoPath: input.repoPath,
      taskKey: input.taskKey,
      branch: input.branch,
      setupCommands: input.setupCommands,
    })
  }
}

/**
 * One scheduling pass: load the world, ask the pure core what to do, and do it.
 *
 * The tick executes `decide()`'s command list rather than iterating tasks itself. That is what
 * makes the concurrency limit, the budget and the failure breaker hold — they are enforced in one
 * place, in a pure function with its own tests, and the tick cannot start a run the scheduler did
 * not ask for even by accident.
 */
export async function tick(deps: TickDeps): Promise<TickReport> {
  // Tells `reconcileOrphans` that its startup-only window has closed. A run that is mid-spawn --
  // row created, pid not yet recorded -- is indistinguishable from one the orphan pass should fail,
  // so a reconcile racing a tick fails a live run and hands its task to a second agent.
  noteTickRan()

  const { world, skippedNoRole } = await loadWorld(deps.workspaceId)
  const commands = decide(world)

  const halt = commands.find((command) => command.kind === 'halt')
  if (halt !== undefined) {
    if (haltAnnounced.get(deps.workspaceId) !== true) {
      haltAnnounced.set(deps.workspaceId, true)
      await appendEvent({
        type: 'guardrail.tripped',
        workspaceId: deps.workspaceId,
        actor: 'system',
        payload: { guardrail: halt.reason, detail: 'scheduling halted for this workspace' },
      })
      // The fan-out lives inside the same one-shot as the announcement above: `decide()` returns
      // `halt` on every tick the condition holds, and a run this pauses moves to
      // `pause_requested` -- a status the *next* tick's `pauseActiveRuns` would no longer find,
      // so re-running it costs nothing but re-running it every second is still noise nobody asked
      // for.
      if (halt.reason === 'budget_exhausted') {
        await pauseActiveRuns(deps.workspaceId, 'budget guardrail', 'guardrail')
      }
    }
    return { started: [], halted: halt.reason, skippedNoRole, planningStarted: null, reviewsStarted: [] }
  }
  haltAnnounced.set(deps.workspaceId, false)

  // The budget warning (spec §5): unlike the halt above, this never stops scheduling, so it is
  // checked and (at most once) announced on every tick that is not already halted. Mutually
  // exclusive with `budget_exhausted` by the domain's `else if` -- the halt branch's early return
  // is what keeps this from running the tick a real halt is announced, not a check here.
  //
  // The one-shot is a durable existence query against the event log, not an in-memory latch like
  // `haltAnnounced`: spec §5 wants the warning to survive a daemon restart, and an in-memory map
  // starts empty on every restart. `evaluateGuardrails` is pure and cheap, so calling it again
  // here -- after `decide()` already called it once inside this same tick -- is not worth avoiding.
  const warning = evaluateGuardrails(world.limits, world.stats).find(
    (breach) => breach.guardrail === 'budget_warning',
  )
  if (warning !== undefined) {
    const announced = await prisma.executionEvent.findFirst({
      where: {
        workspaceId: deps.workspaceId,
        type: 'guardrail_tripped',
        payload: { path: ['guardrail'], equals: 'budget_warning' },
      },
      select: { seq: true },
    })
    if (announced === null) {
      await appendEvent({
        type: 'guardrail.tripped',
        workspaceId: deps.workspaceId,
        actor: 'system',
        payload: { guardrail: 'budget_warning', detail: warning.detail },
      })
    }
  }

  const started: RunId[] = []
  for (const command of commands) {
    if (command.kind !== 'start_run') continue
    const runId = await startRun(deps, command.taskId, command.agentId)
    if (runId !== null) started.push(runId)
  }

  await resumeRequestedRuns(deps)

  // Before the review pass, not after: a planning run works toward an empty board, which
  // `dispatchReviews` (task-scoped) has nothing to do with either way -- the order only matters
  // for `TickReport`'s own field order (spec: planning, then reviews) and for reading one tick's
  // JSON line top to bottom the way the pipeline actually runs.
  const planningStarted = await dispatchPlanning(deps)

  const reviewsStarted = await dispatchReviews(deps)

  // After the review pass, not before: a task cannot reach `merging` until a review approves it,
  // so nothing this call would find can exist before `dispatchReviews` has had its chance to
  // produce one this same tick. Serialized to at most one merge per tick (spec §4) inside
  // `runMergePass` itself.
  await runMergePass(deps.workspaceId)

  return { started, halted: null, skippedNoRole, planningStarted, reviewsStarted }
}

/**
 * Executes the resume intents recorded against this workspace's paused runs (spec M5 §3.3).
 *
 * The web records an intent and leaves the run `paused`; this process -- the one that can own a
 * child -- claims and spawns. That split is not ceremony: §3.4's orphan pass fails every
 * non-terminal, non-`paused` run whose pid is dead, so a row sitting in `resuming` with no process
 * is exactly the shape it destroys. Claiming and spawning inside one process narrows that window to
 * the width the CLI's `resume` has always had.
 *
 * Deliberately placed *after* the halt bail above rather than beside it: a halt is raised by a gate
 * failure or an unverifiable workspace, and picking up a queued resume while one stands relaunches
 * an agent whose gate may still be broken. The intent is left untouched -- visible, unconsumed, and
 * waiting for the operator who clears the halt -- rather than refused, because the request was
 * legitimate when it was made.
 *
 * A resume that throws leaves the run `resuming` with a dead pid -- and nothing in a long-lived
 * daemon ever revisits that on its own. `sweep()` is the only thing that would notice, and it has no
 * production caller (`daemon.ts` wires up `reconcileOrphans`, not `sweep`); `reconcileOrphans` itself
 * runs once before the first tick and refuses ever after (`noteTickRan`/`ticksHaveRun` above). So the
 * catch below concludes the run itself -- mirroring `sweep.ts`'s `concludeDeadRun` -- rather than
 * leaving a `resuming` row with a dead pid, a held task and a busy-looking agent until a restart.
 */
async function resumeRequestedRuns(deps: TickDeps): Promise<void> {
  // `agent: { team: { workspaceId } }`, not `task: { workspaceId }`: a `planning` run (M8b) has no
  // `Task` row, and a paused planning run must resume like any other.
  const intents = await prisma.agentRun.findMany({
    where: {
      status: 'paused',
      resumeRequestedAt: { not: null },
      agent: { team: { workspaceId: deps.workspaceId } },
    },
    select: { id: true, taskId: true, agentId: true },
  })

  for (const intent of intents) {
    // Claimed one at a time, and the claim is what decides ownership: a CLI `resume` racing this
    // tick, or a second daemon, loses here rather than putting a second agent on the branch.
    const { claimed, queuedMessage } = await claimResume(intent.id)
    if (!claimed) continue

    // Registered into `pumps` exactly as the start pass registers its own: `executeResume` owns the
    // resumed run's stream to the end (verify included), so it outlives this tick by design, an
    // unhandled rejection would take the daemon down, and a shutdown -- or a one-shot `tick` -- has
    // to be able to wait for it.
    activePumpRunIds.add(intent.id)
    const resumed = executeResume({ runId: intent.id, registry: deps.registry, message: queuedMessage })
      .catch(async (error: unknown): Promise<void> => {
        console.error(`[tick] resume for run ${intent.id} failed:`, error)
        await concludeFailedResume(deps, intent, error)
      })
      .finally((): void => {
        activePumpRunIds.delete(intent.id)
        pumps.delete(resumed)
      })
    pumps.add(resumed)
  }
}

/**
 * What {@link releaseTaskAfterFailure} did, so the caller can announce it.
 */
interface TaskRelease {
  /** The task's attempt count AFTER the increment. */
  readonly attempt: number
  /** `true` when that count reached `maxAttempts` and the task was parked `failed`. */
  readonly exhausted: boolean
}

/**
 * Counts one failed attempt against a task and puts it somewhere it can be retried -- or stops it.
 *
 * Shared by `failToStart` and `concludeFailedResume` (M13 Decision 4). Both are "an attempted run
 * that failed", and until M13 only the first of them counted: a resume that could not spawn
 * released the task straight back to `rework`, so a run that failed to resume forever was handed
 * out forever, each attempt costing real money and none of them costing an attempt.
 *
 * Conditional on still owning the task, and incremented rather than assigned: a tick that lost the
 * claim race must not roll back the winner's task row or burn an attempt against a run that is very
 * much alive.
 *
 * `lastRejectionReason` is deliberately NOT written here. It is the agent-facing channel --
 * `buildPrompt` puts it in front of the next run as the thing to fix first -- so an
 * orchestrator-side failure landing in it both destroys the verify feedback §8 requires and
 * instructs the next agent to go and fix a setup command it cannot see. The reason lives on the
 * `AgentRun` row and in `run.failed`, which is where an operator looks for it.
 */
async function releaseTaskAfterFailure(
  task: { readonly id: string; readonly maxAttempts: number },
  runId: string,
  parked: 'rework' | 'blocked',
): Promise<TaskRelease> {
  await prisma.task.updateMany({
    where: { id: task.id, activeRunId: runId },
    data: { attempt: { increment: 1 } },
  })
  const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
  const exhausted = after.attempt >= task.maxAttempts
  await prisma.task.updateMany({
    where: { id: task.id, activeRunId: runId },
    data: { status: exhausted ? 'failed' : parked, activeRunId: null },
  })
  return { attempt: after.attempt, exhausted }
}

/**
 * Concludes a resume that failed to spawn, from inside the tick that claimed it.
 *
 * Mirrors `sweep.ts`'s `concludeDeadRun`: a status-conditioned `updateMany` so a run something else
 * already concluded is never clobbered, the same task release, the same `run.failed` event. This is
 * the only place a failed resume spawn is ever concluded -- see the doc comment above
 * `resumeRequestedRuns` for why nothing else in a running daemon would ever get to it.
 */
async function concludeFailedResume(
  deps: TickDeps,
  run: { readonly id: string; readonly taskId: string | null; readonly agentId: string },
  error: unknown,
): Promise<void> {
  const now = new Date()
  // Conditioned on `resuming`: if `executeResume` threw after already moving the run past that
  // status (e.g. inside `verifyConcludedRun`, once the pump had already written a terminal row),
  // that row's status is the true outcome and must not be overwritten with `failed`.
  const concluded = await prisma.agentRun.updateMany({
    where: { id: run.id, status: 'resuming' },
    data: { status: 'failed', terminalAt: now, endedAt: now },
  })
  if (concluded.count === 0) return

  // Release the task the run was holding, exactly as `concludeDeadRun` does -- a failed resume
  // that leaves `activeRunId` pointing at a dead run strands the task `running` forever. A
  // `planning` run (M8b) has no task to release.
  //
  // As of M13 the release COUNTS (Decision 4): a resume that cannot spawn is an attempted run that
  // failed, and a task whose resume can never spawn was otherwise re-dispatched every tick forever.
  let release: TaskRelease | null = null
  if (run.taskId !== null) {
    const task = await prisma.task.findUniqueOrThrow({ where: { id: run.taskId } })
    release = await releaseTaskAfterFailure(task, run.id, 'rework')
  }

  await appendEvent({
    type: 'run.failed',
    workspaceId: deps.workspaceId,
    taskId: run.taskId,
    agentId: run.agentId,
    runId: run.id,
    actor: 'system',
    payload: { reason: `resume failed to spawn: ${error instanceof Error ? error.message : String(error)}` },
  })

  // The task's own terminal, not just the run's. Without it an exhausted task drops off the board
  // with `run.failed` as the only trace, and nothing in the log says why nothing is running.
  if (run.taskId !== null && release !== null && release.exhausted) {
    await appendEvent({
      type: 'task.failed',
      workspaceId: deps.workspaceId,
      taskId: run.taskId,
      actor: 'system',
      payload: {
        reason: `could not resume after ${String(release.attempt)} attempts: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    })
  }
}

/**
 * Starts one run, or records why it could not start.
 *
 * The `AgentRun` row is created **before** provisioning, because spec §13 says a provisioning
 * failure is an attempted run that failed — not a task nobody scheduled. Recording it any other way
 * makes a task that never starts indistinguishable from one the scheduler never picked, which is
 * the difference an operator is actually looking for.
 */
async function startRun(deps: TickDeps, taskId: TaskId, agentId: AgentId): Promise<RunId | null> {
  const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
  // `companyAgent -> template` included so `resolveRuntime` (M12 Task 8) can walk the whole override
  // chain -- a legacy agent with no roster link carries `companyAgent: null` and resolves through
  // its own column alone.
  const agent = await prisma.agent.findUniqueOrThrow({
    where: { id: agentId },
    include: { companyAgent: { include: { template: true } } },
  })
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: task.workspaceId } })

  const taskKey = taskKeyFor(task.id)
  const prefix = `aiteamos/${taskKey}-`
  // The slug is read back from the branch the first attempt recorded, not re-derived from the
  // title. Re-deriving it means renaming a task between attempts computes a different branch, so
  // the worktree it already owns reports `directory` rather than `both` and an ordinary rework
  // escalates as wreckage.
  const slug =
    task.branch !== null && task.branch.startsWith(prefix) ? task.branch.slice(prefix.length) : slugify(task.title)
  const branch = `${prefix}${slug}`

  const run = await prisma.agentRun.create({
    data: { taskId: task.id, agentId: agent.id, status: 'starting' },
  })
  const runId = brandRunId(run.id)

  // The task leaves the startable set now, not after the run finishes: `decide()` treats `ready`
  // and `rework` as startable, so a task left in either would be handed to a second idle agent on
  // the very next tick, a second later.
  //
  // And it is *claimed*, not merely written: the status filter makes this the atomic step that
  // decides which of two overlapping ticks owns the task. Provisioning is awaited inline and a
  // setup command may run for minutes while the timer fires every second (spec §3.1), so two ticks
  // loading the same world is the ordinary case rather than an exotic one -- and both are handed
  // the same `start_run`, because neither's `AgentRun` row exists when the other loads. A blind
  // write let both proceed, which put two live agents in one worktree on one branch. Done in the
  // database rather than with an in-process lock because the CLI's `tick` (Task 16) can run against
  // a live daemon, and a mutex in one process says nothing about the other.
  const claimed = await prisma.task.updateMany({
    where: { id: task.id, status: { in: ['ready', 'rework'] } },
    data: { status: 'running', activeRunId: run.id, branch },
  })
  if (claimed.count === 0) {
    // Lost the race. This is not a failed run -- nothing was attempted -- so it must not leave a
    // `failed` row that reads as an attempt against the task, and must not touch the winner's task.
    await prisma.agentRun.delete({ where: { id: run.id } })
    return null
  }

  await appendEvent({
    type: 'task.started',
    workspaceId: workspace.id,
    taskId: task.id,
    agentId: agent.id,
    runId: run.id,
    actor: 'system',
    payload: { title: task.title },
  })

  // Declared outside the `try` so the catch can tell "never spawned" from "spawned, then something
  // else failed". Without that distinction a failure after the spawn abandons a live agent: the run
  // row goes terminal with no pid, and §3.4's startup sweep only looks at *non-terminal* runs with
  // dead pids, so nothing in the system can ever find that process again.
  let handle: RunHandle | null = null

  // Both declared outside the `try`, `adapter` nullable now that resolving it can itself fail
  // (M12 Task 8: an unconfigured provider, below) -- the catch needs to tell "no adapter to
  // cancel with" from "spawned, then something else failed" just as it already tells that apart
  // for `handle`.
  let adapter: AgentRuntimeAdapter | null = null

  try {
    // M12 Task 8: resolved first, inside the `try`, so a misconfigured provider -- an unresolvable
    // chain (a legacy half-pair, or no workspace default) or a `ProviderKind` this process has no
    // adapter for -- is recorded as an attempted run that failed to start (`failToStart`, spec
    // §13), exactly like a worktree that could not be provisioned. It must not be treated as
    // "nothing to attempt" (the way an all-busy roster is): unlike busyness, a misconfiguration
    // does not resolve itself on the next tick, so the operator needs to see it as a failure,
    // counted against the task's attempt cap, not silently retried forever.
    const workspaceDefault = await workspaceDefaultProvider(workspace.id)
    const resolved = resolveRuntime(agent, workspaceDefault)
    if (resolved.provider === null) {
      throw new Error(
        'no runtime could be resolved for this run: either this workspace has no configured ' +
          'default provider (ProviderConfiguration), or a level of the model override chain names ' +
          'a model with no provider recorded for it',
      )
    }
    // May itself throw (an `invalid_provider` refusal) for a `ProviderKind` this process has no
    // adapter registered for -- M12 Task 8 closes the gap Task 7's ledger named: `isProviderKind`
    // can only check union membership, not configuredness, so this is the first place that can.
    adapter = resolveAdapter(deps.registry, resolved.provider)
    // Spec §6's dispatch-time re-check (M12 Task 9, ruling R9), after the adapter resolves and
    // before anything is spawned. It is a RE-check, not the only one: `packages/control`'s
    // `assignCompany`/`setAgentModel` already refuse this pairing at write time. It exists anyway
    // because resolution crosses four levels, and a template edit -- or a new
    // `ProviderConfiguration` row -- can change the pair under a workspace that was perfectly
    // valid when it was configured, with no write to this workspace at all for the write-time
    // check to have fired on.
    //
    // Thrown, not returned, so it takes the SAME path the `invalid_provider` refusal above already
    // takes: the existing `catch` records an attempted run that failed (`failToStart`, spec §13).
    // `refusalText` is imported from `@ai-team-os/control` rather than hand-copied, so the wording
    // an operator sees here and the wording the write surface promises cannot drift apart.
    //
    // AFTER `resolveAdapter`, deliberately: a kind this process has no adapter for is refused as
    // `invalid_provider` first, which is the more specific truth about it today.
    const admission = admitProvider(workspace, resolved.provider)
    if (!admission.ok) throw new Error(refusalText(admission.refusal))
    // A local, non-null binding: `adapter` itself stays nullable so the `catch` below can tell
    // whether resolving it succeeded, but everything past this point already knows it did.
    const runAdapter = adapter
    const model = resolved.model

    const worktree = await acquireWorktree({
      repoPath: workspace.repoPath,
      baseBranch: workspace.baseBranch,
      taskKey,
      slug,
      branch,
      setupCommands: workspace.setupCommands,
      isRework: task.status === 'rework',
    })

    // No `settingsPath` here any more (M12 Task 2): `runFilePaths` hands back the run's own scratch
    // directory, and what the adapter keeps inside it -- a settings file, a hook script, anything
    // else -- is that adapter's business, reported back opaquely on `handle.runFiles` below.
    const { runDir, pauseFlagPath } = runFilePaths(workspace.repoPath, runId)

    handle = await runAdapter.start({
      runId,
      prompt: buildPrompt(task),
      worktreePath: worktree.path,
      pauseFlagPath,
      runDir,
      gitIdentity: { name: agent.name, email: `${emailLocalPart(agent)}@aiteamos.local` },
      // Conditional spread, not `model`, because `exactOptionalPropertyTypes` treats an explicit
      // `model: undefined` as a different (and disallowed) thing from the key being absent.
      ...(model !== undefined ? { model } : {}),
    })

    await prisma.agentRun.update({
      where: { id: run.id },
      // `provider` (M12 Task 8): the schema comment on `AgentRun.provider` names Tasks 7/8 as the
      // ones that resolve and write it -- Task 7 covered the org-level pair; this is the run-level
      // write. Written here, alongside `pid`, rather than at `agentRun.create` above, because
      // `resolved` is not known until the chain (and the registry) have both been consulted.
      data: { pid: handle.pid, worktreePath: worktree.path, provider: resolved.provider },
    })

    // Only ever a *first* pump for this run: the tick never resumes anything, so the second
    // `run.started` a resumed run would produce (T12's carry, spec §5.7 wants `run.resumed`) is
    // not reachable from here. It becomes Task 16's when `resume` gains a caller.
    //
    // Started, not awaited: the pump outlives this tick by design (spec §5.6), and awaiting it
    // would make one tick as long as one run -- the sweep, the reconcile pass and every other
    // workspace would queue behind a single agent thinking. The rejection handler is not optional:
    // an unhandled rejection here takes the daemon down, and the pump is the component that reacts
    // to a gate failure.
    const pump = pumpRun({
      runId,
      taskId: brandTaskId(task.id),
      agentId: brandAgentId(agent.id),
      workspaceId: deps.workspaceId,
      events: runAdapter.events(runId),
      cancel: () => runAdapter.cancel(runId),
      // The facts a fresh process cannot rediscover, handed to the component that knows when the
      // run pauses. Identity is supplied per-process by design, so there is nowhere else to
      // recover it from once this process is gone. `settingsPath`/`hookPath` come from the
      // adapter's own report (`handle.runFiles`), not from anything this tick derived or wrote
      // itself (M12 Task 2) -- relayed into the checkpoint verbatim, never interpreted here.
      spawn: {
        ...handle.runFiles,
        pauseFlagPath,
        gitIdentity: { name: agent.name, email: `${emailLocalPart(agent)}@aiteamos.local` },
        // Recorded so a pause's checkpoint carries the provider the run actually started with
        // (M12 Task 6/8; spec §4) -- `resume()` replays it verbatim, never re-resolving.
        provider: resolved.provider,
        ...(model !== undefined ? { model } : {}),
      },
    })
      // Verify is chained onto the pump rather than put inside it: the pump owns the *run* row, and
      // what happens to the *task* after a run succeeds (spec §8) is its caller's reaction — the
      // same §3.2 boundary that keeps all of this out of `decide()`. Being part of the chain means
      // `drainPumps` waits for the verdict too, so a one-shot `tick` cannot exit between a run
      // succeeding and its task advancing.
      .then(() => verifyConcludedRun(runId))
      .catch((error: unknown): void => {
        console.error(`[tick] pump for run ${runId} failed:`, error)
      })
      .finally((): void => {
        activePumpRunIds.delete(runId)
        pumps.delete(pump)
      })
    pumps.add(pump)
    activePumpRunIds.add(runId)

    return runId
  } catch (error) {
    // Kill what was spawned before recording anything. An agent nobody can find is worse than a
    // failed run, and this is the only moment its pid is still known.
    let cancelError: unknown = null
    // `adapter !== null` is implied by `handle !== null` (nothing spawns before it resolves), but
    // TypeScript cannot see that relationship through the `let`, and a resolution failure (a
    // misconfigured provider, above) is precisely the case where `adapter` is still `null` here.
    if (handle !== null && adapter !== null) {
      try {
        await adapter.cancel(runId)
      } catch (failure) {
        cancelError = failure
      }
    }
    await failToStart(workspace.id, task, run.id, agent.id, error, cancelError)
    return null
  }
}

/**
 * Records a run that never got going, and puts the task somewhere it can be retried — or stops it.
 *
 * The attempt counts (spec §13), which is the whole reason this path is not silent: a task whose
 * worktree can never be provisioned would otherwise be handed to an agent every tick forever. The
 * cap is checked here rather than left to Task 14's verify loop, because a run that never started
 * never reaches verify, and "the attempt counts" is only true if something eventually reads it.
 */
async function failToStart(
  workspaceId: string,
  task: { readonly id: string; readonly maxAttempts: number },
  runId: string,
  agentId: string,
  error: unknown,
  cancelError: unknown = null,
): Promise<void> {
  const reason =
    (error instanceof Error ? error.message : String(error)) +
    (cancelError === null
      ? ''
      : ` -- AND THE CANCEL FAILED (${String(cancelError)}): the process may still be running.`)
  const now = new Date()

  await prisma.agentRun.update({
    where: { id: runId },
    data: { status: 'failed', terminalAt: now, endedAt: now },
  })

  // Leftovers get `blocked`, not `rework`. `rework` is the exact precondition `acquireWorktree`
  // tests for before it adopts, so parking the task there hands the *next* tick the tree this one
  // just refused as unaccounted-for state -- the guard would hold for one tick and then invert
  // itself. `blocked` is not startable, which is what "an operator has to look at this" means in a
  // status.
  const parked = error instanceof WorktreeExistsError ? 'blocked' : 'rework'

  const { attempt, exhausted } = await releaseTaskAfterFailure(task, runId, parked)

  await appendEvent({
    type: 'run.failed',
    workspaceId,
    taskId: task.id,
    agentId,
    runId,
    actor: 'system',
    payload: { reason },
  })
  if (exhausted) {
    await appendEvent({
      type: 'task.failed',
      workspaceId,
      taskId: task.id,
      actor: 'system',
      payload: { reason: `could not start after ${attempt} attempts: ${reason}` },
    })
  } else if (parked === 'rework') {
    // The task's own state change, not just the run's. Without it the log records that a run failed
    // and says nothing about the task going back into the queue.
    await appendEvent({
      type: 'task.rework',
      workspaceId,
      taskId: task.id,
      actor: 'system',
      payload: { reason, attempt },
    })
  }
}
