import { prisma } from '@slave-of-ai/db/client'
import { LEAD_TEAM_NAME } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { listHelpers } from '../../src/helpers.js'

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "PersonSkill", "TemplateSkill", "Skill", "SkillProvider", "Slave", "Person", "Team", "Workspace", "SlaveTemplate" RESTART IDENTITY CASCADE',
  )
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('listHelpers (lead UX design section 6.5)', () => {
  it('lists the catalogue\'s specialists with their persona, effective skills and the projects that list them', async () => {
    const provider = await prisma.skillProvider.create({ data: { name: 'local' } })
    const [api, sql, css] = await Promise.all(['api-design', 'sql', 'css'].map((name) => prisma.skill.create({ data: { providerId: provider.id, name, description: name } })))
    if (api === undefined || sql === undefined || css === undefined) throw new Error('unreachable')
    const template = await prisma.slaveTemplate.create({ data: { name: 'Backend Architect', role: 'Backend Architect', description: ' Builds APIs. ', sourceDivision: 'engineering' } })
    await prisma.templateSkill.create({ data: { templateId: template.id, skillId: api.id } })
    await prisma.templateSkill.create({ data: { templateId: template.id, skillId: css.id } })
    const bea = await prisma.person.create({ data: { name: 'Bea', templateId: template.id } })
    await prisma.personSkill.create({ data: { personId: bea.id, skillId: sql.id, mode: 'granted' } })
    await prisma.personSkill.create({ data: { personId: bea.id, skillId: css.id, mode: 'revoked' } })
    const project = await prisma.workspace.create({ data: { name: 'Todo', repoPath: '/tmp/todo', verifyCommands: ['true'], setupCommands: [], leadRoster: [bea.id] } })

    expect(await listHelpers()).toEqual([
      { id: bea.id, name: 'Bea', role: 'Backend Architect', description: 'Builds APIs.', speciality: 'engineering', skills: ['api-design', 'sql'], projects: [{ id: project.id, name: 'Todo' }] },
    ])
  })

  it('leaves out released persons and the lead flow\'s own seats, and keeps a person with no persona', async () => {
    await prisma.person.create({ data: { name: 'Gone', releasedAt: new Date() } })
    const ws = await prisma.workspace.create({ data: { name: 'Lead', repoPath: '/tmp/lead', verifyCommands: ['true'], setupCommands: [] } })
    const team = await prisma.team.create({ data: { workspaceId: ws.id, name: LEAD_TEAM_NAME } })
    const lead = await prisma.person.create({ data: { name: 'Lead abc' } })
    await prisma.slave.create({ data: { teamId: team.id, personId: lead.id, role: 'Lead' } })
    await prisma.person.create({ data: { name: 'Free Person' } })

    expect((await listHelpers()).map((row) => [row.name, row.role, row.skills])).toEqual([['Free Person', null, []]])
  })
})
