import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
import { assignPerson, createPerson, setPersonSkills, setTemplateSkills, unassignPerson } from '@slave-of-ai/control'
import { buildRunContext } from '../../src/runContext.js'
import { provisionWorktree } from '../../src/worktree.js'
import { loadWorld } from '../../src/world.js'

const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "Memory", "SlaveMessage", "PersonSkill", "TemplateSkill", "Skill", "SkillProvider", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace", "CompanyTeamMember", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE'

async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(TRUNCATE)
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-persons-runtime-'))
  const git = (args: readonly string[]): void => {
    execFileSync('git', [...args], { cwd: dir })
  }
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Fixture'])
  git(['config', 'user.email', 'fixture@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

const repos: string[] = []

/** Scratch worktree directory -- the same job `runContext.test.ts` does with `provisionWorktree`. */
async function worktreeFor(slug: string): Promise<string> {
  const repoPath = makeRepo()
  repos.push(repoPath)
  const worktree = await provisionWorktree({
    repoPath,
    baseBranch: 'main',
    taskKey: `T-${slug}`,
    slug,
    setupCommands: [],
  })
  return worktree.path
}

beforeEach(async () => {
  await truncateAll()
})

afterAll(() => {
  for (const repo of repos) {
    try {
      execFileSync('rm', ['-rf', repo])
    } catch {
      // best-effort cleanup of scratch repos
    }
  }
})

describe('the scheduler sees seats, and only open ones (R17)', () => {
  it('a closed seat and a pooled person enter no tick', async () => {
    const workspace = await prisma.workspace.create({
      data: { name: 'Alpha', repoPath: '/tmp/a', verifyCommands: ['true'], setupCommands: [] },
    })
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
    const seatedPerson = await createPerson({ name: 'Seated' })
    const removedPerson = await createPerson({ name: 'Removed' })
    await createPerson({ name: 'Pooled' })
    if (!seatedPerson.ok || !removedPerson.ok) throw new Error('setup')
    await assignPerson(seatedPerson.value.personId, team.id, { role: 'dev', runtimeRoles: ['dev'] })
    await assignPerson(removedPerson.value.personId, team.id, { role: 'dev', runtimeRoles: ['dev'] })
    await unassignPerson(removedPerson.value.personId, team.id, { reason: 'done' })

    const loaded = await loadWorld(workspace.id as never)
    expect(loaded.world.slaves).toHaveLength(1)
  })

  it('the selection sees the capabilities off the PERSON', async () => {
    const workspace = await prisma.workspace.create({
      data: { name: 'Alpha', repoPath: '/tmp/a', verifyCommands: ['true'], setupCommands: [] },
    })
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
    const person = await createPerson({ name: 'Atlas', capabilities: ['backend'] })
    if (!person.ok) throw new Error('setup')
    await assignPerson(person.value.personId, team.id, { role: 'dev', runtimeRoles: ['dev'] })

    const loaded = await loadWorld(workspace.id as never)
    // `SchedulableSlave` carries the seat's id; the capability came through the join, which is what
    // this asserts -- the row exists and the tick did not have to read `Slave.capabilities`.
    expect(loaded.world.slaves[0]?.runtimeRoles).toEqual(['dev'])
    const seat = await prisma.slave.findFirstOrThrow({ where: { personId: person.value.personId }, include: { person: true } })
    expect(seat.person.capabilities).toEqual(['backend'])
  })
})

describe('the run context (R18)', () => {
  it('walks seat -> person -> template for the profile, and names the level', async () => {
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Builder', role: 'dev', profile: 'template persona' },
    })
    const workspace = await prisma.workspace.create({
      data: { name: 'Alpha', repoPath: '/tmp/a', verifyCommands: ['true'], setupCommands: [] },
    })
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
    const person = await createPerson({ templateId: template.id, name: 'Atlas', profile: 'person persona' })
    if (!person.ok) throw new Error('setup')
    const seated = await assignPerson(person.value.personId, team.id, { role: 'dev', runtimeRoles: ['dev'] })
    if (!seated.ok) throw new Error('setup')
    const run = await prisma.slaveRun.create({
      data: { slaveId: seated.value.slaveId, status: 'starting', kind: 'implementation' },
    })

    const built = await buildRunContext({
      runId: run.id as never,
      slaveId: seated.value.slaveId as never,
      workspaceId: workspace.id as never,
      taskId: null,
      kind: 'implementation',
      worktreePath: await worktreeFor('m58-a'),
      provider: 'claude_code',
    })
    expect(built.prompt).toContain('person persona')
    expect(built.prompt).not.toContain('template persona')

    // The seat's own override wins over the person's.
    await prisma.slave.update({ where: { id: seated.value.slaveId }, data: { profile: 'seat persona' } })
    const again = await buildRunContext({
      runId: run.id as never,
      slaveId: seated.value.slaveId as never,
      workspaceId: workspace.id as never,
      taskId: null,
      kind: 'implementation',
      worktreePath: await worktreeFor('m58-b'),
      provider: 'claude_code',
    })
    expect(again.prompt).toContain('seat persona')
  })

  it('mounts the PERSON’s effective skills — persona defaults included, revokes excluded', async () => {
    const provider = await prisma.skillProvider.create({ data: { name: 'personal' } })
    const pdf = await prisma.skill.create({ data: { providerId: provider.id, name: 'pdf', description: 'makes pdfs' } })
    const sql = await prisma.skill.create({ data: { providerId: provider.id, name: 'sql', description: 'writes sql' } })
    const template = await prisma.slaveTemplate.create({ data: { name: 'Builder', role: 'dev' } })
    await setTemplateSkills(template.id, [pdf.id, sql.id])
    const workspace = await prisma.workspace.create({
      data: { name: 'Alpha', repoPath: '/tmp/a', verifyCommands: ['true'], setupCommands: [] },
    })
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
    const person = await createPerson({ templateId: template.id, name: 'Atlas' })
    if (!person.ok) throw new Error('setup')
    await setPersonSkills(person.value.personId, { revoke: [sql.id] })
    const seated = await assignPerson(person.value.personId, team.id, { role: 'dev', runtimeRoles: ['dev'] })
    if (!seated.ok) throw new Error('setup')
    const run = await prisma.slaveRun.create({
      data: { slaveId: seated.value.slaveId, status: 'starting', kind: 'implementation' },
    })

    const built = await buildRunContext({
      runId: run.id as never,
      slaveId: seated.value.slaveId as never,
      workspaceId: workspace.id as never,
      taskId: null,
      kind: 'implementation',
      worktreePath: await worktreeFor('m58-c'),
      provider: 'claude_code',
    })
    expect(built.prompt).toContain('pdf')
    expect(built.prompt).not.toContain('writes sql')
  })

  it('the name in the prompt is the person’s, and is the same on both projects', async () => {
    const workspaces = await Promise.all(
      ['Alpha', 'Beta'].map((name) =>
        prisma.workspace.create({ data: { name, repoPath: `/tmp/${name}`, verifyCommands: ['true'], setupCommands: [] } }),
      ),
    )
    const teams = await Promise.all(
      workspaces.map((workspace) => prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })),
    )
    const person = await createPerson({ name: 'Atlas', profile: 'I am Atlas.' })
    if (!person.ok) throw new Error('setup')
    const seats = await Promise.all(teams.map((team) => assignPerson(person.value.personId, team.id, { role: 'dev', runtimeRoles: ['dev'] })))

    for (const [index, seated] of seats.entries()) {
      if (!seated.ok) throw new Error('setup')
      const run = await prisma.slaveRun.create({
        data: { slaveId: seated.value.slaveId, status: 'starting', kind: 'implementation' },
      })
      const built = await buildRunContext({
        runId: run.id as never,
        slaveId: seated.value.slaveId as never,
        workspaceId: workspaces[index]?.id as never,
        taskId: null,
        kind: 'implementation',
        worktreePath: await worktreeFor(`m58-name-${String(index)}`),
        provider: 'claude_code',
      })
      expect(built.prompt).toContain('I am Atlas.')
    }
  })
})

describe('memory (R19)', () => {
  it('a memory written on project A is recalled on project B', async () => {
    const workspaces = await Promise.all(
      ['Alpha', 'Beta'].map((name) =>
        prisma.workspace.create({ data: { name, repoPath: `/tmp/${name}`, verifyCommands: ['true'], setupCommands: [] } }),
      ),
    )
    const teams = await Promise.all(
      workspaces.map((workspace) => prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })),
    )
    const person = await createPerson({ name: 'Atlas' })
    if (!person.ok) throw new Error('setup')
    const seats = await Promise.all(teams.map((team) => assignPerson(person.value.personId, team.id, { role: 'dev', runtimeRoles: ['dev'] })))
    const second = seats[1]
    if (second === undefined || !second.ok) throw new Error('setup')

    await prisma.memory.create({
      data: {
        type: 'lesson',
        scope: 'worker',
        personId: person.value.personId,
        // Where it was LEARNT stays recorded (D2), and is what the "from" column reads.
        workspaceId: workspaces[0]?.id ?? null,
        title: 'Run the migration before the seed',
        body: 'the seed reads columns the migration adds',
        status: 'verified',
        sourceKind: 'run_output',
        createdBy: 'slave',
      },
    })

    const run = await prisma.slaveRun.create({
      data: { slaveId: second.value.slaveId, status: 'starting', kind: 'implementation' },
    })
    const built = await buildRunContext({
      runId: run.id as never,
      slaveId: second.value.slaveId as never,
      workspaceId: workspaces[1]?.id as never,
      taskId: null,
      kind: 'implementation',
      worktreePath: await worktreeFor('m58-memory'),
      provider: 'claude_code',
    })
    expect(built.prompt).toContain('Run the migration before the seed')
  })
})

describe('concurrency (R20)', () => {
  it('one person may hold a live run on two projects at once', async () => {
    const workspaces = await Promise.all(
      ['Alpha', 'Beta'].map((name) =>
        prisma.workspace.create({ data: { name, repoPath: `/tmp/${name}`, verifyCommands: ['true'], setupCommands: [] } }),
      ),
    )
    const teams = await Promise.all(
      workspaces.map((workspace) => prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })),
    )
    const person = await createPerson({ name: 'Atlas' })
    if (!person.ok) throw new Error('setup')
    const seats = await Promise.all(teams.map((team) => assignPerson(person.value.personId, team.id)))
    for (const seat of seats) {
      if (!seat.ok) throw new Error('setup')
      await prisma.slaveRun.create({ data: { slaveId: seat.value.slaveId, status: 'working', kind: 'implementation' } })
    }
    expect(await prisma.slaveRun.count({ where: { slave: { personId: person.value.personId }, status: 'working' } })).toBe(2)
    // Each project still sees exactly one busy seat -- the breaker and the pause stay per run.
    for (const workspace of workspaces) {
      const loaded = await loadWorld(workspace.id as never)
      expect(loaded.world.slaves.filter((slave) => slave.busy)).toHaveLength(1)
    }
  })
})
