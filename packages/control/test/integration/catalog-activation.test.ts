import { prisma } from '@slave-of-ai/db/client'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTemplate, setTemplateActivation } from '../../src/org.js'
import { loadSupervisorWorld } from '../../src/supervisorWorld.js'

const TRUNCATE =
  'TRUNCATE TABLE "CatalogImport", "CompanySlave", "CompanyTeam", "Company", "RunbookTemplate", "Workspace", "SlaveTemplate" RESTART IDENTITY CASCADE'

const NOW = new Date('2026-09-13T12:00:00.000Z')

/** A template with capability keys, which is what makes it a `loadCatalogEntries` candidate at all
 *  (`supervisorWorld.ts`'s non-empty clause, M47). Written straight through Prisma so the case can
 *  choose `active` rather than inherit whatever a verb decided. */
const template = async (name: string, active: boolean): Promise<string> =>
  (
    await prisma.slaveTemplate.create({
      data: { name, role: 'backend', description: `${name} does one thing.`, capabilityKeys: ['backend.services'], active },
    })
  ).id

describe('setTemplateActivation (M55 R2)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('turns a row on and stamps who did it and when', async (): Promise<void> => {
    const id = await template('Inert Persona', false)

    const result = await setTemplateActivation(id, true, 'operator')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ changed: true })
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })
    expect(row.active).toBe(true)
    expect(row.activationChangedBy).toBe('operator')
    expect(row.activationChangedAt).not.toBeNull()
  })

  it('turns a row off again, and the stamp moves with it', async (): Promise<void> => {
    const id = await template('Inert Persona', true)
    await setTemplateActivation(id, true, 'first')
    const off = await setTemplateActivation(id, false, 'second')

    expect(off.ok && off.value.changed).toBe(true)
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })
    expect(row.active).toBe(false)
    expect(row.activationChangedBy).toBe('second')
  })

  it('says `changed: false` for a no-op rather than pretending it did something', async (): Promise<void> => {
    const id = await template('Already On', true)

    const result = await setTemplateActivation(id, true, 'operator')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ changed: false })
    // And it did not stamp: a no-op is not an act, and recording one would make
    // `activationChangedAt` say a person did something they did not do.
    expect((await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })).activationChangedAt).toBeNull()
  })

  it('refuses a template id nobody wrote, with the kind that already exists', async (): Promise<void> => {
    const result = await setTemplateActivation('00000000-0000-4000-8000-000000000000', true, 'operator')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({ kind: 'template_not_found', templateId: '00000000-0000-4000-8000-000000000000' })
  })

  it('accepts no author at all, and records nobody rather than inventing one', async (): Promise<void> => {
    const id = await template('Anonymous Toggle', false)

    await setTemplateActivation(id, true)

    expect((await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })).activationChangedBy).toBeNull()
  })

  it('writes NO event -- the catalog has no workspace (R2, M42 R5)', async (): Promise<void> => {
    const id = await template('Silent Toggle', false)
    const before = await prisma.executionEvent.count()

    await setTemplateActivation(id, true, 'operator')

    expect(await prisma.executionEvent.count()).toBe(before)
  })
})

describe('createTemplate (M55 R2)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('creates a hand-made template ACTIVE -- typing one is the deliberate act `--activate` stands for', async (): Promise<void> => {
    const created = await createTemplate('Typed By A Person', 'backend')

    expect(created.ok).toBe(true)
    if (!created.ok) return
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: created.value.id } })
    expect(row.active).toBe(true)
    // And it is not a TOGGLE: nobody changed anything, so nothing is stamped.
    expect(row.activationChangedAt).toBeNull()
    expect(row.activationChangedBy).toBeNull()
  })
})

describe('loadCatalogEntries through loadSupervisorWorld (M55 R2)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  /** The catalog is only READ when some staffable task names a capability (M47 R4's gate), so the
   *  fixture is a workspace with one ready task that does. Nothing about the gate is under test
   *  here -- the `active` clause beneath it is. */
  const world = async (): Promise<readonly { readonly templateId: string }[]> => {
    const workspace = await prisma.workspace.create({
      data: { name: 'M55 Activation Project', repoPath: '/tmp/m55-activation', verifyCommands: ['true'], setupCommands: [] },
    })
    await prisma.task.create({
      data: {
        workspaceId: workspace.id,
        title: 'harden',
        description: 'a task',
        status: 'ready',
        requiredRole: 'backend',
        maxAttempts: 3,
        attempt: 1,
        requiredCapabilities: ['backend.services'],
      },
    })
    return (await loadSupervisorWorld(workspace.id, NOW)).world.catalog
  }

  it('admits an ACTIVE template with capability keys', async (): Promise<void> => {
    const id = await template('Hirable', true)

    expect((await world()).map((entry) => entry.templateId)).toEqual([id])
  })

  it('admits NOTHING that is inactive, however many capabilities it claims', async (): Promise<void> => {
    await template('Imported This Morning', false)

    expect(await world()).toEqual([])
  })

  it('still excludes an ACTIVE template with no capability keys -- the M47 clause is unchanged', async (): Promise<void> => {
    await prisma.slaveTemplate.create({ data: { name: 'Active But Mute', role: 'backend', active: true } })

    expect(await world()).toEqual([])
  })

  it('mixes: three rows, one of each disqualification, one candidate', async (): Promise<void> => {
    const hirable = await template('The One', true)
    await template('Inactive With Keys', false)
    await prisma.slaveTemplate.create({ data: { name: 'Active Without Keys', role: 'backend', active: true } })

    expect((await world()).map((entry) => entry.templateId)).toEqual([hirable])
  })
})
