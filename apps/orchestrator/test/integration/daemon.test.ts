import { prisma } from '@slave-of-ai/db/client'
import { workspaceId as brandWorkspaceId } from '@slave-of-ai/domain'
import type { AdapterRegistry } from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DAEMON_DISCOVERY_MS, runDaemon, servingLine } from '../../src/daemon.js'
import { resetTickObservation } from '../../src/sweep.js'

/** Nothing in this file dispatches. A registry that throws is the assertion. */
const registry: AdapterRegistry = {
  resolve() {
    throw new Error('this test dispatches nothing, so nothing may resolve an adapter')
  },
}

/** Everything the daemon printed, as one string. The serving line is the daemon's own statement
 *  about what it serves, and `gate:m59-intake` reads the same line out of a real process's stdout
 *  -- so a test that asserted an internal Map would be measuring something no operator can see. */
function captureStdout(): { readonly text: () => string; restore: () => void } {
  let buffer = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  })
  return { text: () => buffer, restore: () => spy.mockRestore() }
}

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the daemon')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('runDaemon serving every project', () => {
  let stop = (): void => {}
  let finished: Promise<void> = Promise.resolve()
  let output: ReturnType<typeof captureStdout> | null = null

  beforeEach(async (): Promise<void> => {
    resetTickObservation()
    // `SlaveTemplate` and `Person` are added for Catalog Person Pool (Task 2): no other test in
    // this file touches either, so truncating both here alongside everything already emptied
    // costs nothing and gives the startup-hook tests below a clean pool to reconcile into.
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "IntakeMessage", "Intake", "GoalVersion", "Task", "Slave", "Team", "Workspace", "Person", "SlaveTemplate" RESTART IDENTITY CASCADE',
    )
  })

  afterEach(async (): Promise<void> => {
    stop()
    await finished
    output?.restore()
    output = null
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  /** Starts a daemon and returns once its first serving line has been printed. */
  async function start(workspaceIds: 'all' | string): Promise<() => string> {
    const captured = captureStdout()
    output = captured
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    stop = release
    finished = runDaemon({
      workspaceIds: workspaceIds === 'all' ? 'all' : brandWorkspaceId(workspaceIds),
      registry,
      periodMs: 200,
      discoveryMs: 300,
      until: gate,
    })
    await until(() => captured.text().includes('serving'))
    return captured.text
  }

  const seed = async (name: string): Promise<string> =>
    (await prisma.workspace.create({ data: { name, repoPath: '/tmp/daemon-test', verifyCommands: ['true'], setupCommands: [] } })).id

  it('names what it serves, and the count is the projects that are active', async (): Promise<void> => {
    await seed('Alpha')
    await seed('Beta')
    const text = await start('all')
    expect(text()).toContain('serving 2 projects')
    expect(text()).toContain('Alpha')
    expect(text()).toContain('Beta')
  })

  it('starts with NO project at all -- a fresh install is not an error any more', async (): Promise<void> => {
    const text = await start('all')
    expect(text()).toContain('serving 0 projects')
  })

  // Catalog Person Pool (Task 2): the sync runs once, before the first serving line, so every
  // active template already has its three managed people by the time any project is served.
  it('runs the person pool sync before serving any project', async (): Promise<void> => {
    const activeTemplate = await prisma.slaveTemplate.create({
      data: { name: 'Daemon Startup Persona', role: 'backend', description: 'x', active: true, capabilityKeys: ['backend.services'] },
    })
    const inactiveTemplate = await prisma.slaveTemplate.create({
      data: { name: 'Daemon Startup Inert', role: 'backend', description: 'x', active: false, capabilityKeys: [] },
    })

    await start('all')

    const managed = await prisma.person.findMany({ where: { templateId: activeTemplate.id, poolSlot: { not: null } } })
    expect(managed).toHaveLength(3)
    expect(await prisma.person.count({ where: { templateId: inactiveTemplate.id } })).toBe(0)
  })

  it('picks up a project created after it started, within one discovery period', async (): Promise<void> => {
    const text = await start('all')
    expect(text()).toContain('serving 0 projects')
    await seed('Created Later')
    await until(() => text().includes('serving 1 project') && text().includes('Created Later'))
  })

  it('stops following a project that was archived', async (): Promise<void> => {
    const id = await seed('Going Away')
    const text = await start('all')
    expect(text()).toContain('serving 1 project')
    await prisma.workspace.update({ where: { id }, data: { archivedAt: new Date() } })
    await until(() => text().includes('serving 0 projects'))
  })

  it('starts serving a project again after it is archived and restored', async (): Promise<void> => {
    const id = await seed('Coming Back')
    const text = await start('all')
    await prisma.workspace.update({ where: { id }, data: { archivedAt: new Date() } })
    await until(() => text().includes('serving 0 projects'))

    await prisma.workspace.update({ where: { id }, data: { archivedAt: null } })
    await until(
      () => text().split('serving 1 project (Coming Back)').length === 3,
      2_000,
    )
  })

  it('serves exactly the one it was told to, and follows nothing', async (): Promise<void> => {
    const id = await seed('Only This One')
    await seed('Not This One')
    const text = await start(id)
    expect(text()).toContain('serving 1 project')
    expect(text()).toContain('Only This One')
    expect(text()).not.toContain('Not This One')
    expect(text()).not.toContain('following new ones')
  })

  it('drains every loop on shutdown and says so once', async (): Promise<void> => {
    await seed('Alpha')
    await seed('Beta')
    const text = await start('all')
    stop()
    await finished
    expect(text()).toContain('daemon stopped')
    expect(text().split('daemon stopped')).toHaveLength(2)
  })

  it('leaves no signal handler behind, so a second daemon in one process is not a leak', async (): Promise<void> => {
    const before = process.listenerCount('SIGTERM')
    await seed('Alpha')
    await start('all')
    stop()
    await finished
    expect(process.listenerCount('SIGTERM')).toBe(before)
  })
})

describe('servingLine', () => {
  it('says one project without the plural, and names them', () => {
    expect(servingLine(['Checkout Platform'], false)).toBe('serving 1 project (Checkout Platform)')
  })

  it('adds the discovery period when it is following new ones', () => {
    expect(servingLine(['a', 'b'], true)).toBe(
      `serving 2 projects (a, b); following new ones every ${String(DAEMON_DISCOVERY_MS / 1000)}s`,
    )
  })

  it('says nothing about names when there are none', () => {
    expect(servingLine([], true)).toBe(
      `serving 0 projects; following new ones every ${String(DAEMON_DISCOVERY_MS / 1000)}s`,
    )
  })
})
