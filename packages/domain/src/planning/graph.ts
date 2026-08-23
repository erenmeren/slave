import { z } from 'zod'
import { jsonObjectsLastToFirst } from '../json/last-object.js'
import { err, ok, type Result } from '../result.js'

export interface PlanTask {
  readonly key: string
  readonly title: string
  readonly description: string
  readonly role: string
  readonly dependsOn: readonly string[]
}

export interface PlanGraph {
  readonly tasks: readonly PlanTask[]
}

const planTaskSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  role: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
})

export const planGraphSchema = z.object({ tasks: z.array(planTaskSchema).min(1).max(20) })

/**
 * Recover the task graph from a planning run's accumulated output text. The prompt demands one
 * JSON object in the final message, but agents wrap JSON in prose and code fences, so this scans
 * for the LAST parseable object that satisfies the schema (the same last-object-wins convention
 * as `parseReviewVerdict`).
 *
 * Once a candidate passes the zod shape check it IS the verdict: a structural violation (a
 * duplicate key, a dangling or self dependency, a dependency cycle) rejects it outright rather
 * than falling back to an earlier candidate — the planner's final graph is what was wrong, and
 * silently executing an earlier draft nobody signed off on would be worse than failing loudly.
 */
export function parsePlanGraph(text: string): Result<PlanGraph, string> {
  for (const candidate of jsonObjectsLastToFirst(text)) {
    const parsed = planGraphSchema.safeParse(candidate)
    if (parsed.success) return validateStructure(parsed.data)
  }
  return err('no JSON object with { "tasks": [...] } found in the planning output')
}

function validateStructure(graph: PlanGraph): Result<PlanGraph, string> {
  const keys = new Set<string>()
  for (const task of graph.tasks) {
    if (keys.has(task.key)) return err(`duplicate task key: "${task.key}"`)
    keys.add(task.key)
  }

  for (const task of graph.tasks) {
    if (task.dependsOn.includes(task.key)) return err(`task "${task.key}" cannot depend on itself`)
    for (const dep of task.dependsOn) {
      if (!keys.has(dep)) return err(`task "${task.key}" depends on unknown key "${dep}"`)
    }
  }

  const cycle = findCycle(graph.tasks)
  if (cycle !== null) return err(`the task graph has a dependency cycle through: ${cycle.join(', ')}`)

  return ok(graph)
}

/**
 * Kahn's algorithm: count in-degrees (each task's dependsOn length) over the plan-local keys,
 * then repeatedly remove zero-in-degree nodes. Whatever is left never reached zero in-degree,
 * meaning it sits on (or downstream of) a cycle.
 */
function findCycle(tasks: readonly PlanTask[]): readonly string[] | null {
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const task of tasks) {
    inDegree.set(task.key, task.dependsOn.length)
    dependents.set(task.key, [])
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      dependents.get(dep)?.push(task.key)
    }
  }

  const queue: string[] = []
  for (const [key, degree] of inDegree) {
    if (degree === 0) queue.push(key)
  }

  let removed = 0
  while (queue.length > 0) {
    const key = queue.shift() as string
    removed += 1
    for (const dependent of dependents.get(key) ?? []) {
      const next = (inDegree.get(dependent) ?? 0) - 1
      inDegree.set(dependent, next)
      if (next === 0) queue.push(dependent)
    }
  }

  if (removed === tasks.length) return null
  return [...inDegree.entries()].filter(([, degree]) => degree > 0).map(([key]) => key)
}
