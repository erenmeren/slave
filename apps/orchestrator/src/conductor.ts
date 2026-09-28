import { isUniqueConstraintViolation, staffPackages, type ModelDecider } from '@slave-of-ai/control'
import { Prisma, prisma } from '@slave-of-ai/db/client'
import {
  CONDUCT_PER_CALL_CAP_USD,
  CONDUCT_RETRY_CAP,
  PACKAGE_WORKER_ROLE,
  assignRequirementKeys,
  buildConductPrompt,
  buildRequirementsPrompt,
  candidateSchema,
  conductPlanSchema,
  integrationBranchName,
  parseConductAnswer,
  parseRequirementsAnswer,
  requirementItemsSchema,
  singlePlan,
  situationSchema,
  validateConduct,
  type ConductPlan,
  type GuardrailKind,
  type PackageSpec,
  type Result,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { loadConductCatalogue, loadRepositoryFacts } from './conductFacts.js'
import { ensureIntegrationBranch } from './goalBranch.js'
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
    select: {
      delivery: true,
      goal: true,
      goalVersion: true,
      haltedReason: true,
      haltClearedAt: true,
      repoPath: true,
      baseBranch: true,
      maxAttempts: true,
    },
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
  // Plan D6: an earlier goal version still on its way to the base branch, or a board left over from
  // planned delivery, holds this one. Said once (final review M5): a goal that is not being
  // conducted must say why, or a person watching the board sees nothing happen and no reason. Not
  // a halt: the wait ends by itself.
  const waitingOn = await earlierGoalOpen(deps.workspaceId, version)
  if (waitingOn !== undefined) {
    await goalWaiting(deps.workspaceId, version, waitingOn)
    return 'waiting'
  }

  const set = await prisma.requirementSet.findUnique({
    where: { workspaceId_goalVersion: { workspaceId: deps.workspaceId, goalVersion: version } },
    select: { items: true },
  })
  if (set === null) return extractRequirements(deps.workspaceId, call, workspace.goal, version, workspace.haltClearedAt)
  return decideAndMaterialise(deps.workspaceId, call, { ...workspace, goal: workspace.goal }, version, set.items)
}

/**
 * The failed calls the retry cap counts (final review I2): only those made since a person last
 * cleared a halt -- the circuit breaker's `haltClearedAt` precedent (`stats.ts`). Counting every
 * failure of the version, a cleared "could not extract requirements" halt re-halted on the very
 * next tick without a new call, so clearing it did nothing.
 */
function failuresSince(haltClearedAt: Date | null): { readonly createdAt?: { readonly gt: Date } } {
  return haltClearedAt === null ? {} : { createdAt: { gt: haltClearedAt } }
}

/** What the size decision reads off the workspace row `conduct` already fetched. */
interface ConductedWorkspace {
  readonly goal: string
  readonly haltClearedAt: Date | null
  readonly repoPath: string
  readonly baseBranch: string
  readonly maxAttempts: number
}

/** Thrown inside `materialise`'s transaction when another tick conducted this version first: a
 *  refusal inside a Prisma interactive transaction must THROW, or what was written commits. */
class AlreadyConducted extends Error {}

/**
 * Spec R2/R3/R5: the size decision of one goal version, then its staffing, then its packages as
 * pinned tasks. At most ONE model call (plan decision D4); at `CONDUCT_RETRY_CAP` unusable answers
 * the version goes `single` by default rather than halting -- a goal whose requirements were read
 * can always be delivered by one worker.
 */
async function decideAndMaterialise(
  workspaceId: string,
  call: ConductorCallTarget,
  workspace: ConductedWorkspace,
  version: number,
  storedItems: Prisma.JsonValue,
): Promise<ConductStep> {
  const items = requirementItemsSchema.parse(storedItems)
  const keys = items.map((i) => i.key)
  // A plan already bought for this version (an ok `conduct` call) is staffed again, never re-bought:
  // staffing can fail after the answer (a pool ran out), and the next tick retries only the staffing.
  const bought = await prisma.conductorCall.findFirst({
    where: { workspaceId, goalVersion: version, stage: 'conduct', outcome: 'ok', plan: { not: Prisma.AnyNull } },
    orderBy: { createdAt: 'desc' },
    select: { plan: true },
  })
  let plan: ConductPlan
  // Only the fallback is decided by rules: it writes no `ConductorCall` row, so a bought plan is
  // always the model's.
  let fallback = false
  if (bought !== null) {
    plan = conductPlanSchema.parse(bought.plan)
  } else {
    const failures = await prisma.conductorCall.findMany({
      where: { workspaceId, goalVersion: version, stage: 'conduct', outcome: 'failed', ...failuresSince(workspace.haltClearedAt) },
      orderBy: { createdAt: 'asc' },
      select: { reason: true },
    })
    const catalogue = await loadConductCatalogue()
    if (failures.length >= CONDUCT_RETRY_CAP) {
      const templateId = await fallbackTemplate(workspaceId, catalogue)
      if (templateId === null) {
        await tripConductor(workspaceId, `goal v${version} has no persona to deliver it: the catalogue shows none`)
        return 'conduct_failed'
      }
      fallback = true
      plan = singlePlan(
        templateId,
        keys,
        `the conductor's answer was unusable ${failures.length} times (last: ${failures.at(-1)?.reason ?? 'unknown'}); single by default`,
      )
    } else {
      let repo: Awaited<ReturnType<typeof loadRepositoryFacts>>
      try {
        repo = await loadRepositoryFacts(workspace.repoPath, workspace.baseBranch)
      } catch (error) {
        // Final review M5: an unreadable repository (an empty one, a base branch that is gone) used
        // to throw into the tick's log and nowhere else. Said once, no halt, no model call: a
        // person's first commit or a fixed base branch makes the next tick work.
        const message = error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error)
        await tripConductor(
          workspaceId,
          `the conductor could not read the repository for goal v${version} (base branch ${workspace.baseBranch}): ${message}`,
        )
        return 'conduct_failed'
      }
      const decided = await callConductor(
        call,
        workspaceId,
        version,
        'conduct',
        buildConductPrompt({
          goal: workspace.goal,
          requirements: items,
          repositoryMap: repo.map,
          catalogue: catalogue.text,
          previousError: failures.at(-1)?.reason ?? null,
        }),
        (text) => {
          const raw = parseConductAnswer(text)
          return raw.ok
            ? validateConduct(raw.value, { requirementKeys: keys, repoFiles: repo.files, templateIds: catalogue.templateIds })
            : raw
        },
        (value) => value,
      )
      if ('failure' in decided) return 'conduct_failed'
      plan = decided.value
    }
  }

  const seats = await staffPackages(workspaceId, version, plan.packages)
  if (!seats.ok) {
    await tripConductor(workspaceId, `staffing goal v${version}: ${seats.error}`)
    return 'conduct_failed'
  }
  // Spec R9: the version's own integration branch, cut before the transaction below (git is not
  // transactional) -- `ensureIntegrationBranch` reuses it when a crash left it without its row.
  const integrationBranch = integrationBranchName(version, workspaceId)
  let cut: { readonly baseCommit: string }
  try {
    cut = await ensureIntegrationBranch(workspace.repoPath, workspace.baseBranch, integrationBranch)
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error)
    await tripConductor(workspaceId, `goal v${version} could not cut its integration branch: ${message}`)
    return 'conduct_failed'
  }
  try {
    await materialise(workspaceId, version, workspace.maxAttempts, plan, fallback, seats.value, items, {
      integrationBranch,
      baseCommit: cut.baseCommit,
    })
  } catch (error) {
    if (error instanceof AlreadyConducted) return 'none'
    throw error
  }
  return 'conducted'
}

/**
 * The persona a `single`-by-default fallback is staffed with. Which template the conductor leaned
 * on in its refused answers is unknowable once they were refused, so the rule is deterministic and
 * needs no model: the persona of an existing open seat that already holds PACKAGE_WORKER_ROLE
 * (someone who has delivered a package here before), else the FIRST template of the catalogue the
 * conductor was shown (ordered by name). Either way a template the catalogue shows, so the pool
 * behind it is one `staffPackages` may hire from. `null` only for an empty catalogue.
 */
async function fallbackTemplate(
  workspaceId: string,
  catalogue: { readonly templateIds: ReadonlySet<string> },
): Promise<string | null> {
  const seats = await prisma.slave.findMany({
    where: { team: { workspaceId }, closedAt: null, person: { releasedAt: null }, runtimeRoles: { has: PACKAGE_WORKER_ROLE } },
    select: { person: { select: { templateId: true } } },
    orderBy: { id: 'asc' },
  })
  const seated = seats
    .map((seat) => seat.person.templateId)
    .find((templateId): templateId is string => templateId !== null && catalogue.templateIds.has(templateId))
  return seated ?? [...catalogue.templateIds][0] ?? null
}

/**
 * Says a conductor problem that a later tick may fix by itself (a pool that ran out): a
 * `guardrail.tripped` with guardrail `conductor_failed`, WITHOUT a halt -- a pool sync or a
 * person's action can make the next tick's staffing succeed. Said once: skipped when the
 * workspace's newest trip already carries the same detail, so an empty pool is not repeated on
 * every tick.
 */
async function tripConductor(workspaceId: string, detail: string): Promise<void> {
  const newest = await prisma.executionEvent.findFirst({
    where: { workspaceId, type: 'guardrail_tripped' },
    orderBy: { seq: 'desc' },
    select: { payload: true },
  })
  const said = (newest?.payload as { readonly detail?: unknown } | null | undefined)?.detail
  if (said === detail) return
  await appendEvent({
    type: 'guardrail.tripped',
    workspaceId,
    actor: 'system',
    payload: { guardrail: 'conductor_failed' satisfies GuardrailKind, detail },
  })
}

/**
 * What a package task's description says: the requirements it delivers, word for word, or -- for
 * a package with none of its own -- what it is for: the integration package wires the others
 * together, any other package delivers its own contract. Keyed on `isIntegration` (final review
 * M4): an ordinary package with no requirement used to read "Wire the packages together: .". The
 * full contract (owned paths, interfaces) is the run context's job (Conductor Task 8).
 */
function taskDescription(pkg: PackageSpec, items: readonly { readonly key: string; readonly text: string }[]): string {
  if (pkg.requirementKeys.length === 0) {
    return pkg.isIntegration
      ? `Wire the packages together: ${pkg.dependsOn.join(', ')}.`
      : `${pkg.title}: no requirement is this package's alone. Deliver what its contract describes, so the packages that depend on it can build on it.`
  }
  const textOf = new Map(items.map((item) => [item.key, item.text] as const))
  return `Requirements:\n${pkg.requirementKeys.map((k) => `${k}: ${textOf.get(k) ?? ''}`).join('\n')}`
}

/**
 * ONE transaction (plan decision D7): the `conduct` decision is recorded already applied, and its
 * packages, their pinned tasks and their dependency edges are written with it -- a decision row
 * with no packages behind it, or packages no decision explains, can never be observed. The events
 * follow the commit (`appendEvent` owns its own transaction on the shared client). The version's
 * `GoalDelivery` row (plan D5: the switch onto the integration branch) is written in the same
 * transaction, so packages never exist without the branch they merge into being on record.
 *
 * Returns the decision's id.
 */
async function materialise(
  workspaceId: string,
  version: number,
  maxAttempts: number,
  plan: ConductPlan,
  fallback: boolean,
  seats: ReadonlyMap<string, string>,
  items: readonly { readonly key: string; readonly text: string }[],
  delivery: { readonly integrationBranch: string; readonly baseCommit: string },
): Promise<string> {
  const subjectId = `${workspaceId}:v${version}`
  const packageKeys = plan.packages.map((p) => p.key)
  const action = { kind: 'conduct' as const, goalVersion: version, mode: plan.mode, packageKeys }
  const situation = situationSchema.parse({
    kind: 'conduct',
    subjectId,
    summary: `Goal v${version}: ${plan.mode}, ${plan.packages.length} package(s)`,
    facts: { goalVersion: version, mode: plan.mode, packages: plan.packages.length },
  })
  const candidates = [candidateSchema.parse({ action, tier: 'applied', why: plan.reason })]

  const { decisionId, tasks } = await prisma.$transaction(async (tx) => {
    // One writer per workspace: two ticks that both staffed the same plan serialise here, and the
    // second finds the first's packages and throws -- rolling back, never committing a duplicate.
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
    if ((await tx.workPackage.count({ where: { workspaceId, goalVersion: version } })) > 0) throw new AlreadyConducted()
    await tx.goalDelivery.create({
      data: { workspaceId, goalVersion: version, integrationBranch: delivery.integrationBranch, baseCommit: delivery.baseCommit },
    })

    const decision = await tx.supervisorDecision.create({
      data: {
        workspaceId,
        situationKind: 'conduct',
        subjectId,
        situation: situation as unknown as Prisma.InputJsonValue,
        candidates: candidates as unknown as Prisma.InputJsonValue,
        chosenIndex: 0,
        action: action as unknown as Prisma.InputJsonValue,
        rationale: plan.reason,
        tier: 'applied',
        status: 'applied',
        decidedBy: fallback ? 'rules' : 'model',
        modelCostUsd: null,
        modelCalled: false,
      },
      select: { id: true },
    })

    const taskIdByKey = new Map<string, string>()
    const created: { readonly id: string; readonly title: string; readonly assigneeId: string | null }[] = []
    for (const pkg of plan.packages) {
      const row = await tx.workPackage.create({
        data: {
          workspaceId,
          goalVersion: version,
          key: pkg.key,
          title: pkg.title,
          requirementKeys: [...pkg.requirementKeys],
          ownedPaths: [...pkg.ownedPaths],
          newPaths: [...pkg.newPaths],
          interface: pkg.interface,
          dependsOn: [...pkg.dependsOn],
          isIntegration: pkg.isIntegration,
          templateId: pkg.templateId,
        },
        select: { id: true },
      })
      const task = await tx.task.create({
        data: {
          workspaceId,
          title: pkg.title,
          description: taskDescription(pkg, items),
          status: 'ready',
          requiredRole: PACKAGE_WORKER_ROLE,
          requiredCapabilities: [],
          createdBy: 'system',
          maxAttempts,
          goalVersion: version,
          assigneeId: seats.get(pkg.key) ?? null,
          workPackageId: row.id,
        },
        select: { id: true, title: true, assigneeId: true },
      })
      taskIdByKey.set(pkg.key, task.id)
      created.push(task)
    }
    for (const pkg of plan.packages) {
      for (const dep of pkg.dependsOn) {
        const taskId = taskIdByKey.get(pkg.key)
        const dependsOnTaskId = taskIdByKey.get(dep)
        if (taskId === undefined || dependsOnTaskId === undefined) continue
        await tx.taskDependency.create({ data: { taskId, dependsOnTaskId } })
      }
    }
    return { decisionId: decision.id, tasks: created }
  })

  for (const task of tasks) {
    await appendEvent({
      type: 'task.created',
      workspaceId,
      taskId: task.id,
      actor: 'system',
      payload: { title: task.title, goalVersion: version, assigneeId: task.assigneeId },
    })
  }
  await appendEvent({
    type: 'workspace.conducted',
    workspaceId,
    actor: 'system',
    payload: { version, mode: plan.mode, packages: packageKeys, decisionId, fallback },
  })
  return decisionId
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
 *
 * Plan 4a: consulted after the goal-delivery rule (`earlierGoalOpen`), for a board left over from
 * planned delivery.
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
 * Plan D6: what goal version `version` waits for, or `undefined` when it may be conducted. An
 * earlier goal version that has not reached the base branch (and was not abandoned) comes first:
 * its number. Else a board left over from planned delivery (Plan 2 D5's `boardIsBusy`): `null`.
 * Accepted is not enough: this version's branch is cut from the base branch, which lacks the
 * earlier version's work until its merge.
 */
async function earlierGoalOpen(workspaceId: string, version: number): Promise<number | null | undefined> {
  const open = await prisma.goalDelivery.findFirst({
    where: { workspaceId, goalVersion: { lt: version }, status: { not: 'abandoned' }, mergedAt: null },
    orderBy: { goalVersion: 'asc' },
    select: { goalVersion: true },
  })
  if (open !== null) return open.goalVersion
  return (await boardIsBusy(workspaceId, version)) ? null : undefined
}

/**
 * Says the wait once per (version, what it waits on) -- its own event, not the `conductor_failed`
 * guardrail it used to borrow (plan D6: the Home feed read that as "a task is blocked and needs
 * you"). Deduplicated against the log, so a daemon restart does not repeat it.
 */
async function goalWaiting(workspaceId: string, version: number, waitingOn: number | null): Promise<void> {
  // Filtered by `version` in SQL and compared on `waitingOn` here: a JSON-path `equals: null` does
  // not match a JSON null in Prisma, and the handful of rows per version costs nothing to read.
  const said = await prisma.executionEvent.findMany({
    where: { workspaceId, type: 'workspace_goal_waiting', payload: { path: ['version'], equals: version } },
    select: { payload: true },
  })
  if (said.some((row) => (row.payload as { readonly waitingOn?: unknown }).waitingOn === waitingOn)) return
  await appendEvent({ type: 'workspace.goal_waiting', workspaceId, actor: 'system', payload: { version, waitingOn } })
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
  haltClearedAt: Date | null,
): Promise<ConductStep> {
  const failures = await prisma.conductorCall.findMany({
    where: { workspaceId, stage: 'requirements', outcome: 'failed', goalVersion: version, ...failuresSince(haltClearedAt) },
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
  // Says how to recover: the next tick after a clear makes a fresh call (`failuresSince`).
  const detail =
    `the conductor could not extract requirements for goal v${version}: ${lastReason}. ` +
    `Reword the goal or fix the model, then retract the halt with: clear-halt --workspace ${workspaceId}`
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
