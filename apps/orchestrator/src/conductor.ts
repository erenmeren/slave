import { isUniqueConstraintViolation, type ModelDecider } from '@slave-of-ai/control'
import { type Prisma, prisma } from '@slave-of-ai/db/client'
import {
  CONDUCT_PER_CALL_CAP_USD,
  CONDUCT_RETRY_CAP,
  assignRequirementKeys,
  buildRequirementsPrompt,
  parseRequirementsAnswer,
  requirementItemsSchema,
  type GuardrailKind,
  type Result,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { modelSeam } from './supervisor.js'
import type { TickDeps } from './tick.js'

export type ConductStep =
  | 'none'
  | 'waiting'
  | 'requirements_set'
  | 'requirements_failed'
  | 'conducted'
  | 'conduct_failed'
  | 'halted'

/** The model a conductor call is made with: the decider and model the Supervisor pass would use. */
interface ConductorCallTarget {
  readonly decider: ModelDecider
  readonly model: string
}

/**
 * The conductor's turn in the tick (Conductor Plan 2), for `conducted` workspaces only. ONE model
 * call per tick at most (plan decision D4): the requirement extraction first, the size decision
 * on a later tick. A daemon tick that spends two minutes on each of two calls starves every other
 * workspace; one call bounds it like one Supervisor pass does.
 */
export async function conduct(deps: TickDeps): Promise<ConductStep> {
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: deps.workspaceId },
    select: { delivery: true, goal: true, goalVersion: true, haltedReason: true },
  })
  if (workspace.delivery !== 'conducted' || workspace.goal === null || workspace.goalVersion === 0) return 'none'
  // A halted workspace spends nothing: the halt is a person's to clear, and this step's own halt
  // (the retry cap below) is exactly one of the things that sets it.
  if (workspace.haltedReason !== null) return 'none'
  const version = workspace.goalVersion
  // Packages exist: this version is conducted, and its tasks are the ordinary scheduler's now.
  if ((await prisma.workPackage.count({ where: { workspaceId: deps.workspaceId, goalVersion: version } })) > 0) return 'none'
  const call = resolveConductorCall(deps)
  if (call === null) return 'none'
  if (await boardIsBusy(deps.workspaceId, version)) return 'waiting'

  const set = await prisma.requirementSet.findUnique({
    where: { workspaceId_goalVersion: { workspaceId: deps.workspaceId, goalVersion: version } },
    select: { id: true },
  })
  if (set === null) return extractRequirements(deps.workspaceId, call, workspace.goal, version)
  return 'none' // Task 6 replaces this line with the size decision
}

/**
 * The seam the Supervisor pass would use (`modelSeam`, shared with `supervise()`), or `null` when
 * the daemon wired none -- then there is nobody to ask and the step reports `'none'`. The budget
 * and halt gates the Supervisor adds are not repeated here: a budget-exhausted tick halts before
 * this step runs, and `conduct` returns on a halt before it resolves anything.
 */
function resolveConductorCall(deps: TickDeps): ConductorCallTarget | null {
  return modelSeam(deps.supervisorDecider, deps.supervisorModel)
}

/**
 * Plan decision D5: a new goal version is conducted only once the board is quiet. A task is LIVE
 * unless it is finished (`failed`, `cancelled`, or `done` AND integrated) or it already belongs to
 * this version's own packages. Conducting v2 over v1's running work would hand two plans the same
 * files.
 */
async function boardIsBusy(workspaceId: string, version: number): Promise<boolean> {
  const live = await prisma.task.count({
    where: {
      workspaceId,
      NOT: [
        { status: { in: ['failed', 'cancelled'] } },
        { status: 'done', integratedAt: { not: null } },
        { workPackage: { goalVersion: version } },
      ],
    },
  })
  return live > 0
}

/**
 * One conductor model call and its ledger row. Exactly ONE `ConductorCall` row per call, whatever
 * happened -- a failed call, an isolation breach and an answer that would not parse are all paid
 * for, and `workspaceSpend` bills from these rows (plan decision D6). `plan` is stored only on a
 * usable answer and only when the caller says what of it to keep (the size decision's plan).
 *
 * A decider that THROWS is a call that was made and whose cost never came back: it is logged as a
 * failed, unmeasured call rather than let through, or the retry cap would never see it and every
 * tick would pay for the same throw.
 */
async function callConductor<T>(
  call: ConductorCallTarget,
  workspaceId: string,
  goalVersion: number,
  stage: 'requirements' | 'conduct',
  prompt: string,
  parse: (text: string) => Result<T, string>,
  planOf?: (value: T) => unknown,
): Promise<{ readonly value: T } | { readonly failure: string }> {
  let costUsd: number | null = null
  let result: { readonly value: T } | { readonly failure: string }
  try {
    const outcome = await call.decider({ model: call.model, prompt, maxBudgetUsd: CONDUCT_PER_CALL_CAP_USD })
    costUsd = outcome.costUsd
    if (outcome.kind === 'failed') result = { failure: outcome.reason }
    else if (outcome.kind === 'isolation_breach') result = { failure: 'the model tried to use tools' }
    else {
      const parsed = parse(outcome.text)
      result = parsed.ok ? { value: parsed.value } : { failure: parsed.error }
    }
  } catch (error) {
    result = { failure: `the model call threw: ${error instanceof Error ? error.message : String(error)}` }
  }
  const plan = 'value' in result && planOf !== undefined ? planOf(result.value) : undefined
  await prisma.conductorCall.create({
    data: {
      workspaceId,
      goalVersion,
      stage,
      outcome: 'value' in result ? 'ok' : 'failed',
      reason: 'failure' in result ? result.failure : null,
      modelCostUsd: costUsd,
      unmeasured: costUsd === null,
      ...(plan === undefined ? {} : { plan: plan as Prisma.InputJsonValue }),
    },
  })
  return result
}

/**
 * Spec R1: the goal version's requirement set, keyed so a requirement that survives a goal edit
 * keeps its key. At `CONDUCT_RETRY_CAP` failed extractions for this version the workspace halts
 * rather than paying for a fourth -- a goal the model cannot read is a person's problem.
 */
async function extractRequirements(
  workspaceId: string,
  call: ConductorCallTarget,
  goal: string,
  version: number,
): Promise<ConductStep> {
  const failures = await prisma.conductorCall.findMany({
    where: { workspaceId, stage: 'requirements', outcome: 'failed', goalVersion: version },
    orderBy: { createdAt: 'desc' },
    select: { reason: true },
  })
  if (failures.length >= CONDUCT_RETRY_CAP) {
    await haltConductor(workspaceId, version, failures[0]?.reason ?? 'no reason recorded')
    return 'halted'
  }

  const answer = await callConductor(call, workspaceId, version, 'requirements', buildRequirementsPrompt(goal), parseRequirementsAnswer)
  if ('failure' in answer) return 'requirements_failed'

  // The newest earlier set is the one whose keys carry forward (R1): a requirement that is
  // textually unchanged keeps its key, and a new one never reuses a retired number.
  const previousRow = await prisma.requirementSet.findFirst({
    where: { workspaceId, goalVersion: { lt: version } },
    orderBy: { goalVersion: 'desc' },
    select: { items: true },
  })
  const previous = previousRow === null ? null : requirementItemsSchema.parse(previousRow.items)
  const items = assignRequirementKeys(answer.value, previous)

  let setId: string
  try {
    const created = await prisma.requirementSet.create({
      data: { workspaceId, goalVersion: version, items: items.map((item) => ({ ...item })) },
      select: { id: true },
    })
    setId = created.id
  } catch (error) {
    // Another tick raced this one to the same version and won: its set stands, and so does its
    // event. This call's own ledger row is already written -- it was paid for either way.
    if (isUniqueConstraintViolation(error)) return 'requirements_set'
    throw error
  }
  await appendEvent({
    type: 'workspace.requirements_set',
    workspaceId,
    actor: 'system',
    payload: { version, count: items.length, setId },
  })
  return 'requirements_set'
}

/** The `merge.ts` halt precedent: the first halt reason stands, and the trip is announced once. */
async function haltConductor(workspaceId: string, version: number, lastReason: string): Promise<void> {
  const detail = `the conductor could not extract requirements for goal v${version}: ${lastReason}`
  const halted = await prisma.workspace.updateMany({
    where: { id: workspaceId, haltedReason: null },
    data: { haltedReason: detail, haltedAt: new Date() },
  })
  if (halted.count === 0) return
  await appendEvent({
    type: 'guardrail.tripped',
    workspaceId,
    actor: 'system',
    payload: { guardrail: 'conductor_failed' satisfies GuardrailKind, detail },
  })
}
