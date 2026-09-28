import { prisma } from '@slave-of-ai/db/client'
import {
  actionSchema,
  err,
  ok,
  requirementItemsSchema,
  type Decider,
  type Result,
  type RequirementItem,
  type TaskStatus,
} from '@slave-of-ai/domain'
import type { ControlRefusal } from './refusal.js'

/**
 * Switch a workspace between the two delivery modes (spec §5), the one thing the CLI's
 * `set-delivery` does.
 *
 * No lock, unlike `setGoal`'s `writeGoalVersion`: there is nothing here two concurrent switches
 * could corrupt -- a plain read-then-write races at worst into two identical updates, and the
 * value it lands on is whichever call ran last, the same as any other single-column toggle.
 *
 * Switching mid-version is allowed, on purpose, both ways:
 * - `planned` -> `conducted` while the planner has a board in flight: the next `conduct` tick
 *   waits it out (`boardIsBusy`, plan decision D5) rather than conducting over live work.
 * - `conducted` -> `planned` and back: a conducted version's `WorkPackage` rows and their pinned
 *   tasks are left exactly as they are. Switching back to `conducted` does not re-run the size
 *   decision for a version already materialised (`conduct` returns `'none'` once packages exist);
 *   switching to `planned` hands that same board to the ordinary planner graph, which treats it as
 *   the board it inherited rather than something to plan afresh.
 */
export async function setDelivery(
  workspaceId: string,
  delivery: 'conducted' | 'planned',
): Promise<Result<{ readonly delivery: 'conducted' | 'planned'; readonly changed: boolean }, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { delivery: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  if (workspace.delivery === delivery) return ok({ delivery, changed: false })
  await prisma.workspace.update({ where: { id: workspaceId }, data: { delivery } })
  return ok({ delivery, changed: true })
}

/** One `ConductorCall` row, as `conductorView` reports it -- the ledger's own columns, unparsed:
 *  a CLI report of what the conductor did is not the place to re-derive spend, only to show it. */
export interface ConductorCallView {
  readonly stage: 'requirements' | 'conduct'
  readonly outcome: 'ok' | 'failed'
  readonly reason: string | null
  readonly modelCostUsd: number | null
  readonly createdAt: string
}

/** One package of a conducted goal version, as `conductorView` reports it. */
export interface ConductorPackageView {
  readonly key: string
  readonly title: string
  readonly requirementKeys: readonly string[]
  readonly ownedPaths: readonly string[]
  readonly isIntegration: boolean
  /** The seat `materialise` pinned this package's task to, or null for a task with no assignee
   *  (staffing failed after the plan was bought, or the row was hand-seeded). */
  readonly seat: { readonly slaveId: string; readonly name: string } | null
  /** `materialise` creates exactly one task per package; null only for a package a test or a
   *  hand-edit left without one. */
  readonly taskId: string | null
  readonly taskStatus: TaskStatus | null
  /** Whether a `RunReport` exists for this package (Conductor R7) -- the board fact `conduct`
   *  Task 9's run context and Task 9's report-before-verify gate both key off. */
  readonly reported: boolean
}

/** What the conductor decided for a goal version, and what it has done about it since -- the
 *  CLI's `conductor` read. */
export interface ConductorView {
  readonly goalVersion: number
  readonly delivery: string
  /** The extracted requirements (Conductor R1), or null before the requirements step has run. */
  readonly requirements: readonly RequirementItem[] | null
  /** The `conduct` decision (Conductor R2), or null before the size decision has run. */
  readonly decision: {
    readonly mode: 'single' | 'partitioned'
    readonly rationale: string
    readonly decidedBy: Decider
    readonly createdAt: string
  } | null
  readonly packages: readonly ConductorPackageView[]
  /** Every model call this version has made, ok or failed, oldest first (plan decision D6). */
  readonly calls: readonly ConductorCallView[]
}

/**
 * What the conductor has decided and done for one goal version (spec §5's CLI read side).
 *
 * `goalVersion` defaults to the workspace's CURRENT version -- the version an operator asking
 * "what did the conductor do" almost always means, and the one every other read in this file
 * (`requirements`, `decision`, `packages`, `calls`) is then scoped to. An older version can still
 * be named explicitly; nothing here assumes it is the newest.
 */
export async function conductorView(
  workspaceId: string,
  goalVersion?: number,
): Promise<Result<ConductorView, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { delivery: true, goalVersion: true },
  })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  const version = goalVersion ?? workspace.goalVersion

  const [set, decisionRow, packages, calls] = await Promise.all([
    prisma.requirementSet.findUnique({
      where: { workspaceId_goalVersion: { workspaceId, goalVersion: version } },
      select: { items: true },
    }),
    prisma.supervisorDecision.findFirst({
      where: { workspaceId, situationKind: 'conduct', subjectId: `${workspaceId}:v${String(version)}` },
      orderBy: { createdAt: 'desc' },
      select: { action: true, rationale: true, decidedBy: true, createdAt: true },
    }),
    prisma.workPackage.findMany({
      where: { workspaceId, goalVersion: version },
      orderBy: { key: 'asc' },
      include: { tasks: true, reports: { select: { id: true } } },
    }),
    prisma.conductorCall.findMany({
      where: { workspaceId, goalVersion: version },
      orderBy: { createdAt: 'asc' },
      select: { stage: true, outcome: true, reason: true, modelCostUsd: true, createdAt: true },
    }),
  ])

  // The seat NAMES for every task a package holds, in one read -- `Task.assigneeId` carries no
  // Prisma relation (it is a plain seat id, the same reason `apps/web/src/server/tasks.ts` reads
  // it this way), so the join has to be done by hand rather than an `include`.
  const seatIds = [
    ...new Set(packages.flatMap((pkg) => pkg.tasks.map((task) => task.assigneeId)).filter((id): id is string => id !== null)),
  ]
  const seats =
    seatIds.length === 0
      ? []
      : await prisma.slave.findMany({ where: { id: { in: seatIds } }, select: { id: true, person: { select: { name: true } } } })
  const seatNameById = new Map(seats.map((seat) => [seat.id, seat.person.name] as const))

  // `safeParse`, not a throw: an operator asking what the conductor decided must not be met with a
  // stack trace over a decision row a newer build wrote a different action shape for -- the same
  // rule `apps/web/src/server/runbook.ts`'s `proposalOf` follows for the same reason.
  const decision = ((): ConductorView['decision'] => {
    if (decisionRow === null) return null
    const action = actionSchema.safeParse(decisionRow.action)
    if (!action.success || action.data.kind !== 'conduct') return null
    return {
      mode: action.data.mode,
      rationale: decisionRow.rationale,
      decidedBy: decisionRow.decidedBy,
      createdAt: decisionRow.createdAt.toISOString(),
    }
  })()

  return ok({
    goalVersion: version,
    delivery: workspace.delivery,
    requirements: set === null ? null : requirementItemsSchema.parse(set.items),
    decision,
    packages: packages.map((pkg) => {
      const task = pkg.tasks[0] ?? null
      return {
        key: pkg.key,
        title: pkg.title,
        requirementKeys: pkg.requirementKeys,
        ownedPaths: pkg.ownedPaths,
        isIntegration: pkg.isIntegration,
        // A seat name missing from the map is a dangling `assigneeId` -- the seat itself is gone
        // (a person deleted, `Slave` cascades with it) -- and that reads as no seat at all, not as
        // a seat named by its own id.
        seat:
          task?.assigneeId == null || !seatNameById.has(task.assigneeId)
            ? null
            : { slaveId: task.assigneeId, name: seatNameById.get(task.assigneeId) as string },
        taskId: task?.id ?? null,
        taskStatus: task?.status ?? null,
        reported: pkg.reports.length > 0,
      }
    }),
    calls: calls.map((call) => ({
      stage: call.stage,
      outcome: call.outcome,
      reason: call.reason,
      modelCostUsd: call.modelCostUsd,
      createdAt: call.createdAt.toISOString(),
    })),
  })
}
