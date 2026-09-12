import { randomUUID } from 'node:crypto'
import { type Prisma, prisma } from '@slave-of-ai/db/client'

/**
 * The one world M53's control tests are written against (Task 2).
 *
 * A single project, a single template, a single worker hired from it, a single task that asks for a
 * capability, and one CONCLUDED run -- the smallest shape `recordRunEvidence` has anything to say
 * about. Every case below it either asserts the columns this seed produces or edits one row and
 * asserts what changed, which keeps each case a statement about ONE rule rather than about a fixture.
 *
 * The taxonomy is NOT seeded here and NOT truncated: `Capability` is the checked-in table every
 * other integration file in this database reads (`capability.test.ts`'s own reset says so), and the
 * two keys used below -- `backend.services` (domain `backend`) and `qa.test-automation` (domain
 * `qa`) -- are already rows in it. Their LABELS are the seeded ones, and the cases assert those
 * words rather than inventing prettier ones: a label a test owns is a label the product does not.
 */
export interface EvidenceFixture {
  readonly workspaceId: string
  readonly teamId: string
  readonly templateId: string
  readonly slaveId: string
  readonly taskId: string
  readonly runId: string
  readonly repoPath: string
}

/** The checkout two projects would share. Written without a trailing slash, so
 *  `normaliseRepositoryKey` is the identity on it and a case asserting `repositoryKey` is asserting
 *  the SNAPSHOT rather than the normalisation (which `derive.test.ts` owns). */
export const EVIDENCE_REPO_PATH = '/tmp/m53-evidence-repo'

/** The template's name, and therefore the `profileName` snapshot of every row keyed on it. */
export const EVIDENCE_TEMPLATE_NAME = 'Backend Developer'

/** The model the fixture's run actually dispatched with, and the template's `defaultModel` -- so
 *  the world loader's resolution chain (`Slave.model ?? CompanySlave.model ?? defaultModel`) has
 *  something to resolve THROUGH rather than off the worker row. */
export const EVIDENCE_MODEL = 'claude-sonnet-4-20250514'

/** The seeded label of `backend.services`. Spelled here once so a case reads the word rather than
 *  a key, and so a taxonomy edit breaks one constant instead of six assertions. */
export const BACKEND_SERVICES_LABEL = 'Service implementation'

const RUN_STARTED_AT = new Date('2026-09-12T09:00:00.000Z')
/** 3 500 ms after {@link RUN_STARTED_AT}: a known span, so `durationMs` is a fact and not a clock. */
const RUN_ENDED_AT = new Date('2026-09-12T09:00:03.500Z')

/**
 * Everything M53's two tables and their neighbours hold, emptied in one statement.
 *
 * `EvidenceRecord` and `StaffingPreference` cascade from `Workspace` and would be reached anyway;
 * both are named explicitly because a reader of this list should be able to see that the milestone's
 * own tables are cleared without tracing a foreign key. `Capability` is deliberately absent.
 */
const TRUNCATE =
  'TRUNCATE TABLE "EvidenceRecord", "StaffingPreference", "ExecutionEvent", "SupervisorDecision", "SlavePermission", "SlaveMessage", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "User", "CollaborationHint", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE'

/**
 * Seed the world above and answer the ids every case addresses it by.
 *
 * The `User` row is not decoration: `ExecutionEvent.userId` is a foreign key, so a principal of
 * `{ userId: 'u1' }` handed to `setStaffingPreference` would make the append throw rather than
 * record who decided what.
 */
export async function seedEvidenceFixture(): Promise<EvidenceFixture> {
  await prisma.$executeRawUnsafe(TRUNCATE)
  await prisma.user.create({ data: { id: 'u1', username: 'operator', passwordHash: 'x' } })
  const workspace = await prisma.workspace.create({
    data: { name: 'M53 Evidence', repoPath: EVIDENCE_REPO_PATH, verifyCommands: ['true'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const template = await prisma.slaveTemplate.create({
    data: {
      name: EVIDENCE_TEMPLATE_NAME,
      role: 'backend',
      capabilityKeys: ['backend.services'],
      defaultModel: EVIDENCE_MODEL,
    },
  })
  const slave = await prisma.slave.create({
    data: {
      teamId: team.id,
      name: 'Atlas',
      role: 'Backend Developer',
      runtimeRoles: ['backend'],
      capabilities: ['backend.services'],
      hiredFromTemplateId: template.id,
    },
  })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Ship the service',
      description: 'a task',
      status: 'ready',
      requiredRole: 'backend',
      requiredCapabilities: ['backend.services'],
      maxAttempts: 3,
    },
  })
  const run = await prisma.slaveRun.create({
    data: {
      taskId: task.id,
      slaveId: slave.id,
      kind: 'implementation',
      status: 'succeeded',
      model: EVIDENCE_MODEL,
      provider: 'claude_code',
      costUsd: 0.42,
      tokensIn: 1_000,
      tokensOut: 2_000,
      startedAt: RUN_STARTED_AT,
      terminalAt: RUN_ENDED_AT,
      endedAt: RUN_ENDED_AT,
    },
  })
  return {
    workspaceId: workspace.id,
    teamId: team.id,
    templateId: template.id,
    slaveId: slave.id,
    taskId: task.id,
    runId: run.id,
    repoPath: EVIDENCE_REPO_PATH,
  }
}

/** What a case may vary about a seeded fact row. Everything omitted takes the fixture's own value,
 *  so a case naming `costProvenance` is a case about the money split and about nothing else. */
export type EvidenceRowOverride = Partial<Omit<Prisma.EvidenceRecordUncheckedCreateInput, 'id' | 'runId'>>

/**
 * Fact rows written DIRECTLY, bypassing `recordRunEvidence`.
 *
 * The reads are grouped aggregates over a table, and driving them through the writer would mean
 * seeding a `SlaveRun` per row to assert a median -- which would make every read case a test of the
 * writer as well. The writer has its own cases; these ones are about the SQL.
 *
 * `runId` is a fresh uuid per row rather than a real run: the column is `@unique` and carries no
 * foreign key, exactly so a record outlives the run it is about (plan erratum E4).
 */
export async function seedEvidenceRows(
  fixture: EvidenceFixture,
  rows: number | readonly EvidenceRowOverride[],
): Promise<void> {
  const overrides = typeof rows === 'number' ? Array.from({ length: rows }, () => ({})) : rows
  for (const override of overrides) {
    await prisma.evidenceRecord.create({
      data: {
        runId: randomUUID(),
        workspaceId: fixture.workspaceId,
        slaveId: fixture.slaveId,
        taskId: fixture.taskId,
        profileKey: `template:${fixture.templateId}`,
        profileName: EVIDENCE_TEMPLATE_NAME,
        model: EVIDENCE_MODEL,
        repositoryKey: fixture.repoPath,
        domains: ['backend'],
        runKind: 'implementation',
        attempt: 1,
        outcome: 'succeeded',
        actualCostUsd: 1,
        costProvenance: 'reported',
        ...override,
      },
    })
  }
}
