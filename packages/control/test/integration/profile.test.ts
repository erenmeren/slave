import { createHash } from 'node:crypto'
import { prisma } from '@slave-of-ai/db/client'
import { PROFILE_MAX_CHARS } from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { setProfile, setRuntimeRoles } from '../../src/profile.js'
import { refusalText } from '../../src/refusal.js'

interface Fixture {
  readonly workspaceId: string
  readonly slaveId: string
  readonly templateId: string
  readonly companySlaveId: string
}

/** One workspace with a worker linked to a roster row, so all three levels of the profile
 *  override chain (`slave` > `companySlave` > `template`) have a real row to be written on. */
async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath: '/tmp/checkout', verifyCommands: ['npm test'], setupCommands: ['npm ci'] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const template = await prisma.slaveTemplate.create({
    data: { name: 'Engineer', role: 'backend', description: 'writes code' },
  })
  const company = await prisma.company.create({ data: { name: 'Acme' } })
  const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
  const companySlave = await prisma.companySlave.create({
    data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Maya' },
  })
  const slave = await prisma.slave.create({
    data: {
      teamId: team.id,
      name: 'Maya',
      role: 'Senior Engineer',
      runtimeRoles: ['backend'],
      companySlaveId: companySlave.id,
    },
  })
  return {
    workspaceId: workspace.id,
    slaveId: slave.id,
    templateId: template.id,
    companySlaveId: companySlave.id,
  }
}

const reset = async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "SlaveMessage", "SlaveRun", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
  )
}

const profileEvents = (workspaceId: string) =>
  prisma.executionEvent.findMany({ where: { workspaceId, type: 'slave_profile_changed' }, orderBy: { seq: 'asc' } })

describe('setProfile', () => {
  let fixture: Fixture
  beforeEach(async () => {
    await reset()
    fixture = await seed()
  })

  it('writes the whole override chain, each level on its own row', async () => {
    expect((await setProfile({ slaveId: fixture.slaveId }, 'worker text', 'operator')).ok).toBe(true)
    expect((await setProfile({ companySlaveId: fixture.companySlaveId }, 'roster text', 'operator')).ok).toBe(true)
    expect((await setProfile({ templateId: fixture.templateId }, 'template text', 'operator')).ok).toBe(true)

    expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId } })).profile).toBe('worker text')
    expect((await prisma.companySlave.findUniqueOrThrow({ where: { id: fixture.companySlaveId } })).profile).toBe('roster text')
    expect((await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: fixture.templateId } })).profile).toBe('template text')
  })

  it('trims, and turns an emptied text into null rather than an empty string', async () => {
    expect((await setProfile({ slaveId: fixture.slaveId }, '  padded  ', 'operator')).ok).toBe(true)
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId } })).profile).toBe('padded')

    expect((await setProfile({ slaveId: fixture.slaveId }, '   ', 'operator')).ok).toBe(true)
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId } })).profile).toBeNull()
  })

  it('clears on null', async () => {
    await setProfile({ slaveId: fixture.slaveId }, 'worker text', 'operator')
    expect((await setProfile({ slaveId: fixture.slaveId }, null, 'operator')).ok).toBe(true)
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId } })).profile).toBeNull()
  })

  it('refuses a profile past the cap, measured AFTER trimming, and writes nothing', async () => {
    const tooLong = `${' '.repeat(10)}${'x'.repeat(PROFILE_MAX_CHARS + 1)}${' '.repeat(10)}`
    const result = await setProfile({ slaveId: fixture.slaveId }, tooLong, 'operator')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toEqual({ kind: 'profile_too_long', limit: PROFILE_MAX_CHARS, length: PROFILE_MAX_CHARS + 1 })
      expect(refusalText(result.error)).toContain(String(PROFILE_MAX_CHARS))
    }
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId } })).profile).toBeNull()
    expect(await profileEvents(fixture.workspaceId)).toHaveLength(0)
  })

  it('accepts a profile of exactly the cap', async () => {
    const exact = 'x'.repeat(PROFILE_MAX_CHARS)
    expect((await setProfile({ slaveId: fixture.slaveId }, exact, 'operator')).ok).toBe(true)
  })

  it('refuses an unknown target of each kind', async () => {
    expect(await setProfile({ slaveId: 'nope' }, 'text', 'operator')).toEqual({
      ok: false, error: { kind: 'slave_not_found', slaveId: 'nope' },
    })
    expect(await setProfile({ templateId: 'nope' }, 'text', 'operator')).toEqual({
      ok: false, error: { kind: 'template_not_found', templateId: 'nope' },
    })
    expect(await setProfile({ companySlaveId: 'nope' }, 'text', 'operator')).toEqual({
      ok: false, error: { kind: 'company_slave_not_found', companySlaveId: 'nope' },
    })
  })

  it('emits slave.profile_changed with the new text hash for a slave target', async () => {
    await setProfile({ slaveId: fixture.slaveId }, 'worker text', 'operator')
    const [event] = await profileEvents(fixture.workspaceId)
    expect(event?.slaveId).toBe(fixture.slaveId)
    expect(event?.actor).toBe('human')
    expect(event?.payload).toEqual({
      target: 'slave',
      targetId: fixture.slaveId,
      // sha256 of the STORED (trimmed) text, the same hash `RunContext`'s manifest carries, so a
      // reader can tell whether a run saw this exact version of the persona.
      sha256: createHash('sha256').update('worker text', 'utf8').digest('hex'),
      actor: 'operator',
    })
  })

  it('emits nothing for a template or catalog-slave target -- the catalog has no event stream', async () => {
    await setProfile({ templateId: fixture.templateId }, 'template text', 'operator')
    await setProfile({ companySlaveId: fixture.companySlaveId }, 'roster text', 'operator')
    expect(await prisma.executionEvent.count({ where: { type: 'slave_profile_changed' } })).toBe(0)
  })

  it('records a cleared profile as sha256: null', async () => {
    await setProfile({ slaveId: fixture.slaveId }, null, 'operator')
    const [event] = await profileEvents(fixture.workspaceId)
    expect((event?.payload as { sha256: unknown }).sha256).toBeNull()
  })
})

describe('setRuntimeRoles', () => {
  let fixture: Fixture
  beforeEach(async () => {
    await reset()
    fixture = await seed()
  })

  it('replaces the set, trimming each entry, and emits the new list', async () => {
    expect((await setRuntimeRoles(fixture.slaveId, [' backend ', 'reviewer'], 'operator')).ok).toBe(true)
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId } })).runtimeRoles).toEqual([
      'backend',
      'reviewer',
    ])

    const [event] = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, type: 'slave_runtime_roles_changed' },
    })
    expect(event?.slaveId).toBe(fixture.slaveId)
    expect(event?.actor).toBe('human')
    expect(event?.payload).toEqual({ slaveId: fixture.slaveId, roles: ['backend', 'reviewer'], actor: 'operator' })
  })

  it('stamps the envelope actor system when the Supervisor is the one staffing (M38 t2)', async () => {
    expect((await setRuntimeRoles(fixture.slaveId, ['backend', 'reviewer'], 'supervisor', 'system')).ok).toBe(true)

    const [event] = await prisma.executionEvent.findMany({ where: { type: 'slave_runtime_roles_changed' } })
    expect(event?.actor).toBe('system')
    // The PAYLOAD actor is still the name of whoever asked for it -- 'supervisor' here, which the
    // envelope enum has no member for (spec erratum E4).
    expect(event?.payload).toEqual({ slaveId: fixture.slaveId, roles: ['backend', 'reviewer'], actor: 'supervisor' })
  })

  it('allows an empty set -- the parked, undispatchable state', async () => {
    expect((await setRuntimeRoles(fixture.slaveId, [], 'operator')).ok).toBe(true)
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId } })).runtimeRoles).toEqual([])
    const [event] = await prisma.executionEvent.findMany({ where: { type: 'slave_runtime_roles_changed' } })
    expect((event?.payload as { roles: unknown }).roles).toEqual([])
  })

  it('refuses a blank entry, a duplicate, and more than twenty -- writing nothing', async () => {
    for (const roles of [['backend', '  '], ['backend', 'backend'], ['backend', ' backend '], Array.from({ length: 21 }, (_, i) => `r${String(i)}`)]) {
      const result = await setRuntimeRoles(fixture.slaveId, roles, 'operator')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe('invalid_runtime_roles')
    }
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId } })).runtimeRoles).toEqual(['backend'])
    expect(await prisma.executionEvent.count({ where: { type: 'slave_runtime_roles_changed' } })).toBe(0)
  })

  it('accepts exactly twenty', async () => {
    const roles = Array.from({ length: 20 }, (_, i) => `r${String(i)}`)
    expect((await setRuntimeRoles(fixture.slaveId, roles, 'operator')).ok).toBe(true)
  })

  it('refuses an unknown slave', async () => {
    expect(await setRuntimeRoles('nope', ['backend'], 'operator')).toEqual({
      ok: false, error: { kind: 'slave_not_found', slaveId: 'nope' },
    })
  })
})
