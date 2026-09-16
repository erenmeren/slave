import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import type { IntakeDraft } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { acceptIntake, openIntake, sendIntakeMessage } from '../../src/intake.js'
import { setInstallationSettings } from '../../src/installation.js'

/**
 * THE ONE SEAM (fix round 1): `acceptIntake`'s own steps never throw in the ordinary course of a
 * test -- every one of them returns a `Result`. To pin "a step that THROWS still lands the intake
 * in `failed`, not stranded in `creating`", something in the sequence has to throw for real, and
 * `setGoal` is the module boundary `acceptIntake` calls last, after `create_workspace` has already
 * committed -- exactly the case the fix protects (a workspace already exists; a naive retry must
 * not make a second one). `throwOnSetGoal` is false for every other case in this file, so nothing
 * else here is mocked in any sense that matters -- the same discipline `breaker.test.ts` documents
 * for its own one seam.
 */
let throwOnSetGoal = false

vi.mock('../../src/goal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/goal.js')>()
  return {
    ...actual,
    setGoal: async (...args: Parameters<typeof actual.setGoal>) => {
      if (throwOnSetGoal) throw new Error('a connection dropped mid-write')
      return actual.setGoal(...args)
    },
  }
})

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'accept-repo-'))
  const git = (args: readonly string[]): void => {
    execFileSync('git', [...args], { cwd: dir })
  }
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Fixture'])
  git(['config', 'user.email', 'fixture@example.com'])
  writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"vitest run"}}')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

async function seedTemplate(name: string, division: string): Promise<string> {
  const template = await prisma.slaveTemplate.create({
    data: { name, role: 'backend', description: '', active: true, sourceDivision: division },
  })
  return template.id
}

const draftFor = (repo: string, name: string): IntakeDraft => ({
  name,
  goal: 'Add rate limiting to the public API',
  repo: { mode: 'existing', path: repo },
  baseBranch: 'main',
  verifyCommands: [{ command: 'npm test', source: 'detected' }],
  setupCommands: [],
  budgetUsd: 20,
  provider: null,
  team: [],
})

describe('acceptIntake', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "IntakeMessage", "Intake", "GoalVersion", "Task", "Slave", "Person", "Team", "Workspace", "InstallationSettings", "SlaveTemplate" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  const opened = async (text: string): Promise<string> => {
    const intake = await openIntake()
    if (!intake.ok) throw new Error('openIntake refused')
    await sendIntakeMessage(intake.value.id, text)
    return intake.value.id
  }

  it('creates the project, its goal v1 and its step log, in order', async (): Promise<void> => {
    const repo = makeRepo()
    const id = await opened(`the repository is at ${repo}`)
    const accepted = await acceptIntake(id, draftFor(repo, 'Public API'))
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error('unreachable')

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: accepted.value.workspaceId } })
    expect(workspace.name).toBe('Public API')
    expect(workspace.repoPath).toBe(repo)
    expect(workspace.verifyCommands).toEqual(['npm test'])
    expect(workspace.goalVersion).toBe(1)
    expect(workspace.goal).toBe('Add rate limiting to the public API')

    const row = await prisma.intake.findUniqueOrThrow({ where: { id } })
    expect(row.status).toBe('created')
    expect(row.workspaceId).toBe(accepted.value.workspaceId)
    const steps = (row.stepLog as { step: string; status: string }[]).map((entry) => `${entry.step}:${entry.status}`)
    expect(steps).toEqual([
      'create_workspace:done',
      'staff:skipped',
      'set_goal:done',
      'mark_created:done',
    ])
  })

  it('hires the team the draft named, onto one department named after the project (M59 R13)', async (): Promise<void> => {
    const repo = makeRepo()
    const templateId = await seedTemplate('Backend Developer', 'engineering')
    const id = await opened(`it is at ${repo}`)
    const accepted = await acceptIntake(id, {
      ...draftFor(repo, 'Staffed'),
      team: [{ templateId, runtimeRoles: ['backend'] }],
    })
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error('unreachable')

    const teams = await prisma.team.findMany({
      where: { workspaceId: accepted.value.workspaceId },
      include: { slaves: true },
    })
    expect(teams).toHaveLength(1)
    expect(teams[0]?.name).toBe('Staffed')
    expect(teams[0]?.slaves).toHaveLength(1)
    // `ensureStaffRoles` put both on the one seat: `dispatchPlanning` refuses without a manager
    // and a review needs a reviewer, so a suggested team without them is a project that looks
    // staffed and does nothing.
    expect(teams[0]?.slaves[0]?.runtimeRoles).toEqual(['backend', 'manager', 'reviewer'])

    const row = await prisma.intake.findUniqueOrThrow({ where: { id } })
    const staff = (row.stepLog as { step: string; status: string; detail: string | null }[]).find(
      (entry) => entry.step === 'staff',
    )
    expect(staff).toMatchObject({ status: 'done' })
    expect(staff?.detail).toContain('1')
  })

  it('resumes staffing without duplicating seats or people after a seat fails', async (): Promise<void> => {
    const repo = makeRepo()
    const backendId = await seedTemplate('Backend Developer', 'engineering')
    const reviewerId = await seedTemplate('Review Specialist', 'engineering')
    const id = await opened(`it is at ${repo}`)
    // The draft saw both templates; one disappears only after the facts and draft are established,
    // so staffing commits its first seat before the second refuses.
    await prisma.slaveTemplate.delete({ where: { id: reviewerId } })
    const draft: IntakeDraft = {
      ...draftFor(repo, 'Resumable Staff'),
      team: [
        { templateId: backendId, runtimeRoles: ['backend'] },
        { templateId: reviewerId, runtimeRoles: ['reviewer'] },
      ],
    }

    const failed = await acceptIntake(id, draft)
    expect(failed.ok).toBe(false)
    expect(await prisma.team.count({ where: { name: 'Resumable Staff' } })).toBe(1)
    expect(await prisma.slave.count({ where: { team: { name: 'Resumable Staff' }, closedAt: null } })).toBe(1)

    await prisma.slaveTemplate.create({
      data: {
        id: reviewerId,
        name: 'Review Specialist',
        role: 'backend',
        description: '',
        active: true,
        sourceDivision: 'engineering',
      },
    })
    const resumed = await acceptIntake(id, draft)
    expect(resumed.ok).toBe(true)
    const team = await prisma.team.findFirstOrThrow({
      where: { name: 'Resumable Staff' },
      include: { slaves: { where: { closedAt: null }, include: { person: true } } },
    })
    expect(team.slaves.map((seat) => seat.person.templateId).sort()).toEqual([backendId, reviewerId].sort())
    expect(await prisma.person.count()).toBe(2)
    expect((await prisma.intake.findUniqueOrThrow({ where: { id } })).status).toBe('created')
  })

  it('creates nobody for an empty team, and says skipped rather than done', async (): Promise<void> => {
    const repo = makeRepo()
    const id = await opened(`it is at ${repo}`)
    const accepted = await acceptIntake(id, { ...draftFor(repo, 'Unstaffed'), team: [] })
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error('unreachable')
    expect(await prisma.team.count({ where: { workspaceId: accepted.value.workspaceId } })).toBe(0)
    const row = await prisma.intake.findUniqueOrThrow({ where: { id } })
    const staff = (row.stepLog as { step: string; status: string; detail: string | null }[]).find(
      (entry) => entry.step === 'staff',
    )
    // "I will staff it myself" is a real answer (R13): the project then shows M38's `no_planner`
    // situation exactly as an unstaffed project does today.
    expect(staff).toMatchObject({ status: 'skipped', detail: 'the draft asked for nobody' })
  })

  it('puts the person s own words on the goal event, so the Supervisor conversation opens with them', async (): Promise<void> => {
    const repo = makeRepo()
    const id = await opened(`build rate limiting; the repository is at ${repo}`)
    const accepted = await acceptIntake(id, draftFor(repo, 'With Words'))
    if (!accepted.ok) throw new Error('unreachable')
    const event = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId: accepted.value.workspaceId, type: 'workspace_goal_set' },
    })
    expect((event.payload as { request?: string }).request).toContain('build rate limiting')
    const created = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId: accepted.value.workspaceId, type: 'workspace_created' },
    })
    expect((created.payload as { intakeId?: string }).intakeId).toBe(id)
  })

  it('creates the repository first when there is none, under the configured root', async (): Promise<void> => {
    const root = mkdtempSync(join(tmpdir(), 'accept-root-'))
    await setInstallationSettings({ reposRoot: root })
    const id = await opened('I have an idea and no repository')
    const draft: IntakeDraft = {
      name: 'Brand New',
      goal: 'A brand new service',
      repo: { mode: 'new', path: null },
      baseBranch: 'main',
      verifyCommands: [{ command: 'npm test', source: 'draft' }],
      setupCommands: [],
      budgetUsd: null,
      provider: null,
      team: [],
    }
    const accepted = await acceptIntake(id, draft)
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error('unreachable')

    const created = join(root, 'brand-new')
    expect(existsSync(join(created, 'README.md'))).toBe(true)
    expect(readFileSync(join(created, 'README.md'), 'utf8')).toContain('A brand new service')
    expect(execFileSync('git', ['-C', created, 'log', '--oneline'], { encoding: 'utf8' }).trim().split('\n')).toHaveLength(1)
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: accepted.value.workspaceId } })
    expect(workspace.repoPath).toBe(created)
    const row = await prisma.intake.findUniqueOrThrow({ where: { id } })
    expect((row.stepLog as { step: string }[])[0]?.step).toBe('init_repository')
  })

  it('stops at the failed step, keeps the log, and resumes where it stopped', async (): Promise<void> => {
    const repo = makeRepo()
    // A project already holds the name, so `create_workspace` refuses `duplicate_name`.
    await prisma.workspace.create({ data: { name: 'Taken', repoPath: repo, verifyCommands: ['npm test'], setupCommands: [] } })

    const id = await opened(`it is at ${repo}`)
    const failed = await acceptIntake(id, draftFor(repo, 'Taken'))
    expect(failed.ok).toBe(false)
    if (failed.ok) throw new Error('unreachable')
    expect(failed.error.kind).toBe('duplicate_name')

    const stopped = await prisma.intake.findUniqueOrThrow({ where: { id } })
    expect(stopped.status).toBe('failed')
    expect(stopped.failureReason).toContain('Taken')
    expect((stopped.stepLog as { step: string; status: string }[]).at(-1)).toMatchObject({
      step: 'create_workspace',
      status: 'failed',
    })
    expect(stopped.workspaceId).toBeNull()

    // A rename, and the same intake goes all the way through.
    const accepted = await acceptIntake(id, draftFor(repo, 'Renamed'))
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error('unreachable')
    const done = await prisma.intake.findUniqueOrThrow({ where: { id } })
    expect(done.status).toBe('created')
    expect((await prisma.workspace.findMany({ where: { name: { in: ['Taken', 'Renamed'] } } })).length).toBe(2)
  })

  it('lands in failed rather than stranded in creating when a step throws, and a second accept resumes (fix round 1)', async (): Promise<void> => {
    const repo = makeRepo()
    const id = await opened(`it is at ${repo}`)

    throwOnSetGoal = true
    try {
      const failed = await acceptIntake(id, draftFor(repo, 'Throws Once'))
      expect(failed.ok).toBe(false)
      if (failed.ok) throw new Error('unreachable')
      expect(failed.error.kind).toBe('accept_step_failed')
    } finally {
      throwOnSetGoal = false
    }

    const stopped = await prisma.intake.findUniqueOrThrow({ where: { id } })
    expect(stopped.status).toBe('failed')
    expect(stopped.failureReason).not.toBeNull()
    expect((stopped.stepLog as { step: string; status: string }[]).at(-1)).toMatchObject({
      step: 'set_goal',
      status: 'failed',
    })
    // `create_workspace` already committed before `set_goal` threw, and its id is what a resumed
    // accept must reuse rather than making a second workspace.
    expect(stopped.workspaceId).not.toBeNull()
    expect(await prisma.workspace.count({ where: { name: 'Throws Once' } })).toBe(1)

    const resumed = await acceptIntake(id, draftFor(repo, 'Throws Once'))
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) throw new Error('unreachable')
    expect(resumed.value.workspaceId).toBe(stopped.workspaceId)
    const done = await prisma.intake.findUniqueOrThrow({ where: { id } })
    expect(done.status).toBe('created')
    expect(await prisma.workspace.count({ where: { name: 'Throws Once' } })).toBe(1)
  })

  it('does not create a second project when accept is run again after it succeeded', async (): Promise<void> => {
    const repo = makeRepo()
    const id = await opened(`it is at ${repo}`)
    const first = await acceptIntake(id, draftFor(repo, 'Once Only'))
    expect(first.ok).toBe(true)
    const again = await acceptIntake(id, draftFor(repo, 'Once Only'))
    expect(again.ok).toBe(false)
    if (again.ok) throw new Error('unreachable')
    expect(again.error.kind).toBe('intake_already_created')
    expect(await prisma.workspace.count({ where: { name: 'Once Only' } })).toBe(1)
  })

  it('refuses a draft the schema will not accept, and says which part', async (): Promise<void> => {
    const id = await opened('hello')
    const result = await acceptIntake(id, { name: '', goal: '' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind).toBe('invalid_draft')
  })

  it('refuses a draft naming a repository no fact row ever reported (R8)', async (): Promise<void> => {
    const repo = makeRepo()
    const id = await opened('I will tell you the path later')
    const result = await acceptIntake(id, draftFor(repo, 'Unreported'))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind).toBe('invalid_draft')
  })

  it('refuses a detected verify command the chosen repository s facts do not list (R8)', async (): Promise<void> => {
    const repo = makeRepo()
    const id = await opened(`the repository is at ${repo}`)
    const draft: IntakeDraft = {
      ...draftFor(repo, 'Bad Detected Command'),
      verifyCommands: [{ command: 'npm run e2e', source: 'detected' }],
    }
    const result = await acceptIntake(id, draft)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind).toBe('invalid_draft')
    if (result.error.kind === 'invalid_draft') {
      expect(result.error.detail).toContain('npm run e2e')
    }
  })

  it('refuses a draft verify command on a repository that already exists (R8)', async (): Promise<void> => {
    const repo = makeRepo()
    const id = await opened(`the repository is at ${repo}`)
    const draft: IntakeDraft = {
      ...draftFor(repo, 'Draft Command On Existing Repo'),
      verifyCommands: [{ command: 'npm test', source: 'draft' }],
    }
    const result = await acceptIntake(id, draft)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind).toBe('invalid_draft')
    if (result.error.kind === 'invalid_draft') {
      expect(result.error.detail).toContain('npm test')
    }
  })
})
