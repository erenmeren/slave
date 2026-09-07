import { prisma } from '@slave-of-ai/db/client'
import { sectors } from '@slave-of-ai/simulation'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyModelDecision,
  cloneSimulation,
  companiesForSector,
  compareSimulations,
  createSimulation,
  injectExternalEvent,
  loadSimulation,
  prepareModelDecision,
  replaySimulation,
  simulationStatus,
  startAutoRun,
  stepSimulation,
  type ModelOutcome,
} from '../../src/simulation.js'

/** The catalog's "Checkout Platform" crew, exactly as `packages/db/src/seed.ts` seeds the demo
 *  roster (its `TEAMS`/`SLAVES`): a Management slave, a Product slave, a dedicated reviewer and
 *  four more Engineering slaves whose catalog ROLE is where the software sector reads expertise
 *  from. The role lives on the template (`SlaveTemplate.role`), not on `CompanySlave`, so each
 *  member here is instantiated from a template carrying its own role. */
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

/** The M29 trade roster: four departments named for the trade sector's roles, no Product slave and
 *  no engineers — a company the software sector cannot staff, and the other half of the
 *  `companiesForSector` check. */
const TRADING: readonly { readonly name: string; readonly department: string; readonly role: string }[] = [
  { name: 'Sonia', department: 'Sales', role: 'clerk' },
  { name: 'Pete', department: 'Purchasing', role: 'clerk' },
  { name: 'Olga', department: 'Operations', role: 'clerk' },
  { name: 'Fin', department: 'Finance', role: 'clerk' },
]

let companyId: string
let tradingId: string
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "SimulationModelUsage", "SimulationJournalEntry", "SimulationRun", "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE')
  companyId = await seedCompany('Checkout Platform', CHECKOUT)
  tradingId = await seedCompany('Demo Trading Co.', TRADING)
})
afterAll(async () => { await prisma.$disconnect() })

async function create(name = 'ship it', policy: 'A' | 'B' = 'A'): Promise<string> {
  const result = await createSimulation({ companyId, name, sector: 'software', policy, seed: 1 })
  expect(result.ok).toBe(true)
  return result.ok ? result.value.id : ''
}

describe('createSimulation for the software sector', () => {
  it('freezes the roster with the catalog role, staffs the three decision roles and the engineer pool', async () => {
    const id = await create()
    const loaded = await loadSimulation(id)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.value.sector).toBe('software')
    expect(loaded.value.plugin.name).toBe('software')
    expect(loaded.value.summary.sector).toBe('software')
    const definition = loaded.value.definition as unknown as {
      roles: { name: string; slaveName: string }[]
      engineers: { id: string; expertise: string }[]
      reviewCapacityPerDay: number
    }
    expect(definition.roles.map((r) => [r.name, r.slaveName])).toEqual([['product', 'John'], ['lead', 'Atlas'], ['reviewer', 'Riley']])
    // Expertise comes from the catalog role: Backend → backend, and anything the sector does not
    // know (Maya's `QA`) → general. Riley reviews, so Riley is not in the pool.
    expect([...definition.engineers].sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: 'Alex', expertise: 'backend' },
      { id: 'Daniel', expertise: 'devops' },
      { id: 'Emma', expertise: 'frontend' },
      { id: 'Maya', expertise: 'general' },
    ])
    expect(definition.reviewCapacityPerDay).toBe(1) // policy A
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(row.sector).toBe('software')
  })

  it('refuses a sector no plugin is registered for, without touching the database', async () => {
    const result = await createSimulation({ companyId, name: 'x', sector: 'retail', policy: 'A' })
    expect(result.ok === false && result.error).toEqual({ kind: 'unsupported_simulation', sector: 'retail', mode: 'simulation' })
    expect(await prisma.simulationRun.count()).toBe(0)
  })

  it('refuses a roster the software sector cannot staff, with the plugin\'s own requirement text', async () => {
    const noProduct = await seedCompany('No Product Co.', [
      { name: 'Atlas', department: 'Management', role: 'manager' },
      { name: 'Alex', department: 'Engineering', role: 'Backend' },
      { name: 'Emma', department: 'Engineering', role: 'Frontend' },
      { name: 'Riley', department: 'Engineering', role: 'reviewer' },
      { name: 'Oliver', department: 'Marketing', role: 'SEO' },
    ])
    const result = await createSimulation({ companyId: noProduct, name: 'x', sector: 'software', policy: 'A' })
    expect(result.ok === false && result.error).toEqual({ kind: 'invalid_simulation_input', detail: sectors.software.rosterRequirement })
    expect(await prisma.simulationRun.count()).toBe(0)
  })

  it('only the roster error becomes a refusal: any other throw out of the plugin surfaces (review round 1)', async () => {
    // `demoDefinition` throws exactly `rosterRequirement` for a roster it cannot staff, and that
    // is the ONE throw `createSimulation` is allowed to turn into a refusal. A bug inside the
    // sector -- anything else -- must reach the caller as the error it is, not be reported to an
    // operator as "your company is short a Product slave".
    const boom = vi.spyOn(sectors.software, 'demoDefinition').mockImplementation(() => { throw new Error('boom') })
    try {
      await expect(createSimulation({ companyId, name: 'boom', sector: 'software', policy: 'A' })).rejects.toThrow('boom')
    } finally {
      boom.mockRestore()
    }
    expect(await prisma.simulationRun.count()).toBe(0)
  })

  it('an llm run puts the plugin\'s own candidate role on the model, not trade\'s', async () => {
    const created = await createSimulation({ companyId, name: 'llm lead', sector: 'software', policy: 'A', decisionProvider: 'llm', modelProvider: 'claude_code', model: 'claude-haiku-4-5', maxModelCostUsd: 2 })
    expect(created.ok).toBe(true)
    const loaded = await loadSimulation(created.ok ? created.value.id : '')
    expect(loaded.ok && loaded.value.summary.llmRoles).toEqual(['lead'])
  })
})

describe('stepping and reading a software run', () => {
  it('runs five days on the software rules provider and reports the sector\'s own headline', async () => {
    const id = await create()
    const stepped = await stepSimulation(id, { untilDay: 5 })
    expect(stepped.ok && stepped.value).toMatchObject({ day: 5, status: 'running' })
    const status = await simulationStatus(id)
    expect(status.ok).toBe(true)
    if (!status.ok) return
    expect(status.value.headline.map((h) => h.label)).toEqual(['queued', 'in progress', 'in review', 'done', 'open incidents'])
    // Five days in, the demo's first requests are moving: something has been assigned or delivered.
    const moved = status.value.headline.filter((h) => h.label === 'in progress' || h.label === 'done').reduce((n, h) => n + h.value, 0)
    expect(moved).toBeGreaterThan(0)
    expect(Object.keys(status.value.metrics).sort()).toEqual(Object.keys(sectors.software.metricLabels).sort())
    const applied = await prisma.simulationJournalEntry.findMany({ where: { simulationId: id, kind: 'action_applied' } })
    expect(applied.length).toBeGreaterThan(0)
    expect(applied.map((r) => r.actorRole)).toContain('lead')
  })

  it('the whole horizon: policy B reviews everything and never reworks, policy A pays for its speed in defects', async () => {
    const a = await create('fast', 'A')
    const b = await create('careful', 'B')
    expect((await stepSimulation(a, { untilDay: 30 })).ok).toBe(true)
    expect((await stepSimulation(b, { untilDay: 30 })).ok).toBe(true)
    const statusA = await simulationStatus(a)
    const statusB = await simulationStatus(b)
    expect(statusA.ok && statusA.value.summary.status).toBe('finished')
    expect(statusB.ok && statusB.value.summary.status).toBe('finished')
    if (!statusA.ok || !statusB.ok) return
    expect(statusB.value.metrics['defectIncidents']).toBe(0)
    expect(statusB.value.metrics['reworkTasks']).toBe(0)
    expect(statusA.value.metrics['defectIncidents']).toBeGreaterThanOrEqual(4)
  }, 30_000)
})

describe('reading a corrupt row', () => {
  it('a queue event the sector\'s own event schema rejects is simulation_corrupt (review round 1, R10)', async () => {
    const id = await create()
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    const state = row.state as { queue: { items: { event: { sizeDays: unknown } }[] } }
    // The queue holds the demo's twelve scheduled `request` events; one of them is made nonsense.
    expect(state.queue.items.length).toBeGreaterThan(0)
    state.queue.items[0]!.event.sizeDays = 'not a number'
    await prisma.simulationRun.update({ where: { id }, data: { state: state as object } })
    const loaded = await loadSimulation(id)
    expect(loaded.ok).toBe(false)
    expect(loaded.ok === false && loaded.error.kind).toBe('simulation_corrupt')
    expect(loaded.ok === false && loaded.error.kind === 'simulation_corrupt' && loaded.error.reason).toMatch(/^state: /)
  })
})

describe('injecting a software external event', () => {
  it('accepts request, incident and absence, and refuses a trade event the software schema does not know', async () => {
    const id = await create()
    expect((await injectExternalEvent(id, { day: 2, event: { type: 'request', area: 'backend', sizeDays: 2, dueInDays: 6 } })).ok).toBe(true)
    expect((await injectExternalEvent(id, { day: 3, event: { type: 'incident', area: 'devops' } })).ok).toBe(true)
    expect((await injectExternalEvent(id, { day: 4, event: { type: 'absence', engineerId: 'Alex', days: 2 } })).ok).toBe(true)
    const trade = await injectExternalEvent(id, { day: 5, event: { type: 'demand', qty: 10, unitPriceMinor: 1_000, dueInDays: 3, collectInDays: 0 } })
    expect(trade.ok === false && trade.error.kind).toBe('invalid_simulation_input')
    const external = await prisma.simulationJournalEntry.findMany({ where: { simulationId: id, kind: 'external_event' }, orderBy: { seq: 'asc' } })
    expect(external.filter((r) => (r.payload as { op?: string }).op === 'injected').map((r) => (r.payload as { event: { type: string } }).event.type)).toEqual(['request', 'incident', 'absence'])
    // All three land in the world when their day comes round.
    expect((await stepSimulation(id, { untilDay: 6 })).ok).toBe(true)
    const after = await loadSimulation(id)
    expect(after.ok).toBe(true)
    if (!after.ok) return
    const state = after.value.state.sector as { tasks: { origin: string; priority: string }[]; engineers: { id: string; absentUntilDay: number | null }[] }
    expect(state.tasks.filter((t) => t.origin === 'incident').length).toBeGreaterThanOrEqual(1)
    // Ruling R6: `absentUntilDay` is the LAST day away — day 4 plus two days.
    expect(state.engineers.find((e) => e.id === 'Alex')?.absentUntilDay).toBe(6)
    // Replay is the whole point of a frozen definition (M29 §6): the software model, its initial
    // state and the three injected events reproduce this exact world from the journal alone.
    expect(await replaySimulation(id)).toEqual({ ok: true, value: { matches: true } })
  })
})

describe('cloning and comparing software runs', () => {
  it('a clone keeps the world and swaps the policy; compare deltas run over the software labels', async () => {
    const a = await create('fast', 'A')
    expect((await stepSimulation(a, { untilDay: 30 })).ok).toBe(true)
    const cloned = await cloneSimulation(a, { name: 'careful', policy: 'B' })
    expect(cloned.ok).toBe(true)
    const b = cloned.ok ? cloned.value.id : ''
    const loadedClone = await loadSimulation(b)
    expect(loadedClone.ok && loadedClone.value.summary).toMatchObject({ sector: 'software', policy: 'B', simTime: 0 })
    expect((await stepSimulation(b, { untilDay: 30 })).ok).toBe(true)
    const comparison = await compareSimulations(a, b)
    expect(comparison.ok).toBe(true)
    if (!comparison.ok) return
    const labels = Object.keys(sectors.software.metricLabels)
    expect(Object.keys(comparison.value.deltas)).toEqual(labels)
    expect(Object.keys(comparison.value.metricLabels)).toEqual(labels)
    expect(comparison.value.metricLabels['avgLeadDays']).toEqual({ label: 'average lead time', kind: 'days' })
    // The delta is arithmetic, nothing more: b − a on every label the plugin publishes.
    for (const key of labels) expect(comparison.value.deltas[key]).toBe((comparison.value.b.metrics[key] ?? 0) - (comparison.value.a.metrics[key] ?? 0))
    expect(comparison.value.definitionsMatch).toBe(true)
    expect(comparison.value.b.metrics['defectIncidents']).toBe(0)
  }, 30_000)

  it('refuses to compare a software run with a trade run', async () => {
    const software = await create()
    const trade = await createSimulation({ companyId: tradingId, name: 'trade run', sector: 'trade', policy: 'A' })
    const compared = await compareSimulations(software, trade.ok ? trade.value.id : '')
    expect(compared.ok === false && compared.error).toEqual({ kind: 'invalid_simulation_input', detail: 'runs of different sectors cannot be compared' })
  })
})

describe('an llm lead run', () => {
  const T0 = new Date('2026-09-07T12:00:00.000Z')
  const answer = (text: string): ModelOutcome => ({ kind: 'answer', text, costUsd: 0.002, tokens: { input: 800, output: 90 }, numTurns: 1 })
  const assignment = (taskId: string, engineerId: string): string =>
    `Assigning the oldest queued task.\n\`\`\`json\n[{"type":"assign_task","params":{"taskId":"${taskId}","engineerId":"${engineerId}"},"rationale":"the area matches","refs":[]}]\n\`\`\`\n`

  it('prompts the lead with its own actions and applies the model\'s assign_task', async () => {
    const created = await createSimulation({ companyId, name: 'llm lead', sector: 'software', policy: 'A', decisionProvider: 'llm', modelProvider: 'claude_code', model: 'claude-haiku-4-5', maxModelCostUsd: 2 })
    const id = created.ok ? created.value.id : ''
    expect(id).not.toBe('')
    expect((await startAutoRun(id, { everyMs: 250, untilDay: 5 })).ok).toBe(true)

    // Day 0: nothing has arrived yet, so the lead has nothing to assign — the day still passes.
    const day0 = await prepareModelDecision(id, T0)
    expect(day0.ok && day0.value.kind).toBe('decide')
    if (!day0.ok || day0.value.kind !== 'decide') return
    expect(day0.value.role).toBe('lead')
    expect(day0.value.prompt).toContain('assign_task')
    // Only the lead's own actions are documented to it.
    expect(day0.value.prompt).not.toContain('accept_request')
    expect(day0.value.prompt).not.toContain('review_task')
    expect((await applyModelDecision(id, { expectedVersion: day0.value.version, role: 'lead', outcome: answer(assignment('t-1', 'Alex')), promptHash: 'h0', now: T0 })).ok).toBe(true)

    // Day 1: the demo's first two requests arrived and the rules `product` queued them, so the
    // model's assignment is one the engine accepts.
    const day1 = await prepareModelDecision(id, new Date(T0.getTime() + 250))
    expect(day1.ok && day1.value.kind).toBe('decide')
    if (!day1.ok || day1.value.kind !== 'decide') return
    expect(day1.value.day).toBe(1)
    const applied = await applyModelDecision(id, { expectedVersion: day1.value.version, role: 'lead', outcome: answer(assignment('t-1', 'Alex')), promptHash: 'h1', now: new Date(T0.getTime() + 250) })
    expect(applied.ok && applied.value).toEqual({ applied: true })

    const leadApplied = await prisma.simulationJournalEntry.findMany({ where: { simulationId: id, kind: 'action_applied', actorRole: 'lead' }, orderBy: { seq: 'asc' } })
    expect(leadApplied.map((r) => (r.payload as { action: { type: string } }).action.type)).toEqual(['assign_task'])
    const decisions = await prisma.simulationJournalEntry.findMany({ where: { simulationId: id, kind: 'decision', actorRole: 'lead' }, orderBy: { seq: 'asc' } })
    expect(decisions.map((r) => (r.payload as { provider: string }).provider)).toEqual(['llm', 'llm'])
    // The rules answered every other role in the same two days.
    const product = await prisma.simulationJournalEntry.findMany({ where: { simulationId: id, kind: 'decision', actorRole: 'product' } })
    expect(product.map((r) => (r.payload as { provider: string }).provider)).toEqual(['rules', 'rules'])
    expect(await prisma.simulationModelUsage.count({ where: { simulationId: id } })).toBe(2)
  })
})

describe('companiesForSector', () => {
  it('keeps only the catalog companies whose roster the sector\'s plugin can staff', async () => {
    const tiny = await prisma.company.create({ data: { name: 'Tiny Co.' } })
    const software = await companiesForSector('software')
    expect(software.map((c) => c.name)).toEqual(['Checkout Platform'])
    expect(software[0]).toEqual({ id: companyId, name: 'Checkout Platform', slaves: 9 })
    // Trade asks only for four bodies, which the software company also has: the two lists are not
    // complements, they are each plugin's own `rosterFits` over the same catalog. What both refuse
    // is a company with nobody in it.
    const trade = await companiesForSector('trade')
    expect(trade.map((c) => c.name)).toEqual(['Checkout Platform', 'Demo Trading Co.'])
    expect(trade.map((c) => c.id)).not.toContain(tiny.id)
    expect(software.map((c) => c.id)).not.toContain(tiny.id)
    expect(software.map((c) => c.id)).not.toContain(tradingId)
  })
})
