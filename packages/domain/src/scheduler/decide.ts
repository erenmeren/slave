import type { SlaveId, TaskId } from '../ids.js'
import type { TaskStatus } from '../task/state.js'
import { holdsRole } from './assign.js'
import {
  evaluateGuardrails,
  type GuardrailLimits,
  type WorkspaceStats,
} from '../guardrails/evaluate.js'

export interface SchedulableTask {
  readonly id: TaskId
  readonly status: TaskStatus
  readonly requiredRole: string
  readonly priority: number
  readonly dependenciesDone: boolean
  /**
   * H9b R1 (F5): the task's latest run was refused by the provider (`api_error`) and its backoff
   * has not run out (`providerBackoffUntil`). Read against the loader's clock rather than carried
   * as an instant, so `decide()` stays a function of the world alone. Optional because a task
   * with no refusal behind it -- every test fixture, and nearly every task -- has nothing to say.
   */
  readonly backingOff?: boolean
  /**
   * Conductor Plan 2 (D3): the seat a package task belongs to. A pinned task is started only on
   * that seat; the role still has to be held (every package seat holds `PACKAGE_WORKER_ROLE`), so
   * a seat whose role was taken away stops receiving its package rather than running it anyway.
   */
  readonly pinnedSlaveId?: SlaveId | null
}

export interface SchedulableSlave {
  readonly id: SlaveId
  /**
   * The roles this slave may be DISPATCHED as (M37 §5) -- not `Slave.role`, which since M37 is
   * the profile's title and says nothing about what the scheduler may put in front of it.
   *
   * An empty set is a real state and means "cannot be dispatched": `.includes` on it is false for
   * every `requiredRole`, including the empty string, so a parked worker is never a candidate
   * without a second guard saying so.
   */
  readonly runtimeRoles: readonly string[]
  readonly busy: boolean
}

export interface World {
  readonly tasks: readonly SchedulableTask[]
  readonly slaves: readonly SchedulableSlave[]
  readonly limits: GuardrailLimits
  readonly stats: WorkspaceStats
}

/**
 * H9c: what a tick with no room is waiting ON. One member today -- the per-workspace cap and the
 * global one are the same wait to anybody reading it (a run somewhere has to conclude) -- and a
 * union rather than a boolean so a second kind of "not now" has somewhere to go.
 */
export type WaitReason = 'concurrency'

export type Command =
  | { readonly kind: 'start_run'; readonly taskId: TaskId; readonly slaveId: SlaveId }
  | { readonly kind: 'halt'; readonly reason: string }
  /**
   * H9c: no room this tick. Not a halt -- nothing is announced, nobody is asked, and every pass
   * that starts no new run (answers, resumes, merges, the Supervisor) goes ahead. Returned alone,
   * like `halt`, and never beside a `start_run`: a tick that can start something has room.
   */
  | { readonly kind: 'wait'; readonly on: WaitReason }

const STARTABLE: readonly TaskStatus[] = ['ready', 'rework']

/**
 * Would `decide()` hand this task to somebody, given a free seat that holds its role?
 *
 * The one reading of "startable" (pilot fix A). `decide()` filtered on this expression inline and
 * nothing else could ask it; the Supervisor now has to, to tell a question whose recipient will run
 * on the next tick -- and so see it in its inbox, which only an implementation run renders -- from
 * one whose recipient never will. Two copies of the rule would be exactly how the Supervisor comes
 * to wait thirty minutes for a seat the scheduler has already decided never to start.
 *
 * Structurally typed so a Supervisor task (which carries no `backingOff`, and reads as "not backing
 * off") is accepted as it is. `dependenciesDone` is the loaders' SQL predicate -- done AND
 * integrated -- and is deliberately not recomputed here.
 */
export function isDispatchable(
  task: Pick<SchedulableTask, 'status' | 'dependenciesDone' | 'backingOff'>,
): boolean {
  return STARTABLE.includes(task.status) && task.dependenciesDone && task.backingOff !== true
}

/**
 * Does this seat hold the role of at least one task `decide()` could start (pilot fix A)?
 *
 * Deliberately not "will `decide()` pick THIS seat": a free seat that holds a dispatchable task's
 * role is started the moment a slot opens, and a tick waiting on the concurrency cap is a seat that
 * WILL run -- the case the Supervisor's ordinary thirty-minute threshold is for.
 *
 * A pinned task (Conductor Plan 2) counts only for its own seat, as in `decide()`: another holder
 * of the role will never be handed it. A seat passed without an `id` has no pinned work.
 */
export function hasStartableWork(
  seat: { readonly id?: string; readonly runtimeRoles: readonly string[] },
  tasks: readonly Pick<
    SchedulableTask,
    'status' | 'dependenciesDone' | 'backingOff' | 'requiredRole' | 'pinnedSlaveId'
  >[],
): boolean {
  return tasks.some(
    (task) =>
      isDispatchable(task) &&
      holdsRole(seat, task.requiredRole) &&
      ((task.pinnedSlaveId ?? null) === null || task.pinnedSlaveId === seat.id),
  )
}

/**
 * Pure scheduling decision. No side effects, no I/O, fully deterministic:
 * the same world always produces the same commands.
 */
export function decide(world: World): readonly Command[] {
  const halting = evaluateGuardrails(world.limits, world.stats).find((b) => b.haltsScheduling)
  if (halting !== undefined) {
    return [{ kind: 'halt', reason: halting.guardrail }]
  }

  let slots = Math.min(
    world.limits.maxConcurrentRuns - world.stats.activeRuns,
    world.limits.maxGlobalConcurrentRuns - world.stats.globalActiveRuns,
  )
  // H9c: a full workspace (or a full machine) waits; it does not halt. Said out loud rather than
  // left as an empty list, because the tick must not start a planning or review run into the slot
  // that is not there either, and an empty list also means "nothing to do".
  if (slots <= 0) return [{ kind: 'wait', on: 'concurrency' }]

  const candidates = world.tasks
    .filter(isDispatchable)
    .toSorted((a, b) => (b.priority - a.priority) || a.id.localeCompare(b.id))

  const availableSlaves = new Map<SlaveId, SchedulableSlave>(
    world.slaves.filter((a) => !a.busy).map((a) => [a.id, a]),
  )

  const commands: Command[] = []

  for (const candidate of candidates) {
    if (slots <= 0) break

    // `holdsRole`, not a second copy of the expression (H2): `chooseAssignee` names a task's holder
    // at creation and this hands the run out, and the two disagreeing about what holding a role
    // means is a card naming one person while the work goes to another.
    // Conductor Plan 2 (D3): a pinned task waits for its own seat, however many others are free.
    const pinned = candidate.pinnedSlaveId ?? null
    const slave =
      pinned !== null
        ? pinnedSeat(availableSlaves, pinned, candidate.requiredRole)
        : [...availableSlaves.values()].find((a) => holdsRole(a, candidate.requiredRole))
    if (slave === undefined) continue

    commands.push({ kind: 'start_run', taskId: candidate.id, slaveId: slave.id })
    availableSlaves.delete(slave.id)
    slots -= 1
  }

  return commands
}

/** The pinned seat, if it is free this tick and still holds the task's role. */
function pinnedSeat(
  availableSlaves: ReadonlyMap<SlaveId, SchedulableSlave>,
  pinned: SlaveId,
  requiredRole: string,
): SchedulableSlave | undefined {
  const seat = availableSlaves.get(pinned)
  return seat !== undefined && holdsRole(seat, requiredRole) ? seat : undefined
}
