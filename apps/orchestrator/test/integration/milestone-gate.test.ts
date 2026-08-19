import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, type DomainEventType } from '@ai-team-os/db'
import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')

/**
 * Spec §16, the milestone gate. Every step is driven from the CLI, because "M3 is done when, from
 * the CLI" is the sentence the gate opens with -- an in-process shortcut would prove a different
 * product than the one an operator runs. Against the fake `claude` here; §16 additionally requires
 * steps 3-4 once by hand against the real CLI, recorded under docs/superpowers/spikes/.
 */
async function runCli(args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<{
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI, ...args], {
      env: {
        ...process.env,
        DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
        AITEAMOS_CLAUDE_BIN: 'node',
        AITEAMOS_CLAUDE_ARGS: `${FAKE} --fixture complete`,
        ...extraEnv,
      },
    })
    return { stdout, stderr, code: 0 }
  } catch (error) {
    const shaped = error as { stdout?: string; stderr?: string; code?: number }
    return { stdout: shaped.stdout ?? '', stderr: shaped.stderr ?? '', code: shaped.code ?? 1 }
  }
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiteamos-gate-'))
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

interface Fixture {
  readonly workspaceId: string
  readonly taskId: string
  readonly repoPath: string
}

const repos: string[] = []

async function seed(options: {
  readonly verifyCommands: readonly string[]
  readonly setupCommands?: readonly string[]
}): Promise<Fixture> {
  const repoPath = makeRepo()
  repos.push(repoPath)
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath,
      verifyCommands: [...options.verifyCommands],
      setupCommands: [...(options.setupCommands ?? [])],
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Add the thing',
      description: 'make it work',
      status: 'ready',
      requiredRole: 'backend',
      maxAttempts: workspace.maxAttempts,
    },
  })
  return { workspaceId: workspace.id, taskId: task.id, repoPath }
}

async function eventTypesFor(workspaceId: string): Promise<readonly DomainEventType[]> {
  const rows = await prisma.executionEvent.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
  return rows.map((row): DomainEventType => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] as DomainEventType)
}

/** Asserts `earlier` and `later` both happened, in that order. An index of -1 fails both ways. */
function expectOrdered(types: readonly DomainEventType[], earlier: DomainEventType, later: DomainEventType): void {
  const first = types.indexOf(earlier)
  const second = types.indexOf(later)
  expect(first, `${earlier} was never emitted`).toBeGreaterThanOrEqual(0)
  expect(second, `${later} was never emitted`).toBeGreaterThan(first)
}

describe('the M3 milestone gate', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true })
    await prisma.$disconnect()
  }, 30_000)

  it('green: a seeded ready task reaches done with a branch — tick, worktree, setup, stream, verify', async (): Promise<void> => {
    // The verify command doubles as the proof that setup ran *in the worktree*: it can only pass
    // where provisioning ran the setup command first, so a verify green here is steps 2 and 5 of
    // §16 observed through one another rather than asserted separately on trust.
    const fixture = await seed({
      setupCommands: ['echo ran > setup-marker'],
      verifyCommands: ['test -f setup-marker'],
    })

    const result = await runCli(['tick'])

    expect(result.code).toBe(0)
    const report = JSON.parse(result.stdout) as { started: readonly string[] }
    expect(report.started).toHaveLength(1)

    // Step 1-2: picked up by a tick, worktree provisioned, setup ran in it.
    const run = await prisma.agentRun.findFirstOrThrow()
    expect(run.status).toBe('succeeded')
    expect(run.pid).toBeGreaterThan(0)
    expect(run.worktreePath).toContain(join('.aiteamos', 'worktrees'))
    expect(existsSync(join(run.worktreePath ?? '', 'setup-marker'))).toBe(true)

    // Step 3: the run's events landed in the log — the run announced itself and its conclusion.
    const types = await eventTypesFor(fixture.workspaceId)
    expect(types).toContain('run.started')
    expect(types).toContain('run.succeeded')

    // Steps 5-6, green: verify ran on the result and the task reached done, in the §8 order --
    // verify strictly after the run concluded, done strictly after verify passed.
    expectOrdered(types, 'run.succeeded', 'task.verifying')
    expectOrdered(types, 'task.verifying', 'task.verify_passed')
    expectOrdered(types, 'task.verify_passed', 'task.done')

    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('done')
    expect(task.branch).toMatch(/^aiteamos\//)
    expect(task.activeRunId).toBeNull()

    // §8: each verify command's outcome is persisted as an Artifact, outside the worktree.
    const artifacts = await prisma.artifact.findMany({ where: { taskId: fixture.taskId } })
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.kind).toBe('verify')
    expect(artifacts[0]?.path.startsWith(run.worktreePath ?? '!')).toBe(false)
    expect(existsSync(artifacts[0]?.path ?? '')).toBe(true)
  }, 60_000)

  it('red: a failing verify sends the task to rework with the failure attached', async (): Promise<void> => {
    const fixture = await seed({ verifyCommands: ['echo BOOM >&2; exit 1'] })

    const result = await runCli(['tick'])

    expect(result.code).toBe(0)

    // The agent's run itself was fine — it is the *work* that failed verification. A gate that
    // conflated the two could pass with verify never wired at all, failing runs standing in for
    // failing work.
    const run = await prisma.agentRun.findFirstOrThrow()
    expect(run.status).toBe('succeeded')

    const types = await eventTypesFor(fixture.workspaceId)
    expectOrdered(types, 'task.verifying', 'task.verify_failed')
    expectOrdered(types, 'task.verify_failed', 'task.rework')

    // Step 6, red: rework with the failure attached — §8's channel to the next run's prompt.
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('rework')
    expect(task.attempt).toBe(1)
    expect(task.lastRejectionReason).toContain('BOOM')
  }, 60_000)

  it('pause: the run pauses on the gate, checkpoints, and resumes to completion', async (): Promise<void> => {
    const fixture = await seed({ verifyCommands: ['true'] })

    // A real pause, produced by the gate denying the fake CLI's tool call — the same protocol the
    // real `claude` follows, which is what lets §16 run this step against either.
    await runCli(['tick'], { AITEAMOS_CLAUDE_ARGS: `${FAKE} --fixture hook-deny` })

    const paused = await prisma.agentRun.findFirstOrThrow()
    expect(paused.status).toBe('paused')

    // Step 4: the checkpoint written from the pause carries what a fresh process needs to resume.
    const checkpoint = await prisma.checkpoint.findUniqueOrThrow({ where: { runId: paused.id } })
    expect(checkpoint.sessionId).not.toBe('')
    expect(checkpoint.worktreePath).toContain('.aiteamos')

    const result = await runCli(['resume', '--run', paused.id], {
      AITEAMOS_CLAUDE_ARGS: `${FAKE} --fixture complete`,
    })

    expect(result.code).toBe(0)

    // The resumed run completes — and its completion is a completion like any other: verify runs
    // on it and the task advances. A resumed run whose success leaves the task `running` forever
    // would make pause/resume a trap rather than a control.
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: paused.id } })
    expect(run.status).toBe('succeeded')
    expect(run.terminalAt).not.toBeNull()

    const types = await eventTypesFor(fixture.workspaceId)
    expect(types).toContain('run.paused')
    expect(types).toContain('run.resumed')
    expectOrdered(types, 'run.resumed', 'task.done')

    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('done')
  }, 60_000)
})
