import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { listCompanies, listProjects, listRoster, listTemplates, listWorkers } from '../../src/server/org.js'

interface Fixture {
  readonly workspaceId: string
  readonly teamId: string
  readonly agentId: string
  readonly taskId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/org-fixture',
      verifyCommands: ['true'],
      setupCommands: [],
      budgetUsd: 100,
      maxToolCallsPerRun: 200,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Add the thing',
      description: 'x',
      status: 'running',
      requiredRole: 'backend',
      maxAttempts: 3,
    },
  })
  return { workspaceId: workspace.id, teamId: team.id, agentId: agent.id, taskId: task.id }
}

describe('org query module', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace", "CompanyAgent", "CompanyTeam", "Company", "AgentTemplate" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  describe('listProjects', () => {
    it('returns the workspace with null company name, counts, worker count and spend when unassigned', async (): Promise<void> => {
      await prisma.task.create({
        data: {
          workspaceId: fixture.workspaceId,
          title: 'Second task',
          description: 'x',
          status: 'done',
          requiredRole: 'backend',
          maxAttempts: 3,
        },
      })
      await prisma.agentRun.create({
        data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'working', costUsd: 3.5 },
      })

      const projects = await listProjects()
      const project = projects.find((p) => p.id === fixture.workspaceId)

      expect(project?.name).toBe('Checkout Platform')
      expect(project?.companyName).toBeNull()
      expect(project?.halted).toBe(false)
      expect(project?.taskCounts).toEqual({ done: 1, total: 2, active: 1, blocked: 0 })
      // Re-pointed by the M14 fix wave (review I4): `workerCount` counts every agent on the
      // workspace's teams, staffed from a company or not. `seed()`'s 'Alex' is exactly such an
      // agent, and it used to be counted as zero agents while the card drew its face.
      expect(project?.workerCount).toBe(1)
      expect(project?.spend).toBeCloseTo(3.5)
      expect(project?.unmeasuredRuns).toBe(0)
    })

    it('never folds an unknown cost into a project\'s spend, and counts it instead', async (): Promise<void> => {
      // M12 Task 9 / ruling R3. This loop's `(run.costUsd ?? 0)` was the array form of the same
      // defect the `_sum` sites had: a run whose cost nobody measured silently contributed a zero,
      // so `$3.50` read as the whole story when it was only the measured part of it.
      await prisma.agentRun.create({
        data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'succeeded', costUsd: 3.5, provider: 'claude_code' },
      })
      await prisma.agentRun.create({
        data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'succeeded', costUsd: null, provider: 'cursor' },
      })

      const projects = await listProjects()
      const project = projects.find((p) => p.id === fixture.workspaceId)

      expect(project?.spend).toBeCloseTo(3.5)
      expect(project?.unmeasuredRuns).toBe(1)
    })

    it('counts neither a run in flight nor a run that never spawned (fix round F1)', async (): Promise<void> => {
      // Same rule as the budget bar, from the same function -- the Projects page inherited the
      // same defect and must inherit the same correction.
      await prisma.agentRun.create({
        data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'working', provider: 'claude_code' },
      })
      await prisma.agentRun.create({
        data: {
          taskId: fixture.taskId,
          agentId: fixture.agentId,
          status: 'failed',
          provider: null,
          terminalAt: new Date(),
          endedAt: new Date(),
        },
      })
      await prisma.agentRun.create({
        data: {
          taskId: fixture.taskId,
          agentId: fixture.agentId,
          status: 'stopped',
          provider: 'claude_code',
          terminalAt: new Date(),
          endedAt: new Date(),
        },
      })

      const projects = await listProjects()
      const project = projects.find((p) => p.id === fixture.workspaceId)

      expect(project?.spend).toBeCloseTo(0)
      expect(project?.unmeasuredRuns).toBe(1)
    })

    it('reports the company name and halted flag once assigned/halted', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      await prisma.workspace.update({
        where: { id: fixture.workspaceId },
        data: { companyId: company.id, haltedReason: 'the pause gate failed open', haltedAt: new Date() },
      })

      const projects = await listProjects()
      const project = projects.find((p) => p.id === fixture.workspaceId)

      expect(project?.companyName).toBe('Acme Robotics')
      expect(project?.halted).toBe(true)
    })

    it('counts every agent on the workspace teams toward workerCount, staffed or not', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Eng' } })
      const template = await prisma.agentTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })
      const companyAgent = await prisma.companyAgent.create({
        data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas' },
      })
      await prisma.agent.create({
        data: { teamId: fixture.teamId, name: 'Atlas (worker)', role: 'backend', companyAgentId: companyAgent.id },
      })

      const projects = await listProjects()
      const project = projects.find((p) => p.id === fixture.workspaceId)

      // Re-pointed by the M14 fix wave (review I4): fixture.agentId ('Alex') has no companyAgentId
      // and IS an agent, so both count. Company staffing is metadata about an agent, not what
      // makes one.
      expect(project?.workerCount).toBe(2)
    })

    // Review I4: `projects.png` showed `AGENTS 0` directly above six avatar tiles on the same
    // card. Both figures are on this DTO, so the disagreement is assertable here rather than
    // only by eye -- the tile and the row must be the same count (the server sends the whole
    // team uncapped; the CLIENT is what caps the avatar row at six for display).
    it('reports the same count in workerCount as it puts faces in the avatar row', async (): Promise<void> => {
      const otherTeam = await prisma.team.create({ data: { workspaceId: fixture.workspaceId, name: 'Design' } })
      await prisma.agent.create({ data: { teamId: otherTeam.id, name: 'Bea', role: 'design' } })

      const project = (await listProjects()).find((p) => p.id === fixture.workspaceId)

      expect(project?.workerCount).toBe(2)
      expect(project?.team).toHaveLength(project?.workerCount ?? -1)
      expect(project?.team.map((m) => m.name).sort()).toEqual(['Alex', 'Bea'])
    })

    it('carries the workspace goal and its workers onto every project row', async (): Promise<void> => {
      const projects = await listProjects()
      expect(projects[0]?.goal).toBeNull()
      expect(projects[0]?.team.map((m) => m.name)).toEqual(['Alex'])
    })
  })

  describe('listRoster', () => {
    async function seedRoster(): Promise<{
      readonly companyId: string
      readonly companyTeamId: string
      readonly templateId: string
    }> {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Eng' } })
      const template = await prisma.agentTemplate.create({
        data: { name: 'Backend Engineer', role: 'backend', defaultModel: 'sonnet' },
      })
      return { companyId: company.id, companyTeamId: companyTeam.id, templateId: template.id }
    }

    it('groups companies -> teams -> members, and returns no workers for an unmaterialized member', async (): Promise<void> => {
      const { companyId, companyTeamId, templateId } = await seedRoster()
      await prisma.companyAgent.create({
        data: { companyTeamId, templateId, name: 'Atlas' },
      })

      const roster = await listRoster()
      const company = roster.find((c) => c.companyId === companyId)

      expect(company?.companyName).toBe('Acme Robotics')
      const team = company?.teams.find((t) => t.companyTeamId === companyTeamId)
      expect(team?.teamName).toBe('Eng')
      const member = team?.members.find((m) => m.name === 'Atlas')
      expect(member?.templateName).toBe('Backend Engineer')
      expect(member?.role).toBe('backend')
      expect(member?.workers).toEqual([])
    })

    it("modelSource is 'roster' when the roster row's model is set", async (): Promise<void> => {
      const { companyTeamId, templateId } = await seedRoster()
      const companyAgent = await prisma.companyAgent.create({
        data: { companyTeamId, templateId, name: 'Atlas', model: 'opus' },
      })

      const roster = await listRoster()
      const member = roster.flatMap((c) => c.teams).flatMap((t) => t.members).find((m) => m.companyAgentId === companyAgent.id)

      expect(member?.modelSource).toBe('roster')
      expect(member?.effectiveModel).toBe('opus')
      expect(member?.rosterModel).toBe('opus')
      expect(member?.templateDefaultModel).toBe('sonnet')
    })

    it("modelSource is 'template' when the roster row's model is unset but the template default is set", async (): Promise<void> => {
      const { companyTeamId, templateId } = await seedRoster()
      const companyAgent = await prisma.companyAgent.create({
        data: { companyTeamId, templateId, name: 'Atlas' },
      })

      const roster = await listRoster()
      const member = roster.flatMap((c) => c.teams).flatMap((t) => t.members).find((m) => m.companyAgentId === companyAgent.id)

      expect(member?.modelSource).toBe('template')
      expect(member?.effectiveModel).toBe('sonnet')
      expect(member?.rosterModel).toBeNull()
    })

    it("modelSource is 'none' when neither the roster row nor the template default has a model", async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Eng' } })
      const template = await prisma.agentTemplate.create({ data: { name: 'QA Engineer', role: 'qa' } })
      const companyAgent = await prisma.companyAgent.create({
        data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Nova' },
      })

      const roster = await listRoster()
      const member = roster.flatMap((c) => c.teams).flatMap((t) => t.members).find((m) => m.companyAgentId === companyAgent.id)

      expect(member?.modelSource).toBe('none')
      expect(member?.effectiveModel).toBeNull()
    })

    it("modelSource is 'worker-varies' when any of the member's materialized workers overrides its own model, even though the roster row has a model", async (): Promise<void> => {
      const { companyTeamId, templateId } = await seedRoster()
      const companyAgent = await prisma.companyAgent.create({
        data: { companyTeamId, templateId, name: 'Atlas', model: 'opus' },
      })
      await prisma.agent.create({
        data: { teamId: fixture.teamId, name: 'Atlas (worker)', role: 'backend', companyAgentId: companyAgent.id, model: 'haiku' },
      })

      const roster = await listRoster()
      const member = roster.flatMap((c) => c.teams).flatMap((t) => t.members).find((m) => m.companyAgentId === companyAgent.id)

      expect(member?.modelSource).toBe('worker-varies')
      // effectiveModel still ignores the worker override -- it is the chain result.
      expect(member?.effectiveModel).toBe('opus')
      expect(member?.workers).toHaveLength(1)
      expect(member?.workers[0]?.model).toBe('haiku')
    })

    // M12 Task 13 fix round 1, spec §8 / finding 4b: `providerSource` is `modelSource`'s pair,
    // walked over the SAME chain (worker override -> roster row -> template default) via the
    // provider columns instead of the model columns -- `chainSource` in `server/org.ts` is the
    // one function computing both.
    it("providerSource is 'roster' when the roster row's provider is set", async (): Promise<void> => {
      const { companyTeamId, templateId } = await seedRoster()
      const companyAgent = await prisma.companyAgent.create({
        data: { companyTeamId, templateId, name: 'Atlas', model: 'opus', provider: 'claude_code' },
      })

      const roster = await listRoster()
      const member = roster.flatMap((c) => c.teams).flatMap((t) => t.members).find((m) => m.companyAgentId === companyAgent.id)

      expect(member?.providerSource).toBe('roster')
      expect(member?.effectiveProvider).toBe('claude_code')
    })

    it("providerSource is 'template' when the roster row's provider is unset but the template default is set", async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Eng' } })
      const template = await prisma.agentTemplate.create({
        data: { name: 'Backend Engineer', role: 'backend', defaultModel: 'sonnet', provider: 'cursor' },
      })
      const companyAgent = await prisma.companyAgent.create({
        data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas' },
      })

      const roster = await listRoster()
      const member = roster.flatMap((c) => c.teams).flatMap((t) => t.members).find((m) => m.companyAgentId === companyAgent.id)

      expect(member?.providerSource).toBe('template')
      expect(member?.effectiveProvider).toBe('cursor')
    })

    it("providerSource is 'none' when neither the roster row nor the template default has a provider", async (): Promise<void> => {
      const { companyTeamId, templateId } = await seedRoster()
      const companyAgent = await prisma.companyAgent.create({
        data: { companyTeamId, templateId, name: 'Atlas' },
      })

      const roster = await listRoster()
      const member = roster.flatMap((c) => c.teams).flatMap((t) => t.members).find((m) => m.companyAgentId === companyAgent.id)

      expect(member?.providerSource).toBe('none')
      expect(member?.effectiveProvider).toBeNull()
    })

    it("providerSource is 'worker-varies' when any of the member's materialized workers overrides its own provider, even though the roster row has a provider", async (): Promise<void> => {
      const { companyTeamId, templateId } = await seedRoster()
      const companyAgent = await prisma.companyAgent.create({
        data: { companyTeamId, templateId, name: 'Atlas', model: 'opus', provider: 'cursor' },
      })
      await prisma.agent.create({
        data: {
          teamId: fixture.teamId,
          name: 'Atlas (worker)',
          role: 'backend',
          companyAgentId: companyAgent.id,
          model: 'haiku',
          provider: 'claude_code',
        },
      })

      const roster = await listRoster()
      const member = roster.flatMap((c) => c.teams).flatMap((t) => t.members).find((m) => m.companyAgentId === companyAgent.id)

      expect(member?.providerSource).toBe('worker-varies')
      // effectiveProvider still ignores the worker override -- it is the chain result.
      expect(member?.effectiveProvider).toBe('cursor')
      expect(member?.workers[0]?.provider).toBe('claude_code')
    })

    it("reuses overview's status/current-task derivation for each worker sub-row", async (): Promise<void> => {
      const { companyTeamId, templateId } = await seedRoster()
      const companyAgent = await prisma.companyAgent.create({
        data: { companyTeamId, templateId, name: 'Atlas' },
      })
      const worker = await prisma.agent.create({
        data: { teamId: fixture.teamId, name: 'Atlas (worker)', role: 'backend', companyAgentId: companyAgent.id },
      })
      const run = await prisma.agentRun.create({
        data: { taskId: fixture.taskId, agentId: worker.id, status: 'working', toolCalls: 50 },
      })
      await prisma.task.update({ where: { id: fixture.taskId }, data: { activeRunId: run.id } })

      const roster = await listRoster()
      const member = roster.flatMap((c) => c.teams).flatMap((t) => t.members).find((m) => m.companyAgentId === companyAgent.id)
      const workerRow = member?.workers.find((w) => w.agentId === worker.id)

      expect(workerRow?.status).toBe('working')
      expect(workerRow?.workspaceId).toBe(fixture.workspaceId)
      expect(workerRow?.projectName).toBe('Checkout Platform')
      expect(workerRow?.currentTask?.title).toBe('Add the thing')
      expect(workerRow?.currentTask?.pct).toBe(25) // 50 tool calls / 200 max = 25%
    })

    it('reports idle with no current task for a worker with no live run', async (): Promise<void> => {
      const { companyTeamId, templateId } = await seedRoster()
      const companyAgent = await prisma.companyAgent.create({
        data: { companyTeamId, templateId, name: 'Atlas' },
      })
      await prisma.agent.create({
        data: { teamId: fixture.teamId, name: 'Atlas (worker)', role: 'backend', companyAgentId: companyAgent.id },
      })

      const roster = await listRoster()
      const member = roster.flatMap((c) => c.teams).flatMap((t) => t.members).find((m) => m.companyAgentId === companyAgent.id)

      expect(member?.workers[0]?.status).toBe('idle')
      expect(member?.workers[0]?.currentTask).toBeNull()
    })
  })

  describe('listWorkers', () => {
    it('returns every agent across every workspace, staffed from a company or not', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Eng' } })
      const template = await prisma.agentTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })
      const companyAgent = await prisma.companyAgent.create({
        data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas' },
      })
      await prisma.agent.create({
        data: { teamId: fixture.teamId, name: 'Atlas (worker)', role: 'backend', companyAgentId: companyAgent.id },
      })
      // `seed()`'s hand-made 'Alex' has no roster link. Re-pointed by the M14 fix wave (review
      // I4): it MUST appear -- the old filter is what rendered the Agents page as a bare header
      // on every development database whose agents were never staffed from a company.
      const workers = await listWorkers()

      expect(workers.map((w) => w.name)).toEqual(['Alex', 'Atlas (worker)'])
      const atlas = workers.find((w) => w.name === 'Atlas (worker)')
      expect(atlas?.role).toBe('backend')
      expect(atlas?.workspaceId).toBe(fixture.workspaceId)
      expect(atlas?.projectName).toBe('Checkout Platform')
    })

    // Review I4, the ruling stated positively: an agent is an `Agent` row on a workspace's team.
    // `department` is the team name (which every agent has); the company is optional.
    it('lists an agent that was never staffed from a company, under its team name', async (): Promise<void> => {
      const workers = await listWorkers()

      expect(workers).toHaveLength(1)
      expect(workers[0]?.name).toBe('Alex')
      expect(workers[0]?.department).toBe('Engineering')
      expect(workers[0]?.projectName).toBe('Checkout Platform')
      expect(workers[0]?.status).toBe('idle')
    })

    it('returns an empty list only when the database holds no agents at all', async (): Promise<void> => {
      await prisma.agent.deleteMany({})
      const workers = await listWorkers()
      expect(workers).toEqual([])
    })

    // Task 9 (C2): `WorkerRow` gains `department`/`provider`/`gate`/`tokens`/`costUsd`/
    // `unmeasuredRuns`. `department` is the worker's TEAM name -- `seed()`'s own team is named
    // 'Engineering', so a roster-linked worker on `fixture.teamId` proves this without a second
    // team fixture.
    it('carries the team name as the department, and the live run provider', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Eng' } })
      const template = await prisma.agentTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })
      const companyAgent = await prisma.companyAgent.create({
        data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas' },
      })
      await prisma.agent.create({
        data: { teamId: fixture.teamId, name: 'Atlas (worker)', role: 'backend', companyAgentId: companyAgent.id },
      })

      const workers = await listWorkers()
      // Re-pointed by the M14 fix wave (review I4): `listWorkers` no longer filters to
      // roster-linked agents, so `seed()`'s 'Alex' sorts ahead of 'Atlas (worker)' and index 0 is
      // no longer this test's subject. Selected by name instead of by position.
      const atlas = workers.find((w) => w.name === 'Atlas (worker)')

      // No run at all yet -- `provider` is null exactly as `AgentCardData.provider` is with no
      // live run: a worker's runtime is not decided until a run resolves it.
      expect(atlas?.department).toBe('Engineering')
      expect(atlas?.provider).toBeNull()
    })

    it('sums tokens only over runs that reported them, and says null when none did', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Eng' } })
      const template = await prisma.agentTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })
      const companyAgent = await prisma.companyAgent.create({
        data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas' },
      })
      const worker = await prisma.agent.create({
        data: { teamId: fixture.teamId, name: 'Atlas (worker)', role: 'backend', companyAgentId: companyAgent.id },
      })

      // Re-pointed by the M14 fix wave (review I4), same reason as above: by name, not by index.
      const atlasIn = (rows: readonly { name: string }[]): number =>
        rows.findIndex((w) => w.name === 'Atlas (worker)')

      const before = await listWorkers()
      expect(before[atlasIn(before)]?.tokens).toBeNull()

      // A live (non-terminal) run that reported tokens and a provider -- `provider` and `tokens`
      // both read off this one.
      await prisma.agentRun.create({
        data: { agentId: worker.id, taskId: fixture.taskId, status: 'working', provider: 'claude_code', tokensIn: 1200, tokensOut: 300 },
      })
      // A finished run that never reported tokens -- must NOT contribute a 0 to the sum, and
      // must not be the one `provider` is read from (it is terminal).
      await prisma.agentRun.create({
        data: { agentId: worker.id, taskId: fixture.taskId, status: 'succeeded', provider: 'claude_code', tokensIn: null, tokensOut: null },
      })

      const after = await listWorkers()
      expect(after[atlasIn(after)]?.tokens).toBe(1500)
      expect(after[atlasIn(after)]?.provider).toBe('claude_code')
    })
  })

  describe('listTemplates and listCompanies', () => {
    it('returns the created templates and companies', async (): Promise<void> => {
      await prisma.agentTemplate.create({
        data: { name: 'Backend Engineer', role: 'backend', description: 'ships backend code', defaultModel: 'sonnet' },
      })
      await prisma.company.create({ data: { name: 'Acme Robotics' } })

      const templates = await listTemplates()
      const companies = await listCompanies()

      // `defaultProvider: null` (M12 Task 13): `listTemplates` now carries the pair's other half
      // beside `defaultModel`, `null` here because this fixture's `agentTemplate.create` above
      // sets no `provider`.
      expect(templates).toEqual([
        {
          id: expect.any(String),
          name: 'Backend Engineer',
          role: 'backend',
          description: 'ships backend code',
          defaultModel: 'sonnet',
          defaultProvider: null,
        },
      ])
      expect(companies).toEqual([{ id: expect.any(String), name: 'Acme Robotics' }])
    })
  })
})
