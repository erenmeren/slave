import type { SlaveId, TaskId } from '../ids.js'
import type { TaskStatus } from '../task/state.js'
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

export type Command =
  | { readonly kind: 'start_run'; readonly taskId: TaskId; readonly slaveId: SlaveId }
  | { readonly kind: 'halt'; readonly reason: string }

const STARTABLE: readonly TaskStatus[] = ['ready', 'rework']

/**
 * Pure scheduling decision. No side effects, no I/O, fully deterministic:
 * the same world always produces the same commands.
 */
export function decide(world: World): readonly Command[] {
  const halting = evaluateGuardrails(world.limits, world.stats).find((b) => b.haltsScheduling)
  if (halting !== undefined) {
    return [{ kind: 'halt', reason: halting.guardrail }]
  }

  const candidates = world.tasks
    .filter((t) => STARTABLE.includes(t.status) && t.dependenciesDone)
    .toSorted((a, b) => (b.priority - a.priority) || a.id.localeCompare(b.id))

  const availableSlaves = new Map<SlaveId, SchedulableSlave>(
    world.slaves.filter((a) => !a.busy).map((a) => [a.id, a]),
  )

  let slots = Math.min(
    world.limits.maxConcurrentRuns - world.stats.activeRuns,
    world.limits.maxGlobalConcurrentRuns - world.stats.globalActiveRuns,
  )
  const commands: Command[] = []

  for (const candidate of candidates) {
    if (slots <= 0) break

    const slave = [...availableSlaves.values()].find((a) => a.runtimeRoles.includes(candidate.requiredRole))
    if (slave === undefined) continue

    commands.push({ kind: 'start_run', taskId: candidate.id, slaveId: slave.id })
    availableSlaves.delete(slave.id)
    slots -= 1
  }

  return commands
}
