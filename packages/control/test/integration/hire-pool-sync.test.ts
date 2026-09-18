/**
 * Final review, Important 5: `hireFromTemplate` must not run a GLOBAL `syncPersonPool()` before it
 * knows no existing open seat can be reused.
 *
 * The verb read a pool candidate before opening its transaction (for lock order -- see the comment
 * in `capability.ts`), and when that read came back `pool_unavailable` it ran a whole-installation
 * pool sync and re-read, unconditionally, BEFORE the transaction had looked for an existing seat.
 * On the well-worn reuse path -- E10's "two situations can both land on the same template" -- every
 * repeat hire therefore walked every active template in the catalogue and wrote three rows for any
 * that were short, to decide something it then threw away. The measured shape of that is a hire
 * doing 800+ round trips to reuse one seat it already had.
 *
 * The sync is now at most ONE, and only after the transaction has established that nothing existing
 * can be reused. Proving "at most one" needs the call itself counted, which is why this file exists
 * separately: it wraps the real `syncPersonPool` in a counting spy through `vi.mock` +
 * `importActual`, so the behaviour under test is the real one and only the call count is observed.
 */
import { prisma } from '@slave-of-ai/db/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/personPool.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/personPool.js')>('../../src/personPool.js')
  return { ...actual, syncPersonPool: vi.fn(actual.syncPersonPool) }
})

const { hireFromTemplate, syncCapabilityTaxonomy } = await import('../../src/capability.js')
const { syncPersonPool } = await import('../../src/personPool.js')

const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "Slave", "Team", "Workspace", "Person", "SlaveTemplate" RESTART IDENTITY CASCADE'

let workspaceSeq = 0

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(TRUNCATE)
  await syncCapabilityTaxonomy()
  vi.mocked(syncPersonPool).mockClear()
})

async function project(): Promise<{ workspaceId: string; teamId: string }> {
  workspaceSeq += 1
  const workspace = await prisma.workspace.create({
    data: {
      name: `Important 5 Project ${String(workspaceSeq)}`,
      repoPath: '/tmp/important-5',
      verifyCommands: ['true'],
      setupCommands: [],
      maxAttempts: 3,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  return { workspaceId: workspace.id, teamId: team.id }
}

/** An ACTIVE template, so a pool sync would genuinely have something to create for it. */
async function activeTemplate(name: string): Promise<{ id: string }> {
  return prisma.slaveTemplate.create({
    data: { name, role: 'backend', description: 'x', active: true, capabilityKeys: ['backend.api-design'] },
  })
}

describe('hireFromTemplate on the reuse path', () => {
  it('runs no pool sync at all when an existing open seat from this template can be reused', async (): Promise<void> => {
    const { workspaceId, teamId } = await project()
    const template = await activeTemplate('Reusable Backend Developer')
    // Somebody already hired from this persona, seated and open. Deliberately UNMANAGED (no
    // `poolSlot`), because the pool for this template has never been synced -- which is what makes
    // a sync observable if one happens.
    const person = await prisma.person.create({ data: { name: 'Already Here', templateId: template.id } })
    await prisma.slave.create({ data: { teamId, personId: person.id, role: 'backend', runtimeRoles: ['backend'] } })

    const first = await hireFromTemplate(workspaceId, template.id, { rationale: 'first repeat' })
    const second = await hireFromTemplate(workspaceId, template.id, { rationale: 'second repeat' })
    const third = await hireFromTemplate(workspaceId, template.id, { rationale: 'third repeat' })

    for (const out of [first, second, third]) {
      expect(out.ok).toBe(true)
      if (out.ok) expect(out.value.reused).toBe(true)
    }
    expect(vi.mocked(syncPersonPool)).not.toHaveBeenCalled()
    // And no pool WRITES either, which is the fact an operator would have noticed: three repeat
    // hires used to leave three managed people behind for a template nobody staffed from.
    expect(await prisma.person.count({ where: { poolSlot: { not: null } } })).toBe(0)
    expect(await prisma.person.count()).toBe(1)
  })

  it('runs no pool sync for ANOTHER template either: the sync it skipped was installation-wide', async (): Promise<void> => {
    const { workspaceId, teamId } = await project()
    const template = await activeTemplate('Reusable Backend Developer')
    // A second active template with no pool. A global sync would create three people for it while
    // deciding a question about the first template -- work with no relation to this hire at all.
    const unrelated = await activeTemplate('Unrelated Active Persona')
    const person = await prisma.person.create({ data: { name: 'Already Here', templateId: template.id } })
    await prisma.slave.create({ data: { teamId, personId: person.id, role: 'backend', runtimeRoles: ['backend'] } })

    expect((await hireFromTemplate(workspaceId, template.id, { rationale: 'repeat' })).ok).toBe(true)

    expect(vi.mocked(syncPersonPool)).not.toHaveBeenCalled()
    expect(await prisma.person.count({ where: { templateId: unrelated.id } })).toBe(0)
  })

  it('reuses the seat even when the pool IS available, and still never syncs', async (): Promise<void> => {
    const { workspaceId, teamId } = await project()
    const template = await activeTemplate('Reusable Backend Developer')
    // The pool exists before the hire -- so selection succeeds and no sync is needed for a
    // different reason. What is being pinned is that the reuse path takes neither. The spy wraps
    // the real function, so this call is the real sync; the counter is cleared after it.
    await syncPersonPool()
    vi.mocked(syncPersonPool).mockClear()
    const person = await prisma.person.create({ data: { name: 'Already Here', templateId: template.id } })
    await prisma.slave.create({ data: { teamId, personId: person.id, role: 'backend', runtimeRoles: ['backend'] } })

    const out = await hireFromTemplate(workspaceId, template.id, { rationale: 'repeat' })

    expect(out.ok && out.value.reused).toBe(true)
    if (out.ok) expect(out.value.personId).toBe(person.id)
    expect(vi.mocked(syncPersonPool)).not.toHaveBeenCalled()
  })
})

describe('hireFromTemplate when the pool is genuinely missing', () => {
  it('syncs exactly once, then seats a managed person', async (): Promise<void> => {
    const { workspaceId } = await project()
    const template = await activeTemplate('Never Synced Backend Developer')

    const out = await hireFromTemplate(workspaceId, template.id, { rationale: 'the first hire ever' })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(vi.mocked(syncPersonPool)).toHaveBeenCalledTimes(1)
    const person = await prisma.person.findUniqueOrThrow({ where: { id: out.value.personId } })
    expect(person.poolSlot).not.toBeNull()
    expect(await prisma.person.count({ where: { templateId: template.id, poolSlot: { not: null } } })).toBe(3)
  })

  /**
   * The MANUAL fallback, genuinely reached (fix round 2, gap 3).
   *
   * This case used to release the three managed people AND clear their `poolSlot`, which is what
   * `releasePerson` writes today (final review, Important 3) -- so the one sync it permitted found
   * three vacant slots, minted three new managed identities, and the second attempt seated one of
   * them. It asserted the sync count, which was right, and its title claimed a fallback that never
   * happened; nothing in the file reached `createPerson`'s branch at all.
   *
   * The state that genuinely cannot be helped is a pool whose slots are OCCUPIED by people who are
   * all released -- which is exactly what any installation that released somebody before Important 3
   * has on disk, because the release did not free the slot. Seeded directly here rather than through
   * `releasePerson`, because the verb no longer produces it and the point is the rows, not the verb:
   * `syncPersonPool` sees three occupied slots and has nothing to create, `selectPoolPerson` filters
   * every one of them out on `releasedAt: null`, and the hire has to make somebody or refuse.
   */
  it('syncs exactly once, cannot be helped by it, and falls back to an UNMANAGED person', async (): Promise<void> => {
    const { workspaceId } = await project()
    const template = await activeTemplate('Everybody Released, Slots Still Held')
    await syncPersonPool()
    // Released, slots UNTOUCHED -- the legacy shape. `poolSlot` deliberately not cleared.
    await prisma.person.updateMany({
      where: { templateId: template.id },
      data: { releasedAt: new Date(), releaseReason: 'released before the slot was freed' },
    })
    vi.mocked(syncPersonPool).mockClear()

    const out = await hireFromTemplate(workspaceId, template.id, { rationale: 'needed anyway' })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    // ONE sync, not a loop and not none: reuse was ruled out under the workspace lock, the pool was
    // given its single chance to help, and the second attempt is the last.
    expect(vi.mocked(syncPersonPool)).toHaveBeenCalledTimes(1)
    // The fallback actually taken: a brand-new person of this persona holding NO slot. That is the
    // `requirePool`-unset compatibility path, and until now nothing proved it was reachable.
    const hired = await prisma.person.findUniqueOrThrow({ where: { id: out.value.personId } })
    expect(hired.poolSlot).toBeNull()
    expect(hired.templateId).toBe(template.id)
    expect(hired.releasedAt).toBeNull()
    expect(out.value.reused).toBe(false)
    // And the sync created nothing, because it had nothing to create: three occupied slots, all held
    // by people it must never touch.
    const managed = await prisma.person.findMany({ where: { templateId: template.id, poolSlot: { not: null } } })
    expect(managed).toHaveLength(3)
    for (const person of managed) expect(person.releasedAt).not.toBeNull()
  })

  it('does not sync a second time on a hire that refuses under requirePool', async (): Promise<void> => {
    const { workspaceId } = await project()
    // INACTIVE: a sync creates nothing for it, so the pool stays unavailable through both attempts
    // and `requirePool` refuses. The sync still ran once -- the point is that it ran once.
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Inactive Persona', role: 'backend', description: 'x', active: false, capabilityKeys: [] },
    })

    const out = await hireFromTemplate(workspaceId, template.id, { rationale: 'automatic', requirePool: true })

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toMatchObject({ kind: 'pool_unavailable', templateId: template.id })
    expect(vi.mocked(syncPersonPool)).toHaveBeenCalledTimes(1)
    expect(await prisma.person.count()).toBe(0)
  })
})
