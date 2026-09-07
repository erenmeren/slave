import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { assignCompany } from '../../src/org.js'
import { adoptSimulation, adoptionPreview, createSimulation, loadSimulation } from '../../src/simulation.js'

/** The catalog's "Checkout Platform" crew, exactly as `software.test.ts` seeds it: the roster the
 *  software sector staffs product / lead / reviewer / four engineers from, plus two members
 *  (Sarah, Oliver) the run never names -- the ones whose CATALOG role must survive adoption. */
const CHECKOUT: readonly { readonly name: string; readonly department: string; readonly role: string }[] = [
  { name: 'Atlas', department: 'Management', role: 'manager' },
  { name: 'Alex', department: 'Engineering', role: 'Backend' },
  { name: 'Emma', department: 'Engineering', role: 'Frontend' },
  { name: 'Daniel', department: 'Engineering', role: 'DevOps' },
  { name: 'Maya', department: 'Engineering', role: 'QA' },
  { name: 'Riley', department: 'Engineering', role: 'reviewer' },
  { name: 'Sarah', department: 'Security', role: 'Security' },
  { name: 'John', department: 'Product', role: 'Business Analyst' },
  { name: 'Oliver', department: 'Marketing', role: 'SEO' },
]

/** The M29 trade roster: four departments named for the trade sector's roles. A trade run is what
 *  `not_adoptable` exists for. */
const TRADING: readonly { readonly name: string; readonly department: string; readonly role: string }[] = [
  { name: 'Sonia', department: 'Sales', role: 'clerk' },
  { name: 'Pete', department: 'Purchasing', role: 'clerk' },
  { name: 'Olga', department: 'Operations', role: 'clerk' },
  { name: 'Fin', department: 'Finance', role: 'clerk' },
]

async function seedCompany(name: string, roster: readonly { readonly name: string; readonly department: string; readonly role: string }[]): Promise<string> {
  const company = await prisma.company.create({ data: { name } })
  const teams = new Map<string, string>()
  for (const member of roster) {
    let teamId = teams.get(member.department)
    if (teamId === undefined) {
      const team = await prisma.companyTeam.create({ data: { companyId: company.id, name: member.department } })
      teamId = team.id
      teams.set(member.department, teamId)
    }
    const templateName = `${name} ${member.role}`
    const template = await prisma.slaveTemplate.upsert({ where: { name: templateName }, create: { name: templateName, role: member.role }, update: {} })
    await prisma.companySlave.create({ data: { companyTeamId: teamId, templateId: template.id, name: member.name } })
  }
  return company.id
}

/** A workspace row with no company: adoption's whole target. `repoPath` is never touched at this
 *  level (no git probe runs in `assignCompany`), so any string does.
 *
 *  Deliberately NOT on the column defaults (review round 1): `autoMerge: true` is what §1
 *  principle 3 exists to switch back off, `maxAttempts: 5` is a value the proposal must be seen to
 *  MOVE rather than coincide with, and `budgetUsd: 12` is a real budget adoption must leave
 *  exactly where it found it (§1 principle 2 -- simulated money never becomes a real one). */
async function seedWorkspace(name: string, over: { readonly archivedAt?: Date } = {}): Promise<{ id: string; name: string }> {
  const workspace = await prisma.workspace.create({
    data: { name, repoPath: '/tmp/x', verifyCommands: [], setupCommands: [], companyId: null, autoMerge: true, maxAttempts: 5, budgetUsd: 12, ...over },
  })
  return { id: workspace.id, name: workspace.name }
}

let companyId: string
let tradingId: string
let alpha: { id: string; name: string }
let beta: { id: string; name: string }
let archived: { id: string; name: string }

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "SimulationModelUsage", "SimulationJournalEntry", "SimulationRun", "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE')
  companyId = await seedCompany('Checkout Platform', CHECKOUT)
  tradingId = await seedCompany('Demo Trading Co.', TRADING)
  alpha = await seedWorkspace('Alpha Project')
  beta = await seedWorkspace('Beta Project')
  archived = await seedWorkspace('Zeta Project', { archivedAt: new Date() })
})
afterAll(async () => { await prisma.$disconnect() })

/** A rules-decided software run on policy A. */
async function softwareRun(name = 'ship it', policy: 'A' | 'B' = 'A'): Promise<string> {
  const result = await createSimulation({ companyId, name, sector: 'software', policy, seed: 1 })
  expect(result.ok).toBe(true)
  return result.ok ? result.value.id : ''
}

/** An `llm` software run on policy B. Creating the row makes NO model call -- the model only ever
 *  runs from the auto-run daemon -- so this is as cheap as the rules run above. */
async function llmRun(name = 'model run'): Promise<string> {
  const result = await createSimulation({
    companyId, name, sector: 'software', policy: 'B', seed: 1,
    decisionProvider: 'llm', modelProvider: 'claude_code', model: 'claude-opus-4', maxModelCostUsd: 5,
  })
  expect(result.ok).toBe(true)
  return result.ok ? result.value.id : ''
}

async function tradeRun(): Promise<string> {
  const result = await createSimulation({ companyId: tradingId, name: 'Q3 plan', sector: 'trade', policy: 'A', seed: 1 })
  expect(result.ok).toBe(true)
  return result.ok ? result.value.id : ''
}

describe('adoptionPreview', () => {
  it('reads the roles off the run, proposes 4 concurrent runs and 3 attempts for policy A, and no model', async () => {
    const id = await softwareRun()

    const preview = await adoptionPreview(id)

    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.value.simulationId).toBe(id)
    expect(preview.value.companyId).toBe(companyId)
    expect(preview.value.companyName).toBe('Checkout Platform')
    // Roster order: departments by name, members by name -- exactly how `createSimulation` reads a
    // catalog roster. Sarah and Oliver are in neither `roles` nor `engineers`, so they keep the
    // catalog role they were instantiated from.
    expect(preview.value.roles).toEqual([
      { slaveName: 'Alex', catalogRole: 'Backend', role: 'backend' },
      { slaveName: 'Daniel', catalogRole: 'DevOps', role: 'devops' },
      { slaveName: 'Emma', catalogRole: 'Frontend', role: 'frontend' },
      { slaveName: 'Maya', catalogRole: 'QA', role: 'general' },
      { slaveName: 'Riley', catalogRole: 'reviewer', role: 'reviewer' },
      { slaveName: 'Atlas', catalogRole: 'manager', role: 'lead' },
      { slaveName: 'Oliver', catalogRole: 'SEO', role: 'SEO' },
      { slaveName: 'John', catalogRole: 'Business Analyst', role: 'product' },
      { slaveName: 'Sarah', catalogRole: 'Security', role: 'Security' },
    ])
    expect(preview.value.settings).toEqual({ maxConcurrentRuns: 4, maxAttempts: 3, autoMerge: false })
    expect(preview.value.model).toBeNull()
  })

  it('proposes 2 attempts for policy B and carries an llm run\'s model', async () => {
    const id = await llmRun()

    const preview = await adoptionPreview(id)

    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.value.settings).toEqual({ maxConcurrentRuns: 4, maxAttempts: 2, autoMerge: false })
    expect(preview.value.model).toEqual({ provider: 'claude_code', model: 'claude-opus-4' })
  })

  it('offers only the workspaces with no company and no archive date', async () => {
    const id = await softwareRun()

    const preview = await adoptionPreview(id)

    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.value.workspaces).toEqual([
      { id: alpha.id, name: 'Alpha Project' },
      { id: beta.id, name: 'Beta Project' },
    ])
  })

  it('drops a workspace from the list once it has a company', async () => {
    const id = await softwareRun()
    const assigned = await assignCompany(beta.id, companyId)
    expect(assigned.ok).toBe(true)

    const preview = await adoptionPreview(id)

    expect(preview.ok === true && preview.value.workspaces.map((w) => w.id)).toEqual([alpha.id])
  })

  it('refuses a trade run with the sector\'s own reason, and an unknown id', async () => {
    const id = await tradeRun()

    const preview = await adoptionPreview(id)

    expect(preview.ok === false && preview.error).toEqual({
      kind: 'not_adoptable', simulationId: id, reason: "the trade sector's roles are not software roles",
    })
    const missing = await adoptionPreview('00000000-0000-0000-0000-000000000000')
    expect(missing.ok === false && missing.error).toEqual({ kind: 'simulation_not_found', simulationId: '00000000-0000-0000-0000-000000000000' })
  })
})

describe('adoptSimulation', () => {
  it('materialises the roster with the run\'s roles, writes the settings and the provenance, and journals the adoption', async () => {
    const id = await softwareRun()

    const result = await adoptSimulation(id, { workspaceId: alpha.id })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.workspaceId).toBe(alpha.id)
    expect([...result.value.assigned.createdTeams].sort()).toEqual(['Engineering', 'Management', 'Marketing', 'Product', 'Security'])
    expect(result.value.assigned.createdWorkers).toHaveLength(9)

    const slaves = await prisma.slave.findMany({ where: { team: { workspaceId: alpha.id } }, orderBy: { name: 'asc' } })
    const byName = new Map(slaves.map((s) => [s.name, s]))
    expect(slaves).toHaveLength(9)
    // Ruling R2: `Slave.role` is what the RUNTIME dispatches on -- `planning.ts` staffs
    // `role === 'manager'`, `review.ts` staffs `role === 'reviewer'`, and the scheduler matches
    // `Task.requiredRole` to it by equality. So the run's decision roles are TRANSLATED, not
    // copied: its lead becomes the manager the planner can find, its reviewer the reviewer the
    // review pass can find, and everyone else keeps the catalog role the planner emits as a
    // `requiredRole`. Exactly one of each, so neither pass has two candidates it never had before.
    expect(slaves.filter((s) => s.role === 'manager').map((s) => s.name)).toEqual(['Atlas'])
    expect(slaves.filter((s) => s.role === 'reviewer').map((s) => s.name)).toEqual(['Riley'])
    expect(byName.get('John')?.role).toBe('Business Analyst')
    expect(byName.get('Alex')?.role).toBe('Backend')
    expect(byName.get('Emma')?.role).toBe('Frontend')
    expect(byName.get('Daniel')?.role).toBe('DevOps')
    expect(byName.get('Maya')?.role).toBe('QA')
    expect(byName.get('Sarah')?.role).toBe('Security')
    expect(byName.get('Oliver')?.role).toBe('SEO')
    // Adoption writes no `requiredRole` at all (R2): that column names the role a TASK needs, and
    // adoption creates no tasks.
    expect(slaves.every((s) => s.requiredRole === null)).toBe(true)

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: alpha.id } })
    expect(workspace.companyId).toBe(companyId)
    expect(workspace.maxConcurrentRuns).toBe(4)
    // The seeded 5 moves to the policy's proposal, the seeded `autoMerge: true` is switched back
    // off (§1 principle 3), and the real budget is untouched (§1 principle 2).
    expect(workspace.maxAttempts).toBe(3)
    expect(workspace.autoMerge).toBe(false)
    expect(workspace.budgetUsd).toBe(12)
    expect(workspace.adoptedFromSimulationId).toBe(id)

    const entries = await prisma.simulationJournalEntry.findMany({ where: { simulationId: id }, orderBy: { seq: 'asc' } })
    const last = entries.at(-1)
    expect(last?.kind).toBe('control')
    const payload = last?.payload as unknown as { op: string; workspaceId: string; workspaceName: string; settings: unknown; roles: Record<string, string>; appliedModel: unknown }
    expect(payload.op).toBe('adopted')
    expect(payload.workspaceId).toBe(alpha.id)
    expect(payload.workspaceName).toBe('Alpha Project')
    expect(payload.settings).toEqual({ maxConcurrentRuns: 4, maxAttempts: 3 })
    expect(payload.roles).toEqual({ Atlas: 'lead', John: 'product', Riley: 'reviewer', Alex: 'backend', Daniel: 'devops', Emma: 'frontend', Maya: 'general' })
    expect(payload.appliedModel).toBeNull()

    // The watermark moves with the journal (M32 item 3): the next writer computes its seq from it.
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect((row.state as unknown as { journalSeq: number }).journalSeq).toBe(last?.seq)

    const loaded = await loadSimulation(id)
    expect(loaded.ok === true && loaded.value.summary.adoptedBy).toEqual([{ workspaceId: alpha.id, workspaceName: 'Alpha Project' }])
  })

  it('emits the company_assigned event a hand assignment emits', async () => {
    const id = await softwareRun()

    await adoptSimulation(id, { workspaceId: alpha.id })

    const events = await prisma.executionEvent.findMany({ where: { workspaceId: alpha.id, type: 'workspace_company_assigned' } })
    expect(events).toHaveLength(1)
  })

  it('refuses a second adoption into the same workspace, leaving no journal row and no provenance', async () => {
    const first = await softwareRun('one')
    const second = await softwareRun('two', 'B')
    expect((await adoptSimulation(first, { workspaceId: alpha.id })).ok).toBe(true)
    const before = await prisma.simulationJournalEntry.count({ where: { simulationId: second } })

    const result = await adoptSimulation(second, { workspaceId: alpha.id })

    expect(result.ok === false && result.error).toEqual({ kind: 'company_already_assigned', workspaceId: alpha.id, companyName: 'Checkout Platform' })
    expect(await prisma.simulationJournalEntry.count({ where: { simulationId: second } })).toBe(before)
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: alpha.id } })
    expect(workspace.adoptedFromSimulationId).toBe(first)
    expect(workspace.maxAttempts).toBe(3)
  })

  it('adopts the same run into a second workspace, and both show on the summary', async () => {
    const id = await softwareRun()

    expect((await adoptSimulation(id, { workspaceId: alpha.id })).ok).toBe(true)
    const second = await adoptSimulation(id, { workspaceId: beta.id })

    expect(second.ok).toBe(true)
    const loaded = await loadSimulation(id)
    expect(loaded.ok === true && [...loaded.value.summary.adoptedBy].map((w) => w.workspaceName).sort()).toEqual(['Alpha Project', 'Beta Project'])
  })

  it('refuses a trade run and an archived workspace, writing nothing', async () => {
    const trade = await tradeRun()

    const notAdoptable = await adoptSimulation(trade, { workspaceId: alpha.id })
    expect(notAdoptable.ok === false && notAdoptable.error).toEqual({
      kind: 'not_adoptable', simulationId: trade, reason: "the trade sector's roles are not software roles",
    })

    const id = await softwareRun()
    const archivedResult = await adoptSimulation(id, { workspaceId: archived.id })
    expect(archivedResult.ok === false && archivedResult.error).toEqual({ kind: 'workspace_archived', workspaceId: archived.id })

    const missing = await adoptSimulation(id, { workspaceId: '00000000-0000-0000-0000-000000000000' })
    expect(missing.ok === false && missing.error).toEqual({ kind: 'workspace_not_found', workspaceId: '00000000-0000-0000-0000-000000000000' })

    expect(await prisma.team.count()).toBe(0)
    expect(await prisma.workspace.count({ where: { companyId: { not: null } } })).toBe(0)
  })

  it('takes the person\'s settings when they are in range and refuses them when they are not', async () => {
    const id = await softwareRun()

    const tooMany = await adoptSimulation(id, { workspaceId: alpha.id, maxConcurrentRuns: 11 })
    expect(tooMany.ok === false && tooMany.error).toEqual({ kind: 'invalid_simulation_input', detail: 'maxConcurrentRuns must be an integer between 1 and 10' })
    const tooFew = await adoptSimulation(id, { workspaceId: alpha.id, maxAttempts: 0 })
    expect(tooFew.ok === false && tooFew.error).toEqual({ kind: 'invalid_simulation_input', detail: 'maxAttempts must be an integer between 1 and 5' })
    const fractional = await adoptSimulation(id, { workspaceId: alpha.id, maxAttempts: 2.5 })
    expect(fractional.ok === false && fractional.error).toEqual({ kind: 'invalid_simulation_input', detail: 'maxAttempts must be an integer between 1 and 5' })
    // Nothing was assigned by any of the three.
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: alpha.id } })).companyId).toBeNull()

    const result = await adoptSimulation(id, { workspaceId: alpha.id, maxConcurrentRuns: 7, maxAttempts: 5 })
    expect(result.ok).toBe(true)
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: alpha.id } })
    expect(workspace.maxConcurrentRuns).toBe(7)
    expect(workspace.maxAttempts).toBe(5)
  })

  it('leaves every roster row alone unless applyModel is ticked, and then writes only the lead\'s', async () => {
    const id = await llmRun()

    expect((await adoptSimulation(id, { workspaceId: alpha.id })).ok).toBe(true)

    const untouched = await prisma.companySlave.findMany({ where: { companyTeam: { companyId } } })
    expect(untouched.every((s) => s.model === null && s.provider === null)).toBe(true)

    const second = await llmRun('another model run')
    expect((await adoptSimulation(second, { workspaceId: beta.id, applyModel: true })).ok).toBe(true)

    const rows = await prisma.companySlave.findMany({ where: { companyTeam: { companyId } } })
    for (const row of rows) {
      if (row.name === 'Atlas') {
        expect(row.model).toBe('claude-opus-4')
        expect(row.provider).toBe('claude_code')
      } else {
        expect(row.model).toBeNull()
        expect(row.provider).toBeNull()
      }
    }
    const entries = await prisma.simulationJournalEntry.findMany({ where: { simulationId: second }, orderBy: { seq: 'desc' }, take: 1 })
    expect((entries[0]?.payload as unknown as { appliedModel: unknown }).appliedModel).toEqual({ provider: 'claude_code', model: 'claude-opus-4' })
  })

  it('ignores applyModel on a rules run, which has no model to apply', async () => {
    const id = await softwareRun()

    const result = await adoptSimulation(id, { workspaceId: alpha.id, applyModel: true })

    expect(result.ok).toBe(true)
    const rows = await prisma.companySlave.findMany({ where: { companyTeam: { companyId } } })
    expect(rows.every((s) => s.model === null && s.provider === null)).toBe(true)
  })

  it('refuses when a role the run assigned names more than one roster slave, before writing anything', async () => {
    const id = await softwareRun()
    // A second "Atlas", in a department the software sector never reads: the frozen definition
    // still names Management's Atlas as its lead, but the roster now has two rows that name
    // answers to, and adoption must not guess which one becomes the manager.
    const security = await prisma.companyTeam.findFirstOrThrow({ where: { companyId, name: 'Security' } })
    const template = await prisma.slaveTemplate.findFirstOrThrow({ where: { name: 'Checkout Platform manager' } })
    await prisma.companySlave.create({ data: { companyTeamId: security.id, templateId: template.id, name: 'Atlas' } })

    const result = await adoptSimulation(id, { workspaceId: alpha.id })

    expect(result.ok === false && result.error).toEqual({
      kind: 'invalid_simulation_input', detail: 'the roster has more than one slave named Atlas; adoption cannot tell which one the run means',
    })
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: alpha.id } })).companyId).toBeNull()
    expect(await prisma.team.count()).toBe(0)
    expect(await prisma.simulationJournalEntry.count({ where: { simulationId: id, kind: 'control' } })).toBe(1)
  })

  it('refuses applyModel when the lead\'s name is ambiguous, and writes no model', async () => {
    const id = await llmRun()
    const security = await prisma.companyTeam.findFirstOrThrow({ where: { companyId, name: 'Security' } })
    const template = await prisma.slaveTemplate.findFirstOrThrow({ where: { name: 'Checkout Platform manager' } })
    await prisma.companySlave.create({ data: { companyTeamId: security.id, templateId: template.id, name: 'Atlas' } })

    const result = await adoptSimulation(id, { workspaceId: alpha.id, applyModel: true })

    expect(result.ok === false && result.error).toEqual({
      kind: 'invalid_simulation_input', detail: "the lead's name is ambiguous in the roster; set the model by hand",
    })
    const rows = await prisma.companySlave.findMany({ where: { companyTeam: { companyId } } })
    expect(rows.every((row) => row.model === null && row.provider === null)).toBe(true)
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: alpha.id } })).companyId).toBeNull()
  })

  it('refuses an idempotency key already used for a different workspace', async () => {
    const id = await softwareRun()
    expect((await adoptSimulation(id, { workspaceId: alpha.id, idempotencyKey: 'k1' })).ok).toBe(true)

    const result = await adoptSimulation(id, { workspaceId: beta.id, idempotencyKey: 'k1' })

    expect(result.ok === false && result.error).toEqual({
      kind: 'invalid_simulation_input', detail: 'idempotency key already used for another workspace',
    })
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: beta.id } })).companyId).toBeNull()
  })

  it('replays an idempotency key without a second journal row or a second refusal', async () => {
    const id = await softwareRun()

    const first = await adoptSimulation(id, { workspaceId: alpha.id, idempotencyKey: 'k1' })
    expect(first.ok).toBe(true)
    const seqs = await prisma.simulationJournalEntry.count({ where: { simulationId: id } })

    const replay = await adoptSimulation(id, { workspaceId: alpha.id, idempotencyKey: 'k1' })

    expect(replay.ok).toBe(true)
    // A re-run materialises nothing, which is exactly what `assignCompany`'s own re-sync reports.
    expect(replay.ok === true && replay.value).toEqual({ workspaceId: alpha.id, assigned: { createdTeams: [], createdWorkers: [] } })
    expect(await prisma.simulationJournalEntry.count({ where: { simulationId: id } })).toBe(seqs)
    expect(await prisma.executionEvent.count({ where: { workspaceId: alpha.id, type: 'workspace_company_assigned' } })).toBe(1)
  })
})
