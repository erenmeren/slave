import { prisma } from '@ai-team-os/db/client'
import { beforeEach, describe, expect, it } from 'vitest'
import { addCompanyAgent, addCompanyTeam, assignCompany, createCompany, createTemplate, setAgentModel } from '../../src/org.js'

describe('catalog and company CRUD', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "CompanyAgent", "CompanyTeam", "Company", "AgentTemplate" RESTART IDENTITY CASCADE',
    )
  })

  describe('createTemplate', () => {
    it('creates the row with the given fields', async (): Promise<void> => {
      const result = await createTemplate('Backend Engineer', 'backend', {
        description: 'ships backend features',
        defaultModel: 'claude-opus',
        provider: 'claude_code',
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      const row = await prisma.agentTemplate.findUniqueOrThrow({ where: { id: result.value.id } })
      expect(row.name).toBe('Backend Engineer')
      expect(row.role).toBe('backend')
      expect(row.description).toBe('ships backend features')
      expect(row.defaultModel).toBe('claude-opus')
      expect(row.provider).toBe('claude_code')
    })

    it('defaults description to an empty string and defaultModel/provider to null when omitted', async (): Promise<void> => {
      const result = await createTemplate('Frontend Engineer', 'frontend')

      expect(result.ok).toBe(true)
      if (!result.ok) return
      const row = await prisma.agentTemplate.findUniqueOrThrow({ where: { id: result.value.id } })
      expect(row.description).toBe('')
      expect(row.defaultModel).toBeNull()
      expect(row.provider).toBeNull()
    })

    it('refuses a defaultModel with no provider, creating nothing', async (): Promise<void> => {
      const result = await createTemplate('Backend Engineer', 'backend', { defaultModel: 'claude-opus' })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'model_without_provider' })
      expect(await prisma.agentTemplate.count()).toBe(0)
    })

    it('refuses a provider with no defaultModel, creating nothing', async (): Promise<void> => {
      const result = await createTemplate('Backend Engineer', 'backend', { provider: 'claude_code' })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'model_without_provider' })
      expect(await prisma.agentTemplate.count()).toBe(0)
    })

    it('refuses a provider kind nothing is configured for, creating nothing', async (): Promise<void> => {
      const result = await createTemplate('Backend Engineer', 'backend', {
        defaultModel: 'claude-opus',
        provider: 'nope' as never,
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'invalid_provider', provider: 'nope' })
      expect(await prisma.agentTemplate.count()).toBe(0)
    })

    it('refuses a duplicate template name', async (): Promise<void> => {
      await createTemplate('Backend Engineer', 'backend')
      const result = await createTemplate('Backend Engineer', 'backend')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'duplicate_name', name: 'Backend Engineer' })
      expect(await prisma.agentTemplate.count()).toBe(1)
    })

    it('refuses a whitespace name, creating nothing', async (): Promise<void> => {
      const result = await createTemplate('   ', 'backend')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'invalid_name' })
      expect(await prisma.agentTemplate.count()).toBe(0)
    })

    it('refuses a whitespace role, creating nothing', async (): Promise<void> => {
      const result = await createTemplate('Backend Engineer', '   ')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'invalid_name' })
      expect(await prisma.agentTemplate.count()).toBe(0)
    })

    it('refuses a whitespace-only defaultModel, creating nothing', async (): Promise<void> => {
      const result = await createTemplate('Backend Engineer', 'backend', { defaultModel: '  ' })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'invalid_model' })
      expect(await prisma.agentTemplate.count()).toBe(0)
    })
  })

  describe('createCompany', () => {
    it('creates the row with the given name', async (): Promise<void> => {
      const result = await createCompany('Acme Corp')

      expect(result.ok).toBe(true)
      if (!result.ok) return
      const row = await prisma.company.findUniqueOrThrow({ where: { id: result.value.id } })
      expect(row.name).toBe('Acme Corp')
    })

    it('refuses a duplicate company name', async (): Promise<void> => {
      await createCompany('Acme Corp')
      const result = await createCompany('Acme Corp')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'duplicate_name', name: 'Acme Corp' })
      expect(await prisma.company.count()).toBe(1)
    })

    it('refuses a whitespace name, creating nothing', async (): Promise<void> => {
      const result = await createCompany('   ')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'invalid_name' })
      expect(await prisma.company.count()).toBe(0)
    })
  })

  describe('addCompanyTeam', () => {
    it('creates the row under the given company', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Corp' } })

      const result = await addCompanyTeam(company.id, 'Engineering')

      expect(result.ok).toBe(true)
      if (!result.ok) return
      const row = await prisma.companyTeam.findUniqueOrThrow({ where: { id: result.value.id } })
      expect(row.companyId).toBe(company.id)
      expect(row.name).toBe('Engineering')
    })

    it('refuses an unknown company', async (): Promise<void> => {
      const unknown = '00000000-0000-4000-8000-000000000000'

      const result = await addCompanyTeam(unknown, 'Engineering')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'company_not_found', companyId: unknown })
    })

    it('refuses a duplicate team name within the same company', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Corp' } })
      await addCompanyTeam(company.id, 'Engineering')

      const result = await addCompanyTeam(company.id, 'Engineering')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'duplicate_name', name: 'Engineering' })
      expect(await prisma.companyTeam.count()).toBe(1)
    })

    it('allows the same team name under two different companies', async (): Promise<void> => {
      const a = await prisma.company.create({ data: { name: 'Acme Corp' } })
      const b = await prisma.company.create({ data: { name: 'Globex Corp' } })

      const first = await addCompanyTeam(a.id, 'Engineering')
      const second = await addCompanyTeam(b.id, 'Engineering')

      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)
    })

    it('refuses a whitespace name, creating nothing', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Corp' } })

      const result = await addCompanyTeam(company.id, '  ')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'invalid_name' })
      expect(await prisma.companyTeam.count()).toBe(0)
    })
  })

  describe('addCompanyAgent', () => {
    async function seedTeamAndTemplate(): Promise<{ companyTeamId: string; templateId: string }> {
      const company = await prisma.company.create({ data: { name: 'Acme Corp' } })
      const team = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
      const template = await prisma.agentTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })
      return { companyTeamId: team.id, templateId: template.id }
    }

    it('creates the row under the given team and template, with an optional model+provider override', async (): Promise<void> => {
      const { companyTeamId, templateId } = await seedTeamAndTemplate()

      const result = await addCompanyAgent(companyTeamId, templateId, 'Atlas', {
        model: 'claude-haiku',
        provider: 'claude_code',
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      const row = await prisma.companyAgent.findUniqueOrThrow({ where: { id: result.value.id } })
      expect(row.companyTeamId).toBe(companyTeamId)
      expect(row.templateId).toBe(templateId)
      expect(row.name).toBe('Atlas')
      expect(row.model).toBe('claude-haiku')
      expect(row.provider).toBe('claude_code')
    })

    it('defaults model and provider to null when omitted', async (): Promise<void> => {
      const { companyTeamId, templateId } = await seedTeamAndTemplate()

      const result = await addCompanyAgent(companyTeamId, templateId, 'Atlas')

      expect(result.ok).toBe(true)
      if (!result.ok) return
      const row = await prisma.companyAgent.findUniqueOrThrow({ where: { id: result.value.id } })
      expect(row.model).toBeNull()
      expect(row.provider).toBeNull()
    })

    it('refuses a model with no provider, creating nothing', async (): Promise<void> => {
      const { companyTeamId, templateId } = await seedTeamAndTemplate()

      const result = await addCompanyAgent(companyTeamId, templateId, 'Atlas', { model: 'claude-haiku' })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'model_without_provider' })
      expect(await prisma.companyAgent.count()).toBe(0)
    })

    it('refuses a provider kind nothing is configured for, creating nothing', async (): Promise<void> => {
      const { companyTeamId, templateId } = await seedTeamAndTemplate()

      const result = await addCompanyAgent(companyTeamId, templateId, 'Atlas', {
        model: 'claude-haiku',
        provider: 'nope' as never,
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'invalid_provider', provider: 'nope' })
      expect(await prisma.companyAgent.count()).toBe(0)
    })

    it('refuses an unknown company team', async (): Promise<void> => {
      const { templateId } = await seedTeamAndTemplate()
      const unknown = '00000000-0000-4000-8000-000000000000'

      const result = await addCompanyAgent(unknown, templateId, 'Atlas')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'company_team_not_found', companyTeamId: unknown })
    })

    it('refuses an unknown template', async (): Promise<void> => {
      const { companyTeamId } = await seedTeamAndTemplate()
      const unknown = '00000000-0000-4000-8000-000000000000'

      const result = await addCompanyAgent(companyTeamId, unknown, 'Atlas')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'template_not_found', templateId: unknown })
    })

    it('refuses a duplicate agent name within the same team', async (): Promise<void> => {
      const { companyTeamId, templateId } = await seedTeamAndTemplate()
      await addCompanyAgent(companyTeamId, templateId, 'Atlas')

      const result = await addCompanyAgent(companyTeamId, templateId, 'Atlas')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'duplicate_name', name: 'Atlas' })
      expect(await prisma.companyAgent.count()).toBe(1)
    })

    it('allows the same agent name in two different teams', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Corp' } })
      const teamA = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
      const teamB = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Design' } })
      const template = await prisma.agentTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })

      const first = await addCompanyAgent(teamA.id, template.id, 'Atlas')
      const second = await addCompanyAgent(teamB.id, template.id, 'Atlas')

      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)
    })

    it('refuses a whitespace name, creating nothing', async (): Promise<void> => {
      const { companyTeamId, templateId } = await seedTeamAndTemplate()

      const result = await addCompanyAgent(companyTeamId, templateId, '  ')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'invalid_name' })
      expect(await prisma.companyAgent.count()).toBe(0)
    })

    it('refuses a whitespace-only model, creating nothing', async (): Promise<void> => {
      const { companyTeamId, templateId } = await seedTeamAndTemplate()

      const result = await addCompanyAgent(companyTeamId, templateId, 'Atlas', { model: '  ' })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'invalid_model' })
      expect(await prisma.companyAgent.count()).toBe(0)
    })
  })
})

describe('assignCompany', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Agent", "Team", "Workspace", "CompanyAgent", "CompanyTeam", "Company", "AgentTemplate" RESTART IDENTITY CASCADE',
    )
  })

  async function seedWorkspace(): Promise<{ id: string }> {
    const workspace = await prisma.workspace.create({
      data: {
        name: 'Checkout Platform',
        repoPath: '/tmp/does-not-matter',
        verifyCommands: ['npm test'],
        setupCommands: ['npm ci'],
      },
    })
    return { id: workspace.id }
  }

  /** Template names are made unique across calls via the company id, since they are unique globally. */
  async function seedCompanyWithRoster(
    agentCount: number,
    companyName = 'Acme Corp',
  ): Promise<{ companyId: string; companyName: string; teamName: string }> {
    const company = await prisma.company.create({ data: { name: companyName } })
    const team = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
    for (let i = 0; i < agentCount; i += 1) {
      const template = await prisma.agentTemplate.create({
        data: { name: `Role ${i}-${company.id}`, role: `role-${i}` },
      })
      await prisma.companyAgent.create({
        data: { companyTeamId: team.id, templateId: template.id, name: `Worker ${i}` },
      })
    }
    return { companyId: company.id, companyName: company.name, teamName: team.name }
  }

  it('materializes a team and workers from the roster, linking companyAgentId and emitting one event', async (): Promise<void> => {
    const workspace = await seedWorkspace()
    const { companyId, companyName, teamName } = await seedCompanyWithRoster(3)

    const result = await assignCompany(workspace.id, companyId)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.createdTeams).toEqual([teamName])
    expect(result.value.createdWorkers).toHaveLength(3)

    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
    expect(ws.companyId).toBe(companyId)

    expect(await prisma.team.count({ where: { workspaceId: workspace.id } })).toBe(1)
    const team = await prisma.team.findFirstOrThrow({ where: { workspaceId: workspace.id } })
    expect(team.name).toBe(teamName)

    const agents = await prisma.agent.findMany({ where: { teamId: team.id } })
    expect(agents).toHaveLength(3)
    for (const agent of agents) {
      expect(agent.companyAgentId).not.toBeNull()
      expect(agent.role).toMatch(/^role-\d$/)
    }

    for (const worker of result.value.createdWorkers) {
      expect(worker.companyAgentId).not.toBe('')
      const agent = agents.find((a) => a.name === worker.name)
      expect(agent?.companyAgentId).toBe(worker.companyAgentId)
    }

    const events = await prisma.executionEvent.findMany({
      where: { workspaceId: workspace.id, type: 'workspace_company_assigned' },
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.actor).toBe('human')
    const payload = events[0]?.payload as unknown as {
      company: string
      workers: readonly { companyAgentId: string; name: string; role: string }[]
    }
    expect(payload.company).toBe(companyName)
    expect(payload.workers).toHaveLength(3)
    for (const worker of payload.workers) {
      const agent = agents.find((a) => a.name === worker.name)
      expect(agent?.companyAgentId).toBe(worker.companyAgentId)
    }
  })

  it('re-running immediately creates nothing new but still emits an event with an empty workers array', async (): Promise<void> => {
    const workspace = await seedWorkspace()
    const { companyId } = await seedCompanyWithRoster(3)
    await assignCompany(workspace.id, companyId)

    const result = await assignCompany(workspace.id, companyId)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.createdTeams).toEqual([])
    expect(result.value.createdWorkers).toEqual([])

    expect(await prisma.agent.count()).toBe(3)

    const events = await prisma.executionEvent.findMany({
      where: { workspaceId: workspace.id, type: 'workspace_company_assigned' },
      orderBy: { seq: 'asc' },
    })
    expect(events).toHaveLength(2)
    expect(events[1]?.payload).toMatchObject({ workers: [] })
  })

  it('grows by exactly one worker when the roster gains a member, leaving existing rows untouched', async (): Promise<void> => {
    const workspace = await seedWorkspace()
    const { companyId } = await seedCompanyWithRoster(3)
    await assignCompany(workspace.id, companyId)
    const before = await prisma.agent.findMany({ orderBy: { name: 'asc' } })

    const team = await prisma.companyTeam.findFirstOrThrow({ where: { companyId } })
    const template = await prisma.agentTemplate.create({ data: { name: `Role extra-${companyId}`, role: 'role-extra' } })
    await prisma.companyAgent.create({
      data: { companyTeamId: team.id, templateId: template.id, name: 'Worker extra' },
    })

    const result = await assignCompany(workspace.id, companyId)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.createdWorkers).toHaveLength(1)
    expect(result.value.createdWorkers[0]?.name).toBe('Worker extra')

    const after = await prisma.agent.findMany({ orderBy: { name: 'asc' } })
    expect(after).toHaveLength(4)
    for (const row of before) {
      expect(after.find((a) => a.id === row.id)).toEqual(row)
    }
  })

  it('refuses when the workspace is already assigned to a different company, changing nothing', async (): Promise<void> => {
    const workspace = await seedWorkspace()
    const { companyId: firstCompanyId } = await seedCompanyWithRoster(1)
    await assignCompany(workspace.id, firstCompanyId)

    const other = await prisma.company.create({ data: { name: 'Globex Corp' } })

    const result = await assignCompany(workspace.id, other.id)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: 'company_already_assigned',
        workspaceId: workspace.id,
        companyName: 'Acme Corp',
      })
    }

    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
    expect(ws.companyId).toBe(firstCompanyId)
    expect(await prisma.team.count()).toBe(1)
    expect(await prisma.agent.count()).toBe(1)
  })

  it('serialises two concurrent assigns of different companies so exactly one wins, never a silent overwrite', async (): Promise<void> => {
    const workspace = await seedWorkspace()
    const a = await seedCompanyWithRoster(1, 'Acme Corp')
    const b = await seedCompanyWithRoster(1, 'Globex Corp')

    // Two operators racing to assign two DIFFERENT companies to the same not-yet-assigned
    // workspace at the same instant. Under READ COMMITTED with no lock, both transactions would
    // observe companyId === null before either commits, both pass the refusal check, and both
    // write -- the second silently overwriting the first's companyId with no refusal and nothing
    // in the event log to explain it. The `SELECT ... FOR UPDATE` re-check inside the transaction
    // (mirroring `dependency.ts:addTaskDependency`) serialises the two calls instead: exactly one
    // must win.
    const [first, second] = await Promise.all([
      assignCompany(workspace.id, a.companyId),
      assignCompany(workspace.id, b.companyId),
    ])

    const results = [first, second]
    const succeeded = results.filter((r) => r.ok)
    const refused = results.filter((r) => !r.ok)
    expect(succeeded).toHaveLength(1)
    expect(refused).toHaveLength(1)
    if (!refused[0]!.ok) expect(refused[0]!.error.kind).toBe('company_already_assigned')

    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
    expect([a.companyId, b.companyId]).toContain(ws.companyId)

    // Exactly the winner's roster materialized -- the loser wrote nothing, not even a team.
    expect(await prisma.team.count({ where: { workspaceId: workspace.id } })).toBe(1)
    expect(await prisma.agent.count()).toBe(1)
  })

  it('keeps a pre-existing hand-made team and agent, materializing alongside them', async (): Promise<void> => {
    const workspace = await seedWorkspace()
    const legacyTeam = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Legacy Ops' } })
    const legacyAgent = await prisma.agent.create({ data: { teamId: legacyTeam.id, name: 'OldHand', role: 'legacy' } })
    const { companyId, teamName } = await seedCompanyWithRoster(2)

    const result = await assignCompany(workspace.id, companyId)

    expect(result.ok).toBe(true)

    const stillThere = await prisma.agent.findUniqueOrThrow({ where: { id: legacyAgent.id } })
    expect(stillThere.name).toBe('OldHand')
    expect(stillThere.role).toBe('legacy')

    const teams = await prisma.team.findMany({ where: { workspaceId: workspace.id } })
    expect(teams.map((t) => t.name).sort()).toEqual(['Legacy Ops', teamName].sort())
  })

  it('stamps companyTeamId on a freshly created team', async (): Promise<void> => {
    const workspace = await seedWorkspace()
    const { companyId, teamName } = await seedCompanyWithRoster(1)
    const companyTeam = await prisma.companyTeam.findFirstOrThrow({ where: { companyId } })

    await assignCompany(workspace.id, companyId)

    const team = await prisma.team.findFirstOrThrow({ where: { workspaceId: workspace.id, name: teamName } })
    expect(team.companyTeamId).toBe(companyTeam.id)
  })

  it('re-assigning after the CompanyTeam is renamed matches by id, creating no duplicate team and no new workers', async (): Promise<void> => {
    const workspace = await seedWorkspace()
    const { companyId } = await seedCompanyWithRoster(2)
    await assignCompany(workspace.id, companyId)
    const before = await prisma.team.findMany({ where: { workspaceId: workspace.id } })
    expect(before).toHaveLength(1)

    const companyTeam = await prisma.companyTeam.findFirstOrThrow({ where: { companyId } })
    await prisma.$executeRawUnsafe('UPDATE "CompanyTeam" SET name = $1 WHERE id = $2', 'Renamed Team', companyTeam.id)

    const result = await assignCompany(workspace.id, companyId)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.createdTeams).toEqual([])
    expect(result.value.createdWorkers).toEqual([])

    const teams = await prisma.team.findMany({ where: { workspaceId: workspace.id } })
    expect(teams).toHaveLength(1)
    expect(teams[0]?.id).toBe(before[0]?.id)
    // The materialized team's own name is NOT retroactively renamed -- only newly created teams
    // pick up the roster's current name (Decision 6, additive-only).
    expect(await prisma.agent.count({ where: { team: { workspaceId: workspace.id } } })).toBe(2)
  })

  it('adopts a pre-existing hand-made team with the same name on first assign, stamping it rather than duplicating', async (): Promise<void> => {
    const workspace = await seedWorkspace()
    const { companyId, teamName } = await seedCompanyWithRoster(1)
    const legacyTeam = await prisma.team.create({ data: { workspaceId: workspace.id, name: teamName } })

    const result = await assignCompany(workspace.id, companyId)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.createdTeams).toEqual([])

    const teams = await prisma.team.findMany({ where: { workspaceId: workspace.id } })
    expect(teams).toHaveLength(1)
    expect(teams[0]?.id).toBe(legacyTeam.id)
    const companyTeam = await prisma.companyTeam.findFirstOrThrow({ where: { companyId } })
    expect(teams[0]?.companyTeamId).toBe(companyTeam.id)

    expect(await prisma.agent.count({ where: { teamId: legacyTeam.id } })).toBe(1)
  })

  it('rolls back the whole assignment when a roster template has gone dangling mid-transaction', async (): Promise<void> => {
    const workspace = await seedWorkspace()
    const { companyId } = await seedCompanyWithRoster(1)
    const companyAgent = await prisma.companyAgent.findFirstOrThrow({ where: { companyTeam: { companyId } } })

    // Force the FK target to go missing out from under the seeded CompanyAgent -- a state a plain
    // RESTRICT-backed delete can never produce, so the trigger-based FK check is disabled for the
    // width of one transaction (`SET LOCAL` unwinds automatically at commit; nothing else in the
    // process is affected) and the template is deleted while still referenced.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`)
      await tx.$executeRawUnsafe('DELETE FROM "AgentTemplate" WHERE id = $1', companyAgent.templateId)
    })

    await expect(assignCompany(workspace.id, companyId)).rejects.toThrow()

    expect(await prisma.agent.count()).toBe(0)
    expect(await prisma.team.count()).toBe(0)
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
    expect(ws.companyId).toBeNull()
  })
})

describe('setAgentModel', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  async function seedAgent(): Promise<{ id: string }> {
    const workspace = await prisma.workspace.create({
      data: { name: 'Checkout Platform', repoPath: '/tmp/does-not-matter', verifyCommands: ['true'], setupCommands: [] },
    })
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
    const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
    return { id: agent.id }
  }

  it('writes the model and provider columns together', async (): Promise<void> => {
    const { id } = await seedAgent()

    const result = await setAgentModel(id, 'claude-opus', 'claude_code')

    expect(result.ok).toBe(true)
    const row = await prisma.agent.findUniqueOrThrow({ where: { id } })
    expect(row.model).toBe('claude-opus')
    expect(row.provider).toBe('claude_code')
  })

  it('refuses an unknown agent', async (): Promise<void> => {
    const unknown = '00000000-0000-4000-8000-000000000000'

    const result = await setAgentModel(unknown, 'claude-opus', 'claude_code')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'agent_not_found', agentId: unknown })
  })

  it('refuses an empty-string model, leaving the columns unchanged', async (): Promise<void> => {
    const { id } = await seedAgent()
    await setAgentModel(id, 'claude-opus', 'claude_code')

    const result = await setAgentModel(id, '', 'claude_code')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'invalid_model' })
    const row = await prisma.agent.findUniqueOrThrow({ where: { id } })
    expect(row.model).toBe('claude-opus')
    expect(row.provider).toBe('claude_code')
  })

  it('refuses a model with no provider to run it', async (): Promise<void> => {
    const { id } = await seedAgent()

    const result = await setAgentModel(id, 'some-model', null)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'model_without_provider' })
    const row = await prisma.agent.findUniqueOrThrow({ where: { id } })
    expect(row.model).toBeNull()
    expect(row.provider).toBeNull()
  })

  it('refuses a provider with no model, the same way', async (): Promise<void> => {
    const { id } = await seedAgent()

    const result = await setAgentModel(id, null, 'claude_code')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'model_without_provider' })
    const row = await prisma.agent.findUniqueOrThrow({ where: { id } })
    expect(row.model).toBeNull()
    expect(row.provider).toBeNull()
  })

  it('refuses a provider kind nothing is configured for', async (): Promise<void> => {
    const { id } = await seedAgent()

    const result = await setAgentModel(id, 'm', 'nope' as never)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'invalid_provider', provider: 'nope' })
    const row = await prisma.agent.findUniqueOrThrow({ where: { id } })
    expect(row.model).toBeNull()
    expect(row.provider).toBeNull()
  })

  it('clears both halves of the pair together', async (): Promise<void> => {
    const { id } = await seedAgent()
    await setAgentModel(id, 'claude-opus', 'claude_code')

    const result = await setAgentModel(id, null, null)

    expect(result.ok).toBe(true)
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id } })
    expect(agent.model).toBeNull()
    expect(agent.provider).toBeNull()
  })
})
