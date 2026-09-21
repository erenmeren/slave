import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { INTAKE_BOOTSTRAP_VERIFY_COMMAND, INTAKE_MAX_SEATS_PER_TEMPLATE, type IntakeDraft } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { acceptIntake, openIntake, sendIntakeMessage } from '../../src/intake.js'
import { setInstallationSettings } from '../../src/installation.js'
import { syncPersonPool } from '../../src/personPool.js'

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

async function seedTemplate(name: string, division: string, role = 'backend'): Promise<string> {
  const template = await prisma.slaveTemplate.create({
    data: { name, role, description: '', active: true, sourceDivision: division },
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
  autoMerge: true,
  autonomy: 'act',
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

  /**
   * E R7/R1: the two switches the card carries land on the row the project runs by. They default
   * ON in the draft schema, so a project created from a conversation merges approved work and lets
   * its Supervisor act -- `createWorkspace`'s own defaults (the Prisma column's `false` and
   * `propose`) are what a project created from the CLI or the form still gets.
   */
  it('carries the card s two switches onto the project: auto-merge on, Supervisor acting', async (): Promise<void> => {
    const repo = makeRepo()
    const id = await opened(`the repository is at ${repo}`)

    const accepted = await acceptIntake(id, draftFor(repo, 'Autonomous'))

    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error('unreachable')
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: accepted.value.workspaceId } })
    expect(workspace.autoMerge).toBe(true)
    expect(workspace.supervisorAutonomy).toBe('act')
  })

  /**
   * H3: a project born from a conversation is born with a runtime. The model was free to leave
   * `provider` at `null` (`intakeDraftSchema` permits it), and `createWorkspace` writes NO
   * `ProviderConfiguration` row for `null` -- before this fix that project could not make a
   * single model call, and its planning failed with nothing pointing back here.
   */
  it('creates exactly one ProviderConfiguration of kind claude_code when the draft named none', async (): Promise<void> => {
    const repo = makeRepo()
    const id = await opened(`the repository is at ${repo}`)

    const accepted = await acceptIntake(id, draftFor(repo, 'Runnable'))

    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error('unreachable')
    const configurations = await prisma.providerConfiguration.findMany({
      where: { workspaceId: accepted.value.workspaceId },
    })
    expect(configurations).toHaveLength(1)
    expect(configurations[0]?.kind).toBe('claude_code')
  })

  it('still creates exactly the provider an explicit draft named, cursor', async (): Promise<void> => {
    const repo = makeRepo()
    const id = await opened(`the repository is at ${repo}`)

    const accepted = await acceptIntake(id, { ...draftFor(repo, 'Named Provider'), provider: 'cursor' })

    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error('unreachable')
    const configurations = await prisma.providerConfiguration.findMany({
      where: { workspaceId: accepted.value.workspaceId },
    })
    expect(configurations).toHaveLength(1)
    expect(configurations[0]?.kind).toBe('cursor')
  })

  it('carries an unchecked card through too: the person said no to both', async (): Promise<void> => {
    const repo = makeRepo()
    const id = await opened(`the repository is at ${repo}`)

    const accepted = await acceptIntake(id, { ...draftFor(repo, 'By Hand'), autoMerge: false, autonomy: 'propose' })

    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error('unreachable')
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: accepted.value.workspaceId } })
    expect(workspace.autoMerge).toBe(false)
    expect(workspace.supervisorAutonomy).toBe('propose')
  })

  it('stages seats onto functional departments derived from each template s primary role, not a catch-all named after the project (Task 4)', async (): Promise<void> => {
    const repo = makeRepo()
    const backendId = await seedTemplate('Backend Developer', 'engineering', 'backend')
    const designId = await seedTemplate('Visual Designer', 'design', 'design')
    const id = await opened(`it is at ${repo}`)
    const accepted = await acceptIntake(id, {
      ...draftFor(repo, 'Staffed'),
      team: [
        { templateId: backendId, runtimeRoles: ['backend'] },
        { templateId: designId, runtimeRoles: ['design'] },
      ],
    })
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error('unreachable')

    const teams = await prisma.team.findMany({
      where: { workspaceId: accepted.value.workspaceId },
      include: { slaves: true },
    })
    expect(teams.map((team) => team.name).sort()).toEqual(['Design', 'Engineering'])
    // No project-named catch-all department exists at all, alongside the two functional ones.
    expect(await prisma.team.count({ where: { workspaceId: accepted.value.workspaceId, name: 'Staffed' } })).toBe(0)

    const engineering = teams.find((team) => team.name === 'Engineering')
    expect(engineering?.slaves).toHaveLength(1)
    // `ensureStaffRoles` put both on the one seat whose division looks like engineering:
    // `dispatchPlanning` refuses without a manager and a review needs a reviewer, so a suggested
    // team without them is a project that looks staffed and does nothing.
    expect(engineering?.slaves[0]?.runtimeRoles).toEqual(['backend', 'manager', 'reviewer'])

    const design = teams.find((team) => team.name === 'Design')
    expect(design?.slaves).toHaveLength(1)
    expect(design?.slaves[0]?.runtimeRoles).toEqual(['design'])

    // Automatic staffing selects from the managed pool -- it creates no `Person` row of its own.
    expect(await prisma.person.count()).toBe(6) // two templates' pools, three managed slots apiece
    const seated = await prisma.person.findMany({
      where: { id: { in: [...(engineering?.slaves.map((s) => s.personId) ?? []), ...(design?.slaves.map((s) => s.personId) ?? [])] } },
    })
    expect(seated.every((person) => person.poolSlot !== null)).toBe(true)

    const row = await prisma.intake.findUniqueOrThrow({ where: { id } })
    const staff = (row.stepLog as { step: string; status: string; detail: string | null }[]).find(
      (entry) => entry.step === 'staff',
    )
    expect(staff).toMatchObject({ status: 'done' })
    expect(staff?.detail).toContain('Design')
    expect(staff?.detail).toContain('Engineering')
  })

  /**
   * FINAL REVIEW, IMPORTANT 8, at the boundary that matters. `intakeDraftSchema` is where the rule
   * lives and `packages/domain/test/intake/draft.test.ts` is where it is specified; this is the
   * proof that an impossible draft cannot get past ACCEPTANCE -- the schema is re-parsed here, so a
   * draft stored before the rule existed, or one an edited card produced, is refused at the door
   * rather than half-staffed behind it.
   */
  it('refuses a draft asking for a fourth seat from one persona, and creates no project at all', async (): Promise<void> => {
    const repo = makeRepo()
    const backendId = await seedTemplate('Backend Developer', 'engineering', 'backend')
    const id = await opened(`it is at ${repo}`)

    const accepted = await acceptIntake(id, {
      ...draftFor(repo, 'Over Staffed'),
      team: [1, 2, 3, 4].map(() => ({ templateId: backendId, runtimeRoles: ['backend'] })),
    })

    expect(accepted.ok).toBe(false)
    if (accepted.ok) throw new Error('unreachable')
    expect(accepted.error.kind).toBe('invalid_draft')
    // The refusal names the persona and the limit, because `invalid_draft` carries the issue text
    // straight through to whatever renders it.
    expect(accepted.error).toMatchObject({ detail: expect.stringContaining('three') })
    expect(await prisma.workspace.count()).toBe(0)
    // Still the conversation it was, neither `creating` nor `created`: a refused accept leaves the
    // intake where the person can edit the card and press the button again.
    const row = await prisma.intake.findUniqueOrThrow({ where: { id } })
    expect(row.status).toBe('awaiting_reply')
    expect(row.workspaceId).toBeNull()
  })

  // Three is not one too many: a persona HAS three, and a project that genuinely needs three
  // backend specialists gets three managed people rather than a refusal.
  it('accepts three seats from one persona and seats three managed people on them', async (): Promise<void> => {
    const repo = makeRepo()
    const backendId = await seedTemplate('Backend Developer', 'engineering', 'backend')
    const id = await opened(`it is at ${repo}`)

    const accepted = await acceptIntake(id, {
      ...draftFor(repo, 'Three Deep'),
      team: [1, 2, 3].map(() => ({ templateId: backendId, runtimeRoles: ['backend'] })),
    })

    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error('unreachable')
    const seats = await prisma.slave.findMany({
      where: { team: { workspaceId: accepted.value.workspaceId } },
      include: { person: true },
    })
    expect(seats).toHaveLength(3)
    // All three managed, and all three DIFFERENT people -- the whole pool, with nobody seated twice
    // and nobody invented.
    expect(seats.every((seat) => seat.person.poolSlot !== null)).toBe(true)
    expect(new Set(seats.map((seat) => seat.personId)).size).toBe(3)
  })

  // The domain constant and the pool's own slot count are two numbers that mean one thing, in two
  // packages that cannot import each other (`INTAKE_MAX_SEATS_PER_TEMPLATE`'s own note). This file
  // can import both, so it is where they are pinned together: raise the pool to four slots without
  // raising the draft limit and this fails rather than quietly capping every intake at three.
  it('pins the per-persona seat limit to the number of managed slots a persona actually has', async (): Promise<void> => {
    const backendId = await seedTemplate('Backend Developer', 'engineering', 'backend')
    await syncPersonPool()

    expect(await prisma.person.count({ where: { templateId: backendId, poolSlot: { not: null } } })).toBe(
      INTAKE_MAX_SEATS_PER_TEMPLATE,
    )
  })

  it('seats each of several approved seats for one template with a distinct managed person, on the same department (Task 4)', async (): Promise<void> => {
    const repo = makeRepo()
    const templateId = await seedTemplate('Backend Developer', 'engineering', 'backend')
    const id = await opened(`it is at ${repo}`)
    const accepted = await acceptIntake(id, {
      ...draftFor(repo, 'Two Backend Seats'),
      team: [
        { templateId, runtimeRoles: ['backend'] },
        { templateId, runtimeRoles: ['backend'] },
      ],
    })
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error('unreachable')

    const team = await prisma.team.findFirstOrThrow({
      where: { workspaceId: accepted.value.workspaceId, name: 'Engineering' },
      include: { slaves: true },
    })
    expect(team.slaves).toHaveLength(2)
    const personIds = team.slaves.map((seat) => seat.personId)
    expect(new Set(personIds).size).toBe(2)
    expect(await prisma.person.count()).toBe(3) // one template's pool, all three managed slots
    const persons = await prisma.person.findMany({ where: { id: { in: personIds } } })
    expect(persons.every((person) => person.poolSlot !== null)).toBe(true)
  })

  it('resumes staffing without duplicating seats, departments or people after a seat fails (Task 4)', async (): Promise<void> => {
    const repo = makeRepo()
    const backendId = await seedTemplate('Backend Developer', 'engineering', 'backend')
    const designId = await seedTemplate('Visual Designer', 'design', 'design')
    const id = await opened(`it is at ${repo}`)
    // The draft saw both templates; one disappears only after the facts and draft are established,
    // so staffing commits its first seat before the second refuses.
    await prisma.slaveTemplate.delete({ where: { id: designId } })
    const draft: IntakeDraft = {
      ...draftFor(repo, 'Resumable Staff'),
      team: [
        { templateId: backendId, runtimeRoles: ['backend'] },
        { templateId: designId, runtimeRoles: ['design'] },
      ],
    }

    const failed = await acceptIntake(id, draft)
    expect(failed.ok).toBe(false)
    if (failed.ok) throw new Error('unreachable')
    expect(failed.error).toMatchObject({ kind: 'template_not_found', templateId: designId })

    const workspace = await prisma.workspace.findFirstOrThrow({ where: { name: 'Resumable Staff' } })
    // Only the Engineering seat committed; no Design department and no half-open seat for it.
    expect(await prisma.team.count({ where: { workspaceId: workspace.id } })).toBe(1)
    expect(await prisma.team.findFirstOrThrow({ where: { workspaceId: workspace.id } })).toMatchObject({
      name: 'Engineering',
    })
    expect(await prisma.slave.count({ where: { team: { workspaceId: workspace.id }, closedAt: null } })).toBe(1)
    expect(await prisma.person.count()).toBe(3) // only the backend template's pool was ever synced

    await prisma.slaveTemplate.create({
      data: { id: designId, name: 'Visual Designer', role: 'design', description: '', active: true, sourceDivision: 'design' },
    })
    const resumed = await acceptIntake(id, draft)
    expect(resumed.ok).toBe(true)

    const teams = await prisma.team.findMany({ where: { workspaceId: workspace.id }, include: { slaves: { where: { closedAt: null } } } })
    expect(teams.map((team) => team.name).sort()).toEqual(['Design', 'Engineering'])
    // The Engineering seat from the failed run was REUSED, not duplicated.
    expect(teams.find((team) => team.name === 'Engineering')?.slaves).toHaveLength(1)
    expect(teams.find((team) => team.name === 'Design')?.slaves).toHaveLength(1)
    expect(await prisma.person.count()).toBe(6) // the design template's pool was synced on resume, once
    expect((await prisma.intake.findUniqueOrThrow({ where: { id } })).status).toBe('created')
  })

  it('fails the staff step with the typed refusal when the pool is still unavailable after one sync and retry (Task 4)', async (): Promise<void> => {
    const repo = makeRepo()
    const templateId = await seedTemplate('Backend Developer', 'engineering', 'backend')
    await syncPersonPool()
    // Every managed slot released before staffing runs -- sync repairs capabilities, it never
    // un-releases anyone, so the one retry the step allows finds the same nobody.
    await prisma.person.updateMany({ where: { templateId }, data: { releasedAt: new Date(), releaseReason: 'test' } })

    const id = await opened(`it is at ${repo}`)
    const accepted = await acceptIntake(id, {
      ...draftFor(repo, 'No Pool'),
      team: [{ templateId, runtimeRoles: ['backend'] }],
    })
    expect(accepted.ok).toBe(false)
    if (accepted.ok) throw new Error('unreachable')
    expect(accepted.error).toMatchObject({ kind: 'pool_unavailable', templateId })
    expect((await prisma.intake.findUniqueOrThrow({ where: { id } })).status).toBe('failed')
  })

  it('seats a pool person who already holds an open seat on another project, but never twice in this one (Task 4)', async (): Promise<void> => {
    const repo = makeRepo()
    const templateId = await seedTemplate('Backend Developer', 'engineering', 'backend')
    await syncPersonPool()
    const pool = await prisma.person.findMany({ where: { templateId } })
    expect(pool).toHaveLength(3)

    const other = await prisma.workspace.create({
      data: { name: 'Other Project', repoPath: '/tmp/other-project', verifyCommands: [], setupCommands: [] },
    })
    const otherTeam = await prisma.team.create({ data: { workspaceId: other.id, name: 'Engineering' } })
    // Every managed person for this template is already busy elsewhere: selection must still work,
    // since a seat on another project is fine (Task 2's own guarantee) and nobody is excluded here
    // merely for holding one.
    for (const person of pool) {
      await prisma.slave.create({ data: { teamId: otherTeam.id, personId: person.id, role: 'backend', runtimeRoles: ['backend'] } })
    }

    const id = await opened(`it is at ${repo}`)
    const accepted = await acceptIntake(id, {
      ...draftFor(repo, 'Shared Person'),
      team: [{ templateId, runtimeRoles: ['backend'] }],
    })
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error('unreachable')

    const team = await prisma.team.findFirstOrThrow({
      where: { workspaceId: accepted.value.workspaceId, name: 'Engineering' },
      include: { slaves: true },
    })
    expect(team.slaves).toHaveLength(1)
    const chosenId = team.slaves[0]?.personId
    if (chosenId === undefined) throw new Error('unreachable')
    expect(pool.map((person) => person.id)).toContain(chosenId)
    // The same person's seat on the OTHER project is untouched.
    expect(await prisma.slave.count({ where: { personId: chosenId, team: { workspaceId: other.id }, closedAt: null } })).toBe(1)
    // And they hold exactly one open seat in THIS workspace, never two.
    expect(
      await prisma.slave.count({ where: { personId: chosenId, team: { workspaceId: accepted.value.workspaceId }, closedAt: null } }),
    ).toBe(1)
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
      autoMerge: true,
      autonomy: 'act',
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

  it('plants a gate of its own when the model named none, and asks the project to write it', async (): Promise<void> => {
    // M60 §7b. An empty list is what the model should answer for a repository that does not exist
    // (there is no code, so no command proves anything), and it must NOT reach `createWorkspace`
    // as one: zero verify commands is `verify_not_configured`, which blocks the task and halts the
    // whole project on its first piece of work. So the system plants its own command -- and puts
    // writing the script it names into the goal, because a gate nothing is asked to create is a
    // gate the first task fails through every attempt it has.
    const root = mkdtempSync(join(tmpdir(), 'accept-bootstrap-'))
    await setInstallationSettings({ reposRoot: root })
    const id = await opened('I have an idea and no repository at all')
    const draft: IntakeDraft = {
      name: 'Idea Only',
      goal: 'Redesign the marketing site from scratch',
      repo: { mode: 'new', path: null },
      baseBranch: 'main',
      verifyCommands: [],
      setupCommands: [],
      budgetUsd: null,
      provider: null,
      autoMerge: true,
      autonomy: 'act',
      team: [],
    }
    const accepted = await acceptIntake(id, draft)
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error('unreachable')

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: accepted.value.workspaceId } })
    expect(workspace.verifyCommands).toEqual([INTAKE_BOOTSTRAP_VERIFY_COMMAND])
    const goal = await prisma.goalVersion.findFirstOrThrow({
      where: { workspaceId: accepted.value.workspaceId },
      orderBy: { version: 'desc' },
    })
    // The person's own goal is still the goal; the clause is added to it rather than replacing it.
    expect(goal.text).toContain('Redesign the marketing site from scratch')
    expect(goal.text).toContain('scripts/verify.sh')

    // The script the gate names is planted WITH the repository, executable, in the first commit --
    // not asked of the project as its first task. Asked, the planner made every other task depend
    // on it (observed 2026-09-20: a research task waiting on a shell script), and a stub cost two
    // model runs. The clause therefore says the script exists and must be extended, never that it
    // must be created first.
    const created = join(root, 'idea-only')
    const script = join(created, 'scripts', 'verify.sh')
    expect(existsSync(script)).toBe(true)
    expect(statSync(script).mode & 0o111).not.toBe(0)
    expect(execFileSync('bash', [script], { cwd: created, encoding: 'utf8' })).toBeDefined()
    expect(execFileSync('git', ['-C', created, 'ls-files'], { encoding: 'utf8' }).split('\n')).toContain('scripts/verify.sh')
    expect(execFileSync('git', ['-C', created, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('')
    expect(goal.text).toContain('already exists')
    expect(goal.text).not.toContain('Before anything else')
  })

  it('plants no script when the draft named its own gate for a new repository', async (): Promise<void> => {
    const root = mkdtempSync(join(tmpdir(), 'accept-named-new-'))
    await setInstallationSettings({ reposRoot: root })
    const id = await opened('I have an idea and no repository')
    const draft: IntakeDraft = {
      name: 'Named New',
      goal: 'A brand new service',
      repo: { mode: 'new', path: null },
      baseBranch: 'main',
      verifyCommands: [{ command: 'npm test', source: 'draft' }],
      setupCommands: [],
      budgetUsd: null,
      provider: null,
      autoMerge: true,
      autonomy: 'act',
      team: [],
    }
    const accepted = await acceptIntake(id, draft)
    expect(accepted.ok).toBe(true)
    expect(existsSync(join(root, 'named-new', 'scripts', 'verify.sh'))).toBe(false)
  })

  it('leaves a named gate exactly as the draft named it, planting nothing over it', async (): Promise<void> => {
    const repo = makeRepo()
    const id = await opened(`it is at ${repo}`)
    const accepted = await acceptIntake(id, draftFor(repo, 'Named Gate'))
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error('unreachable')

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: accepted.value.workspaceId } })
    expect(workspace.verifyCommands).toEqual(['npm test'])
    const goal = await prisma.goalVersion.findFirstOrThrow({
      where: { workspaceId: accepted.value.workspaceId },
      orderBy: { version: 'desc' },
    })
    expect(goal.text).not.toContain('scripts/verify.sh')
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
