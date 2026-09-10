import { z } from 'zod'
import { jsonObjectsLastToFirst } from '../json/last-object.js'
import { err, ok, type Result } from '../result.js'
import type { TaskStatus } from '../task/state.js'
import { findCycle, planGraphSchema, type PlanTask } from './graph.js'

/**
 * What a re-plan run returns (M40 §1, "re-planning is a delta, never a rebuild").
 *
 * The three arrays are about DIFFERENT things and none of them has to cover the board: `add` is new
 * work the changed goal now needs, `cancel` names existing tasks the changed goal no longer needs,
 * `keep` names the ones it still does. A task the model does not mention is KEPT -- silence is not
 * a cancellation, because a model that forgot to list a task must not be able to delete it.
 */
export interface PlanDelta {
  readonly add: readonly PlanTask[]
  readonly cancel: readonly string[]
  readonly keep: readonly string[]
}

/** The `add` entries are exactly `parsePlanGraph`'s own task shape -- reused from
 *  {@link planGraphSchema} rather than re-spelt, so a field added to one is added to both. */
const planTaskSchema = planGraphSchema.shape.tasks.element

/**
 * The shape a candidate object must have before {@link validateDelta} looks at its content.
 *
 * All three keys are REQUIRED even though every one of them may be empty. The parser scans a whole
 * message last-object-to-first, so the schema is also what tells the delta apart from the other
 * objects a model puts in its prose (a single `PlanTask`, a first-plan `{"tasks":[...]}`); an
 * object that only sometimes has to carry `keep` would match far more of them.
 *
 * `add` is capped at 20 for the same reason `planGraphSchema` caps `tasks`: a re-plan that wants
 * twenty-one new tasks is not a delta.
 */
const planDeltaSchema = z.object({
  add: z.array(planTaskSchema).max(20),
  cancel: z.array(z.string().min(1)),
  keep: z.array(z.string().min(1)),
})

/**
 * Recover a re-plan's delta from a planning run's accumulated output text (M40 §3).
 *
 * Same convention as `parsePlanGraph`: the LAST parseable object that satisfies the shape IS the
 * answer, and a structural violation in it rejects the whole parse rather than falling back to an
 * earlier candidate -- executing a draft the manager then revised would be worse than failing.
 *
 * `existingTaskIds` is the board the delta is read against, which is what makes this validator
 * different from `parsePlanGraph`'s: a new task's `dependsOn` may name either a plan-local key or
 * an EXISTING task id (spec §1), and `cancel`/`keep` may name only existing ids.
 */
export function parsePlanDelta(text: string, existingTaskIds: readonly string[]): Result<PlanDelta, string> {
  for (const candidate of jsonObjectsLastToFirst(text)) {
    const parsed = planDeltaSchema.safeParse(candidate)
    if (parsed.success) return validateDelta(parsed.data, existingTaskIds)
  }
  return err('no JSON object with { "add": [...], "cancel": [...], "keep": [...] } found in the re-plan output')
}

/**
 * Everything about a delta that a zod shape cannot say (spec erratum E1).
 *
 * `graph.ts`'s `validateStructure` is module-private and could not be reused even if it were not:
 * it requires every `dependsOn` entry to be a plan-local key, which is precisely the rule a delta
 * relaxes. The cycle check is the one piece that IS shared -- {@link findCycle}, exported for this
 * -- and it is fed the PLAN-LOCAL projection of each `dependsOn`, because it counts in-degrees as
 * `dependsOn.length` and an entry pointing at an existing task id would never be decremented and
 * would read as a cycle that is not there.
 */
function validateDelta(delta: PlanDelta, existingTaskIds: readonly string[]): Result<PlanDelta, string> {
  const existing = new Set(existingTaskIds)

  const keys = new Set<string>()
  for (const task of delta.add) {
    if (keys.has(task.key)) return err(`duplicate task key: "${task.key}"`)
    // A key that is already a task id would make `dependsOn: ["task-2"]` ambiguous between the new
    // task and the old one, and would make the created row impossible to tell from the board row
    // it shadows.
    if (existing.has(task.key)) return err(`task key "${task.key}" is already a task on the board`)
    keys.add(task.key)
  }

  for (const task of delta.add) {
    if (task.dependsOn.includes(task.key)) return err(`task "${task.key}" cannot depend on itself`)
    for (const dep of task.dependsOn) {
      if (!keys.has(dep) && !existing.has(dep)) {
        return err(`task "${task.key}" depends on unknown key "${dep}"`)
      }
    }
  }

  const planLocal = delta.add.map((task) => ({ ...task, dependsOn: task.dependsOn.filter((dep) => keys.has(dep)) }))
  const cycle = findCycle(planLocal)
  if (cycle !== null) return err(`the added tasks have a dependency cycle through: ${cycle.join(', ')}`)

  for (const taskId of delta.cancel) {
    if (!existing.has(taskId)) return err(`cancel names a task that is not on the board: "${taskId}"`)
  }
  for (const taskId of delta.keep) {
    if (!existing.has(taskId)) return err(`keep names a task that is not on the board: "${taskId}"`)
  }

  const cancelled = new Set(delta.cancel)
  for (const taskId of delta.keep) {
    if (cancelled.has(taskId)) return err(`task "${taskId}" is both cancelled and kept`)
  }

  return ok(delta)
}

/**
 * The re-plan run's trailer, the sibling of `PLANNING_GRAPH_INSTRUCTIONS` in
 * `../run-context/render.ts` -- appended by `renderRunContext` when a `replan` section is present
 * (spec erratum E2), which is the only thing that tells a re-plan run from a first-plan run.
 *
 * Three literals are load-bearing beyond the text's own readability, and the tests pin all three:
 * - `"replan"` (with its quotes, exactly as `PLANNING_GRAPH_INSTRUCTIONS` carries `"task graph"`)
 *   is what the fake CLI's re-plan arm selects on, and it is checked BEFORE the `"task graph"` arm.
 * - `"task graph"` must NOT appear, or the fake would answer a re-plan with a first plan.
 * - `verdict` must NOT appear, or it would be answered with a review verdict.
 * `candidateIndex` and `sources` are absent for the same reason against M38/M39's decision arms.
 *
 * Kept in `delta.ts` rather than beside its sibling because it is the prompt half of THIS module's
 * contract: the JSON example it prints is the shape {@link parsePlanDelta} accepts, and a test
 * feeds that very line back through the parser so the two can never drift.
 */
export const REPLAN_INSTRUCTIONS = [
  'You are the engineering manager and this is a "replan": the GOAL above changed while your team already had a board.',
  'Read the repository for context, but do NOT modify, create, or commit any file.',
  '',
  'Your final message must contain exactly one JSON object and nothing else on its line:',
  '{"add":[{"key":"short-unique-key","title":"...","description":"...","role":"backend","dependsOn":["other-key-or-existing-task-id"]}],"cancel":["<task id to cancel>"],"keep":["<task id to keep>"]}',
  'All three arrays may be empty. At most 20 additions. Keys are plan-local, must not repeat, and must not be an id already on the board.',
  'dependsOn may name another new key or an existing task id, and must not form a cycle.',
  'Put a task id in "cancel" only when the new GOAL no longer needs that work, and in "keep" when it still does. A task you do not mention is kept, and a task must not be in both.',
  'You never cancel work that is running or done: a cancellation of anything but a backlog, ready or blocked task is dropped, and every cancellation you ask for is a proposal a human approves.',
].join('\n')

/** One task on the board a re-plan is read against -- the facts {@link applyCancelPolicy} and the
 *  `replan` run-context section need, and nothing else. */
export interface BoardTask {
  readonly id: string
  readonly title: string
  readonly status: TaskStatus
  /** The goal version the plan that created it derived from; null for a hand-made task. */
  readonly goalVersion: number | null
}

/** The statuses a re-plan may cancel (M40 §1): work that has not started. Anything else -- a run
 *  in flight, a review in progress, a merge, a finished or already-terminal task -- is the
 *  model's request DROPPED, because a wrong deletion costs real work (ruling R1). */
const CANCELLABLE_STATUSES: readonly TaskStatus[] = ['backlog', 'ready', 'blocked']

export interface CancelPolicyOutcome {
  readonly cancellable: readonly string[]
  readonly dropped: readonly { readonly taskId: string; readonly status: TaskStatus }[]
}

/**
 * Split a delta's requested cancellations into the ones a proposal may be recorded for and the
 * ones that are refused by status (M40 §1).
 *
 * Both halves are in the order the model asked in, because both are reported to a human -- the
 * dropped ones through `workspace.replanned.droppedCancellations`, which is what stops a refused
 * cancellation being silently forgotten.
 *
 * An id that is not on the board at all is ignored rather than dropped: {@link parsePlanDelta}
 * already refuses such a delta, so this can only be reached with a board read after the parse, and
 * there is no status to record for a task that is not there.
 */
export function applyCancelPolicy(delta: PlanDelta, board: readonly BoardTask[]): CancelPolicyOutcome {
  const byId = new Map(board.map((task) => [task.id, task]))
  const cancellable: string[] = []
  const dropped: { taskId: string; status: TaskStatus }[] = []

  for (const taskId of delta.cancel) {
    const task = byId.get(taskId)
    if (task === undefined) continue
    if (CANCELLABLE_STATUSES.includes(task.status)) cancellable.push(taskId)
    else dropped.push({ taskId, status: task.status })
  }

  return { cancellable, dropped }
}
