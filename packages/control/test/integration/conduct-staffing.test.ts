/**
 * Conductor Plan 2 (R5, D2): one seat per package. Two packages of one persona must land on two
 * different seats -- the verb's reuse-by-persona would have put both on one -- each seat holds the
 * package role, an idle seat of the persona is reused before anybody is hired, a seat still holding
 * a live package task is not, and a pool that runs out refuses with the persona named.
 */
import { prisma } from '@slave-of-ai/db/client'
import { PACKAGE_WORKER_ROLE } from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { syncCapabilityTaxonomy } from '../../src/capability.js'
import { staffPackages } from '../../src/conductStaffing.js'
import { syncPersonPool } from '../../src/personPool.js'

const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "Task", "WorkPackage", "Slave", "Team", "Workspace", "Person", "SlaveTemplate" RESTART IDENTITY CASCADE'

let w = ''

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(TRUNCATE)
  await syncCapabilityTaxonomy()
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Conduct Staffing',
      repoPath: '/tmp/conduct-staffing',
      verifyCommands: ['true'],
      setupCommands: [],
      maxAttempts: 3,
    },
  })
  w = workspace.id
  await prisma.team.create({ data: { workspaceId: w, name: 'Engineering' } })
  // Role `backend`, not the package role, so every seat has to be GIVEN `PACKAGE_WORKER_ROLE`.
  await prisma.slaveTemplate.create({
    data: { id: 't-backend', name: 'Backend Developer', role: 'backend', description: 'x', active: true, capabilityKeys: [] },
  })
  await prisma.slaveTemplate.create({
    data: { id: 't-docs', name: 'Technical Writer', role: 'docs', description: 'x', active: true, capabilityKeys: [] },
  })
  // The managed pool: three people per active template, which is all `syncPersonPool` ever keeps.
  await syncPersonPool()
})

describe('staffPackages', () => {
  it('gives two packages of the same persona two different seats, each holding the package role', async (): Promise<void> => {
    const seats = await staffPackages(w, 1, [
      { key: 'a', templateId: 't-backend' },
      { key: 'b', templateId: 't-backend' },
    ])
    expect(seats.ok).toBe(true)
    if (!seats.ok) return
    expect(seats.value.get('a')).toBeDefined()
    expect(seats.value.get('a')).not.toBe(seats.value.get('b'))
    const slaves = await prisma.slave.findMany({ where: { id: { in: [...seats.value.values()] } } })
    expect(slaves).toHaveLength(2)
    expect(slaves.every((s) => s.runtimeRoles.includes(PACKAGE_WORKER_ROLE))).toBe(true)
  })

  it('staffs packages of different personas from their own pools', async (): Promise<void> => {
    const seats = await staffPackages(w, 1, [
      { key: 'api', templateId: 't-backend' },
      { key: 'docs', templateId: 't-docs' },
    ])
    expect(seats.ok).toBe(true)
    if (!seats.ok) return
    const slaves = await prisma.slave.findMany({
      where: { id: { in: [...seats.value.values()] } },
      select: { id: true, person: { select: { templateId: true } } },
    })
    const templateOf = new Map(slaves.map((s) => [s.id, s.person.templateId]))
    expect(templateOf.get(seats.value.get('api') ?? '')).toBe('t-backend')
    expect(templateOf.get(seats.value.get('docs') ?? '')).toBe('t-docs')
  })

  it('reuses an idle seat of the persona before hiring', async (): Promise<void> => {
    const first = await staffPackages(w, 1, [{ key: 'a', templateId: 't-backend' }])
    const again = await staffPackages(w, 2, [{ key: 'x', templateId: 't-backend' }])
    expect(first.ok && again.ok).toBe(true)
    if (!first.ok || !again.ok) return
    expect(again.value.get('x')).toBe(first.value.get('a'))
    expect(await prisma.slave.count({ where: { team: { workspaceId: w } } })).toBe(1)
  })

  it('does not reuse a seat that still holds a live package task', async (): Promise<void> => {
    const first = await staffPackages(w, 1, [{ key: 'a', templateId: 't-backend' }])
    const seat = first.ok ? (first.value.get('a') ?? '') : ''
    const pkg = await prisma.workPackage.create({
      data: { workspaceId: w, goalVersion: 1, key: 'a', title: 'a', requirementKeys: [], ownedPaths: ['**'], interface: '', templateId: 't-backend' },
    })
    await prisma.task.create({
      data: { workspaceId: w, title: 'a', description: 'a', status: 'running', maxAttempts: 3, requiredRole: PACKAGE_WORKER_ROLE, assigneeId: seat, workPackageId: pkg.id },
    })
    const second = await staffPackages(w, 2, [{ key: 'x', templateId: 't-backend' }])
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.get('x')).not.toBe(seat)
  })

  it('reuses a seat whose package task is over', async (): Promise<void> => {
    const first = await staffPackages(w, 1, [{ key: 'a', templateId: 't-backend' }])
    const seat = first.ok ? (first.value.get('a') ?? '') : ''
    const pkg = await prisma.workPackage.create({
      data: { workspaceId: w, goalVersion: 1, key: 'a', title: 'a', requirementKeys: [], ownedPaths: ['**'], interface: '', templateId: 't-backend' },
    })
    await prisma.task.create({
      data: { workspaceId: w, title: 'a', description: 'a', status: 'done', integratedAt: new Date(), maxAttempts: 3, requiredRole: PACKAGE_WORKER_ROLE, assigneeId: seat, workPackageId: pkg.id },
    })
    const second = await staffPackages(w, 2, [{ key: 'x', templateId: 't-backend' }])
    expect(second.ok && second.value.get('x')).toBe(seat)
  })

  it('refuses with the persona named when the pool is exhausted', async (): Promise<void> => {
    // Three managed people per persona, one open seat each per project: the fourth package has
    // nobody left, and a sync cannot make a fourth slot.
    const result = await staffPackages(w, 1, [1, 2, 3, 4].map((i) => ({ key: `p${String(i)}`, templateId: 't-backend' })))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toContain('t-backend')
    expect(!result.ok && result.error).toContain('"p4"')
  })
})
