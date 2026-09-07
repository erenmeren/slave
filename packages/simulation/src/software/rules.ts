import type { ActionEnvelope } from '../core/action.js'
import type { DecisionProvider, DecisionRequest } from '../decide/provider.js'
import type { SoftwareSimulationDefinition } from './definition.js'
import { isAbsent, isFree, type Engineer, type Task } from './state.js'

const envelope = (type: string, params: Record<string, unknown>, rationale: string, refs: string[] = []): ActionEnvelope => ({ type, params, rationale, refs })

/**
 * The software rules provider (design §3.4). Deterministic, policy-parameterized, and it reads
 * only the observation it was handed. Product accepts everything; the reviewer works the review
 * queue oldest first; the lead is where the two policies differ — A takes the first free engineer,
 * B holds a task for someone who knows the area until `matchWaitDays` have passed.
 */
export class SoftwareRulesDecisionProvider implements DecisionProvider {
  readonly kind = 'rules' as const
  constructor(private readonly definition: SoftwareSimulationDefinition) {}

  decide(request: DecisionRequest): readonly ActionEnvelope[] {
    const o = request.observation
    switch (request.role.name) {
      case 'product': {
        const requested = ((o['requestedTasks'] as Task[] | undefined) ?? []).slice(0, this.definition.limits.maxDecisionsPerStep)
        return requested.map((t) => envelope('accept_request', { taskId: t.id }, `request ${t.id} (${t.area}, ${t.sizeDays}d) due day ${t.dueDay}`, [t.id]))
      }
      case 'lead':
        return this.lead(request)
      case 'reviewer': {
        const remaining = Number(o['reviewCapacityPerDay'] ?? 0) - Number(o['reviewedToday'] ?? 0)
        const inReview = ((o['inReviewTasks'] as Task[] | undefined) ?? []).slice(0, Math.max(0, remaining))
        return inReview.map((t) => envelope('review_task', { taskId: t.id }, `review ${t.id} finished day ${t.finishedDay}`, [t.id]))
      }
      default:
        return []
    }
  }

  private lead(request: DecisionRequest): ActionEnvelope[] {
    const o = request.observation
    const queue = (o['queue'] as Task[] | undefined) ?? []
    const engineers = (o['engineers'] as Engineer[] | undefined) ?? []
    const matchWaitDays = Number(o['matchWaitDays'] ?? 0)
    const max = request.role.constraints['maxAssignmentsPerStep'] ?? queue.length
    // Engineers claimed earlier in this same decision point: the provider proposes a whole day's
    // assignments from one observation, so it has to remember who it already spent.
    const used = new Set<string>()
    const actions: ActionEnvelope[] = []
    for (const task of queue) {
      if (actions.length >= max) break
      const free = engineers.filter((e) => isFree(e) && !isAbsent(e) && !used.has(e.id))
      if (free.length === 0) break
      const chosen = this.pick(task, free, request.day, matchWaitDays)
      // No pick under policy B is a deliberate wait, not a dead end: a later task in the queue may
      // still have someone who matches it, so keep walking.
      if (chosen === undefined) continue
      used.add(chosen.id)
      const why = chosen.expertise === task.area ? `matches ${task.area}` : `no ${task.area} engineer free`
      actions.push(envelope('assign_task', { taskId: task.id, engineerId: chosen.id }, `${task.priority === 'incident' ? 'incident' : 'task'} ${task.id} (${task.area}, ${task.sizeDays}d) → ${chosen.id}: ${why}`, [task.id]))
    }
    return actions
  }

  private pick(task: Task, free: readonly Engineer[], day: number, matchWaitDays: number): Engineer | undefined {
    if (this.definition.policy === 'A') return free[0]
    const matched = free.find((e) => e.expertise === task.area)
    if (matched !== undefined) return matched
    const waited = day - (task.queuedDay ?? day)
    return waited >= matchWaitDays ? free[0] : undefined
  }
}
