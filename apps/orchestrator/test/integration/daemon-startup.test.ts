/**
 * Final review fix round 2, gap 4: the daemon's startup reconciliation, on both of its outcomes.
 *
 * Important 4 removed the second, redundant `syncPersonPool()` that followed
 * `reconcileTemplateCapabilities()` at startup, on the grounds that the reconciliation ends by
 * syncing the pool itself and that the remaining call is outside any try/catch so startup still
 * fails loudly. `daemon.test.ts` proves the pool ends up staffed. Neither of the two claims the
 * comment in `daemon.ts` actually makes was tested: that a FAILED pass stops the daemon rather than
 * letting it serve projects over a partial pool, and that the pass runs exactly ONCE.
 *
 * Both are asserted here, and this file is separate from `daemon.test.ts` because `vi.mock` is
 * per-file and every case there wants the real `@slave-of-ai/control`.
 */
import { prisma } from '@slave-of-ai/db/client'
import type { AdapterRegistry } from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A mutable holder rather than `mockImplementation`, because `vi.mock` is hoisted above every
 * `const` in this file and the factory may not close over one that is not yet initialised
 * (`apps/web/test/integration/organization.test.ts`'s own note, same idiom).
 */
const reconcileThrows: { value: unknown } = { value: null }

vi.mock('@slave-of-ai/control', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@slave-of-ai/control')>()
  return {
    ...actual,
    // The REAL pass, counted -- so what is observed is how often the daemon asks for it, not a
    // simulation of what it does. Its report comes back through `mock.results`, which is what makes
    // "exactly one pool pass" provable rather than inferred.
    reconcileTemplateCapabilities: vi.fn(
      async (): ReturnType<typeof actual.reconcileTemplateCapabilities> => {
        if (reconcileThrows.value !== null) throw reconcileThrows.value
        return actual.reconcileTemplateCapabilities()
      },
    ),
    // Counted too, and expected NEVER to be called: this is the redundant second pass Important 4
    // deleted, and a count of zero is what stops it coming back.
    syncPersonPool: vi.fn(actual.syncPersonPool),
  }
})

const { reconcileTemplateCapabilities, syncPersonPool } = await import('@slave-of-ai/control')
const { runDaemon } = await import('../../src/daemon.js')
const { resetTickObservation } = await import('../../src/sweep.js')

/** Nothing in this file dispatches. A registry that throws is the assertion. */
const registry: AdapterRegistry = {
  resolve() {
    throw new Error('this test dispatches nothing, so nothing may resolve an adapter')
  },
}

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

describe('runDaemon startup reconciliation (final review fix round 2, gap 4)', () => {
  let stop = (): void => {}
  let finished: Promise<void> = Promise.resolve()
  let output: ReturnType<typeof captureStdout> | null = null

  beforeEach(async (): Promise<void> => {
    resetTickObservation()
    reconcileThrows.value = null
    vi.mocked(reconcileTemplateCapabilities).mockClear()
    vi.mocked(syncPersonPool).mockClear()
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

  const seed = async (name: string): Promise<string> =>
    (await prisma.workspace.create({ data: { name, repoPath: '/tmp/daemon-startup-test', verifyCommands: ['true'], setupCommands: [] } })).id

  const activeTemplate = async (name: string): Promise<{ readonly id: string }> =>
    prisma.slaveTemplate.create({
      data: { name, role: 'backend', description: 'x', active: true, capabilityKeys: ['backend.services'] },
    })

  it('rejects loudly when the reconciliation fails, and serves no project at all', async (): Promise<void> => {
    // A project that WOULD be served, so "no loop started" is a claim about a daemon that had
    // something to serve rather than about an empty install.
    const workspaceId = await seed('Never Served')
    const captured = captureStdout()
    output = captured
    reconcileThrows.value = new Error('the person pool could not be reconciled')

    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    stop = release

    await expect(
      runDaemon({ workspaceIds: 'all', registry, periodMs: 200, discoveryMs: 300, until: gate }),
    ).rejects.toThrow('the person pool could not be reconciled')

    // The whole finding: the throw is not caught, so nothing downstream of it ran. No serving line
    // means no loop, no subscription, no tick and no sweep -- the daemon stopped where it should.
    expect(captured.text()).not.toContain('serving')
    expect(captured.text()).not.toContain(workspaceId)
    // And it stopped BEFORE the pool it could not reconcile was half-used: nothing was staffed.
    expect(await prisma.person.count()).toBe(0)
  })

  it('runs exactly one reconciliation, and asks for no pool sync of its own', async (): Promise<void> => {
    await seed('Served Once')
    const template = await activeTemplate('Startup Pass Persona')
    const captured = captureStdout()
    output = captured

    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    stop = release
    finished = runDaemon({ workspaceIds: 'all', registry, periodMs: 200, discoveryMs: 300, until: gate })
    await until(() => captured.text().includes('serving'))

    expect(vi.mocked(reconcileTemplateCapabilities)).toHaveBeenCalledTimes(1)
    // Zero. The daemon used to run a second, unconditional `syncPersonPool()` right after the
    // reconciliation, which re-scanned every active template to report the people the pass before it
    // had just created as `0 created, 3 unchanged` -- an operator reading "staffed nothing" off a
    // startup that had staffed three.
    expect(vi.mocked(syncPersonPool)).not.toHaveBeenCalled()

    // ONE pool pass, and this is its report: `3 created` is only true of the FIRST pass over an
    // unstaffed template. A second pass anywhere in this startup would have found the slots filled
    // and reported them unchanged.
    const report = await vi.mocked(reconcileTemplateCapabilities).mock.results[0]?.value
    expect(report?.pool).toEqual({ templates: 1, created: 3, updated: 0, unchanged: 0 })
    expect(await prisma.person.count({ where: { templateId: template.id, poolSlot: { not: null } } })).toBe(3)
  })
})
