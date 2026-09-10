import { z } from 'zod'
import { CAPABILITY_KEY_PATTERN } from '../capability/taxonomy.js'
import { jsonObjectsLastToFirst } from '../json/last-object.js'
import { err, ok, type Result } from '../result.js'

export interface PlanTask {
  readonly key: string
  readonly title: string
  readonly description: string
  /**
   * The runtime role the planner asked for, when it asked for one at all.
   *
   * OPTIONAL as of M47 (plan erratum E2). It used to be required, and while it was, a task's
   * `requiredRole` could only ever be this literal — there was no reachable state in which the
   * capability projection (R2) decided the role, and the milestone's central claim could not be
   * measured. A task must still carry a role OR at least one capability; that is checked in
   * {@link validateStructure}, not here, so a graph naming neither is REJECTED rather than falling
   * back to an earlier candidate object in the same message.
   */
  readonly role?: string | undefined
  /** M47 R3: the capabilities this work needs, in the taxonomy's dotted vocabulary. Optional in
   *  the JSON (`.default([])`), so every fixture and every plan written before this milestone
   *  still parses — an old `plan-graph.ndjson` reads back as a task with no capabilities and the
   *  planner's own role, which is exactly what it meant. Validated against the TABLE later, by
   *  `concludePlanning`: this module is pure and has no taxonomy to check against. */
  readonly capabilities: readonly string[]
  readonly dependsOn: readonly string[]
}

export interface PlanGraph {
  readonly tasks: readonly PlanTask[]
}

const planTaskSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  role: z.string().min(1).optional(),
  dependsOn: z.array(z.string()).default([]),
  // A plain non-empty string here on purpose (fix round 1, and M47 t2 for the PATTERN): a shape
  // violation makes `parsePlanGraph` fall back to an EARLIER candidate object in the same message,
  // so neither the count nor the spelling may be enforced at this level -- a planner that wrote a
  // LABEL where a key belongs would otherwise have an already-revised draft executed on its
  // behalf, over a spelling. Both are structural rules, checked in {@link validateStructure} with
  // named errors, exactly as the duplicate-key and cycle rules are.
  capabilities: z.array(z.string().min(1)).default([]),
})

/** How many capabilities one task may ask for. A task naming eleven has not been decomposed --
 *  the same judgement `planGraphSchema`'s 20-task cap makes about a plan. */
export const MAX_TASK_CAPABILITIES = 10

export const planGraphSchema = z.object({ tasks: z.array(planTaskSchema).min(1).max(20) })

/**
 * Recover the task graph from a planning run's accumulated output text. The prompt demands one
 * JSON object in the final message, but slaves wrap JSON in prose and code fences, so this scans
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
  for (const task of graph.tasks) {
    // E2: a task nobody can staff is not a plan. `requiredRole` is what the scheduler matches and
    // `requiredCapabilities` is what it is derived from; with neither, `concludePlanning` would
    // write a null role and BOTH loaders would drop the row — a task on the board that no pass
    // can ever see.
    if (task.role === undefined && task.capabilities.length === 0) {
      return err(`task "${task.key}" names neither a role nor a capability`)
    }
    if (task.capabilities.length > MAX_TASK_CAPABILITIES) {
      return err(`task "${task.key}" asks for more than ${String(MAX_TASK_CAPABILITIES)} capabilities`)
    }
    // The vocabulary is KEYS (R1, R3): the prompt shows the planner keys and nothing else, so a
    // label here is a plan written in a vocabulary nobody offered. Refused by name rather than
    // dropped, because a task whose only capabilities were labels would derive no role at all --
    // and `droppedCapabilities` (which reports keys the TABLE does not have) cannot rescue a
    // string that could never have been a key.
    const malformed = task.capabilities.find((key) => !CAPABILITY_KEY_PATTERN.test(key))
    if (malformed !== undefined) {
      return err(`task "${task.key}" asks for "${malformed}", which is not a capability key`)
    }
  }

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
 *
 * Exported as of M40 (spec erratum E1) for `delta.ts`, which validates a re-plan's `add` list the
 * same way but cannot reuse `validateStructure`: a delta's `dependsOn` may also name an EXISTING
 * task id, which is not a plan-local key. CONTRACT for that second caller -- every `dependsOn`
 * entry must be one of the passed tasks' own keys, because the in-degree count is
 * `dependsOn.length` and an entry naming something outside the set is never decremented, so it
 * reads as a cycle. `delta.ts` projects the plan-local subset of each `dependsOn` before calling.
 */
export function findCycle(tasks: readonly PlanTask[]): readonly string[] | null {
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
