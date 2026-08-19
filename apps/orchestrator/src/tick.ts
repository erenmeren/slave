import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { prisma } from '@ai-team-os/db/client'
import {
  decide,
  runId as brandRunId,
  taskId as brandTaskId,
  agentId as brandAgentId,
  type AgentId,
  type RunId,
  type TaskId,
  type WorkspaceId,
} from '@ai-team-os/domain'
import { appendEvent } from '@ai-team-os/events'
import { type AgentRuntimeAdapter, writeSettingsFile } from '@ai-team-os/providers'
import { pumpRun } from './pump.js'
import { loadWorld } from './world.js'
import { WorktreeExistsError, adoptWorktree, provisionWorktree, type WorktreeHandle } from './worktree.js'

export interface TickDeps {
  readonly workspaceId: WorkspaceId
  readonly adapter: AgentRuntimeAdapter
  /**
   * Absolute path to the **orchestrator's** `scripts/pause-gate.sh`, not the workspace repo's.
   * Injected rather than resolved from this module's own location because a daemon does not
   * reliably know its install path, and a test needs to point at a real script.
   */
  readonly hookPath: string
}

export interface TickReport {
  readonly started: readonly RunId[]
  readonly halted: string | null
  readonly skippedNoRole: number
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
 */
const pumps = new Set<Promise<unknown>>()

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
 * Where the run's own files live: **outside** the worktree, under the repository's `.aiteamos`.
 *
 * The settings file must be registered by absolute path (ADR 0001 §3) and the pause flag must be
 * unique per run (spec §5.2) — but neither may sit inside the worktree, because Task 14 runs verify
 * there and Task 11 already found `.aiteamos/` showing up as untracked content. A settings file in
 * the worktree makes every verify see a dirty tree it did not create.
 */
function runFilePaths(repoPath: string, runId: RunId): { settingsPath: string; pauseFlagPath: string } {
  const dir = join(repoPath, '.aiteamos', 'runs', runId)
  mkdirSync(dir, { recursive: true })
  return { settingsPath: join(dir, 'settings.json'), pauseFlagPath: join(dir, 'pause.flag') }
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
    }
    return { started: [], halted: halt.reason, skippedNoRole }
  }
  haltAnnounced.set(deps.workspaceId, false)

  const started: RunId[] = []
  for (const command of commands) {
    if (command.kind !== 'start_run') continue
    const runId = await startRun(deps, command.taskId, command.agentId)
    if (runId !== null) started.push(runId)
  }

  return { started, halted: null, skippedNoRole }
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
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
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
  await prisma.task.update({
    where: { id: task.id },
    data: { status: 'running', activeRunId: run.id, branch },
  })
  await appendEvent({
    type: 'task.started',
    workspaceId: workspace.id,
    taskId: task.id,
    agentId: agent.id,
    runId: run.id,
    actor: 'system',
    payload: { title: task.title },
  })

  try {
    const worktree = await acquireWorktree({
      repoPath: workspace.repoPath,
      baseBranch: workspace.baseBranch,
      taskKey,
      slug,
      branch,
      setupCommands: workspace.setupCommands,
      isRework: task.status === 'rework',
    })

    const { settingsPath, pauseFlagPath } = runFilePaths(workspace.repoPath, runId)
    writeSettingsFile({ settingsPath, hookPath: deps.hookPath })

    const handle = await deps.adapter.start({
      runId,
      prompt: buildPrompt(task),
      worktreePath: worktree.path,
      pauseFlagPath,
      settingsPath,
      hookPath: deps.hookPath,
      gitIdentity: { name: agent.name, email: `${slugify(agent.name)}@aiteamos.local` },
    })

    await prisma.agentRun.update({
      where: { id: run.id },
      data: { pid: handle.pid, worktreePath: worktree.path },
    })

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
      events: deps.adapter.events(runId),
      cancel: () => deps.adapter.cancel(runId),
    })
      .catch((error: unknown): void => {
        console.error(`[tick] pump for run ${runId} failed:`, error)
      })
      .finally((): void => {
        pumps.delete(pump)
      })
    pumps.add(pump)

    return runId
  } catch (error) {
    await failToStart(workspace.id, task, run.id, agent.id, error)
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
  task: { readonly id: string; readonly attempt: number; readonly maxAttempts: number },
  runId: string,
  agentId: string,
  error: unknown,
): Promise<void> {
  const reason = error instanceof Error ? error.message : String(error)
  const now = new Date()
  const attempt = task.attempt + 1
  const exhausted = attempt >= task.maxAttempts

  await prisma.agentRun.update({
    where: { id: runId },
    data: { status: 'failed', terminalAt: now, endedAt: now },
  })
  await prisma.task.update({
    where: { id: task.id },
    data: {
      status: exhausted ? 'failed' : 'rework',
      attempt,
      activeRunId: null,
      lastRejectionReason: reason,
    },
  })

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
  }
}
