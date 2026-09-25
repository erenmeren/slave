import type { GuardrailKind } from './kinds.js'

export interface GuardrailLimits {
  readonly maxConcurrentRuns: number
  /**
   * The spend ceiling, or `null` for a workspace that is not budgeted at all (M12 Task 9).
   *
   * `null` is not "a budget of zero" and not "unlimited-by-default": it is the deliberate state
   * an operator puts a workspace into when they accept that spend will not be measured -- spec §6
   * makes it the only state in which a runtime that cannot report cost may run. The guardrail is
   * real or it is absent; there is no silently inert middle. `Workspace.budgetUsd` keeps its
   * `@default(20)`, so reaching this state takes a deliberate act.
   */
  readonly budgetUsd: number | null
  readonly runTimeoutMs: number
  readonly maxToolCallsPerRun: number
  readonly maxAttempts: number
  readonly consecutiveFailureLimit: number
  readonly maxGlobalConcurrentRuns: number
}

export interface WorkspaceStats {
  readonly activeRuns: number
  readonly globalActiveRuns: number
  readonly spentUsd: number
  readonly consecutiveFailures: number
  readonly emergencyStopped: boolean
}

export interface GuardrailBreach {
  /**
   * M51 R4: the closed union, not a bare string. Every producer of a breach or of a
   * `guardrail.tripped` payload now imports a member of {@link GUARDRAIL_KINDS}, so a seventeenth
   * spelling is a build error here rather than a value nobody can filter for or label. The stored
   * payload's own schema stays `z.string()` -- see `kinds.ts` for why.
   */
  readonly guardrail: GuardrailKind
  readonly detail: string
  /**
   * Whether this breach STOPS the project: `decide()` returns `halt` on the first one, the tick
   * announces it with `guardrail.tripped`, and the Supervisor raises `workspace_halted` about it.
   *
   * H9c: `concurrency` and `global_concurrency` are breaches that do NOT halt. A project at its run
   * cap is busy, not stuck -- the next run to conclude frees the slot and nothing anybody decides
   * would free it sooner -- so `decide()` reads them as "no room this tick" (`wait`), and they
   * never reach a person as a halt. They are still REPORTED here, because a reader asking "is
   * anything at a limit" (the budget warning, the resume rule) wants the whole list.
   */
  readonly haltsScheduling: boolean
}

/**
 * Spec §9.2 seeded defaults. `budgetUsd` stays `20` after M12 Task 9 widened the field to accept
 * `null`: nullability is an operator's deliberate opt-out, never the default posture.
 */
export const DEFAULT_GUARDRAIL_LIMITS: GuardrailLimits = {
  maxConcurrentRuns: 3,
  budgetUsd: 20,
  runTimeoutMs: 30 * 60 * 1000,
  maxToolCallsPerRun: 200,
  maxAttempts: 3,
  consecutiveFailureLimit: 3,
  maxGlobalConcurrentRuns: 6,
}

const BUDGET_WARNING_RATIO = 0.8

export function evaluateGuardrails(
  limits: GuardrailLimits,
  stats: WorkspaceStats,
): readonly GuardrailBreach[] {
  const breaches: GuardrailBreach[] = []

  if (stats.emergencyStopped) {
    breaches.push({
      guardrail: 'emergency_stop',
      detail: 'Emergency stop is engaged for this workspace.',
      haltsScheduling: true,
    })
  }

  if (stats.activeRuns >= limits.maxConcurrentRuns) {
    breaches.push({
      guardrail: 'concurrency',
      detail: `${stats.activeRuns} active runs at limit ${limits.maxConcurrentRuns}.`,
      // H9c: no room, not a halt -- see `haltsScheduling`.
      haltsScheduling: false,
    })
  }

  if (stats.globalActiveRuns >= limits.maxGlobalConcurrentRuns) {
    breaches.push({
      guardrail: 'global_concurrency',
      detail: `${stats.globalActiveRuns} active runs across all workspaces at the global limit ${limits.maxGlobalConcurrentRuns}.`,
      haltsScheduling: false,
    })
  }

  // The null branch is a real guard, not a defensive one, and it is deliberately written as an
  // explicit `!== null` rather than left to the comparisons below: JavaScript coerces `null` to
  // `0` in a relational comparison, so `stats.spentUsd >= null` is TRUE for any positive spend --
  // an unbudgeted workspace would halt on `budget_exhausted` at its first cent, reporting
  // "Spent $3 of $null".
  //
  // No "unmeasured runs" breach is emitted alongside these, deliberately (M12 Task 9 / ruling
  // R8): admission already refuses a cost-blind runtime into a budgeted workspace at both write
  // time and dispatch, so a budgeted workspace can only host cost-reporting runtimes; and every
  // LIVE run carries a null cost until it concludes, so a breach keyed on unmeasured runs would
  // fire on every healthy tick of every healthy workspace. The count of unmeasured runs is
  // carried to the SURFACES (`overview.ts` and `org.ts` call `sumSpend`; the budget bar shows
  // the count) where it informs an operator, not to the guardrail, where it would only halt
  // work that is going fine. `world.ts` -- this function's own caller -- deliberately does NOT
  // call `sumSpend`: with no consumer for `unknownRuns` here, the split would be computed and
  // discarded, so it stays on a Prisma `_sum` (M12 Task 9 fix round F3).
  const budgetUsd = limits.budgetUsd
  if (budgetUsd !== null) {
    if (stats.spentUsd >= budgetUsd) {
      breaches.push({
        guardrail: 'budget_exhausted',
        detail: `Spent $${stats.spentUsd} of $${budgetUsd}.`,
        haltsScheduling: true,
      })
    } else if (stats.spentUsd >= budgetUsd * BUDGET_WARNING_RATIO) {
      breaches.push({
        guardrail: 'budget_warning',
        detail: `Spent $${stats.spentUsd} of $${budgetUsd}.`,
        haltsScheduling: false,
      })
    }
  }

  if (stats.consecutiveFailures >= limits.consecutiveFailureLimit) {
    breaches.push({
      guardrail: 'circuit_breaker',
      detail: `${stats.consecutiveFailures} consecutive failed runs.`,
      haltsScheduling: true,
    })
  }

  return breaches
}

/**
 * The halts under which even a RESUME is refused (H8).
 *
 * A resume continues a run that is already counted and starts nothing, so a halt that exists to
 * stop NEW work -- `circuit_breaker` -- must not stand in its way, and neither may a full
 * workspace. They used to: on 2026-09-21 three runs parked by the breaker held every slot of their
 * workspace, `decide()` halted on `concurrency`, the tick's halt branch returned before its resume
 * pass, and the person's own resume request sat for four hours behind a halt the parked runs
 * themselves caused. (Since H9c a full workspace is not a halt at all -- `haltsScheduling` -- so
 * that tick now runs its ordinary resume pass.) The two here are different in kind: an emergency stop is a person saying
 * nothing may move, and an empty purse cannot pay for the continuation either.
 *
 * ONE set, read by both sides: the tick decides whether its halt branch resumes by it, and
 * `requestResume` (`packages/control`) refuses by it, so a CLI or web resume into an empty purse
 * is refused where the person can read why rather than recorded and carried out by whichever
 * tick next finds the budget raised.
 */
export const HALTS_THAT_REFUSE_A_RESUME: ReadonlySet<GuardrailKind> = new Set<GuardrailKind>([
  'emergency_stop',
  'budget_exhausted',
])

/**
 * The first breach that refuses a resume, or `null` -- decided from the WHOLE list (H8 fix round
 * 1, I1).
 *
 * `decide()` reports only the first halting breach, and a caller judging by that name alone would
 * miss a refusing breach listed behind it (before H9c, a full workspace over budget halted as
 * `concurrency` and resumed a run into an empty purse). So the question is asked of every breach,
 * not of the halt's name.
 */
export function breachRefusingResume(breaches: readonly GuardrailBreach[]): GuardrailBreach | null {
  return breaches.find((breach) => HALTS_THAT_REFUSE_A_RESUME.has(breach.guardrail)) ?? null
}
