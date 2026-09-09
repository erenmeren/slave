import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { SUPERVISOR_PER_CALL_CAP_USD } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildShellFacts } from '../../src/server/shell.js'

// A real directory, not a placeholder (M23 G3 idiom -- see `packages/control/test/integration/
// org-edit.test.ts`'s own comment): `Workspace.repoPath` needs to exist for anything that stats
// it, and a reboot clears /tmp.
const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-shell-facts-'))

afterAll(() => {
  rmSync(repoPath, { recursive: true, force: true })
})

interface Fixture {
  readonly workspaceId: string
  readonly slaveId: string
}

async function seed(overrides: { readonly goal?: string | null; readonly haltedReason?: string | null } = {}): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath,
      verifyCommands: ['true'],
      setupCommands: [],
      budgetUsd: 2,
      goal: 'goal' in overrides ? overrides.goal ?? null : 'Ship it',
      haltedReason: overrides.haltedReason ?? null,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  return { workspaceId: workspace.id, slaveId: slave.id }
}

/** One `SupervisorDecision` row, minimal but valid: a model call with the cost given (`null` for a
 *  call whose cost never came back, which `modelCalled: true` is what makes chargeable). */
const decisionRow = (workspaceId: string, subjectId: string, modelCostUsd: number | null) => ({
  workspaceId,
  situationKind: 'no_reviewer' as const,
  subjectId,
  situation: { kind: 'no_reviewer', subjectId, summary: 'nobody holds reviewer', facts: {} },
  candidates: [],
  chosenIndex: 0,
  action: { kind: 'no_action' },
  rationale: 'seeded',
  tier: 'noop' as const,
  status: 'applied' as const,
  decidedBy: 'model' as const,
  modelCostUsd,
  modelCalled: true,
})

describe('buildShellFacts status block', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "SlaveRun", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('sums known spend, counts the unmeasured run, and carries the goal and halt state through', async (): Promise<void> => {
    const fixture = await seed()
    await prisma.slaveRun.create({
      data: { slaveId: fixture.slaveId, status: 'succeeded', provider: 'claude_code', costUsd: 0.25 },
    })
    await prisma.slaveRun.create({
      data: { slaveId: fixture.slaveId, status: 'succeeded', provider: 'claude_code', costUsd: null },
    })

    const facts = await buildShellFacts(fixture.workspaceId)
    expect(facts?.status).toEqual({ goal: 'Ship it', spentUsd: 0.25, unmeasuredRuns: 1, haltedReason: null })
  })

  it("reports the guardrail's total, Supervisor spend included, while the caveat stays about RUNS", async (): Promise<void> => {
    // The header this feeds is mounted by the project layout on /tasks, /graph and /activity too,
    // and it used to publish `spendOfGroups`' run-only figure while Overview published
    // `workspaceSpend`'s. So the same project's budget bar shrank when you changed tab the moment
    // the Supervisor cost anything (final review Important 3). One workspace, one number.
    const fixture = await seed()
    await prisma.slaveRun.create({
      data: { slaveId: fixture.slaveId, status: 'succeeded', provider: 'claude_code', costUsd: 0.25 },
    })
    await prisma.slaveRun.create({
      data: { slaveId: fixture.slaveId, status: 'succeeded', provider: 'claude_code', costUsd: null },
    })
    await prisma.supervisorDecision.create({ data: decisionRow(fixture.workspaceId, 'a', 0.1) })
    // A call that was made and whose cost never came back: charged at the per-call cap, exactly as
    // the guardrail charges it.
    await prisma.supervisorDecision.create({ data: decisionRow(fixture.workspaceId, 'b', null) })

    const facts = await buildShellFacts(fixture.workspaceId)
    expect(facts?.status.spentUsd).toBeCloseTo(0.25 + 0.1 + SUPERVISOR_PER_CALL_CAP_USD, 10)
    // Still ONE: the caveat beside the figure counts unmeasured RUNS, and the Supervisor's
    // unmeasured call is not unknown -- it is already inside the total above.
    expect(facts?.status.unmeasuredRuns).toBe(1)
  })

  it('carries a halted workspace with no goal through as null goal and the halt reason', async (): Promise<void> => {
    const fixture = await seed({ goal: null, haltedReason: 'emergency stop by t' })

    const facts = await buildShellFacts(fixture.workspaceId)
    expect(facts?.status).toEqual({ goal: null, spentUsd: 0, unmeasuredRuns: 0, haltedReason: 'emergency stop by t' })
  })
})
