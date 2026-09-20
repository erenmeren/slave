import { prisma } from '@slave-of-ai/db/client'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  addCapability,
  backfillSlaveCapabilities,
  hireFromTemplate,
  listCapabilities,
  listOrganization,
  seatMember,
  mergeRuntimeRoles,
  setPersonCapabilities,
  syncCapabilityTaxonomy,
} from '../../src/capability.js'
import { syncPersonPool } from '../../src/personPool.js'
import { releasePerson, unassignPerson } from '../../src/persons.js'
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
  'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace", "CollaborationHint", "CompanyTeamMember", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE'

let workspaceSeq = 0

beforeEach(async (): Promise<void> => {
  workspaceSeq = 0
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
  // Numbered: `Workspace.name` is unique, and one case needs three projects to seat one person on.
  workspaceSeq += 1
  const ws = await prisma.workspace.create({
    data: {
      name: workspaceSeq === 1 ? 'M47 Control' : `M47 Control ${String(workspaceSeq)}`,
      repoPath: '/tmp/m47',
      verifyCommands: ['true'],
      setupCommands: [],
      maxAttempts: 3,
    },
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
    // 2026-09-20 catalogue capability mapping, R1: `legal.contracts` is now a seeded row (grown
    // taxonomy), so the operator key this case adds is `legal.playbook`, a key the seed does not
    // carry.
    const ok = await addCapability({ key: 'legal.playbook', label: 'Playbook review', role: 'legal' })
    expect(ok.ok).toBe(true)
    expect((await listCapabilities()).find((row) => row.key === 'legal.playbook')?.domain).toBe('legal')

    for (const bad of [
      { key: 'Legal.Playbook', label: 'x', role: 'legal' },
      { key: 'legal.playbook', label: 'x', role: 'legal' },
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

describe('setPersonCapabilities', () => {
  it('stores the resolved keys, adds their roles to every open seat, and never removes a role', async (): Promise<void> => {
    const { teamId } = await workspace()
    const person = await prisma.person.create({ data: { name: 'Rae' } })
    const slave = await prisma.slave.create({ data: { teamId: teamId, role: 'Engineer', runtimeRoles: ['backend'], personId: person.id } })
    const out = await setPersonCapabilities(person.id, ['Application security', 'Vibes'], 'operator')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.keys).toEqual(['security.application'])
    expect(out.value.unresolved).toEqual(['Vibes'])
    // The union, in the order M37's `addRuntimeRoles` writes it: what was held, then what is new.
    expect(out.value.runtimeRoles).toEqual(['backend', 'security'])
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: slave.id }, include: { person: true } })
    expect(row.person.capabilities).toEqual(['security.application'])
  })

  it('refuses a slave that is not there', async (): Promise<void> => {
    const out = await setPersonCapabilities('00000000-0000-4000-8000-000000000000', ['appsec'], 'operator')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.kind).toBe('person_not_found')
  })

  // M58 R1: the capability set is one fact about one specialist, so it holds on every project they
  // sit on -- and the roles it projects to land on each of their OPEN seats.
  it('writes one capability set and reaches every open seat the person holds', async (): Promise<void> => {
    const first = await workspace()
    const second = await workspace()
    const person = await prisma.person.create({ data: { name: 'Rae' } })
    const here = await prisma.slave.create({ data: { teamId: first.teamId, role: 'Engineer', runtimeRoles: ['backend'], personId: person.id } })
    const there = await prisma.slave.create({ data: { teamId: second.teamId, role: 'Engineer', runtimeRoles: [], personId: person.id } })
    const closed = await prisma.slave.create({
      data: { teamId: (await workspace()).teamId, role: 'Engineer', runtimeRoles: [], personId: person.id, closedAt: new Date() },
    })

    expect((await setPersonCapabilities(person.id, ['security.application'], 'operator')).ok).toBe(true)

    expect((await prisma.person.findUniqueOrThrow({ where: { id: person.id } })).capabilities).toEqual(['security.application'])
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: here.id } })).runtimeRoles).toEqual(['backend', 'security'])
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: there.id } })).runtimeRoles).toEqual(['security'])
    // A closed seat is history: it keeps the empty set it was closed with.
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: closed.id } })).runtimeRoles).toEqual([])
  })

  // Final review, Minor 8. The role event fired on every call, so re-running the verb with the same
  // list put a role change on a timeline where no role had changed -- and writing the capability
  // set, the thing the operator actually asked for, was recorded nowhere at all.
  it('records the capability change in labels, and the role change only when the roles moved', async (): Promise<void> => {
    const { teamId } = await workspace()
    const person = await prisma.person.create({ data: { name: 'Rae' } })
    const slave = await prisma.slave.create({ data: { teamId: teamId, role: 'Engineer', runtimeRoles: ['backend'], personId: person.id } })

    expect((await setPersonCapabilities(person.id, ['security.application'], 'operator')).ok).toBe(true)
    expect(await roleEvents(slave.id)).toHaveLength(1)
    // LABELS on the event (Minor 5c): the timeline card renders `from -> to` verbatim at a person.
    expect(await capabilityEvents(slave.id)).toEqual([{ from: null, to: 'Application security' }])

    // The same list again: nothing moved, and nothing is recorded.
    expect((await setPersonCapabilities(person.id, ['security.application'], 'operator')).ok).toBe(true)
    expect(await roleEvents(slave.id)).toHaveLength(1)
    expect(await capabilityEvents(slave.id)).toHaveLength(1)

    // A different capability whose role the worker ALREADY holds: the capabilities moved, the roles
    // did not, and exactly one of the two events is written.
    expect((await setPersonCapabilities(person.id, ['backend.api-design'], 'operator')).ok).toBe(true)
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
    const person = await prisma.person.create({ data: { name: 'Rae' } })
    const slave = await prisma.slave.create({ data: { teamId: teamId, role: 'Engineer', runtimeRoles: ROLES_AT_CAP, personId: person.id } })
    const out = await setPersonCapabilities(person.id, ['security.application'], 'operator')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.kind).toBe('invalid_runtime_roles')
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: slave.id }, include: { person: true } })
    expect(row.runtimeRoles).toEqual(ROLES_AT_CAP)
    expect(row.person.capabilities).toEqual([])
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
    const slave = await prisma.slave.create({ data: { teamId: teamId, role: 'Engineer', runtimeRoles: ['backend'], personId: (await prisma.person.create({ data: { name: 'Rae' } })).id } })
    const out = await mergeRuntimeRoles(slave.id, ['security'], 'supervisor')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.runtimeRoles).toEqual(['backend', 'security'])
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: slave.id }, include: { person: true } })).runtimeRoles).toEqual([
      'backend',
      'security',
    ])
    expect(await roleEvents(slave.id)).toHaveLength(1)
  })

  it('writes nothing and records nothing when the worker already holds every add', async (): Promise<void> => {
    const { teamId } = await workspace()
    const slave = await prisma.slave.create({ data: { teamId: teamId, role: 'Engineer', runtimeRoles: ['backend'], personId: (await prisma.person.create({ data: { name: 'Rae' } })).id } })
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
    const slave = await prisma.slave.create({ data: { teamId: teamId, role: 'Engineer', runtimeRoles: ['backend'], personId: (await prisma.person.create({ data: { name: 'Rae' } })).id } })
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
    const slave = await prisma.slave.create({ data: { teamId: teamId, role: 'Engineer', runtimeRoles: ROLES_AT_CAP, personId: (await prisma.person.create({ data: { name: 'Rae' } })).id } })
    const out = await mergeRuntimeRoles(slave.id, ['security'], 'supervisor')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.kind).toBe('invalid_runtime_roles')
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: slave.id }, include: { person: true } })).runtimeRoles).toEqual(ROLES_AT_CAP)
    expect(await roleEvents(slave.id)).toHaveLength(0)
  })

  // The cap is a cap, not a refusal to be idempotent: a worker already AT it can still be merged
  // with a role it holds, because the union does not grow.
  it('still succeeds at the cap when every add is already held', async (): Promise<void> => {
    const { teamId } = await workspace()
    const slave = await prisma.slave.create({ data: { teamId: teamId, role: 'Engineer', runtimeRoles: ROLES_AT_CAP, personId: (await prisma.person.create({ data: { name: 'Rae' } })).id } })
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
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: out.value.slaveId }, include: { person: true } })
    expect(row.person.capabilities).toEqual(['security.application'])
    expect(row.runtimeRoles).toEqual(['security'])
    expect(row.person.templateId).toBe(template.id)
    expect(row.person.selectionRationale).toBe('authentication work needs application security')
    expect(row.person.name).toBe('Security Reviewer')
    // Fix round 1, Important 4: the PERSON comes back too. Tasks 3-8 give a hire a skill, a
    // department or a second seat, and every one of those addresses the person, not the seat.
    expect(out.value.personId).toBe(row.personId)
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
    expect(second.value.personId).toBe(first.value.personId)
    expect(second.value.reused).toBe(true)
    expect(await prisma.slave.count({ where: { team: { workspaceId } } })).toBe(1)
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: first.value.slaveId }, include: { person: true } })
    // The rationale of the FIRST hire is not overwritten: it is why this worker is here.
    expect(row.person.selectionRationale).toBe('first')
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
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: first.value.slaveId }, include: { person: true } })
    expect(row.person.capabilities).toEqual(['backend.api-design', 'qa.test-automation', 'security.application'])
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
    await prisma.slave.create({ data: { teamId: teamId, role: 'x', runtimeRoles: [], personId: (await prisma.person.create({ data: { name: 'Security Reviewer' } })).id } })
    const template = await prisma.slaveTemplate.create({ data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'] } })
    const out = await hireFromTemplate(workspaceId, template.id, { rationale: 'why' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: out.value.slaveId }, include: { person: true } })
    expect(row.person.name).toBe('Security Reviewer 2')
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
   * `setPersonCapabilities` and `mergeRuntimeRoles` all lock the SLAVE row, so a `set-runtime-roles`
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
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: first.value.slaveId }, include: { person: true } })
    // `reviewer` is the one the stale read used to eat.
    expect(row.runtimeRoles).toEqual(['security', 'reviewer', 'qa'])
    expect(row.person.capabilities).toEqual(['qa.test-automation', 'security.application'])
  })

  /**
   * Fix round 1, Important 5. The same lost update as the case above, reopened by M58's split:
   * `capabilities` is the PERSON's column now, this branch merges and writes it under a lock the
   * helper took on the SEAT, and `setPersonCapabilities` writes it under a lock on the PERSON. Two
   * different rows, so the two serialised against nothing -- and one person can hold several seats,
   * so there is not even a seat row in common to fall back on. `lockedSlave` locks Person -> Slave
   * now, the order `setPersonCapabilities` takes.
   *
   * Concurrent rather than back to back, because the lock is the only thing being asserted: either
   * serial order leaves a set this test can name, and the interleaving leaves a third one that is
   * neither -- the merge computed from the row as it was BEFORE the operator's write, landing on
   * top of it.
   */
  it('never loses a capability set while a second hire is merging into the same person', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })
    const first = await hireFromTemplate(workspaceId, template.id, { rationale: 'first' })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const [set, second] = await Promise.all([
      setPersonCapabilities(first.value.personId, ['backend.api-design'], 'operator'),
      hireFromTemplate(workspaceId, template.id, { rationale: 'second', capabilities: ['qa.test-automation'] }),
    ])
    expect(set.ok && second.ok).toBe(true)

    const row = await prisma.slave.findUniqueOrThrow({ where: { id: first.value.slaveId }, include: { person: true } })
    // Whichever won, the loser read the winner's write: the operator's set then the hire's merge on
    // top of it, or the hire's merge then the operator's set replacing it. What may NOT happen is
    // the hire's merge landing over a set it never saw, which is exactly
    // `['qa.test-automation', 'security.application']`.
    expect([
      ['backend.api-design', 'qa.test-automation', 'security.application'],
      ['backend.api-design'],
    ]).toContainEqual(row.person.capabilities)
  })

  /**
   * Fix round 2, Important 1. Fix round 1 gave `lockedSlave` a Person lock and left `releaseWorker`
   * taking Slave -> Person, which is the OTHER order: a release and a reusing hire on the same
   * person could each hold one of the two rows and wait for the other, and Postgres aborts one with
   * 40P01 rather than letting them wait forever. Both take PERSON FIRST now, which is the one order
   * this package uses everywhere.
   *
   * A deadlock is a race, so this runs the pair five times over fresh fixtures: with the inverted
   * order it fails on the round that happens to interleave, and a `40P01` is a REJECTED promise
   * rather than a refusal, which is why `allSettled` is what this reads.
   */
  it('never deadlocks a release against a hire reusing the same person', async (): Promise<void> => {
    const rounds = 5
    for (let round = 0; round < rounds; round += 1) {
      const { workspaceId } = await workspace()
      const template = await prisma.slaveTemplate.create({
        data: { name: `Deadlock Probe ${String(round)}`, role: 'security', capabilityKeys: ['security.application'] },
      })
      const task = await engagement(workspaceId)
      const first = await hireFromTemplate(workspaceId, template.id, {
        rationale: 'one assignment',
        temporary: true,
        engagementTaskId: task.id,
      })
      expect(first.ok).toBe(true)
      if (!first.ok) return

      const outcomes = await Promise.allSettled([
        releasePerson(first.value.personId, 'the engagement is over'),
        hireFromTemplate(workspaceId, template.id, { rationale: 'again', capabilities: ['qa.test-automation'] }),
      ])

      // Nothing THREW. A refusal is a returned value; only an aborted transaction rejects, and the
      // message a deadlock rejects with is the one this assertion prints.
      expect(outcomes.filter((outcome) => outcome.status === 'rejected').map((outcome) => String((outcome as PromiseRejectedResult).reason))).toEqual([])
      const [release, hire] = outcomes
      expect(release.status === 'fulfilled' && release.value.ok).toBe(true)
      expect(hire.status === 'fulfilled' && hire.value.ok).toBe(true)

      // One of the two serial results, and nothing in between. Release first: the person is released,
      // the reuse branch's `releasedAt: null` filter skips them and the hire creates a second person
      // and seat. Hire first: it merges into the seat they already hold and the release then empties
      // its runtime roles -- one seat either way for the person who was released.
      const seats = await prisma.slave.findMany({ where: { team: { workspaceId } }, include: { person: true } })
      expect([1, 2]).toContain(seats.length)
      const releasedSeat = seats.find((seat) => seat.id === first.value.slaveId)
      expect(releasedSeat?.person.releasedAt).not.toBeNull()
      expect(releasedSeat?.runtimeRoles).toEqual([])
    }
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
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: first.value.slaveId }, include: { person: true } })
    expect(row.runtimeRoles).toEqual(ROLES_AT_CAP)
    expect(row.person.capabilities).toEqual(['security.application'])
  })

  it('writes lifecycle project for an ordinary hire, and no engagement', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })
    const result = await hireFromTemplate(workspaceId, template.id, { rationale: 'needed here' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const worker = await prisma.slave.findUniqueOrThrow({ where: { id: result.value.slaveId }, include: { person: true } })
    expect(worker.person.lifecycle).toBe('project')
    expect(worker.engagementTaskId).toBeNull()
    // M50 R1: the rationale is the SENTENCE, and nothing else. The column is the record now.
    expect(worker.person.selectionRationale).toBe('needed here')
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
    const worker = await prisma.slave.findUniqueOrThrow({ where: { id: result.value.slaveId }, include: { person: true } })
    expect(worker.person.lifecycle).toBe('ephemeral')
    expect(worker.engagementTaskId).toBe(task.id)
    // The suffix is gone (R1): a column holds the fact, so the sentence stays the sentence.
    expect(worker.person.selectionRationale).toBe('one assignment')
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
    const worker = await prisma.slave.findUniqueOrThrow({ where: { id: first.value.slaveId }, include: { person: true } })
    // E13: R4 is absolute -- only `setLifecycle` moves a lifecycle.
    expect(worker.person.lifecycle).toBe('project')
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
    const firstName = (await prisma.slave.findUniqueOrThrow({ where: { id: first.value.slaveId }, include: { person: true } })).person.name
    expect((await releasePerson(first.value.personId, 'over')).ok).toBe(true)

    const second = await hireFromTemplate(workspaceId, template.id, { rationale: 'again' })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.reused).toBe(false)
    expect(second.value.slaveId).not.toBe(first.value.slaveId)
    const secondName = (await prisma.slave.findUniqueOrThrow({ where: { id: second.value.slaveId }, include: { person: true } })).person.name
    expect(secondName).toBe(`${firstName} 2`)
  })
})

describe('hireFromTemplate and the managed person pool (Catalog Person Pool Task 4)', () => {
  it('seats a managed pool person instead of creating one, when the template is active', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'], active: true },
    })
    await syncPersonPool()
    const pool = await prisma.person.findMany({ where: { templateId: template.id } })
    expect(pool).toHaveLength(3)

    const out = await hireFromTemplate(workspaceId, template.id, { rationale: 'authentication work needs application security' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.reused).toBe(false)
    expect(pool.map((person) => person.id)).toContain(out.value.personId)
    // No new Person row: the managed pool still holds exactly the three it started with.
    expect(await prisma.person.count()).toBe(3)

    const row = await prisma.slave.findUniqueOrThrow({ where: { id: out.value.slaveId }, include: { person: true } })
    expect(row.person.poolSlot).not.toBeNull()
    expect(row.runtimeRoles).toEqual(['security'])
    // `org.changed { field: 'created' }` fires exactly as it does for an on-demand hire (event,
    // rationale-carrying capability set, and roles are all preserved).
    const events = await prisma.executionEvent.findMany({ where: { workspaceId, type: 'org_changed' } })
    expect(events).toHaveLength(1)
    expect((events[0]?.payload as { personId?: string }).personId).toBe(out.value.personId)
  })

  it('reuses an already-open seat from this template over the pool, without ever switching who is seated', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    // Inactive: this first hire is exactly today's on-demand path, and creates an unmanaged
    // worker.
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })
    const first = await hireFromTemplate(workspaceId, template.id, { rationale: 'first' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const firstPerson = await prisma.person.findUniqueOrThrow({ where: { id: first.value.personId } })
    expect(firstPerson.poolSlot).toBeNull()

    // The template turns active, and its pool comes to exist, only AFTER the first hire.
    await prisma.slaveTemplate.update({ where: { id: template.id }, data: { active: true } })
    await syncPersonPool()

    const second = await hireFromTemplate(workspaceId, template.id, { rationale: 'second' })
    expect(second.ok && second.value.reused).toBe(true)
    if (!second.ok) return
    // The SAME unmanaged worker -- reuse wins over the pool even once the pool exists.
    expect(second.value.personId).toBe(first.value.personId)
    expect(await prisma.slave.count({ where: { team: { workspaceId } } })).toBe(1)
    // The pool exists and is untouched: nobody in it holds a seat here.
    expect(await prisma.person.count({ where: { templateId: template.id, poolSlot: { not: null } } })).toBe(3)
    expect(
      await prisma.slave.count({ where: { team: { workspaceId }, person: { poolSlot: { not: null } } } }),
    ).toBe(0)
  })

  it('never selects a released or an inactive template s managed person', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'], active: true },
    })
    await syncPersonPool()
    await prisma.person.updateMany({
      where: { templateId: template.id },
      data: { releasedAt: new Date(), releaseReason: 'test' },
    })

    // Every managed slot released: the on-demand fallback below is what the CLI's unset
    // `requirePool` keeps -- a brand-new, unmanaged Person, not a released one un-retired.
    const out = await hireFromTemplate(workspaceId, template.id, { rationale: 'needed anyway' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const person = await prisma.person.findUniqueOrThrow({ where: { id: out.value.personId } })
    expect(person.poolSlot).toBeNull()
    expect(person.releasedAt).toBeNull()
  })

  it('syncs a missing pool once and retries selection once before seating a fresh candidate', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'], active: true },
    })
    // Nothing has synced this template's pool yet -- `hireFromTemplate` itself must, on the very
    // first hire against an active template with none.
    expect(await prisma.person.count({ where: { templateId: template.id } })).toBe(0)

    const out = await hireFromTemplate(workspaceId, template.id, { rationale: 'first ever hire' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(await prisma.person.count({ where: { templateId: template.id, poolSlot: { not: null } } })).toBe(3)
    const person = await prisma.person.findUniqueOrThrow({ where: { id: out.value.personId } })
    expect(person.poolSlot).not.toBeNull()
  })

  it('falls back to an on-demand hire when the pool is unavailable even after the sync/retry, unless requirePool refuses it', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'], active: true },
    })
    await syncPersonPool()
    await prisma.person.updateMany({ where: { templateId: template.id }, data: { releasedAt: new Date(), releaseReason: 'test' } })

    // The CLI's compatibility path: `requirePool` unset falls back exactly as it always has.
    const manual = await hireFromTemplate(workspaceId, template.id, { rationale: 'manual hire' })
    expect(manual.ok).toBe(true)
    if (!manual.ok) return
    const manualPerson = await prisma.person.findUniqueOrThrow({ where: { id: manual.value.personId } })
    expect(manualPerson.poolSlot).toBeNull()

    // The automatic path: `requirePool` refuses rather than creating an unmanaged worker.
    const otherTemplate = await prisma.slaveTemplate.create({
      data: { name: 'QA Specialist', role: 'qa', capabilityKeys: ['qa.test-automation'], active: true },
    })
    await syncPersonPool()
    await prisma.person.updateMany({ where: { templateId: otherTemplate.id }, data: { releasedAt: new Date(), releaseReason: 'test' } })
    const before = await prisma.person.count()
    const automatic = await hireFromTemplate(workspaceId, otherTemplate.id, { rationale: 'automatic hire', requirePool: true })
    expect(automatic.ok).toBe(false)
    if (automatic.ok) return
    expect(automatic.error).toMatchObject({ kind: 'pool_unavailable', templateId: otherTemplate.id })
    // Nothing was created for the refused hire.
    expect(await prisma.person.count()).toBe(before)
  })
})

/**
 * Final review, Important 1. A hire landed in `teams[0]` -- the project's first department BY NAME
 * -- which on any project with more than one department is alphabetical chance. An intake-staffed
 * project has real functional departments (`functionalDepartmentFor`, `@slave-of-ai/domain`, used
 * by `intake.ts`'s own staff step), so a backend specialist hired later was filed under `Design`
 * because D sorts before E. The two staffing paths have to agree about where a role belongs, or
 * the org chart means nothing after the first supervisor hire.
 */
describe('hireFromTemplate and functional departments (final review, Important 1)', () => {
  /** A project shaped like one intake staffed: two real departments, neither of them a default. */
  async function twoDepartmentProject(): Promise<{ workspaceId: string; design: string; engineering: string }> {
    const { workspaceId } = await workspace()
    // `workspace()` seeds `Engineering`; `Design` sorts BEFORE it, which is the whole point.
    const engineering = await prisma.team.findFirstOrThrow({ where: { workspaceId, name: 'Engineering' } })
    const design = await prisma.team.create({ data: { workspaceId, name: 'Design' } })
    return { workspaceId, design: design.id, engineering: engineering.id }
  }

  it('files a backend hire in Engineering, not in the alphabetically first department', async (): Promise<void> => {
    const { workspaceId, design, engineering } = await twoDepartmentProject()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Backend Developer', role: 'backend', capabilityKeys: ['backend.api-design'], active: true },
    })
    await syncPersonPool()

    const out = await hireFromTemplate(workspaceId, template.id, { rationale: 'the API needs designing' })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    const seat = await prisma.slave.findUniqueOrThrow({ where: { id: out.value.slaveId } })
    expect(seat.teamId).toBe(engineering)
    expect(seat.teamId).not.toBe(design)
  })

  it('files a design hire in Design, so the rule is a mapping and not a preference for Engineering', async (): Promise<void> => {
    const { workspaceId, design } = await twoDepartmentProject()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Product Designer', role: 'design', capabilityKeys: ['design.visual'], active: true },
    })
    await syncPersonPool()

    const out = await hireFromTemplate(workspaceId, template.id, { rationale: 'the flow needs designing' })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: out.value.slaveId } })).teamId).toBe(design)
  })

  it('creates the department when the project has not got one yet, rather than borrowing another', async (): Promise<void> => {
    const { workspaceId, design } = await twoDepartmentProject()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'QA Specialist', role: 'qa', capabilityKeys: ['qa.test-automation'], active: true },
    })
    await syncPersonPool()

    const out = await hireFromTemplate(workspaceId, template.id, { rationale: 'nothing is tested' })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    const seat = await prisma.slave.findUniqueOrThrow({ where: { id: out.value.slaveId }, include: { team: true } })
    expect(seat.team.name).toBe('QA')
    expect(seat.teamId).not.toBe(design)
  })

  it('keeps the Specialists fallback for a role the table does not recognise', async (): Promise<void> => {
    const { workspaceId } = await twoDepartmentProject()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Falconry Consultant', role: 'falconry', capabilityKeys: [], active: true },
    })
    await syncPersonPool()

    const out = await hireFromTemplate(workspaceId, template.id, { rationale: 'the birds need handling' })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    const seat = await prisma.slave.findUniqueOrThrow({ where: { id: out.value.slaveId }, include: { team: true } })
    expect(seat.team.name).toBe('Specialists')
  })

  it('reuses the department it created, rather than a second row with the same name', async (): Promise<void> => {
    const { workspaceId } = await twoDepartmentProject()
    const backend = await prisma.slaveTemplate.create({
      data: { name: 'Backend Developer', role: 'backend', capabilityKeys: [], active: true },
    })
    const frontend = await prisma.slaveTemplate.create({
      data: { name: 'Frontend Developer', role: 'frontend', capabilityKeys: [], active: true },
    })
    await syncPersonPool()

    const first = await hireFromTemplate(workspaceId, backend.id, { rationale: 'server work' })
    const second = await hireFromTemplate(workspaceId, frontend.id, { rationale: 'browser work' })

    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    const seats = await prisma.slave.findMany({ where: { id: { in: [first.value.slaveId, second.value.slaveId] } } })
    expect(new Set(seats.map((seat) => seat.teamId)).size).toBe(1)
    expect(await prisma.team.count({ where: { workspaceId, name: 'Engineering' } })).toBe(1)
  })

  it('files an unmapped primary role by its projected runtime roles before reaching Specialists', async (): Promise<void> => {
    // `functionalDepartmentFor`'s second clause: the primary role maps to nothing, so the roles the
    // capabilities PROJECT to decide. `qa.test-automation` projects to `qa`, which is QA.
    const { workspaceId } = await twoDepartmentProject()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Unmapped But Testing', role: 'falconry', capabilityKeys: ['qa.test-automation'], active: true },
    })
    await syncPersonPool()

    const out = await hireFromTemplate(workspaceId, template.id, { rationale: 'testing, oddly titled' })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    const seat = await prisma.slave.findUniqueOrThrow({ where: { id: out.value.slaveId }, include: { team: true } })
    expect(seat.team.name).toBe('QA')
  })
})

/**
 * Final review, Important 2, at the operator-facing verb. A managed person's capability set has a
 * template baseline they cannot be edited out of and an explicit grant half they can. So a request
 * here is read as the desired EFFECTIVE set: whatever it asks for beyond the baseline becomes the
 * grant, the baseline is restored in full, and the answer the caller reads back is the effective
 * set rather than the narrower thing they asked for.
 */
describe('setPersonCapabilities and the baseline/grant split (final review, Important 2)', () => {
  async function managedPerson(capabilityKeys: readonly string[]): Promise<{ personId: string; templateId: string }> {
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: [...capabilityKeys], active: true },
    })
    await syncPersonPool()
    const person = await prisma.person.findFirstOrThrow({ where: { templateId: template.id, poolSlot: 1 } })
    return { personId: person.id, templateId: template.id }
  }

  it('records only the EXTRA keys as grants, never the template baseline', async (): Promise<void> => {
    const { personId } = await managedPerson(['security.application'])

    const out = await setPersonCapabilities(personId, ['security.application', 'qa.test-automation'], 'operator')

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect([...out.value.keys].toSorted()).toEqual(['qa.test-automation', 'security.application'])
    const after = await prisma.person.findUniqueOrThrow({ where: { id: personId } })
    // The baseline is NOT in the grant column: if it were, the next template edit would stop
    // reaching this person, which is the drift the split exists to prevent.
    expect(after.capabilityGrants).toEqual(['qa.test-automation'])
    expect([...after.capabilities].toSorted()).toEqual(['qa.test-automation', 'security.application'])
  })

  it('restores a baseline key the request left out, and says so in what it returns', async (): Promise<void> => {
    const { personId } = await managedPerson(['security.application', 'backend.api-design'])

    // The request names ONE baseline key and drops the other. A managed person cannot be edited
    // out of their persona -- that is a template edit -- so the dropped key comes back.
    const out = await setPersonCapabilities(personId, ['security.application'], 'operator')

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect([...out.value.keys].toSorted()).toEqual(['backend.api-design', 'security.application'])
    const after = await prisma.person.findUniqueOrThrow({ where: { id: personId } })
    expect([...after.capabilities].toSorted()).toEqual(['backend.api-design', 'security.application'])
    expect(after.capabilityGrants).toEqual([])
  })

  it('a grant survives the next pool sync, and a later request can take the grant back off', async (): Promise<void> => {
    const { personId } = await managedPerson(['security.application'])
    await setPersonCapabilities(personId, ['security.application', 'qa.test-automation'], 'operator')

    await syncPersonPool()
    expect([...(await prisma.person.findUniqueOrThrow({ where: { id: personId } })).capabilities].toSorted()).toEqual([
      'qa.test-automation',
      'security.application',
    ])

    // Asking for the baseline alone is how a grant is removed: nothing beyond the baseline, so no
    // grants.
    const removed = await setPersonCapabilities(personId, ['security.application'], 'operator')
    expect(removed.ok).toBe(true)
    const after = await prisma.person.findUniqueOrThrow({ where: { id: personId } })
    expect(after.capabilityGrants).toEqual([])
    expect(after.capabilities).toEqual(['security.application'])
  })

  it('leaves an UNMANAGED person exactly as it always behaved: a plain replacement, no grants', async (): Promise<void> => {
    const { workspaceId, teamId } = await workspace()
    const person = await prisma.person.create({ data: { name: 'Manual Specialist', capabilities: ['backend.api-design'] } })
    await prisma.slave.create({ data: { teamId, personId: person.id, role: 'backend', runtimeRoles: ['backend'] } })
    void workspaceId

    const out = await setPersonCapabilities(person.id, ['qa.test-automation'], 'operator')

    expect(out.ok).toBe(true)
    if (!out.ok) return
    // REPLACED, not unioned -- the verb's own contract for a person with no persona baseline.
    expect(out.value.keys).toEqual(['qa.test-automation'])
    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } })
    expect(after.capabilities).toEqual(['qa.test-automation'])
    expect(after.capabilityGrants).toEqual([])
  })

  it('automatic pool hiring records the EXTRA required capability as a grant, and the baseline as baseline', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'], active: true },
    })
    await syncPersonPool()

    // The hire asks for one capability BEYOND the persona -- the supervisor's
    // `capability_unstaffed` situation, where the gap is what the hire is for.
    const out = await hireFromTemplate(workspaceId, template.id, {
      rationale: 'nothing here can automate a test',
      capabilities: ['qa.test-automation'],
    })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    const person = await prisma.person.findUniqueOrThrow({ where: { id: out.value.personId } })
    expect(person.poolSlot).not.toBeNull()
    expect(person.capabilityGrants).toEqual(['qa.test-automation'])
    expect([...person.capabilities].toSorted()).toEqual(['qa.test-automation', 'security.application'])

    // And it survives the sync that follows, which is the fact that makes the grant worth storing.
    await syncPersonPool()
    const synced = await prisma.person.findUniqueOrThrow({ where: { id: out.value.personId } })
    expect([...synced.capabilities].toSorted()).toEqual(['qa.test-automation', 'security.application'])
  })

  it('a pool hire that asks for nothing extra records no grants at all', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'], active: true },
    })
    await syncPersonPool()

    const out = await hireFromTemplate(workspaceId, template.id, { rationale: 'ordinary hire' })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect((await prisma.person.findUniqueOrThrow({ where: { id: out.value.personId } })).capabilityGrants).toEqual([])
  })

  it('projects runtime roles from the EFFECTIVE set, not from the narrower request', async (): Promise<void> => {
    const { workspaceId, teamId } = await workspace()
    const { personId } = await managedPerson(['security.application'])
    await prisma.slave.create({ data: { teamId, personId, role: 'security', runtimeRoles: [] } })
    void workspaceId

    // Asks for the QA capability alone. The baseline security key comes back, so the seat must
    // gain BOTH projected roles -- a role set computed off the request would have missed one.
    const out = await setPersonCapabilities(personId, ['qa.test-automation'], 'operator')

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect([...out.value.runtimeRoles].toSorted()).toEqual(['qa', 'security'])
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
    const roster = await prisma.person.create({ data: { templateId: template.id, name: 'Sam', lifecycle: 'permanent', departments: { create: { companyTeamId: companyTeam.id } } } })
    // Every one of these is shaped like a worker the pre-M47 code wrote: linked to a template,
    // holding a role, providing nothing.
    const hired = await prisma.slave.create({ data: { teamId: teamId, role: 'security', runtimeRoles: ['backend'], personId: (await prisma.person.create({ data: { name: 'Hired', templateId: template.id } })).id } })
    const materialised = await prisma.slave.create({ data: { teamId: teamId, role: 'security', runtimeRoles: [], personId: roster.id } })
    const described = await prisma.slave.create({ data: { teamId: teamId, role: 'security', runtimeRoles: ['backend'], personId: (await prisma.person.create({ data: { name: 'Described', templateId: template.id, capabilities: ['backend.api-design'] } })).id } })
    const bare = await prisma.slave.create({ data: { teamId: teamId, role: 'Engineer', runtimeRoles: ['backend'], personId: (await prisma.person.create({ data: { name: 'Bare' } })).id } })
    return { workspaceId, hired: hired.id, materialised: materialised.id, described: described.id, bare: bare.id }
  }

  it('describes a worker from the template it came from and adds the roles those project to', async (): Promise<void> => {
    const f = await fixture()
    // `described` is not even scanned -- the query asks for an EMPTY capability set -- so the one
    // skip is `bare`, the worker with no template to read.
    expect(await backfillSlaveCapabilities(f.workspaceId)).toEqual({ updated: 2, skipped: 1 })

    const hired = await prisma.slave.findUniqueOrThrow({ where: { id: f.hired }, include: { person: true } })
    expect(hired.person.capabilities).toEqual(['security.application'])
    // UNIONED, never replaced: taking a role away as a side effect of describing a skill parks a
    // worker mid-project.
    expect(hired.runtimeRoles).toEqual(['backend', 'security'])

    // Through the roster row's template, which is how a materialised worker is linked.
    const materialised = await prisma.slave.findUniqueOrThrow({ where: { id: f.materialised }, include: { person: true } })
    expect(materialised.person.capabilities).toEqual(['security.application'])
    expect(materialised.runtimeRoles).toEqual(['security'])
  })

  it("never touches a worker an operator has already described, or one with no template", async (): Promise<void> => {
    const f = await fixture()
    await backfillSlaveCapabilities(f.workspaceId)
    const described = await prisma.slave.findUniqueOrThrow({ where: { id: f.described }, include: { person: true } })
    expect(described.person.capabilities).toEqual(['backend.api-design'])
    expect(described.runtimeRoles).toEqual(['backend'])
    const bare = await prisma.slave.findUniqueOrThrow({ where: { id: f.bare }, include: { person: true } })
    expect(bare.person.capabilities).toEqual([])
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
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: f.hired }, include: { person: true } })).person.capabilities).toEqual([])
  })
})

describe('materialiseCompanySlave', () => {
  it('seats ONE person on the project, with what they provide and the roles it projects to', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Roster Security', role: 'security', capabilityKeys: ['security.application'] },
    })
    const company = await prisma.company.create({ data: { name: 'M47 Co' } })
    const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Security' } })
    const rosterRow = await prisma.person.create({
      // M58 R1: what they provide is theirs, written when they were created from the persona.
      data: {
        templateId: template.id,
        name: 'Sam',
        capabilities: template.capabilityKeys,
        lifecycle: 'permanent',
        departments: { create: { companyTeamId: companyTeam.id } },
      },
    })
    const out = await seatMember(workspaceId, rosterRow.id, { rationale: 'the board needs application security' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: out.value.slaveId }, include: { person: true } })
    expect(row.personId).toBe(rosterRow.id)
    expect(row.person.capabilities).toEqual(['security.application'])
    expect(row.runtimeRoles).toEqual(['security'])
    // The department is created from the roster team, exactly as `assignCompanyTx` does it.
    const team = await prisma.team.findUniqueOrThrow({ where: { id: row.teamId } })
    expect(team.companyTeamId).toBe(companyTeam.id)
    // Idempotent: the same person twice is the same seat.
    const again = await seatMember(workspaceId, rosterRow.id, {})
    expect(again.ok && again.value.created).toBe(false)
  })

  it('materialises a roster worker as permanent', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Roster Security', role: 'security', capabilityKeys: ['security.application'] },
    })
    const company = await prisma.company.create({ data: { name: 'M50 Co' } })
    const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Security' } })
    const rosterRow = await prisma.person.create({ data: { templateId: template.id, name: 'Sam', lifecycle: 'permanent', departments: { create: { companyTeamId: companyTeam.id } } } })
    const result = await seatMember(workspaceId, rosterRow.id, { rationale: 'from the roster' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const worker = await prisma.slave.findUniqueOrThrow({ where: { id: result.value.slaveId }, include: { person: true } })
    // M50 R1: a roster worker EXISTS in the organisation, which is what `permanent` means -- never
    // the column default, which would call every one of them a project hire.
    expect(worker.person.lifecycle).toBe('permanent')
  })

  // Fix round 1, Minor 4. One person can hold several seats on one project over time -- one per
  // department they have sat in -- and `orderBy: id` alone found whichever was created first.
  it('prefers a seat that is OPEN over a closed one the same person still holds here', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const person = await prisma.person.create({ data: { name: 'Two Seats', lifecycle: 'permanent' } })
    const first = await prisma.team.create({ data: { workspaceId, name: 'Aaa' } })
    const second = await prisma.team.create({ data: { workspaceId, name: 'Bbb' } })
    // The closed one sorts FIRST by id, which is what made the old read pick it.
    const closed = await prisma.slave.create({
      data: { id: 'aaaa-closed', teamId: first.id, personId: person.id, role: 'worker', closedAt: new Date() },
    })
    const open = await prisma.slave.create({
      data: { id: 'zzzz-open', teamId: second.id, personId: person.id, role: 'worker', runtimeRoles: ['reviewer'] },
    })

    const out = await seatMember(workspaceId, person.id, {})

    expect(out.ok && out.value).toEqual({ slaveId: open.id, created: false })
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: closed.id } })).closedAt).not.toBeNull()
  })

  // Fix round 1, Minor 5. `assignCompanyTx` reopens by clearing `closedAt` and nothing else; this
  // recomputed the roles from the person's capabilities, which silently undid every
  // `set-runtime-roles` an operator had made on that seat before it was closed.
  it('reopens a closed seat with the runtime roles it already had', async (): Promise<void> => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Reopen Security', role: 'security', capabilityKeys: ['security.application'] },
    })
    const person = await prisma.person.create({
      data: { templateId: template.id, name: 'Reopened', capabilities: template.capabilityKeys, lifecycle: 'permanent' },
    })
    const team = await prisma.team.create({ data: { workspaceId, name: 'Security' } })
    const seat = await prisma.slave.create({
      data: { teamId: team.id, personId: person.id, role: 'security', runtimeRoles: ['reviewer'], closedAt: new Date() },
    })

    const out = await seatMember(workspaceId, person.id, {})

    expect(out.ok && out.value).toEqual({ slaveId: seat.id, created: true })
    const reopened = await prisma.slave.findUniqueOrThrow({ where: { id: seat.id } })
    expect(reopened.closedAt).toBeNull()
    expect(reopened.runtimeRoles).toEqual(['reviewer'])

    // ...unless the caller says what the seat should dispatch as, which is the one rule both this
    // verb and `moveSlave`'s reopen follow.
    await prisma.slave.update({ where: { id: seat.id }, data: { closedAt: new Date() } })
    const asked = await seatMember(workspaceId, person.id, { runtimeRoles: ['security'] })
    expect(asked.ok).toBe(true)
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: seat.id } })).runtimeRoles).toEqual(['security'])
  })

  // Whole-branch review: unassign empties runtimeRoles, and reopen used to restore none of them.
  it('restores default runtimeRoles when reopening a seat emptied by unassign', async (): Promise<void> => {
    const { workspaceId, teamId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Restore Backend', role: 'backend', capabilityKeys: ['security.application'] },
    })
    const person = await prisma.person.create({
      data: { templateId: template.id, name: 'Restored', capabilities: template.capabilityKeys, lifecycle: 'permanent' },
    })
    const first = await seatMember(workspaceId, person.id, {})
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const removed = await unassignPerson(person.id, teamId, { reason: 'done here' })
    expect(removed.ok).toBe(true)
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: first.value.slaveId } })).runtimeRoles).toEqual([])

    const again = await seatMember(workspaceId, person.id, {})
    expect(again.ok).toBe(true)
    if (!again.ok) return
    const reopened = await prisma.slave.findUniqueOrThrow({ where: { id: again.value.slaveId } })
    expect(reopened.id).toBe(first.value.slaveId)
    expect(reopened.closedAt).toBeNull()
    expect(reopened.runtimeRoles).toEqual(['backend', 'security'])
  })

  it('refuses to reopen a seat for a released person', async (): Promise<void> => {
    const { workspaceId, teamId } = await workspace()
    const person = await prisma.person.create({ data: { name: 'Released', lifecycle: 'ephemeral' } })
    const seat = await prisma.slave.create({
      data: { teamId, personId: person.id, role: 'worker', runtimeRoles: ['worker'] },
    })
    const released = await releasePerson(person.id, 'the engagement is over')
    expect(released.ok).toBe(true)

    const out = await seatMember(workspaceId, person.id, {})

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.kind).toBe('person_released')
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: seat.id } })).closedAt).not.toBeNull()
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
    const rosterRow = await prisma.person.create({ data: { templateId: template.id, name: 'Sam', lifecycle: 'permanent', departments: { create: { companyTeamId: companyTeam.id } } } })

    const out = await seatMember(workspaceId, rosterRow.id, {})
    expect(out.ok).toBe(true)
    if (!out.ok) return

    const row = await prisma.slave.findUniqueOrThrow({ where: { id: out.value.slaveId }, include: { person: true } })
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
    await prisma.slave.create({ data: { teamId: teamId, role: 'backend', runtimeRoles: ['backend'], personId: (await prisma.person.create({ data: { name: 'Ada' } })).id } })
    const hired = await hireFromTemplate(workspaceId, template.id, { rationale: 'the board needs application security' })
    expect(hired.ok).toBe(true)
    if (!hired.ok) return

    const view = await listOrganization(workspaceId)
    expect(view.ok).toBe(true)
    if (!view.ok) return
    expect(view.value.workers.map((worker) => worker.name)).toEqual(['Ada', 'Security Reviewer'])
    const worker = view.value.workers[1]
    // M50 R6: the column (on `Person` since M58 R1), not the `companySlaveId === null` derivation
    // this view used to make --
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
