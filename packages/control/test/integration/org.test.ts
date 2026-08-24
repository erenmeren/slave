import { prisma } from '@ai-team-os/db/client'
import { beforeEach, describe, expect, it } from 'vitest'
import { addCompanyAgent, addCompanyTeam, createCompany, createTemplate } from '../../src/org.js'

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
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      const row = await prisma.agentTemplate.findUniqueOrThrow({ where: { id: result.value.id } })
      expect(row.name).toBe('Backend Engineer')
      expect(row.role).toBe('backend')
      expect(row.description).toBe('ships backend features')
      expect(row.defaultModel).toBe('claude-opus')
    })

    it('defaults description to an empty string and defaultModel to null when omitted', async (): Promise<void> => {
      const result = await createTemplate('Frontend Engineer', 'frontend')

      expect(result.ok).toBe(true)
      if (!result.ok) return
      const row = await prisma.agentTemplate.findUniqueOrThrow({ where: { id: result.value.id } })
      expect(row.description).toBe('')
      expect(row.defaultModel).toBeNull()
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

    it('creates the row under the given team and template, with an optional model override', async (): Promise<void> => {
      const { companyTeamId, templateId } = await seedTeamAndTemplate()

      const result = await addCompanyAgent(companyTeamId, templateId, 'Atlas', { model: 'claude-haiku' })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      const row = await prisma.companyAgent.findUniqueOrThrow({ where: { id: result.value.id } })
      expect(row.companyTeamId).toBe(companyTeamId)
      expect(row.templateId).toBe(templateId)
      expect(row.name).toBe('Atlas')
      expect(row.model).toBe('claude-haiku')
    })

    it('defaults model to null when omitted', async (): Promise<void> => {
      const { companyTeamId, templateId } = await seedTeamAndTemplate()

      const result = await addCompanyAgent(companyTeamId, templateId, 'Atlas')

      expect(result.ok).toBe(true)
      if (!result.ok) return
      const row = await prisma.companyAgent.findUniqueOrThrow({ where: { id: result.value.id } })
      expect(row.model).toBeNull()
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
  })
})
