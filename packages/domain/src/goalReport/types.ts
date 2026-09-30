/**
 * Conductor Plan 5 (spec R10): one goal version's report as plain data. It holds what was asked,
 * what was verified and how, who did which part, what it cost, and every recorded decision on the
 * way. `loadGoalReport` (`packages/control`) builds it from recorded rows only, and no model
 * re-derives any of it (plan D1). The web page, the Markdown export and the chat note render it.
 * Every timestamp is an ISO string (UTC), so the value crosses a route unchanged.
 */
/** `conducted_without_delivery` (final wave I1): a version conducted under Plans 2/3 -- a `conduct`
 *  decision and packages, but no `GoalDelivery` -- whose packages merge straight into the base
 *  branch. Plan 4a's conductor writes the delivery in the packages' own transaction, so a version
 *  conducted since then is never in this state. */
export const GOAL_REPORT_STATES = [
  'not_conducted',
  'conducted_without_delivery',
  'integrating',
  'verifying',
  'accepted',
  'merged',
  'needs_human',
  'abandoned',
] as const
export type GoalReportState = (typeof GOAL_REPORT_STATES)[number]

export type GoalReportVerdictStatus = 'pass' | 'fail' | 'unverifiable'

/** One requirement's verdict in one round: the check the verifier wrote and ran, its trimmed
 *  output and its reason, exactly as `VerificationResult` stores them. */
export interface GoalReportVerdict {
  readonly round: number
  readonly runId: string
  readonly status: GoalReportVerdictStatus
  readonly check: string
  readonly output: string
  readonly reason: string
}

export interface GoalReportRequirement {
  readonly key: string
  readonly text: string
  /** The goal sentence the requirement came from (spec R1). The person checks the extraction
   *  against it. */
  readonly source: string
  /** The package whose `requirementKeys` holds it; null before conduct. */
  readonly packageKey: string | null
  /** The latest round's verdict (plan D4); null before any round. */
  readonly verdict: GoalReportVerdict | null
  /** Its status in every round, oldest first. */
  readonly history: readonly { readonly round: number; readonly status: GoalReportVerdictStatus }[]
}

export interface GoalReportRound {
  readonly round: number
  /** The verification run whose verdict counts for this round (plan D4). */
  readonly runId: string
  /** The verifier seat's person, or null if the seat is gone. */
  readonly verifier: string | null
  /** The integration commit the round checked (`SlaveRun.verificationTip`). */
  readonly commit: string | null
  readonly at: string
  readonly pass: number
  readonly fail: number
  readonly unverifiable: number
}

/** A package worker's latest `<slave-report>` (spec R7), cut down to what a reader needs. */
export interface GoalReportWorkerReport {
  readonly runId: string
  readonly requirements: readonly { readonly key: string; readonly status: 'done' | 'partial' | 'not_done'; readonly evidence: string }[]
  readonly workflowDone: number
  readonly workflowTotal: number
}

export interface GoalReportPackage {
  readonly key: string
  readonly title: string
  readonly isIntegration: boolean
  readonly requirementKeys: readonly string[]
  readonly ownedPaths: readonly string[]
  readonly dependsOn: readonly string[]
  /** The persona (catalogue template) the conductor named for it, or null if it was deleted. */
  readonly persona: string | null
  /** The person on the seat its task is pinned to now (plan D6), or null. */
  readonly seat: string | null
  readonly taskId: string | null
  readonly taskStatus: string | null
  /** `Task.integratedAt` is set: on the version's integration branch, or, for a version with no
   *  delivery (`conducted_without_delivery`), on the base branch. */
  readonly integrated: boolean
  /** Git's list at each merge into the integration branch, united and sorted (plan D3). Null when
   *  no merge recorded one. */
  readonly mergedFiles: readonly string[] | null
  /** A merge touched more files than `GOAL_REPORT_FILES_MAX`, so the list is a lower bound. */
  readonly mergedFilesTruncated: boolean
  /** The latest report's `filesTouched`: the worker's own claim. Null when no report was filed. */
  readonly reportedFiles: readonly string[] | null
  readonly report: GoalReportWorkerReport | null
  readonly implementationRuns: number
}

export interface GoalReportDelivery {
  readonly integrationBranch: string
  readonly baseBranch: string
  readonly baseCommit: string
  readonly verifiedCommit: string | null
  readonly round: number
  readonly roundBase: number
  /** `Workspace.verificationRoundCap`: rounds allowed from `roundBase`. */
  readonly roundCap: number
  readonly acceptedAt: string | null
  readonly mergedAt: string | null
  /** From `workspace.goal_merged`: who landed it, the base branch's commit, and where. */
  readonly merge: { readonly by: 'system' | 'human'; readonly commit: string; readonly into: string } | null
  readonly mergeError: string | null
  readonly needsHumanReason: string | null
  /** From `workspace.goal_abandoned`. */
  readonly abandonedAt: string | null
}

/** The conductor's size decision (spec R2): the recorded `conduct` decision. */
export interface GoalReportDecision {
  readonly mode: 'single' | 'partitioned'
  /** The conductor's reason: the model's words, or the rules' when `fallback`. */
  readonly reason: string
  readonly decidedBy: 'model' | 'rules'
  readonly fallback: boolean
  readonly at: string
}

export interface GoalReportQuestion {
  /** The question's `SlaveMessage` id. */
  readonly id: string
  readonly at: string
  readonly packageKey: string | null
  readonly askedBy: string | null
  readonly question: string
  readonly answer: { readonly at: string; readonly by: 'person' | 'supervisor' | 'slave'; readonly text: string } | null
}

/** Plan D5. `versionUsd` = `runsMeasuredUsd + conductorMeasuredUsd + conductorUnmeasuredCalls *
 *  CONDUCT_PER_CALL_CAP_USD + supervisorMeasuredUsd + supervisorUnmeasuredCalls *
 *  SUPERVISOR_PER_CALL_CAP_USD`. Unmeasured and live runs are counted, never summed. */
export interface GoalReportSpend {
  readonly runsMeasuredUsd: number
  readonly runsUnmeasured: number
  readonly runsLive: number
  readonly conductorMeasuredUsd: number
  readonly conductorUnmeasuredCalls: number
  readonly supervisorMeasuredUsd: number
  readonly supervisorUnmeasuredCalls: number
  readonly versionUsd: number
  /** `workspaceSpend(...).spentUsd`: the budget guardrail's own figure. */
  readonly projectSpentUsd: number
  readonly projectBudgetUsd: number | null
}

/** Who wrote a trail entry's quoted `detail` (plan D6). */
export type GoalReportAuthor = 'system' | 'model' | 'person'

export interface GoalReportTrailEntry {
  readonly at: string
  /** A sentence Slave composed from ids, keys and counts. Package keys and titles in it came from
   *  the conductor's answer, so renderers escape it like any other text. */
  readonly text: string
  /** A rationale, a rework reason, a stop reason: quoted, bounded by `GOAL_REPORT_DETAIL_MAX_CHARS`. */
  readonly detail: string | null
  readonly detailBy: GoalReportAuthor | null
  readonly packageKey: string | null
}

/** Skeleton-and-smoke spec S7 (plan B D10): one smoke attempt of the version, as `SmokeAttempt`
 *  stores it. */
export interface GoalReportSmoke {
  readonly attemptId: string
  readonly round: number
  readonly outcome: 'running' | 'passed' | 'missing' | 'stub' | 'failed' | 'timed_out' | 'error'
  readonly exitCode: number | null
  readonly durationMs: number | null
  /** The integration commit it checked. */
  readonly tip: string
  /** Trimmed at `SMOKE_OUTPUT_MAX_CHARS` when it was recorded. */
  readonly output: string
  /** `endedAt`, or `startedAt` while it runs. */
  readonly at: string
  /** The package its failure sent back, or null. */
  readonly reworkedPackage: string | null
  /** Plan B D11 (user ruling 2026-09-30): the package the fix was handed on to, the file and the
   *  change asked for; null when there was no hand-off. `change` is the worker's own words, raw:
   *  renderers escape it like any other text. */
  readonly handOff: { readonly toPackage: string; readonly path: string; readonly change: string } | null
  /** The version was abandoned while this attempt ran, and it sent nothing back: its outcome (a
   *  SIGTERM reads `failed`, exit 143) is the abandon's doing, not the product's (plan B Task 4). */
  readonly stoppedByAbandon: boolean
}

/** Supervisor-as-conductor spec C2 (plan A Task 8): one request a package made of another, or the
 *  conductor made of a package, as `PackageHandOff` stores it. */
export interface GoalReportHandOff {
  readonly id: string
  readonly at: string
  readonly source: 'report' | 'answer'
  readonly fromPackage: string | null
  readonly toPackage: string | null
  readonly path: string | null
  readonly packageKey: string | null
  /** The worker's (or the conductor's) own words, raw: renderers escape them. */
  readonly change: string
  readonly status: 'pending' | 'delivered' | 'reopened' | 'duplicate' | 'own' | 'to_conductor' | 'expired'
  /** Why it was routed so, when Slave recorded a reason. */
  readonly note: string | null
}

/** Supervisor-as-conductor spec C3: one decision every package's contract listed. The words are
 *  the conductor's or a person's, raw: renderers escape them. */
export interface GoalReportSharedDecision {
  readonly title: string
  readonly decision: string
  readonly source: 'conductor_plan' | 'conductor_answer' | 'person'
  readonly at: string
}

/** Skeleton spec S9 (plan B D10): one tool call the version's runs were refused. */
export interface GoalReportDenial {
  readonly at: string
  readonly runId: string
  /** The package whose task the run worked, or null for a verification run. */
  readonly packageKey: string | null
  readonly kind: 'permission_mode' | 'permission_matrix'
  readonly detail: string
}

export interface GoalReport {
  readonly workspaceId: string
  readonly workspaceName: string
  /** `Workspace.baseBranch`: what the report names when there is no delivery to name it. */
  readonly baseBranch: string
  readonly goalVersion: number
  /** Every version of the workspace that has a report, ascending (the page's version links). */
  readonly versions: readonly number[]
  /** `GoalVersion.text`, or null for a row seeded without one. */
  readonly goal: string | null
  readonly state: GoalReportState
  readonly delivery: GoalReportDelivery | null
  readonly decision: GoalReportDecision | null
  /** Null until the requirements step has run (spec R1). */
  readonly requirements: readonly GoalReportRequirement[] | null
  readonly rounds: readonly GoalReportRound[]
  readonly packages: readonly GoalReportPackage[]
  readonly verifier: string | null
  readonly questions: readonly GoalReportQuestion[]
  /** Every smoke attempt of the version, oldest first. */
  readonly smoke: readonly GoalReportSmoke[]
  /** The oldest `GOAL_REPORT_HANDOFFS_MAX` hand-offs of the version, oldest first (expired ones too: they have no event). */
  readonly handOffs: readonly GoalReportHandOff[]
  /** Hand-offs past `GOAL_REPORT_HANDOFFS_MAX`, left out. */
  readonly handOffsOmitted: number
  /** The version's shared decisions, oldest first. */
  readonly decisions: readonly GoalReportSharedDecision[]
  /** The oldest `GOAL_REPORT_DENIALS_MAX` denials of the version's runs, oldest first. */
  readonly deniedToolCalls: readonly GoalReportDenial[]
  /** Denials past `GOAL_REPORT_DENIALS_MAX`, left out. */
  readonly deniedToolCallsOmitted: number
  readonly spend: GoalReportSpend
  readonly trail: readonly GoalReportTrailEntry[]
  /** Trail entries older than the newest `GOAL_REPORT_TRAIL_MAX`, left out. */
  readonly trailOmitted: number
  /** The newest timestamp among the facts (plan D7: no clock is read), or null when there is none. */
  readonly asOf: string | null
}
