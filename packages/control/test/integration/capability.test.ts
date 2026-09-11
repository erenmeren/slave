import { prisma } from '@slave-of-ai/db/client'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  addCapability,
  backfillSlaveCapabilities,
  hireFromTemplate,
  listCapabilities,
  listOrganization,
  materialiseCompanySlave,
  mergeRuntimeRoles,
  setSlaveCapabilities,
  syncCapabilityTaxonomy,
} from '../../src/capability.js'
import { releaseWorker } from '../../src/lifecycle.js'
import { setRuntimeRoles } from '../../src/profile.js'

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

/** The `slave.runtime_roles_changed` rows written for one worker. */
const roleEvents = (slaveId: string) =>
  prisma.executionEvent.findMany({ where: { type: 'slave_runtime_roles_changed', slaveId } })

/** The `org.changed { field: 'capabilities' }` rows written for one worker (final review, 5c/8). */
const capabilityEvents = async (slaveId: string): Promise<{ from: string | null; to: string | null }[]> => {
  const rows = await prisma.executionEvent.findMany({
    where: { type: 'org_changed', slaveId },
    orderBy: { seq: 'asc' },
  })
  return rows
    .map((row) => row.payload as { field?: string; from?: string | null; to?: string | null })
    .filter((payload) => payload.field === 'capabilities')
    .map((payload) => ({ from: payload.from ?? null, to: payload.to ?? null }))
}

/** A role set one under the cap, so adding exactly one more crosses it. */
const ROLES_AT_CAP = Array.from({ length: 20 }, (_, index) => `role-${String(index)}`)

/** M50 R2: the ONE assignment a temporary hire names. A real row, because `Slave.engagementTaskId`
 *  is a foreign key and a made-up id is refused by the database rather than by the verb. */
async function engagement(workspaceId: string): Promise<{ id: string }> {
  return prisma.task.create({
    data: {
      workspaceId,
      title: 'Add authentication',
      description: 'the one assignment',
      status: 'ready',
      maxAttempts: 3,
      requiredRole: 'security',
    },
  })
}

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
    // `security.application` is a row OTHER files in this database read. The repair is what this
    // case is about, so it happens either way (fix round 1, minor 6): a `finally` puts the row
    // back even when an assertion above it throws.
    await prisma.capability.update({ where: { key: 'security.application' }, data: { label: 'wrong', role: 'backend' } })
    try {
      await prisma.capability.create({
        data: { key: 'local.thing', label: 'A local thing', domain: 'local', role: 'backend', synonyms: [], createdBy: 'human' },
      })
      const out = await syncCapabilityTaxonomy()
      expect(out.updated).toBe(1)
      const rows = await listCapabilities()
      expect(rows.find((row) => row.key === 'security.application')?.role).toBe('security')
      expect(rows.find((row) => row.key === 'local.thing')).toBeDefined()
    } finally {
      await syncCapabilityTaxonomy()
    }
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

  // Final review, Minor 8. The role event fired on every call, so re-running the verb with the same
  // list put a role change on a timeline where no role had changed -- and writing the capability
  // set, the thing the operator actually asked for, was recorded nowhere at all.
  it('records the capability change in labels, and the role change only when the roles moved', async (): Promise<void> => {
    const { teamId } = await workspace()
    const slave = await prisma.slave.create({
      data: { teamId, name: 'Rae', role: 'Engineer', runtimeRoles: ['backend'] },
    })

    expect((await setSlaveCapabilities(slave.id, ['security.application'], 'operator')).ok).toBe(true)
    expect(await roleEvents(slave.id)).toHaveLength(1)
    // LABELS on the event (Minor 5c): the timeline card renders `from -> to` verbatim at a person.
    expect(await capabilityEvents(slave.id)).toEqual([{ from: null, to: 'Application security' }])

    // The same list again: nothing moved, and nothing is recorded.
    expect((await setSlaveCapabilities(slave.id, ['security.application'], 'operator')).ok).toBe(true)
    expect(await roleEvents(slave.id)).toHaveLength(1)
    expect(await capabilityEvents(slave.id)).toHaveLength(1)

    // A different capability whose role the worker ALREADY holds: the capabilities moved, the roles
    // did not, and exactly one of the two events is written.
    expect((await setSlaveCapabilities(slave.id, ['backend.api-design'], 'operator')).ok).toBe(true)
    expect(await roleEvents(slave.id)).toHaveLength(1)
    expect(await capabilityEvents(slave.id)).toEqual([
      { from: null, to: 'Application security' },
      { from: 'Application security', to: 'API design' },
    ])
  })

  // Final review, Minor 7. `setRuntimeRoles` refuses a set over the cap; this verb unions into the
  // same column and never asked, so it could write a set the operator-facing verb would refuse.
  it('refuses, before writing anything, when the projected roles would pass the cap', async (): Promise<void> => {
    const { teamId } = await workspace()
    const slave = await prisma.slave.create({
      data: { teamId, name: 'Rae', role: 'Engineer', runtimeRoles: ROLES_AT_CAP },
    })
    const out = await setSlaveCapabilities(slave.id, ['security.application'], 'operator')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.kind).toBe('invalid_runtime_roles')
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: slave.id } })
    expect(row.runtimeRoles).toEqual(ROLES_AT_CAP)
    expect(row.capabilities).toEqual([])
    expect(await roleEvents(slave.id)).toHaveLength(0)
  })
})

/**
 * Fix round 1, Important 1. The Supervisor's `assign_capability` is the first AUTO-APPLIED runtime
 * role write in the system, and the M38 helper it used to go through read the slave outside the
 * lock its write took: `setSlaveCapabilities` committing `['backend','frontend']` in between meant
 * `frontend` was silently dropped by a union computed from a stale read.
 */
describe('mergeRuntimeRoles', () => {
  it('unions the adds into what the worker holds, held first', async (): Promise<void> => {
    const { teamId } = await workspace()
    const slave = await prisma.slave.create({
      data: { teamId, name: 'Rae', role: 'Engineer', runtimeRoles: ['backend'] },
    })
    const out = await mergeRuntimeRoles(slave.id, ['security'], 'supervisor')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.runtimeRoles).toEqual(['backend', 'security'])
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: slave.id } })).runtimeRoles).toEqual([
      'backend',
      'security',
    ])
    expect(await roleEvents(slave.id)).toHaveLength(1)
  })

  it('writes nothing and records nothing when the worker already holds every add', async (): Promise<void> => {
    const { teamId } = await workspace()
    const slave = await prisma.slave.create({
      data: { teamId, name: 'Rae', role: 'Engineer', runtimeRoles: ['backend'] },
    })
    expect((await mergeRuntimeRoles(slave.id, ['security'], 'supervisor')).ok).toBe(true)
    const again = await mergeRuntimeRoles(slave.id, ['security'], 'supervisor')
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value.runtimeRoles).toEqual(['backend', 'security'])
    // One event, from the first call: a set that did not move is not a fact worth a row.
    expect(await roleEvents(slave.id)).toHaveLength(1)
  })

  it('keeps BOTH writes when a capability edit and a merge land back to back', async (): Promise<void> => {
    const { teamId } = await workspace()
    const slave = await prisma.slave.create({
      data: { teamId, name: 'Rae', role: 'Engineer', runtimeRoles: ['backend'] },
    })
    // The operator's edit gives them `frontend` (through the taxonomy) -- and the Supervisor's
    // merge, which read the roster before that landed, must not take it away again.
    await prisma.slave.update({ where: { id: slave.id }, data: { runtimeRoles: ['backend', 'frontend'] } })
    const out = await mergeRuntimeRoles(slave.id, ['security'], 'supervisor')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.runtimeRoles).toEqual(['backend', 'frontend', 'security'])
  })

  it('refuses a slave that is not there', async (): Promise<void> => {
    const out = await mergeRuntimeRoles('nope', ['security'], 'supervisor')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.kind).toBe('slave_not_found')
  })

  // Final review, Minor 7: the refusal is returned BEFORE the write, so the Supervisor arm that
  // calls this records the decision `failed` and the worker keeps the roles it had.
  it('refuses rather than growing a worker past the runtime-role cap', async (): Promise<void> => {
    const { teamId } = await workspace()
    const slave = await prisma.slave.create({
      data: { teamId, name: 'Rae', role: 'Engineer', runtimeRoles: ROLES_AT_CAP },
    })
    const out = await mergeRuntimeRoles(slave.id, ['security'], 'supervisor')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.kind).toBe('invalid_runtime_roles')
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: slave.id } })).runtimeRoles).toEqual(ROLES_AT_CAP)
    expect(await roleEvents(slave.id)).toHaveLength(0)
  })

  // The cap is a cap, not a refusal to be idempotent: a worker already AT it can still be merged
  // with a role it holds, because the union does not grow.
  it('still succeeds at the cap when every add is already held', async (): Promise<void> => {
    const { teamId } = await workspace()
    const slave = await prisma.slave.create({
      data: { teamId, name: 'Rae', role: 'Engineer', runtimeRoles: ROLES_AT_CAP },
    })
    const out = await mergeRuntimeRoles(slave.id, ['role-0'], 'supervisor')
    expect(out.ok).toBe(true)
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

  // Fix round 1, minor 2: the "is one already hired?" read now happens under the workspace row
  // lock, so two concurrent hires serialise instead of both deciding "no" and creating two.
  it('creates exactly one worker when two hires for the same template race', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })

    const [first, second] = await Promise.all([
      hireFromTemplate(workspaceId, template.id, { rationale: 'first', capabilities: ['qa.test-automation'] }),
      hireFromTemplate(workspaceId, template.id, { rationale: 'second', capabilities: ['backend.api-design'] }),
    ])

    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(await prisma.slave.count({ where: { team: { workspaceId } } })).toBe(1)
    // One of the two created the worker and the other reused it; which one won the lock is not
    // something a test may assert, but that exactly one reused it is.
    expect([first.value.reused, second.value.reused].filter(Boolean)).toHaveLength(1)
    expect(first.value.slaveId).toBe(second.value.slaveId)
    // Both callers' capabilities are on the row: the loser merged rather than overwrote.
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: first.value.slaveId } })
    expect(row.capabilities).toEqual(['backend.api-design', 'qa.test-automation', 'security.application'])
    expect([...row.runtimeRoles].toSorted()).toEqual(['backend', 'qa', 'security'])
  })

  // Fix round 1, minor 3: a reuse that CHANGES the worker is a write, and a write nobody can see
  // in the log is how a roster grows roles no one remembers granting.
  it('records the reuse: the roles event when the role set grew, the capability event when only the keys did', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })
    const first = await hireFromTemplate(workspaceId, template.id, { rationale: 'first' })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    // A second hire bringing a capability that projects to a role the worker did not hold.
    const grew = await hireFromTemplate(workspaceId, template.id, { rationale: 'second', capabilities: ['qa.test-automation'] })
    expect(grew.ok && grew.value.reused).toBe(true)
    const roleEvents = await prisma.executionEvent.findMany({
      where: { workspaceId, type: 'slave_runtime_roles_changed' },
    })
    expect(roleEvents).toHaveLength(1)
    expect((roleEvents[0]?.payload as { roles: string[] }).roles).toEqual(['security', 'qa'])

    // A third bringing a capability that projects to a role it already holds: the keys changed,
    // the role set did not.
    const merged = await hireFromTemplate(workspaceId, template.id, {
      rationale: 'third',
      capabilities: ['security.authentication'],
    })
    expect(merged.ok && merged.value.reused).toBe(true)
    const orgEvents = await prisma.executionEvent.findMany({
      where: { workspaceId, type: 'org_changed', slaveId: first.value.slaveId },
    })
    // One for the hire that created the worker, one for this capability merge.
    expect(orgEvents.map((event) => (event.payload as { field: string }).field)).toEqual(['created', 'capabilities'])

    // ...and a reuse that changes nothing writes nothing: there is no fact to record.
    await hireFromTemplate(workspaceId, template.id, { rationale: 'fourth' })
    expect(await prisma.executionEvent.count({ where: { workspaceId, type: 'org_changed' } })).toBe(2)
    expect(await prisma.executionEvent.count({ where: { workspaceId, type: 'slave_runtime_roles_changed' } })).toBe(1)
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

  /**
   * FINAL REVIEW, IMPORTANT 1. The reuse branch held the WORKSPACE row under `FOR UPDATE` -- which
   * serialises it against another hire and against nothing else. `setRuntimeRoles`,
   * `setSlaveCapabilities` and `mergeRuntimeRoles` all lock the SLAVE row, so a `set-runtime-roles`
   * landing between the `findFirst` and the update was overwritten by a union computed from the
   * row as it was BEFORE it: the role the operator had just granted, gone, with no event to say so.
   *
   * Back to back rather than concurrent, for the reason the round-1 concurrency case gives: the
   * `FOR UPDATE` is the argument, and a sequential case is the one that can actually assert which
   * roles survived.
   */
  it('lands both a role granted between two hires and the roles the second hire brings', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })
    const first = await hireFromTemplate(workspaceId, template.id, { rationale: 'first' })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    // The operator's own write, through the verb that owns the column.
    const granted = await setRuntimeRoles(first.value.slaveId, ['security', 'reviewer'], 'operator')
    expect(granted.ok).toBe(true)

    const second = await hireFromTemplate(workspaceId, template.id, {
      rationale: 'second',
      capabilities: ['qa.test-automation'],
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.slaveId).toBe(first.value.slaveId)
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: first.value.slaveId } })
    // `reviewer` is the one the stale read used to eat.
    expect(row.runtimeRoles).toEqual(['security', 'reviewer', 'qa'])
    expect(row.capabilities).toEqual(['qa.test-automation', 'security.application'])
  })

  // Final review, Minor 5c: the event a person reads carries the WORDS. The keys are on the slave
  // row this event names, so nothing is lost.
  it('records a reuse that only added capabilities in labels, not in keys', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })
    const first = await hireFromTemplate(workspaceId, template.id, { rationale: 'first' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    // `review.code-review` projects to `reviewer`; give it to them first, so the reuse below moves
    // the capabilities and NOT the roles and takes the `org.changed` arm.
    expect((await setRuntimeRoles(first.value.slaveId, ['security', 'reviewer'], 'operator')).ok).toBe(true)
    expect(
      (await hireFromTemplate(workspaceId, template.id, { rationale: 'second', capabilities: ['review.code-review'] })).ok,
    ).toBe(true)
    expect(await capabilityEvents(first.value.slaveId)).toEqual([
      { from: 'Application security', to: 'Code review, Application security' },
    ])
  })

  // Final review, Minor 7: the reuse merge unions into `runtimeRoles` like the other two writers,
  // and refuses the same way when the union would pass the cap.
  it('refuses a reuse whose merged roles would pass the cap, and writes nothing', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })
    const first = await hireFromTemplate(workspaceId, template.id, { rationale: 'first' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    await prisma.slave.update({ where: { id: first.value.slaveId }, data: { runtimeRoles: ROLES_AT_CAP } })

    const second = await hireFromTemplate(workspaceId, template.id, {
      rationale: 'second',
      capabilities: ['qa.test-automation'],
    })
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.error.kind).toBe('invalid_runtime_roles')
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: first.value.slaveId } })
    expect(row.runtimeRoles).toEqual(ROLES_AT_CAP)
    expect(row.capabilities).toEqual(['security.application'])
  })

  it('writes lifecycle project for an ordinary hire, and no engagement', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })
    const result = await hireFromTemplate(workspaceId, template.id, { rationale: 'needed here' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const worker = await prisma.slave.findUniqueOrThrow({ where: { id: result.value.slaveId } })
    expect(worker.lifecycle).toBe('project')
    expect(worker.engagementTaskId).toBeNull()
    // M50 R1: the rationale is the SENTENCE, and nothing else. The column is the record now.
    expect(worker.selectionRationale).toBe('needed here')
  })

  it('writes lifecycle ephemeral and the engagement for a temporary hire', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })
    const task = await engagement(workspaceId)
    const result = await hireFromTemplate(workspaceId, template.id, {
      rationale: 'one assignment',
      temporary: true,
      engagementTaskId: task.id,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const worker = await prisma.slave.findUniqueOrThrow({ where: { id: result.value.slaveId } })
    expect(worker.lifecycle).toBe('ephemeral')
    expect(worker.engagementTaskId).toBe(task.id)
    // The suffix is gone (R1): a column holds the fact, so the sentence stays the sentence.
    expect(worker.selectionRationale).toBe('one assignment')
  })

  it('refuses a temporary hire whose assignment is not a task of this project', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })
    const result = await hireFromTemplate(workspaceId, template.id, {
      rationale: 'one assignment',
      temporary: true,
      engagementTaskId: '00000000-0000-0000-0000-000000000000',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('task_not_found')
    // Refused BEFORE the first write: no worker, and no `org.changed { field: 'created' }`.
    expect(await prisma.slave.count({ where: { team: { workspaceId } } })).toBe(0)
  })

  it('reuses an unreleased hire and never rewrites its lifecycle', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })
    const task = await engagement(workspaceId)
    const first = await hireFromTemplate(workspaceId, template.id, { rationale: 'needed here' })
    const second = await hireFromTemplate(workspaceId, template.id, {
      rationale: 'one assignment',
      temporary: true,
      engagementTaskId: task.id,
    })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.value.reused).toBe(true)
    expect(second.value.slaveId).toBe(first.value.slaveId)
    const worker = await prisma.slave.findUniqueOrThrow({ where: { id: first.value.slaveId } })
    // E13: R4 is absolute -- only `setLifecycle` moves a lifecycle.
    expect(worker.lifecycle).toBe('project')
    expect(worker.engagementTaskId).toBeNull()
  })

  it('never reuses a RELEASED worker -- the new hire is a new worker with the next name', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })
    const task = await engagement(workspaceId)
    const first = await hireFromTemplate(workspaceId, template.id, {
      rationale: 'one assignment',
      temporary: true,
      engagementTaskId: task.id,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const firstName = (await prisma.slave.findUniqueOrThrow({ where: { id: first.value.slaveId } })).name
    expect((await releaseWorker(first.value.slaveId, 'over')).ok).toBe(true)

    const second = await hireFromTemplate(workspaceId, template.id, { rationale: 'again' })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.reused).toBe(false)
    expect(second.value.slaveId).not.toBe(first.value.slaveId)
    const secondName = (await prisma.slave.findUniqueOrThrow({ where: { id: second.value.slaveId } })).name
    expect(secondName).toBe(`${firstName} 2`)
  })
})

/**
 * FINAL REVIEW, IMPORTANT 4. `Slave.capabilities` is `@default([])` and nothing backfilled it, so on
 * every project that existed before M47 the column is empty on every row -- and `formTeam`'s FIRST
 * and cheapest tier is the one that reads it. This verb is the once-per-project fix.
 */
describe('backfillSlaveCapabilities', () => {
  async function fixture(): Promise<{
    workspaceId: string
    hired: string
    materialised: string
    described: string
    bare: string
  }> {
    const { workspaceId, teamId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })
    const company = await prisma.company.create({ data: { name: 'M47 Co' } })
    const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Security' } })
    const roster = await prisma.companySlave.create({
      data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Sam' },
    })
    // Every one of these is shaped like a worker the pre-M47 code wrote: linked to a template,
    // holding a role, providing nothing.
    const hired = await prisma.slave.create({
      data: { teamId, name: 'Hired', role: 'security', runtimeRoles: ['backend'], hiredFromTemplateId: template.id },
    })
    const materialised = await prisma.slave.create({
      data: { teamId, name: 'Sam', role: 'security', runtimeRoles: [], companySlaveId: roster.id },
    })
    const described = await prisma.slave.create({
      data: {
        teamId,
        name: 'Described',
        role: 'security',
        runtimeRoles: ['backend'],
        hiredFromTemplateId: template.id,
        capabilities: ['backend.api-design'],
      },
    })
    const bare = await prisma.slave.create({ data: { teamId, name: 'Bare', role: 'Engineer', runtimeRoles: ['backend'] } })
    return { workspaceId, hired: hired.id, materialised: materialised.id, described: described.id, bare: bare.id }
  }

  it('describes a worker from the template it came from and adds the roles those project to', async (): Promise<void> => {
    const f = await fixture()
    // `described` is not even scanned -- the query asks for an EMPTY capability set -- so the one
    // skip is `bare`, the worker with no template to read.
    expect(await backfillSlaveCapabilities(f.workspaceId)).toEqual({ updated: 2, skipped: 1 })

    const hired = await prisma.slave.findUniqueOrThrow({ where: { id: f.hired } })
    expect(hired.capabilities).toEqual(['security.application'])
    // UNIONED, never replaced: taking a role away as a side effect of describing a skill parks a
    // worker mid-project.
    expect(hired.runtimeRoles).toEqual(['backend', 'security'])

    // Through the roster row's template, which is how a materialised worker is linked.
    const materialised = await prisma.slave.findUniqueOrThrow({ where: { id: f.materialised } })
    expect(materialised.capabilities).toEqual(['security.application'])
    expect(materialised.runtimeRoles).toEqual(['security'])
  })

  it("never touches a worker an operator has already described, or one with no template", async (): Promise<void> => {
    const f = await fixture()
    await backfillSlaveCapabilities(f.workspaceId)
    const described = await prisma.slave.findUniqueOrThrow({ where: { id: f.described } })
    expect(described.capabilities).toEqual(['backend.api-design'])
    expect(described.runtimeRoles).toEqual(['backend'])
    const bare = await prisma.slave.findUniqueOrThrow({ where: { id: f.bare } })
    expect(bare.capabilities).toEqual([])
  })

  it('writes one org.changed per changed worker, in labels, and nothing on a second run', async (): Promise<void> => {
    const f = await fixture()
    await backfillSlaveCapabilities(f.workspaceId)
    expect(await capabilityEvents(f.hired)).toEqual([{ from: null, to: 'Application security' }])
    expect(await capabilityEvents(f.described)).toEqual([])

    // Idempotent: the second run finds nothing empty that has a template.
    expect(await backfillSlaveCapabilities(f.workspaceId)).toEqual({ updated: 0, skipped: 1 })
    expect(await capabilityEvents(f.hired)).toHaveLength(1)
  })

  it('does every project when no workspace is named, and skips a worker the cap would break', async (): Promise<void> => {
    const f = await fixture()
    await prisma.slave.update({ where: { id: f.hired }, data: { runtimeRoles: ROLES_AT_CAP } })
    const out = await backfillSlaveCapabilities()
    // The materialised worker was described; the capped one and the bare one were not.
    expect(out).toEqual({ updated: 1, skipped: 2 })
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: f.hired } })).capabilities).toEqual([])
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

  it('materialises a roster worker as permanent', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Roster Security', role: 'security', capabilityKeys: ['security.application'] },
    })
    const company = await prisma.company.create({ data: { name: 'M50 Co' } })
    const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Security' } })
    const rosterRow = await prisma.companySlave.create({
      data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Sam' },
    })
    const result = await materialiseCompanySlave(workspaceId, rosterRow.id, { rationale: 'from the roster' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const worker = await prisma.slave.findUniqueOrThrow({ where: { id: result.value.slaveId } })
    // M50 R1: a roster worker EXISTS in the organisation, which is what `permanent` means -- never
    // the column default, which would call every one of them a project hire.
    expect(worker.lifecycle).toBe('permanent')
  })
})

// Fix round 1, minor 4: the department step is `assignCompanyTx`'s own, shared rather than
// re-implemented -- a hand-made department of the same name is ADOPTED, never shadowed by a
// `Security 2` the operator did not ask for.
describe('materialiseCompanySlave and a department that already exists', () => {
  it('binds the roster team to a hand-made department of the same name', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const legacy = await prisma.team.create({ data: { workspaceId, name: 'Security' } })
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Roster Security', role: 'security', capabilityKeys: ['security.application'] },
    })
    const company = await prisma.company.create({ data: { name: 'M47 Co' } })
    const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Security' } })
    const rosterRow = await prisma.companySlave.create({
      data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Sam' },
    })

    const out = await materialiseCompanySlave(workspaceId, rosterRow.id, {})
    expect(out.ok).toBe(true)
    if (!out.ok) return

    const row = await prisma.slave.findUniqueOrThrow({ where: { id: out.value.slaveId } })
    expect(row.teamId).toBe(legacy.id)
    expect((await prisma.team.findUniqueOrThrow({ where: { id: legacy.id } })).companyTeamId).toBe(companyTeam.id)
    expect(await prisma.team.count({ where: { workspaceId, name: 'Security 2' } })).toBe(0)
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
    // M50 R6: the column, not the `companySlaveId === null` derivation this view used to make --
    // which could not tell a project hire from a specialist brought in for one assignment.
    expect(worker?.lifecycle).toBe('project')
    expect(worker?.released).toBeNull()
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
