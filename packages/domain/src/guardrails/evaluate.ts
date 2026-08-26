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
  readonly guardrail: string
  readonly detail: string
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
      haltsScheduling: true,
    })
  }

  if (stats.globalActiveRuns >= limits.maxGlobalConcurrentRuns) {
    breaches.push({
      guardrail: 'global_concurrency',
      detail: `${stats.globalActiveRuns} active runs across all workspaces at the global limit ${limits.maxGlobalConcurrentRuns}.`,
      haltsScheduling: true,
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
  // carried to the SURFACES (`world.ts`'s `sumSpend`, the budget bar) where it informs an
  // operator, not to the guardrail, where it would only halt work that is going fine.
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
