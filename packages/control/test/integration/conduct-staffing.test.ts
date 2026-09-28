/**
 * Conductor Plan 2 (R5, D2): one seat per package. Two packages of one persona must land on two
 * different seats -- the verb's reuse-by-persona would have put both on one -- each seat holds the
 * package role, an idle seat of the persona is reused before anybody is hired, a seat still holding
 * a live package task is not, and a pool that runs out refuses with the persona named.
 */
import { prisma } from '@slave-of-ai/db/client'
import { PACKAGE_WORKER_ROLE, VERIFIER_ROLE } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { syncCapabilityTaxonomy } from '../../src/capability.js'
import { implementersOf, staffPackages, staffVerifier } from '../../src/conductStaffing.js'
import { syncPersonPool } from '../../src/personPool.js'

const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "Task", "WorkPackage", "Slave", "Team", "Workspace", "Person" RESTART IDENTITY CASCADE'

let w = ''

/**
 * The templates this file makes, removed by id: a TRUNCATE of "SlaveTemplate" CASCADE would also
 * empty every table that references it (runbooks, hints, skills) under other files' feet, and
 * leftover templates change what other files' supervisors and pools see.
 */
async function removeTemplates(): Promise<void> {
  const ids = ['t-backend', 't-docs']
  // Their pool people first: a pooled person cannot outlive its template (poolSlot needs templateId).
  await prisma.person.deleteMany({ where: { templateId: { in: ids } } })
  await prisma.slaveTemplate.deleteMany({ where: { id: { in: ids } } })
}

afterAll(async (): Promise<void> => {
  await removeTemplates()
})

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(TRUNCATE)
  await removeTemplates()
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

  /** Final review M2: the only reviewer, made a package worker, could review nobody's package but
   *  someone else's -- and nobody could review its own (reviewer is never the implementer). */
  it('hires rather than reuse the workspace\'s only reviewer, and reuses a reviewer when there is another', async (): Promise<void> => {
    const team = await prisma.team.findFirstOrThrow({ where: { workspaceId: w } })
    const pooled = await prisma.person.findMany({ where: { templateId: 't-backend' }, orderBy: { id: 'asc' }, take: 2 })
    const reviewer = await prisma.slave.create({
      data: { teamId: team.id, role: 'Backend Developer', runtimeRoles: ['backend', 'reviewer'], personId: pooled[0]?.id ?? '' },
    })
    const alone = await staffPackages(w, 1, [{ key: 'a', templateId: 't-backend' }])
    expect(alone.ok).toBe(true)
    if (!alone.ok) return
    expect(alone.value.get('a')).not.toBe(reviewer.id)
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: reviewer.id } })).runtimeRoles).not.toContain(PACKAGE_WORKER_ROLE)

    // A second reviewer on another persona: the first may now take a package, and the second reviews it.
    const docsPerson = await prisma.person.findFirstOrThrow({ where: { templateId: 't-docs' } })
    await prisma.slave.create({ data: { teamId: team.id, role: 'Technical Writer', runtimeRoles: ['docs', 'reviewer'], personId: docsPerson.id } })
    const shared = await staffPackages(w, 2, [{ key: 'b', templateId: 't-backend' }, { key: 'c', templateId: 't-backend' }])
    expect(shared.ok && [...shared.value.values()]).toContain(reviewer.id)
  })

  /** Plan 4b D4: a verifier is never an implementer -- its seat stays out of package staffing. */
  it('never reuses a seat holding the verifier role; a hire staffs the package instead', async (): Promise<void> => {
    const team = await prisma.team.findFirstOrThrow({ where: { workspaceId: w } })
    const person = await prisma.person.findFirstOrThrow({ where: { templateId: 't-backend' }, orderBy: { id: 'asc' } })
    const verifier = await prisma.slave.create({
      data: { teamId: team.id, role: 'Backend Developer', runtimeRoles: ['backend', VERIFIER_ROLE], personId: person.id },
    })
    const seats = await staffPackages(w, 1, [{ key: 'a', templateId: 't-backend' }])
    expect(seats.ok).toBe(true)
    if (!seats.ok) return
    expect(seats.value.get('a')).not.toBe(verifier.id)
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: verifier.id } })).runtimeRoles).not.toContain(PACKAGE_WORKER_ROLE)
    expect(await prisma.slave.count({ where: { team: { workspaceId: w } } })).toBe(2)
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

describe('staffVerifier', () => {
  async function seat(runtimeRoles: readonly string[], templateId = 't-backend', skip = 0): Promise<string> {
    const team = await prisma.team.findFirstOrThrow({ where: { workspaceId: w } })
    const person = await prisma.person.findMany({ where: { templateId }, orderBy: { id: 'asc' }, skip, take: 1 })
    const slave = await prisma.slave.create({
      data: { teamId: team.id, role: 'Seat', runtimeRoles: [...runtimeRoles], personId: person[0]?.id ?? '' },
    })
    return slave.id
  }

  /** An `implementation` run by `slaveId` on a package task of goal version `goalVersion`. */
  async function implemented(slaveId: string, goalVersion: number): Promise<void> {
    const pkg = await prisma.workPackage.create({
      data: { workspaceId: w, goalVersion, key: `k${slaveId}`, title: 'k', requirementKeys: [], ownedPaths: ['**'], interface: '', templateId: 't-backend' },
    })
    const task = await prisma.task.create({
      data: { workspaceId: w, title: 'k', description: 'k', status: 'done', maxAttempts: 3, requiredRole: PACKAGE_WORKER_ROLE, assigneeId: slaveId, workPackageId: pkg.id },
    })
    await prisma.slaveRun.create({ data: { taskId: task.id, slaveId, kind: 'implementation', status: 'succeeded' } })
  }

  it('picks an open seat already holding the verifier role', async (): Promise<void> => {
    const verifier = await seat(['backend', VERIFIER_ROLE])
    const chosen = await staffVerifier(w, 1, new Set(), 't-backend')
    expect(chosen.ok && chosen.value).toBe(verifier)
    expect(await prisma.slave.count({ where: { team: { workspaceId: w } } })).toBe(1)
  })

  it('gives the verifier role to a reviewer seat when no verifier exists', async (): Promise<void> => {
    const reviewer = await seat(['backend', 'reviewer'])
    const chosen = await staffVerifier(w, 1, new Set(), 't-backend')
    expect(chosen.ok && chosen.value).toBe(reviewer)
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: reviewer } })).runtimeRoles).toContain(VERIFIER_ROLE)
  })

  it('hires a new seat when the only reviewer holds a package of this version', async (): Promise<void> => {
    const reviewer = await seat(['backend', 'reviewer'])
    const chosen = await staffVerifier(w, 1, new Set([reviewer]), 't-docs')
    expect(chosen.ok).toBe(true)
    if (!chosen.ok) return
    expect(chosen.value).not.toBe(reviewer)
    const hired = await prisma.slave.findUniqueOrThrow({ where: { id: chosen.value }, include: { person: true } })
    expect(hired.runtimeRoles).toContain(VERIFIER_ROLE)
    expect(hired.person.templateId).toBe('t-docs')
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: reviewer } })).runtimeRoles).not.toContain(VERIFIER_ROLE)
  })

  it('does not choose a verifier seat that implemented a task of this goal version', async (): Promise<void> => {
    const verifier = await seat(['backend', VERIFIER_ROLE])
    await implemented(verifier, 1)
    expect([...(await implementersOf(w, 1))]).toEqual([verifier])
    expect((await implementersOf(w, 2)).size).toBe(0)
    const v1 = await staffVerifier(w, 1, new Set(), 't-backend')
    expect(v1.ok && v1.value).not.toBe(verifier)
    expect(v1.ok).toBe(true)
    // Version 2: the same seat implemented nothing there, so it verifies it. The v1 verifier's seat
    // is closed first: two eligible verifiers would be chosen by id, which is random.
    await prisma.slave.update({ where: { id: v1.ok ? v1.value : '' }, data: { closedAt: new Date() } })
    const v2 = await staffVerifier(w, 2, new Set(), 't-backend')
    expect(v2.ok && v2.value).toBe(verifier)
  })

  it('refuses, naming the verifier and the persona, when nobody is eligible and the pool is gone', async (): Promise<void> => {
    const chosen = await staffVerifier(w, 1, new Set(), 't-missing')
    expect(chosen.ok).toBe(false)
    expect(!chosen.ok && chosen.error).toContain('verifier')
    expect(!chosen.ok && chosen.error).toContain('t-missing')
  })
})
