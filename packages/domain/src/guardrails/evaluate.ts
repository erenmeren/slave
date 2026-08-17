export interface GuardrailLimits {
  readonly maxConcurrentRuns: number
  readonly budgetUsd: number
  readonly runTimeoutMs: number
  readonly maxToolCallsPerRun: number
  readonly maxAttempts: number
  readonly consecutiveFailureLimit: number
}

export interface WorkspaceStats {
  readonly activeRuns: number
  readonly spentUsd: number
  readonly consecutiveFailures: number
  readonly emergencyStopped: boolean
}

export interface GuardrailBreach {
  readonly guardrail: string
  readonly detail: string
  readonly haltsScheduling: boolean
}

/** Spec §9.2 seeded defaults. */
export const DEFAULT_GUARDRAIL_LIMITS: GuardrailLimits = {
  maxConcurrentRuns: 3,
  budgetUsd: 20,
  runTimeoutMs: 30 * 60 * 1000,
  maxToolCallsPerRun: 200,
  maxAttempts: 3,
  consecutiveFailureLimit: 3,
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

  if (stats.spentUsd >= limits.budgetUsd) {
    breaches.push({
      guardrail: 'budget_exhausted',
      detail: `Spent $${stats.spentUsd} of $${limits.budgetUsd}.`,
      haltsScheduling: true,
    })
  } else if (stats.spentUsd >= limits.budgetUsd * BUDGET_WARNING_RATIO) {
    breaches.push({
      guardrail: 'budget_warning',
      detail: `Spent $${stats.spentUsd} of $${limits.budgetUsd}.`,
      haltsScheduling: false,
    })
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
