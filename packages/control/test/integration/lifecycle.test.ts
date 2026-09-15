import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, describe, expect, it } from 'vitest'
import { mergeRuntimeRoles } from '../../src/capability.js'
import { setLifecycle } from '../../src/lifecycle.js'
import { releasePerson } from '../../src/persons.js'
import { setRuntimeRoles } from '../../src/profile.js'

/** Every row this file makes carries one of these two prefixes, so the teardown can find its own
 *  work in a database every other integration file in this run also writes to. `M50 Lifecycle` and
 *  not `M50 Security` (fix round 1, Minor 6): `supervisor.test.ts` names ITS template
 *  `M50 Security …`, and a prefix two files share is a teardown that reaches into the other one. */
const WORKSPACE_PREFIX = 'M50 Lifecycle'
const TEMPLATE_PREFIX = 'M50 Lifecycle Security'

const BRANCH = 'slaveofai/T-m50-lifecycle'

/** The repositories {@link makeRepo} left on disk, removed once at the end of the file. */
const repos: string[] = []

/**
 * A real repository with one real worktree on its own branch -- `collect.test.ts`'s own fixture,
 * trimmed to what this file needs. The `worktreesCollected: 1` case has to prove the count against
 * a tree `git worktree remove` can actually remove, which a made-up path cannot do.
 */
function makeRepo(): { repoPath: string; worktreePath: string } {
  const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-lifecycle-'))
  const run = (...args: readonly string[]): void => {
    execFileSync('git', [...args], { cwd: repoPath, encoding: 'utf8' })
  }
  run('init', '-q', '-b', 'main')
  run('config', 'user.name', 'Fixture')
  run('config', 'user.email', 'fixture@example.com')
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n')
  run('add', '-A')
  run('commit', '-q', '-m', 'initial')
  mkdirSync(join(repoPath, '.slaveofai'), { recursive: true })
  writeFileSync(join(repoPath, '.slaveofai', '.gitignore'), '*\n')
  const worktreePath = join(repoPath, '.slaveofai', 'worktrees', 'T-m50')
  run('worktree', 'add', '-b', BRANCH, worktreePath)
  repos.push(repoPath)
  return { repoPath, worktreePath }
}

/**
 * A project with one task, one template, one ephemeral worker hired for that task, and one run on
 * it. Every knob is a fact one of the cases below is about; the defaults are the ordinary
 * "assignment finished, worker idle" shape.
 */
async function seedEngagement(opts: {
  readonly taskStatus: 'done' | 'running'
  readonly lifecycle?: 'project' | 'ephemeral'
  readonly runStatus?: 'succeeded' | 'working'
  readonly worktreePath?: string | null
  /** A REAL repository and a real worktree on disk, so `collectTaskWorktree` can succeed and the
   *  release can count it. Overrides {@link worktreePath}. */
  readonly realWorktree?: boolean
}): Promise<{ workspaceId: string; slaveId: string; personId: string; taskId: string; runId: string; worktreePath: string | null }> {
  const stamp = `${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
  const repo = opts.realWorktree === true ? makeRepo() : null
  const worktreePath =
    repo !== null ? repo.worktreePath : opts.worktreePath === undefined ? null : opts.worktreePath
  const workspace = await prisma.workspace.create({
    // `verifyCommands`/`setupCommands` have no column default -- an omitted one is a null
    // constraint violation, not an empty list (`capability.test.ts`'s own workspace seed).
    data: {
      name: `${WORKSPACE_PREFIX} ${stamp}`,
      repoPath: repo?.repoPath ?? '/tmp/m50-lifecycle',
      verifyCommands: ['true'],
      setupCommands: [],
      maxAttempts: 3,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Specialists' } })
  const template = await prisma.slaveTemplate.create({
    data: { name: `${TEMPLATE_PREFIX} ${stamp}`, role: 'security', capabilityKeys: ['security.application'] },
  })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Add authentication',
      description: 'the one assignment',
      status: opts.taskStatus,
      maxAttempts: 3,
      requiredRole: 'security',
      ...(repo === null ? {} : { branch: BRANCH }),
    },
  })
  // M58 R1: `Person.name` is unique across the INSTALLATION, so the fixture's name carries the same
  // stamp its workspace and template already do -- this file seeds more than once per run.
  const person = await prisma.person.create({
    data: {
      name: `Robin ${stamp}`,
      capabilities: ['security.application'],
      selectionRationale: 'brought in for the authentication path',
      templateId: template.id,
      lifecycle: opts.lifecycle ?? 'ephemeral',
    },
  })
  const slave = await prisma.slave.create({
    data: { teamId: team.id, role: 'Security Reviewer', runtimeRoles: ['security'], engagementTaskId: task.id, personId: person.id },
  })
  const run = await prisma.slaveRun.create({
    data: {
      taskId: task.id,
      slaveId: slave.id,
      kind: 'implementation',
      status: opts.runStatus ?? 'succeeded',
      worktreePath,
    },
  })
  return { workspaceId: workspace.id, slaveId: slave.id, personId: person.id, taskId: task.id, runId: run.id, worktreePath }
}

// FK order, scoped to this file's own name prefixes (`memory.test.ts`'s idiom). This file does NOT
// truncate: `capability.test.ts` may truncate the same tables, and a file that only deletes what it
// made can sit anywhere in the run order without emptying a table under the next one.
afterAll(async () => {
  const workspaces = await prisma.workspace.findMany({
    where: { name: { startsWith: WORKSPACE_PREFIX } },
    select: { id: true },
  })
  const workspaceIds = workspaces.map((row) => row.id)
  await prisma.executionEvent.deleteMany({ where: { workspaceId: { in: workspaceIds } } })
  await prisma.slaveRun.deleteMany({ where: { slave: { team: { workspaceId: { in: workspaceIds } } } } })
  await prisma.task.deleteMany({ where: { workspaceId: { in: workspaceIds } } })
  await prisma.slave.deleteMany({ where: { team: { workspaceId: { in: workspaceIds } } } })
  await prisma.team.deleteMany({ where: { workspaceId: { in: workspaceIds } } })
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } })
  await prisma.slaveTemplate.deleteMany({ where: { name: { startsWith: TEMPLATE_PREFIX } } })
  for (const repoPath of repos) rmSync(repoPath, { recursive: true, force: true })
})

describe('releasePerson', () => {
  it('empties the runtime roles, stamps the release, and keeps every row the worker wrote', async () => {
    const { workspaceId, slaveId, personId, taskId, runId } = await seedEngagement({ taskStatus: 'done' })

    const result = await releasePerson(personId, 'the engagement is over')
    expect(result.ok).toBe(true)

    const after = await prisma.slave.findUniqueOrThrow({ where: { id: slaveId }, include: { person: true } })
    expect(after.runtimeRoles).toEqual([])
    expect(after.person.releasedAt).not.toBeNull()
    expect(after.person.releaseReason).toBe('the engagement is over')
    // R5: nothing else moved.
    expect(after.person.lifecycle).toBe('ephemeral')
    expect(after.engagementTaskId).toBe(taskId)
    expect(after.person.capabilities).toEqual(['security.application'])
    expect(after.person.selectionRationale).not.toBeNull()
    expect(after.person.templateId).not.toBeNull()
    expect(await prisma.slaveRun.count({ where: { slaveId } })).toBe(1)
    expect(await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).toBeDefined()

    const event = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId, type: 'slave_released' },
      orderBy: { seq: 'desc' },
    })
    expect(event.payload).toMatchObject({ slaveId: personId, personId, reason: 'the engagement is over' })
  })

  it('releases a person that is not ephemeral -- a release is the end of the engagement, not a lifecycle check', async () => {
    const { personId } = await seedEngagement({ taskStatus: 'done', lifecycle: 'project' })
    const result = await releasePerson(personId, 'the engagement is over')
    expect(result.ok).toBe(true)
  })

  it('refuses a second release, and writes nothing the second time', async () => {
    const { slaveId, personId } = await seedEngagement({ taskStatus: 'done' })
    expect((await releasePerson(personId, 'first')).ok).toBe(true)
    const second = await releasePerson(personId, 'second')
    expect(second.ok).toBe(false)
    expect(second.ok ? null : second.error.kind).toBe('already_released')
    const after = await prisma.slave.findUniqueOrThrow({ where: { id: slaveId }, include: { person: true } })
    expect(after.person.releaseReason).toBe('first')
  })

  it('refuses while a run is live, and leaves the roles alone', async () => {
    const { slaveId, personId } = await seedEngagement({ taskStatus: 'done', runStatus: 'working' })
    const result = await releasePerson(personId, 'no')
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error.kind).toBe('run_in_progress')
    const after = await prisma.slave.findUniqueOrThrow({ where: { id: slaveId }, include: { person: true } })
    expect(after.runtimeRoles).toEqual(['security'])
  })

  it('refuses a person that is gone', async () => {
    const result = await releasePerson('00000000-0000-0000-0000-000000000000', 'no')
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error.kind).toBe('person_not_found')
  })

  it('counts only the worktrees it could actually collect, and never throws for one it could not', async () => {
    // The run carries a path that is not a worktree of this repository, so `git worktree remove`
    // refuses and `collectTaskWorktree` returns `worktree_remove_failed`. The release still stands.
    const { slaveId, personId } = await seedEngagement({ taskStatus: 'done', worktreePath: '/nonexistent/m50-gate-tree' })
    const result = await releasePerson(personId, 'the engagement is over')
    expect(result.ok).toBe(true)
    expect(result.ok ? result.value.worktreesCollected : -1).toBe(0)
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: slaveId }, include: { person: true } })).person.releasedAt).not.toBeNull()
  })

  // Fix round 1, Minor 5: the count is a MEASUREMENT, so one case has to see it reach 1 against a
  // tree git can actually remove -- otherwise every assertion in this file is about zero.
  it('counts the worktree it removed, and nulls the path the run was holding', async () => {
    const { personId, runId, worktreePath } = await seedEngagement({ taskStatus: 'done', realWorktree: true })
    expect(worktreePath).not.toBeNull()
    expect(existsSync(worktreePath ?? '')).toBe(true)

    const result = await releasePerson(personId, 'the engagement is over')
    expect(result.ok).toBe(true)
    expect(result.ok ? result.value.worktreesCollected : -1).toBe(1)
    expect(existsSync(worktreePath ?? '')).toBe(false)
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).worktreePath).toBeNull()
  })

  // Fix round 1, Important 1: `slave.released`'s payload schema is `z.string().min(1)`, so a blank
  // reason written to the column would commit the release and then have the EVENT refused. The
  // sentence is normalised before the transaction, and no refusal kind was added for it (D4).
  it('records a blank reason as "released" rather than writing a release nothing can log', async () => {
    const { workspaceId, slaveId, personId } = await seedEngagement({ taskStatus: 'done' })
    const result = await releasePerson(personId, '   ')
    expect(result.ok).toBe(true)
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: slaveId }, include: { person: true } })).person.releaseReason).toBe('released')
    const event = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId, type: 'slave_released' },
      orderBy: { seq: 'desc' },
    })
    expect(event.payload).toMatchObject({ slaveId: personId, personId, reason: 'released' })
  })
})

describe('a released worker and who may re-arm it', () => {
  /**
   * M50 final wave, I1. The automatic writers refuse a released worker; a PERSON does not. The
   * whole of what a release writes is `runtimeRoles = []`, and `set-runtime-roles` is documented as
   * the way into and out of that parked state -- an operator who wants the worker back on the board
   * for an afternoon says so by hand, and the row keeps `releasedAt` and the sentence either way.
   */
  it('still lets a person put the roles back by hand, releasedAt and the reason untouched', async () => {
    const { slaveId, personId } = await seedEngagement({ taskStatus: 'done' })
    expect((await releasePerson(personId, 'the engagement is over')).ok).toBe(true)

    const result = await setRuntimeRoles(slaveId, ['security'], 'operator')
    expect(result.ok).toBe(true)
    const after = await prisma.slave.findUniqueOrThrow({ where: { id: slaveId }, include: { person: true } })
    expect(after.runtimeRoles).toEqual(['security'])
    expect(after.person.releasedAt).not.toBeNull()
    expect(after.person.releaseReason).toBe('the engagement is over')
  })

  // The other half of the same rule: the Supervisor's own union verb refuses the row a person may
  // still write, with the kind a second release already uses.
  it('refuses the Supervisor union verb on a released worker, and writes nothing', async () => {
    const { slaveId, personId } = await seedEngagement({ taskStatus: 'done' })
    expect((await releasePerson(personId, 'the engagement is over')).ok).toBe(true)

    const merged = await mergeRuntimeRoles(slaveId, ['security'], 'supervisor', 'system')
    expect(merged.ok).toBe(false)
    expect(merged.ok ? null : merged.error.kind).toBe('already_released')
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: slaveId }, include: { person: true } })).runtimeRoles).toEqual([])
  })
})

describe('setLifecycle', () => {
  it('moves ephemeral to project, clearing the engagement and the release with it', async () => {
    const { workspaceId, slaveId, personId } = await seedEngagement({ taskStatus: 'done' })
    expect((await releasePerson(personId, 'over')).ok).toBe(true)

    const result = await setLifecycle(personId, 'project')
    expect(result.ok).toBe(true)
    const after = await prisma.slave.findUniqueOrThrow({ where: { id: slaveId }, include: { person: true } })
    expect(after.person.lifecycle).toBe('project')
    // The release CLOSED the seat. `setLifecycle` clears engagement only on OPEN seats -- a
    // closed seat is history -- and writes no project event when nobody is sitting.
    expect(after.closedAt).not.toBeNull()
    expect(after.person.releasedAt).toBeNull()
    expect(after.person.releaseReason).toBeNull()
    // R4: nothing is restored. The person sets the roles.
    expect(after.runtimeRoles).toEqual([])
    expect(await prisma.executionEvent.count({ where: { workspaceId, type: 'org_changed' } })).toBe(0)
  })

  it('refuses permanent for a person in no department', async () => {
    const { slaveId, personId } = await seedEngagement({ taskStatus: 'done' })
    const result = await setLifecycle(personId, 'permanent')
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error.kind).toBe('not_in_roster')
  })

  // Fix round 1, Minor 1: the no-move is decided BEFORE the department check.
  // A permanent person whose department was deleted is still permanent -- and asking for the
  // lifecycle they already have is a no-op, never a refusal about a change nobody made.
  it('is a no-op, not not_in_roster, for a permanent person in no department asked to stay permanent', async () => {
    const { workspaceId, slaveId, personId } = await seedEngagement({ taskStatus: 'done' })
    await prisma.person.update({ where: { id: personId }, data: { lifecycle: 'permanent' } })
    const before = await prisma.executionEvent.count({ where: { workspaceId, type: 'org_changed' } })

    const result = await setLifecycle(personId, 'permanent')
    expect(result.ok).toBe(true)
    expect(result.ok ? result.value : null).toEqual({ from: 'permanent', to: 'permanent' })
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: slaveId }, include: { person: true } })).person.lifecycle).toBe('permanent')
    expect(await prisma.executionEvent.count({ where: { workspaceId, type: 'org_changed' } })).toBe(before)
  })

  it('refuses while a run is live', async () => {
    const { slaveId, personId } = await seedEngagement({ taskStatus: 'done', runStatus: 'working' })
    const result = await setLifecycle(personId, 'project')
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error.kind).toBe('live_runs')
  })

  it('writes no event when the lifecycle did not move', async () => {
    const { workspaceId, slaveId, personId } = await seedEngagement({ taskStatus: 'done' })
    const before = await prisma.executionEvent.count({ where: { workspaceId, type: 'org_changed' } })
    expect((await setLifecycle(personId, 'ephemeral')).ok).toBe(true)
    expect(await prisma.executionEvent.count({ where: { workspaceId, type: 'org_changed' } })).toBe(before)
  })
})
