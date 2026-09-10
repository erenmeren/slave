import { prisma } from '@slave-of-ai/db/client'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  addCapability,
  hireFromTemplate,
  listCapabilities,
  listOrganization,
  materialiseCompanySlave,
  setSlaveCapabilities,
  syncCapabilityTaxonomy,
} from '../../src/capability.js'

/**
 * The package's own truncate idiom (there is no shared helper in this directory): the project and
 * catalog tables this file writes, and NOT `Capability`.
 *
 * The taxonomy is left in place deliberately. It is a SEEDED table every other integration file in
 * this database reads (a planning prompt's key list, a projection), and truncating it mid-run would
 * empty it under a test in another file. What this file must undo instead is its own operator rows
 * -- `addCapability` writes real ones and a second run of this file would otherwise refuse them as
 * duplicates -- and any seed row a case hand-edits, which `syncCapabilityTaxonomy` puts back.
 */
const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CollaborationHint", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE'

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(TRUNCATE)
  await prisma.capability.deleteMany({ where: { createdBy: { not: 'seed' } } })
  await syncCapabilityTaxonomy()
})

async function workspace(): Promise<{ workspaceId: string; teamId: string }> {
  const ws = await prisma.workspace.create({
    data: { name: 'M47 Control', repoPath: '/tmp/m47', verifyCommands: ['true'], setupCommands: [], maxAttempts: 3 },
  })
  const team = await prisma.team.create({ data: { workspaceId: ws.id, name: 'Engineering' } })
  return { workspaceId: ws.id, teamId: team.id }
}

describe('syncCapabilityTaxonomy', () => {
  it('is idempotent: a second run creates nothing and changes nothing', async (): Promise<void> => {
    const again = await syncCapabilityTaxonomy()
    expect(again).toEqual({ created: 0, updated: 0 })
    const rows = await listCapabilities()
    expect(rows.length).toBeGreaterThan(40)
    expect(rows.map((row) => row.key)).toEqual([...rows.map((row) => row.key)].toSorted())
    expect(rows.find((row) => row.key === 'security.application')?.role).toBe('security')
  })

  it('brings a hand-edited seed row back to the checked-in list, and leaves an operator row alone', async (): Promise<void> => {
    await prisma.capability.update({ where: { key: 'security.application' }, data: { label: 'wrong', role: 'backend' } })
    await prisma.capability.create({
      data: { key: 'local.thing', label: 'A local thing', domain: 'local', role: 'backend', synonyms: [], createdBy: 'human' },
    })
    const out = await syncCapabilityTaxonomy()
    expect(out.updated).toBe(1)
    const rows = await listCapabilities()
    expect(rows.find((row) => row.key === 'security.application')?.role).toBe('security')
    expect(rows.find((row) => row.key === 'local.thing')).toBeDefined()
  })
})

describe('addCapability', () => {
  it('adds an operator key and refuses a malformed one, a duplicate and a blank label', async (): Promise<void> => {
    const ok = await addCapability({ key: 'legal.contracts', label: 'Contract review', role: 'legal' })
    expect(ok.ok).toBe(true)
    expect((await listCapabilities()).find((row) => row.key === 'legal.contracts')?.domain).toBe('legal')

    for (const bad of [
      { key: 'Legal.Contracts', label: 'x', role: 'legal' },
      { key: 'legal.contracts', label: 'x', role: 'legal' },
      { key: 'legal.terms', label: '   ', role: 'legal' },
      { key: 'legal.terms', label: 'x', role: '  ' },
    ]) {
      const refused = await addCapability(bad)
      expect(refused.ok).toBe(false)
      if (refused.ok) return
      expect(refused.error.kind).toBe('invalid_capability')
    }
  })
})

describe('setSlaveCapabilities', () => {
  it('stores the resolved keys, adds their roles to the runtime roles, and never removes a role', async (): Promise<void> => {
    const { teamId } = await workspace()
    const slave = await prisma.slave.create({
      data: { teamId, name: 'Rae', role: 'Engineer', runtimeRoles: ['backend'] },
    })
    const out = await setSlaveCapabilities(slave.id, ['Application security', 'Vibes'], 'operator')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.keys).toEqual(['security.application'])
    expect(out.value.unresolved).toEqual(['Vibes'])
    // The union, in the order M37's `addRuntimeRoles` writes it: what was held, then what is new.
    expect(out.value.runtimeRoles).toEqual(['backend', 'security'])
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: slave.id } })
    expect(row.capabilities).toEqual(['security.application'])
  })

  it('refuses a slave that is not there', async (): Promise<void> => {
    const out = await setSlaveCapabilities('nope', ['appsec'], 'operator')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.kind).toBe('slave_not_found')
  })
})

describe('hireFromTemplate', () => {
  it('creates a project worker carrying the template capabilities, their roles, the template and the rationale', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })
    const out = await hireFromTemplate(workspaceId, template.id, { rationale: 'authentication work needs application security' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.reused).toBe(false)
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: out.value.slaveId } })
    expect(row.capabilities).toEqual(['security.application'])
    expect(row.runtimeRoles).toEqual(['security'])
    expect(row.hiredFromTemplateId).toBe(template.id)
    expect(row.selectionRationale).toBe('authentication work needs application security')
    expect(row.name).toBe('Security Reviewer')
    // `org.changed { field: 'created' }` -- there is no `slave.created` event in this repository.
    const events = await prisma.executionEvent.findMany({ where: { workspaceId, type: 'org_changed' } })
    expect(events).toHaveLength(1)
  })

  // E10: two capability situations in ONE pass can both propose the same template.
  it('reuses the worker it already hired from that template rather than hiring a second', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application', 'qa.test-automation'] },
    })
    const first = await hireFromTemplate(workspaceId, template.id, { rationale: 'first' })
    const second = await hireFromTemplate(workspaceId, template.id, { rationale: 'second' })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.value.slaveId).toBe(first.value.slaveId)
    expect(second.value.reused).toBe(true)
    expect(await prisma.slave.count({ where: { team: { workspaceId } } })).toBe(1)
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: first.value.slaveId } })
    // The rationale of the FIRST hire is not overwritten: it is why this worker is here.
    expect(row.selectionRationale).toBe('first')
  })

  it('names a second worker from the same template distinctly when the project already has that name', async (): Promise<void> => {
    const { workspaceId, teamId } = await workspace()
    await prisma.slave.create({ data: { teamId, name: 'Security Reviewer', role: 'x', runtimeRoles: [] } })
    const template = await prisma.slaveTemplate.create({ data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'] } })
    const out = await hireFromTemplate(workspaceId, template.id, { rationale: 'why' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: out.value.slaveId } })
    expect(row.name).toBe('Security Reviewer 2')
  })

  it('refuses an unknown template, an unknown workspace and a capability the taxonomy does not have', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    expect((await hireFromTemplate(workspaceId, 'nope', { rationale: 'x' })).ok).toBe(false)
    const template = await prisma.slaveTemplate.create({ data: { name: 'T', role: 'security' } })
    expect((await hireFromTemplate('nope', template.id, { rationale: 'x' })).ok).toBe(false)

    const unknown = await hireFromTemplate(workspaceId, template.id, { rationale: 'x', capabilities: ['nope.nothing'] })
    expect(unknown.ok).toBe(false)
    if (unknown.ok) return
    expect(unknown.error.kind).toBe('capability_not_found')
    // Refused BEFORE the write: nothing was hired.
    expect(await prisma.slave.count({ where: { team: { workspaceId } } })).toBe(0)
  })
})

describe('materialiseCompanySlave', () => {
  it('brings ONE roster worker onto the project, with its template capabilities and their roles', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Roster Security', role: 'security', capabilityKeys: ['security.application'] },
    })
    const company = await prisma.company.create({ data: { name: 'M47 Co' } })
    const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Security' } })
    const rosterRow = await prisma.companySlave.create({
      data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Sam' },
    })
    const out = await materialiseCompanySlave(workspaceId, rosterRow.id, { rationale: 'the board needs application security' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: out.value.slaveId } })
    expect(row.companySlaveId).toBe(rosterRow.id)
    expect(row.capabilities).toEqual(['security.application'])
    expect(row.runtimeRoles).toEqual(['security'])
    // The department is created from the roster team, exactly as `assignCompanyTx` does it.
    const team = await prisma.team.findUniqueOrThrow({ where: { id: row.teamId } })
    expect(team.companyTeamId).toBe(companyTeam.id)
    // Idempotent: the same roster row twice is the same worker.
    const again = await materialiseCompanySlave(workspaceId, rosterRow.id, {})
    expect(again.ok && again.value.created).toBe(false)
  })
})

describe('listOrganization', () => {
  it('reads every worker with what it provides, why it is here, and the hints its template carries', async (): Promise<void> => {
    const { workspaceId, teamId } = await workspace()
    const advisor = await prisma.slaveTemplate.create({ data: { name: 'Gate Platform Builder', role: 'backend' } })
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })
    await prisma.collaborationHint.create({
      data: {
        templateId: template.id,
        text: 'Hand the gate work to the Gate Platform Builder.',
        targetTemplateId: advisor.id,
        capability: 'security.application',
      },
    })
    await prisma.slave.create({ data: { teamId, name: 'Ada', role: 'backend', runtimeRoles: ['backend'] } })
    const hired = await hireFromTemplate(workspaceId, template.id, { rationale: 'the board needs application security' })
    expect(hired.ok).toBe(true)
    if (!hired.ok) return

    const view = await listOrganization(workspaceId)
    expect(view.ok).toBe(true)
    if (!view.ok) return
    expect(view.value.workers.map((worker) => worker.name)).toEqual(['Ada', 'Security Reviewer'])
    const worker = view.value.workers[1]
    expect(worker?.kind).toBe('project')
    expect(worker?.capabilities).toEqual(['security.application'])
    expect(worker?.hiredFromTemplateName).toBe('Security Reviewer')
    expect(worker?.selectionRationale).toBe('the board needs application security')
    expect(worker?.busy).toBe(false)
    expect(view.value.hints).toEqual([
      {
        slaveId: hired.value.slaveId,
        text: 'Hand the gate work to the Gate Platform Builder.',
        targetTemplateName: 'Gate Platform Builder',
        capability: 'security.application',
      },
    ])
  })

  it('refuses a workspace that is not there', async (): Promise<void> => {
    const out = await listOrganization('nope')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.kind).toBe('workspace_not_found')
  })
})
