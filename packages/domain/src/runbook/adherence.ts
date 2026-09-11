import { TERMINAL, type TaskStatus } from '../task/state.js'
import { stageOrder, type RunbookStage } from './spec.js'

/** A board task, flattened to what adherence actually reads. Structurally typed, so both the
 *  orchestrator's plan rows and the web's DTO can be passed without a conversion. */
export interface AdherenceTask {
  readonly id: string
  readonly stage: string | null
  readonly status: TaskStatus
}

/** How well a board follows its runbook (R2, R6). SOFT throughout: a plan that skips a stage is
 *  never refused -- the gap is simply visible. */
export interface Adherence {
  /** Stage keys with at least one task, in {@link stageOrder}. */
  readonly stagesCovered: readonly string[]
  /** Stage keys with none, in {@link stageOrder} -- the measurement this milestone exists to make. */
  readonly stagesMissing: readonly string[]
  /** `Task.stage` values the runbook has no key for, sorted. A task stamped with a stage from a
   *  runbook that has since been replaced is a fact, not a crash. */
  readonly unknownStages: readonly string[]
  /** Where the work IS (R6): the first stage in order with any non-terminal task. */
  readonly currentStage: string | null
}

/**
 * Measure a board against a runbook.
 *
 * The current stage has three cases and only two of them are obvious. With unfinished work, it is
 * the first stage in order that holds some -- that is where the team is. With every staged task
 * terminal, it is the LAST stage: the work is finished, and pointing at the first stage would say
 * the project had not started. With NOTHING THIS RUNBOOK CAN SEE (plan erratum E7) it is the FIRST
 * stage: "every task is terminal" is vacuously true over zero tasks, and a runbook adopted before
 * the first plan has not reached its release stage.
 *
 * That last case counts STAGED tasks, not tasks (fix to the plan's own wording, which said
 * `tasks.length === 0` and so contradicted the case below it): a board holding nothing but
 * hand-made tasks -- none of which carries a stage, none of which is evidence about a runbook --
 * is exactly as unstarted against this runbook as an empty one, and reporting its release stage
 * would claim a process nobody has begun is finished.
 */
export function measureAdherence(
  stages: readonly RunbookStage[],
  tasks: readonly AdherenceTask[],
): Adherence {
  const ordered = stageOrder(stages)
  const known = new Set(ordered.map((stage) => stage.key))
  const byStage = new Map<string, AdherenceTask[]>()
  const unknown = new Set<string>()
  for (const task of tasks) {
    if (task.stage === null) continue
    if (!known.has(task.stage)) {
      unknown.add(task.stage)
      continue
    }
    const bucket = byStage.get(task.stage)
    if (bucket === undefined) byStage.set(task.stage, [task])
    else bucket.push(task)
  }

  const stagesCovered = ordered.filter((stage) => byStage.has(stage.key)).map((stage) => stage.key)
  const stagesMissing = ordered.filter((stage) => !byStage.has(stage.key)).map((stage) => stage.key)
  const live = (task: AdherenceTask): boolean => !TERMINAL.includes(task.status)
  const active = ordered.find((stage) => (byStage.get(stage.key) ?? []).some(live))
  const staged = [...byStage.values()].reduce((count, bucket) => count + bucket.length, 0)

  const currentStage =
    ordered.length === 0
      ? null
      : (active?.key ?? (staged === 0 ? (ordered[0]?.key ?? null) : (ordered[ordered.length - 1]?.key ?? null)))

  return {
    stagesCovered,
    stagesMissing,
    unknownStages: [...unknown].toSorted((a, b) => a.localeCompare(b)),
    currentStage,
  }
}
