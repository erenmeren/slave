import { z } from 'zod'
import { err, ok, type Result } from '../result.js'

/** A stage key, and a runbook key: a lower-case dash-separated slug. The same alphabet
 *  `CAPABILITY_KEY_PATTERN` uses for one half of a capability key, because both are typed by an
 *  operator into a CLI flag and read back out of a URL. */
export const RUNBOOK_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** How many stages one runbook may carry. Thirteen stages is a process, not a plan a team can
 *  follow -- the same judgement `planGraphSchema`'s 20-task cap makes about a plan. */
export const RUNBOOK_MAX_STAGES = 12

/** One stage of a runbook (M48 R3): a phase of the work, what it is for, what it needs, what it
 *  leaves behind, and what has to pass before it counts. */
export interface RunbookStage {
  readonly key: string
  readonly title: string
  readonly objective: string
  /** Taxonomy keys this stage needs. SUGGESTS a roster (R3) -- `formTeam` reads them; nothing here
   *  creates a worker. */
  readonly capabilities: readonly string[]
  /** Other STAGE keys, never task ids. Acyclic, checked by {@link parseRunbookStages}. */
  readonly dependsOn: readonly string[]
  readonly expectedOutputs: readonly string[]
  /** Shell commands `verifyConcludedRun` runs for a task in this stage, AFTER the workspace's own
   *  `verifyCommands` (R6). The seed cannot know a project's commands, so every seed stage has
   *  none -- a gate is a workspace's own. */
  readonly gates: readonly string[]
  /** What `Task.maxAttempts` is set to for a task created in this stage (R2); null means the
   *  workspace's own value, which is what every task got before this milestone. */
  readonly retry: { readonly maxAttempts: number } | null
  /** The sentence a `task_failed` situation carries when a task of this stage exhausts its
   *  attempts (R6, plan erratum E6). Null is ordinary. */
  readonly escalation: string | null
}

export const RUNBOOK_SOURCES = ['seed', 'persona', 'human'] as const
export type RunbookSource = (typeof RUNBOOK_SOURCES)[number]

/** A whole runbook, as the pure functions here and every reader see it. The DATA lives in
 *  `RunbookTemplate`; nothing in `packages/domain` reads a database, so every function below takes
 *  runbooks as an argument -- which is also what makes each of them a three-line fixture. */
export interface Runbook {
  readonly id: string
  readonly key: string
  readonly name: string
  readonly description: string
  /** Whole-word goal matching (R5). Never substrings: see {@link recommendRunbooks}. */
  readonly keywords: readonly string[]
  readonly requiredCapabilities: readonly string[]
  readonly optionalCapabilities: readonly string[]
  readonly stages: readonly RunbookStage[]
  readonly source: RunbookSource
  /** The template a `persona` runbook was translated from; null for `seed` and `human`. */
  readonly sourceTemplateId: string | null
}

const text = z.string().min(1).max(400)

const runbookStageSchema = z.object({
  key: z.string().regex(RUNBOOK_KEY_PATTERN, 'a stage key is a lower-case dash-separated slug'),
  title: text,
  objective: text,
  capabilities: z.array(z.string().min(1)).max(10).default([]),
  dependsOn: z.array(z.string().min(1)).max(RUNBOOK_MAX_STAGES).default([]),
  expectedOutputs: z.array(text).max(10).default([]),
  gates: z.array(z.string().min(1).max(400)).max(10).default([]),
  // A stage that may be attempted zero times is not a stage; a stage that may be attempted twenty
  // is a budget nobody set. `Workspace.maxAttempts` defaults to 3, and this is its override.
  retry: z.object({ maxAttempts: z.number().int().min(1).max(10) }).nullable().default(null),
  escalation: text.nullable().default(null),
})

/** Typed with an `unknown` INPUT (the `answerPrompt.ts` annotation): seven of a stage's nine fields
 *  are `.default()`ed, so what this schema accepts is deliberately looser than what it produces. */
export const runbookStagesSchema: z.ZodType<readonly RunbookStage[], z.ZodTypeDef, unknown> = z
  .array(runbookStageSchema)
  .min(1)
  .max(RUNBOOK_MAX_STAGES)

/**
 * Validates a `RunbookTemplate.stages` `Json` value (R3) -- the shape AND everything a zod shape
 * cannot say: unique keys, dependencies that resolve, no self-dependency, no cycle.
 *
 * Structural failures are named, the way `validateStructure` names a bad plan (`../planning/
 * graph.ts:74`): the operator who wrote the file, or the persona translation that produced it, gets
 * the key that is wrong rather than a zod path.
 */
export function parseRunbookStages(value: unknown): Result<readonly RunbookStage[], string> {
  if (Array.isArray(value) && value.length === 0) return err('a runbook needs at least one stage')
  const parsed = runbookStagesSchema.safeParse(value)
  if (!parsed.success) return err(parsed.error.message)
  const stages = parsed.data

  const keys = new Set<string>()
  for (const stage of stages) {
    if (keys.has(stage.key)) return err(`duplicate stage key: "${stage.key}"`)
    keys.add(stage.key)
  }
  for (const stage of stages) {
    if (stage.dependsOn.includes(stage.key)) return err(`stage "${stage.key}" cannot depend on itself`)
    for (const dep of stage.dependsOn) {
      if (!keys.has(dep)) return err(`stage "${stage.key}" depends on unknown stage "${dep}"`)
    }
  }
  const cycle = findStageCycle(stages)
  if (cycle !== null) return err(`the runbook has a stage cycle through: ${cycle.join(', ')}`)
  return ok(stages)
}

/**
 * The stages in the order they are meant to happen (R3): Kahn's algorithm with a KEY-ASCENDING
 * ready queue.
 *
 * The tie-break is the whole point. Two stages that depend on nothing are ordered by key rather
 * than by the order somebody typed them, so the same runbook renders the same prompt, the same
 * panel and the same `stagesMissing` list on every machine. A caller must validate with
 * {@link parseRunbookStages} first -- a cyclic list here simply comes back short, because there is
 * no order to report for a cycle.
 */
export function stageOrder(stages: readonly RunbookStage[]): readonly RunbookStage[] {
  const byKey = new Map(stages.map((stage) => [stage.key, stage] as const))
  const inDegree = new Map(stages.map((stage) => [stage.key, stage.dependsOn.length] as const))
  const dependents = new Map<string, string[]>(stages.map((stage) => [stage.key, []]))
  for (const stage of stages) {
    for (const dep of stage.dependsOn) dependents.get(dep)?.push(stage.key)
  }

  const ready = [...inDegree.entries()].filter(([, degree]) => degree === 0).map(([key]) => key)
  const ordered: RunbookStage[] = []
  while (ready.length > 0) {
    ready.sort((a, b) => a.localeCompare(b))
    const key = ready.shift() as string
    const stage = byKey.get(key)
    if (stage !== undefined) ordered.push(stage)
    for (const dependent of dependents.get(key) ?? []) {
      const next = (inDegree.get(dependent) ?? 0) - 1
      inDegree.set(dependent, next)
      if (next === 0) ready.push(dependent)
    }
  }
  return ordered
}

/** The keys that never reached zero in-degree -- a cycle, or downstream of one. Sorted, so the
 *  refusal sentence is the same one twice. */
function findStageCycle(stages: readonly RunbookStage[]): readonly string[] | null {
  const ordered = stageOrder(stages)
  if (ordered.length === stages.length) return null
  const placed = new Set(ordered.map((stage) => stage.key))
  return stages
    .map((stage) => stage.key)
    .filter((key) => !placed.has(key))
    .toSorted((a, b) => a.localeCompare(b))
}
