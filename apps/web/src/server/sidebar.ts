import { prisma } from '@slave-of-ai/db/client'
import { BLOCKING_TASK_STATUS, buildNeedsYou, mayHaveBlockingRow, type NeedsYouItem } from './needsYou'
import {
  BLOCKING_SITUATION_KINDS,
  needsYou,
  userWorkspaceStatus,
  type TaskStatus,
  type UserWorkspaceState,
} from '@slave-of-ai/domain'

/**
 * One row of the sidebar's Projects tree (M57 R5).
 *
 * FOUR fields a person can see and one they cannot: the name, the dot's status, the amber count,
 * and `tasksActive` — which is not drawn but IS what `userWorkspaceStatus` needs to tell "working"
 * from "idle", so it rides along rather than being recomputed by the component.
 */
export interface SidebarProject {
  readonly id: string
  readonly name: string
  /** Always `false` today: `buildSidebarTree` hides archived projects. On the DTO anyway, because
   *  the tree's own `data-archived` attribute is what a later milestone's "show archived" toggle
   *  would key on, and a field nobody has to add later is cheaper than one they do. */
  readonly archived: boolean
  /** The RAW state, for `data-status` and for the dot's tone. */
  readonly status: UserWorkspaceState
  /** The WORD, for `title` and for a screen reader (`docs/ia.md` rule 3). */
  readonly statusLabel: string
  readonly needsYouCount: number
  /** Human cards H4 (Task 9 fix round 1 ruling): the number of rows the project's needs-you queue
   *  marks blocking -- the queue's own rule, counted on its own beside `needsYouCount`: what stops a
   *  goal version and a person can act on, not merely what waits. */
  readonly blockingCount: number
  readonly tasksActive: number
}

/** `overview.ts`'s and `shell.ts`'s own list, restated here for the same reason `shell.ts` restates
 *  it: neither exports it, and this module's whole point is not to depend on either. */
const ACTIVE_TASK_STATUSES = ['ready', 'running', 'verifying', 'reviewing', 'merging', 'rework', 'waiting'] as const

/**
 * Every project a person can reach, with the one word and the one number the tree draws.
 *
 * SIX QUERIES, and deliberately not `listProjects()` (plan erratum E3): that function is the
 * PROJECTS PAGE's read model — six grouped reads plus a `findMany` with a nested include of every
 * team's every slave, returning spend, avatars and per-status task counts — and this one runs in
 * the ROOT layout, which means on every page in the product. What the tree draws is a name, a dot
 * and a number.
 *
 * `needsYouCount` derives THROUGH the domain's `needsYou(...)`, one status group at a time, exactly
 * as `listProjects` does (`server/org.ts:317-330`), so the number in the tree and the number on the
 * project card cannot come to disagree. It is the same FLOOR `docs/ia.md` documents: the fourth
 * clause (a `waiting` task whose question nobody can answer) needs a per-task join that neither
 * this reader nor `listProjects` makes, and `buildNeedsYou` is the fuller answer on the Overview.
 */
export async function buildSidebarTree(): Promise<readonly SidebarProject[]> {
  return (await readSidebar()).tree
}

/** The tree, plus the needs-you queue of every project whose blocking count had to be read off it
 *  -- so Home, which lists those very queues, never builds one twice. */
export interface SidebarRead {
  readonly tree: readonly SidebarProject[]
  readonly queues: ReadonlyMap<string, readonly NeedsYouItem[]>
}

/**
 * {@link buildSidebarTree}'s read, keeping the queues it built (Task 9 fix round 1).
 *
 * `blockingCount` IS the number of blocking rows the project's needs-you queue shows (ruling: one
 * queue, one definition) -- so it is read off `buildNeedsYou` itself, never a second formula. That
 * read walks the Supervisor's world, so it is made ONLY for a project that can have a blocking row
 * at all: a blocked task, a pending `goal_needs_human` / `task_blocked_human` card, or a run parked
 * on a question (every other blocking row needs one of the three -- a question card or a bare
 * question blocks only while its asker is parked). Three grouped reads find those projects for every
 * project at once; a project with none of the three costs nothing more, and reads 0.
 */
export async function readSidebar(now: Date = new Date()): Promise<SidebarRead> {
  const [workspaces, taskGroups, unintegratedDoneGroups, pendingDecisionGroups, parkedRunGroups, blockingCardGroups] = await Promise.all([
    prisma.workspace.findMany({
      where: { archivedAt: null },
      select: { id: true, name: true, haltedReason: true, autoMerge: true, archivedAt: true },
      orderBy: { name: 'asc' },
    }),
    prisma.task.groupBy({ by: ['workspaceId', 'status'], _count: { _all: true } }),
    // `integratedAt` is not a `by` column, so the half of `done` that is still sitting on a branch
    // cannot be counted out of the group above — its own grouped read, ONE for every project.
    prisma.task.groupBy({
      by: ['workspaceId'],
      where: { status: 'done', integratedAt: null },
      _count: { _all: true },
    }),
    // DECISIONS, not the tasks they are about: `SupervisorDecision` has no task column, and its
    // `subjectId` is a task id, a message id, a role name or the workspace's own id depending on
    // the situation. `docs/ia.md` records exactly what this number is.
    prisma.supervisorDecision.groupBy({
      by: ['workspaceId'],
      where: { status: 'pending' },
      _count: { _all: true },
    }),
    // Human cards H4: which projects CAN have a blocking row -- a run parked on its question, and
    // the two cards that stop a version on their own (a blocked task is in `taskGroups` above). Two
    // grouped reads, ONE each for every project; the count itself is the queue's.
    prisma.$queryRaw<{ workspaceId: string; n: bigint }[]>`
      SELECT t."workspaceId", COUNT(*)::bigint AS n
      FROM "SlaveRun" r JOIN "Slave" s ON s.id = r."slaveId" JOIN "Team" t ON t.id = s."teamId"
      WHERE r.status = 'paused' AND r."pauseReason" = 'waiting_for_answer'
      GROUP BY t."workspaceId"`,
    prisma.supervisorDecision.groupBy({
      by: ['workspaceId'],
      where: { status: 'pending', situationKind: { in: [...BLOCKING_SITUATION_KINDS] } },
      _count: { _all: true },
    }),
  ])

  const unintegratedDoneOf = (workspaceId: string): number =>
    unintegratedDoneGroups.find((group) => group.workspaceId === workspaceId)?._count._all ?? 0
  const pendingDecisionsOf = (workspaceId: string): number =>
    pendingDecisionGroups.find((group) => group.workspaceId === workspaceId)?._count._all ?? 0
  const blockedTasksOf = (workspaceId: string): number =>
    taskGroups.find((group) => group.workspaceId === workspaceId && group.status === BLOCKING_TASK_STATUS)?._count._all ?? 0
  const blockingCardsOf = (workspaceId: string): number =>
    blockingCardGroups.find((group) => group.workspaceId === workspaceId)?._count._all ?? 0
  const parkedRunsOf = (workspaceId: string): number =>
    Number(parkedRunGroups.find((group) => group.workspaceId === workspaceId)?.n ?? 0n)

  const candidates = workspaces.filter((workspace) =>
    mayHaveBlockingRow({ blockedTasks: blockedTasksOf(workspace.id), blockingCards: blockingCardsOf(workspace.id), parkedRuns: parkedRunsOf(workspace.id) }),
  )
  // Fix round 2: each project's queue on its own. This read runs in the ROOT layout, so one project
  // whose world will not load must not take every page of every project down with it: its failure
  // is logged, its queue is absent, and its count falls back to the one that needs no world.
  const built = await Promise.all(
    candidates.map(async (workspace): Promise<readonly [string, readonly NeedsYouItem[]] | null> => {
      try {
        return [workspace.id, await buildNeedsYou(workspace.id, now)] as const
      } catch (cause) {
        console.error(`sidebar: the needs-you queue of project ${workspace.id} could not be built; its blocking count falls back to its blocked tasks and blocking cards`, cause)
        return null
      }
    }),
  )
  const queues = new Map(built.filter((entry): entry is readonly [string, readonly NeedsYouItem[]] => entry !== null))
  const failed = new Set(candidates.filter((_, index) => built[index] === null).map((workspace) => workspace.id))
  const blockingOf = (workspaceId: string): number => {
    // The fallback, for a queue that could not be read: what blocks with no world read -- blocked
    // tasks and the blocking cards. It may count a blocked task and its card twice, and it misses a
    // parked question; it is shown only while the queue itself cannot be read.
    if (failed.has(workspaceId)) return blockedTasksOf(workspaceId) + blockingCardsOf(workspaceId)
    // A project `mayHaveBlockingRow` ruled out has no queue read and no blocking row.
    return (queues.get(workspaceId) ?? []).filter((row) => row.blocking).length
  }

  const tree = workspaces.map((workspace): SidebarProject => {
    let needsYouCount = 0
    let tasksActive = 0
    for (const group of taskGroups) {
      if (group.workspaceId !== workspace.id) continue
      const status = group.status as TaskStatus
      if ((ACTIVE_TASK_STATUSES as readonly string[]).includes(status)) tasksActive += group._count._all
      if (status === 'done') {
        const unintegrated = unintegratedDoneOf(workspace.id)
        if (needsYou({ status, autoMerge: workspace.autoMerge, integrated: false })) needsYouCount += unintegrated
        if (needsYou({ status, autoMerge: workspace.autoMerge, integrated: true })) {
          needsYouCount += group._count._all - unintegrated
        }
        continue
      }
      if (needsYou({ status, autoMerge: workspace.autoMerge })) needsYouCount += group._count._all
    }
    needsYouCount += pendingDecisionsOf(workspace.id)

    const archived = workspace.archivedAt !== null
    const status = userWorkspaceStatus({
      archived,
      halted: workspace.haltedReason !== null,
      needsYouCount,
      tasksActive,
    })
    return {
      id: workspace.id,
      name: workspace.name,
      archived,
      status: status.state,
      statusLabel: status.label,
      needsYouCount,
      blockingCount: blockingOf(workspace.id),
      tasksActive,
    }
  })
  return { tree, queues }
}
