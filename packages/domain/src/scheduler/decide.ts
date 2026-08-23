import type { AgentId, TaskId } from '../ids.js'
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

export interface SchedulableAgent {
  readonly id: AgentId
  readonly role: string
  readonly busy: boolean
}

export interface World {
  readonly tasks: readonly SchedulableTask[]
  readonly agents: readonly SchedulableAgent[]
  readonly limits: GuardrailLimits
  readonly stats: WorkspaceStats
}

export type Command =
  | { readonly kind: 'start_run'; readonly taskId: TaskId; readonly agentId: AgentId }
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

  const availableAgents = new Map<AgentId, SchedulableAgent>(
    world.agents.filter((a) => !a.busy).map((a) => [a.id, a]),
  )

  let slots = Math.min(
    world.limits.maxConcurrentRuns - world.stats.activeRuns,
    world.limits.maxGlobalConcurrentRuns - world.stats.globalActiveRuns,
  )
  const commands: Command[] = []

  for (const candidate of candidates) {
    if (slots <= 0) break

    const agent = [...availableAgents.values()].find((a) => a.role === candidate.requiredRole)
    if (agent === undefined) continue

    commands.push({ kind: 'start_run', taskId: candidate.id, agentId: agent.id })
    availableAgents.delete(agent.id)
    slots -= 1
  }

  return commands
}
