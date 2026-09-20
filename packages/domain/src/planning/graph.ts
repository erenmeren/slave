import { z } from 'zod'
import { CAPABILITY_KEY_PATTERN } from '../capability/taxonomy.js'
// TYPE-ONLY, and deliberately so: it pins {@link TASK_NEEDS} to the permission vocabulary without
// making this pure shape parser depend on the matrix at runtime.
import type { PermissionKind } from '../permission/kinds.js'
import { handoffContractSchema, type HandoffContract } from '../handoff/contract.js'
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
  /**
   * M48 R1/R2: the typed handoff for this task. Optional at the shape (`.optional()`), because
   * every plan written before this milestone carries none and an old fixture must still parse --
   * the same back-compat rule `capabilities` follows.
   *
   * A LOOSE `z.record` at the shape and the real schema in {@link validateStructure} (plan erratum
   * E16's sibling reason): `parsePlanGraph` falls back to an earlier candidate object on a SHAPE
   * failure, so a contract with a missing `expectedOutput` would otherwise have an already-revised
   * draft executed on its behalf. It is a structural rule, refused by name.
   */
  readonly handoff?: HandoffContract | undefined
  /** M48 R2: the runbook stage this task belongs to, when the workspace has adopted a runbook.
   *  Checked against the adopted runbook's stage keys in {@link validateStructure}, which takes
   *  them as an argument (plan erratum E1). */
  readonly stage?: string | undefined
  /**
   * E R5: the permissions this task's work needs, from {@link TASK_NEEDS} and nothing else.
   *
   * OPTIONAL at the type for `capabilities`' back-compat reason (the JSON carries `.default([])`,
   * so it is always an array after a parse): every fixture and every plan written before this
   * milestone reads back as a task that needs nothing, which is exactly what it meant.
   *
   * A HINT, not structure. A value outside the list is DROPPED rather than refused -- see
   * {@link PlanGraph.droppedNeeds} -- because the board does not depend on this field and a whole
   * planning run thrown away over a word the planner invented would cost far more than the
   * permission it was asking for.
   */
  readonly needs?: readonly TaskNeed[] | undefined
  readonly dependsOn: readonly string[]
}

/**
 * The permissions a plan may ask for on a task's behalf (E R5). A CLOSED list, and deliberately
 * the two kinds a plan can actually know about in advance: reading the web, and running commands
 * beyond the repository's own scripts. The other four are a person's decision about a worker, not
 * a property of the work.
 *
 * Spelled here rather than derived from `PERMISSION_KINDS`, because it is a SUBSET chosen for what
 * a plan can know -- and pinned to that vocabulary by the `satisfies` below, which is a type-only
 * dependency and compiles away: a word this list carries that the matrix does not have would be a
 * red build rather than a grant nothing can resolve.
 */
export const TASK_NEEDS = ['network_fetch', 'run_commands'] as const satisfies readonly PermissionKind[]

export type TaskNeed = (typeof TASK_NEEDS)[number]

function isTaskNeed(value: string): value is TaskNeed {
  return (TASK_NEEDS as readonly string[]).includes(value)
}

/**
 * One task's needs, split into what this system has words for and what it does not (E R5).
 *
 * DEDUPED across both halves by one `seen` set (fix round 1): `Task.requiredPermissions` is a set
 * in everything but its column type, so a planner that wrote `network_fetch` twice must not grant
 * it twice, and a report naming the same invented word three times is noise rather than a finding.
 * No cap is needed beyond this -- once bounded to {@link TASK_NEEDS} the kept list cannot exceed
 * two -- which is why `needs` has no equivalent of {@link MAX_TASK_CAPABILITIES}.
 *
 * Shared by {@link validateStructure} (which reports the dropped half) and {@link normalisePlanTask}
 * (which keeps the other), so a first plan and a re-plan's `add` list cannot bound them differently.
 */
function partitionNeeds(needs: readonly string[] | null | undefined): {
  readonly kept: readonly TaskNeed[]
  readonly dropped: readonly string[]
} {
  const seen = new Set<string>()
  const kept: TaskNeed[] = []
  const dropped: string[] = []
  for (const need of needs ?? []) {
    if (seen.has(need)) continue
    seen.add(need)
    if (isTaskNeed(need)) kept.push(need)
    else dropped.push(need)
  }
  return { kept, dropped: dropped.toSorted() }
}

export interface PlanGraph {
  readonly tasks: readonly PlanTask[]
  /**
   * E R5: needs the planner wrote that {@link TASK_NEEDS} does not have, per task key, sorted.
   *
   * The sibling of `concludePlanning`'s `droppedCapabilities`, and reported for the same reason: a
   * silently ignored vocabulary is how an operator concludes the feature does not work. ABSENT
   * when nothing was dropped, so a plan written in the two words this system has carries no field
   * about it at all.
   */
  readonly droppedNeeds?: Readonly<Record<string, readonly string[]>> | undefined
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
  // Loose on purpose, exactly like `capabilities` above: a shape violation here would make
  // `parsePlanGraph` fall back to an EARLIER draft, and a handoff that is merely incomplete is a
  // named structural refusal instead.
  //
  // `.nullish()`, not `.optional()` (fix round 1, Important 1; spec erratum E18). A planner asked
  // for an optional field answers it two ways -- by omitting it, and by writing `null` -- and
  // `.optional()` accepted only the first. The second FAILED THE SHAPE, which is precisely the
  // failure this looseness exists to prevent: `parsePlanGraph` walked past the final object and ran
  // an earlier draft, silently. `null` means absent; {@link validateStructure} normalises it away.
  handoff: z.record(z.string(), z.unknown()).nullish(),
  stage: z.string().min(1).nullish(),
  // A plain string array, never `z.enum(TASK_NEEDS)`, for the looseness every field above it keeps:
  // a shape violation makes `parsePlanGraph` fall back to an EARLIER candidate object in the same
  // message, so a planner that invented a word would have an already-revised draft executed on its
  // behalf. {@link validateStructure} drops the unknown values and reports them instead.
  //
  // `.nullish()`, not `.default([])` (fix round 1): `handoff` and `stage` learnt this from erratum
  // E18 -- a planner asked for an optional field answers it two ways, by omitting it and by writing
  // `null`, and a schema that accepts only the first FAILS THE SHAPE on the second. `null` means
  // absent; {@link normalisePlanTask} normalises it to the empty list.
  needs: z.array(z.string().min(1)).nullish(),
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
export function parsePlanGraph(text: string, stageKeys: readonly string[] = []): Result<PlanGraph, string> {
  for (const candidate of jsonObjectsLastToFirst(text)) {
    const parsed = planGraphSchema.safeParse(candidate)
    if (parsed.success) return validateStructure(parsed.data as PlanGraph, stageKeys)
  }
  return err('no JSON object with { "tasks": [...] } found in the planning output')
}

function validateStructure(graph: PlanGraph, stageKeys: readonly string[]): Result<PlanGraph, string> {
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
    // `!= null` on purpose, for both: `null` is a planner saying "no contract" / "no stage", and
    // erratum E18 makes that the same answer as omitting the key.
    if (task.handoff != null) {
      const contract = handoffContractSchema.safeParse(task.handoff)
      if (!contract.success) {
        return err(`task "${task.key}" has a handoff that is not a contract: ${contract.error.message}`)
      }
    }
    // Plan erratum E1: the stage vocabulary is decided by the caller, and this module is pure.
    //
    // The caller reads it off THE RUN'S OWN recorded manifest (M48 final review, Important 3) --
    // the runbook the planner was actually shown -- never off the workspace at conclude time: a
    // runbook adopted while the run was in flight would otherwise make every stage in a perfectly
    // good graph unknown, and this check would throw the whole plan away. An EMPTY list is "this
    // run was shown no runbook", under which any stage stands; such a stage lands on the board as
    // written and `measureAdherence` reports it against whatever the project follows now.
    if (task.stage != null && stageKeys.length > 0 && !stageKeys.includes(task.stage)) {
      return err(`task "${task.key}" names stage "${task.stage}", which this runbook does not have`)
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

  // The contract is re-read out of the strict schema and put back on the task, so every caller gets
  // `HandoffContract` rather than the loose record the shape let through. One parse, at the
  // boundary -- `concludePlanning` never re-validates.
  //
  // A `null` handoff or stage is DELETED rather than carried (erratum E18): `concludePlanning`
  // writes these straight onto a `Task` row, and a `null` reaching `Task.handoff` is a JSON null in
  // the column -- a value every reader then has to tell apart from an absent contract -- while a
  // `null` reaching `Task.stage` would be a stage named nothing. `undefined` is the one spelling of
  // "the planner did not ask for this".
  //
  // E R5: the needs are partitioned rather than checked. Collected per task key and SORTED, so the
  // plan event reports the same thing however the planner ordered them.
  const droppedNeeds: Record<string, readonly string[]> = {}
  for (const task of graph.tasks) {
    const { dropped } = partitionNeeds(task.needs)
    if (dropped.length > 0) droppedNeeds[task.key] = dropped
  }

  return ok({
    tasks: graph.tasks.map(normalisePlanTask),
    ...(Object.keys(droppedNeeds).length === 0 ? {} : { droppedNeeds }),
  })
}

/**
 * One task with its optional M48 fields normalised: a parsed `HandoffContract` where there is one,
 * and the KEY REMOVED where the planner wrote `null` or nothing (spec erratum E18).
 *
 * Exported for `delta.ts`'s `validateDelta` alone -- the same rule applies to a re-plan's `add`
 * list, and the two must not drift -- exactly as {@link findCycle} is exported for that one caller.
 */
export function normalisePlanTask(task: PlanTask): PlanTask {
  const { handoff, stage, needs, ...rest } = task
  return {
    ...rest,
    // E R5: the needs are BOUNDED here rather than in `validateStructure` alone, so a delta's `add`
    // list -- which reuses this function and never sees that validator -- cannot carry a word
    // outside the closed list onto a `Task` row either. The dropped values are reported by
    // `validateStructure`, which is the one caller with a plan event to report them on. A `null`
    // here is the planner saying "no needs", exactly as it is for `handoff` and `stage` above.
    needs: partitionNeeds(needs).kept,
    ...(handoff == null ? {} : { handoff: handoffContractSchema.parse(handoff) }),
    ...(stage == null ? {} : { stage }),
  }
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
