import { prisma } from '@slave-of-ai/db/client'

/**
 * The one seed the three M45 read-model suites share (`brief`, `needs-you`, `supervisor-timeline`).
 *
 * The idiom is `overview.test.ts`'s, copied rather than invented: the same TRUNCATE list, the same
 * workspace/team/slave shape. It lives in its own module because THREE files need it with
 * different options -- a project that merges by itself and one that does not, a budgeted project
 * and one that is not -- and three private copies of one seed are three things to keep in step.
 * `overview.test.ts` keeps its own `seed()` untouched: its whole file is built on that fixture.
 *
 * Not a `*.test.ts` file, so vitest's `include` never collects it as a suite.
 */
export interface ProjectFixture {
  readonly workspaceId: string
  readonly teamId: string
  readonly slaveId: string
}

export interface SeedOptions {
  /** `Workspace.autoMerge`. Default `false` -- the hand-merge project, where a finished task that
   *  nobody integrated is a thing waiting on a person. */
  readonly autoMerge?: boolean
  readonly goal?: string | null
  readonly budgetUsd?: number | null
  readonly supervisorEnabled?: boolean
  /** The role the seeded worker holds, in `role` and in `runtimeRoles`. */
  readonly role?: string
}

/** Every table the three suites write, in FK order. `SupervisorDecision`, `GoalVersion` and
 *  `RunContext` are reached through their FKs by `CASCADE`, the same way every neighbouring
 *  integration test reaches them. */
const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "Approval", "Artifact", "Checkpoint", "SlaveMessage", "RunContext", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE'

export async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(TRUNCATE)
}

export async function seedWorkspace(options: SeedOptions = {}): Promise<ProjectFixture> {
  const role = options.role ?? 'dev'
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/m45-fixture-does-not-need-to-exist',
      verifyCommands: ['true'],
      setupCommands: [],
      autoMerge: options.autoMerge ?? false,
      goal: options.goal ?? null,
      budgetUsd: options.budgetUsd ?? null,
      supervisorEnabled: options.supervisorEnabled ?? true,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const slave = await prisma.slave.create({
    data: { teamId: team.id, name: 'Alex', role, runtimeRoles: [role] },
  })
  return { workspaceId: workspace.id, teamId: team.id, slaveId: slave.id }
}

/** A task, with the two columns the schema requires and no test cares about filled in. */
export async function seedTask(
  workspaceId: string,
  data: {
    readonly title: string
    readonly status?: string
    readonly integratedAt?: Date | null
    readonly lastRejectionReason?: string | null
    readonly createdAt?: Date
  },
): Promise<{ readonly id: string; readonly title: string }> {
  const task = await prisma.task.create({
    data: {
      workspaceId,
      title: data.title,
      description: 'seeded by the M45 project fixture',
      status: (data.status ?? 'backlog') as never,
      requiredRole: 'dev',
      maxAttempts: 3,
      integratedAt: data.integratedAt ?? null,
      lastRejectionReason: data.lastRejectionReason ?? null,
      ...(data.createdAt === undefined ? {} : { createdAt: data.createdAt }),
    },
  })
  return { id: task.id, title: task.title }
}

/**
 * A pending `SupervisorDecision`, valid against `situationSchema`.
 *
 * `facts` is NOT optional in that schema, and `listDecisions` parses every row it returns through
 * it -- a situation without `facts` makes the whole read throw rather than skipping one row.
 */
export async function seedPendingDecision(
  workspaceId: string,
  options: { readonly subjectId: string; readonly summary?: string; readonly situationKind?: string } = {
    subjectId: 'reviewer',
  },
): Promise<{ readonly id: string }> {
  const summary = options.summary ?? 'nobody holds reviewer'
  const kind = options.situationKind ?? 'no_reviewer'
  const decision = await prisma.supervisorDecision.create({
    data: {
      workspaceId,
      situationKind: kind as never,
      subjectId: options.subjectId,
      situation: { kind, subjectId: options.subjectId, summary, facts: {} },
      candidates: [],
      chosenIndex: 0,
      action: { kind: 'escalate_to_human', summary },
      rationale: 'no holder',
      tier: 'proposed',
      status: 'pending',
      decidedBy: 'rules',
      modelCalled: false,
    },
  })
  return { id: decision.id }
}

/**
 * A question nothing but a person can answer, in the shape `loadSupervisorWorld` actually reads.
 *
 * Three facts are load-bearing and none of them are optional (`stillPendingQuestion`,
 * `waitingSenderRunIds` in `packages/control/src/messaging.ts`): the message must be a `question`
 * that `expectsReply`, it must carry a `senderRunId`, and THAT run must be `paused` with
 * `pauseReason: 'waiting_for_answer'`. A bare `SlaveMessage` row with none of them is not a pending
 * question to the Supervisor's world at all, and would make every "a question needs you" assertion
 * vacuously pass against an empty list.
 *
 * `recipientRole` names a role no worker holds, which is `holders === 0` -- M39's unanswerable
 * shape, the one the needs-you queue is about.
 */
export async function seedUnanswerableQuestion(
  fixture: ProjectFixture,
  options: { readonly body?: string; readonly taskId?: string | null } = {},
): Promise<{ readonly messageId: string; readonly runId: string }> {
  const run = await prisma.slaveRun.create({
    data: {
      slaveId: fixture.slaveId,
      taskId: options.taskId ?? null,
      kind: 'planning',
      status: 'paused',
      pauseReason: 'waiting_for_answer',
    },
  })
  const message = await prisma.slaveMessage.create({
    data: {
      workspaceId: fixture.workspaceId,
      slaveId: fixture.slaveId,
      taskId: options.taskId ?? null,
      senderRunId: run.id,
      threadId: 'thread-m45',
      kind: 'question',
      body: options.body ?? 'Which payment gateway should we use?',
      actor: 'slave',
      expectsReply: true,
      recipientRole: 'nobody-holds-this',
    },
  })
  return { messageId: message.id, runId: run.id }
}
