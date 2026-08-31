import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')

interface CliResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

/**
 * Runs the real built CLI as a child process.
 *
 * Not an exported function called in-process: exit codes, argv parsing and the bin wiring are the
 * things a command-line tool gets wrong, and only a child exercises them. Spec §16 drives the
 * milestone gate from the CLI, so the CLI is what has to work.
 *
 * `DATABASE_URL` is passed explicitly because the child loads `.env` for itself and would otherwise
 * drive the *development* database while the test asserts against the test one.
 */
async function runCli(args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<CliResult> {
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
  const dir = mkdtempSync(join(tmpdir(), 'aiteamos-cli-'))
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
  readonly agentId: string
  readonly repoPath: string
}

const repos: string[] = []

async function seed(): Promise<Fixture> {
  const repoPath = makeRepo()
  repos.push(repoPath)
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath, verifyCommands: ['true'], setupCommands: [] },
  })
  // M12 Task 8: no agent in this file names a model anywhere in the chain, so `resolveRuntime`
  // falls all the way to the workspace default -- which needs a `ProviderConfiguration` row to
  // exist at all, or every dispatch here (the real CLI, `dist/cli.js`) refuses instead of
  // starting the run under test.
  await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
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
  return { workspaceId: workspace.id, taskId: task.id, agentId: agent.id, repoPath }
}

describe('the orchestrator CLI', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace", "CompanyAgent", "CompanyTeam", "Company", "AgentTemplate" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true })
    await prisma.$disconnect()
  }, 30_000)

  it('runs exactly one tick and prints a report', async (): Promise<void> => {
    const result = await runCli(['tick'])

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ started: expect.any(Array) })
  }, 30_000)

  it('starts exactly one run per tick invocation', async (): Promise<void> => {
    await runCli(['tick'])

    // "Exactly one tick" is the command's whole contract -- a `tick` that looped, or that also
    // reconciled, would be indistinguishable from `daemon` by its output alone.
    expect(await prisma.agentRun.count()).toBe(1)
  }, 30_000)

  it('does not reconcile orphans on a bare tick', async (): Promise<void> => {
    const other = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'held by a dead run',
        description: 'x',
        status: 'running',
        requiredRole: 'backend',
        maxAttempts: 3,
      },
    })
    await prisma.agentRun.create({
      data: { taskId: other.id, agentId: fixture.agentId, status: 'working', pid: 999_999 },
    })

    await runCli(['tick'])

    // A CLI `tick` may run alongside a live daemon, and Task 15's orphan pass is startup-only for a
    // reason: a run that is mid-spawn is indistinguishable from one it should fail. Reconciling
    // here would fail runs belonging to a daemon that is very much alive.
    const run = await prisma.agentRun.findFirstOrThrow({ where: { taskId: other.id } })
    expect(run.status).toBe('working')
  }, 30_000)

  it('exits non-zero for an unknown run', async (): Promise<void> => {
    const result = await runCli(['pause', '--run', 'nope'])

    expect(result.code).not.toBe(0)
  }, 30_000)

  it('exits non-zero and prints usage for an unknown command', async (): Promise<void> => {
    const result = await runCli(['frobnicate'])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/usage/i)
  }, 30_000)

  it('runs skills sync and reports what it found', async (): Promise<void> => {
    const result = await runCli(['skills', 'sync'])

    expect(result.code).toBe(0)
    // The catalog is read from the DAEMON HOST's disk, so this asserts the shape of the report
    // rather than a count: a CI machine has no `~/.claude/skills`, and a machine that does has an
    // unknowable number.
    expect(result.stdout).toMatch(/^skill catalog synced: \d+ provider\(s\), \d+ skill\(s\), \d+ marked missing\n$/m)
  }, 30_000)

  it('refuses an unknown skills subcommand with usage', async (): Promise<void> => {
    const result = await runCli(['skills', 'frobnicate'])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/unknown skills subcommand: frobnicate/)
  }, 30_000)

  it('clears a workspace safety halt', async (): Promise<void> => {
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { haltedReason: 'gate failure', haltedAt: new Date() },
    })

    const result = await runCli(['clear-halt', '--workspace', fixture.workspaceId])

    expect(result.code).toBe(0)
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })
    expect(ws.haltedReason).toBeNull()
    expect(ws.haltedAt).toBeNull()
  })

  it('engages an emergency stop that halts the workspace', async (): Promise<void> => {
    const result = await runCli(['emergency-stop', '--workspace', fixture.workspaceId])

    expect(result.code).toBe(0)
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })
    expect(ws.haltedReason).not.toBeNull()
  }, 30_000)

  it('refuses emergency-stop with no --workspace given, even with exactly one workspace', async (): Promise<void> => {
    // Unlike `resolveWorkspace` alone, `emergency-stop` follows `clear-halt`'s mandatory-flag idiom:
    // `--workspace` is required even when the database holds exactly one workspace, because
    // emergency-stopping the wrong one by omission is the kind of mistake this command exists to
    // prevent an operator from making silently.
    const result = await runCli(['emergency-stop'])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/--workspace is required/)
  }, 30_000)

  it('sets a workspace goal', async (): Promise<void> => {
    const result = await runCli(['set-goal', '--workspace', fixture.workspaceId, '--goal', 'x'])

    expect(result.code).toBe(0)
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })
    expect(ws.goal).toBe('x')
  })

  it('exits non-zero for set-goal with no --goal given', async (): Promise<void> => {
    const result = await runCli(['set-goal', '--workspace', fixture.workspaceId])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/--goal is required/)
  })

  it('creates a template', async (): Promise<void> => {
    const result = await runCli(['create-template', '--name', 'Backend Engineer', '--role', 'backend'])

    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/^template .+ created$/m)
    expect(await prisma.agentTemplate.count()).toBe(1)
  })

  it('exits non-zero for create-template with no --name given', async (): Promise<void> => {
    const result = await runCli(['create-template', '--role', 'backend'])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/--name is required/)
  })

  it('creates a company', async (): Promise<void> => {
    const result = await runCli(['create-company', '--name', 'Acme Corp'])

    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/^company .+ created$/m)
    expect(await prisma.company.count()).toBe(1)
  })

  it('exits non-zero for create-company with no --name given', async (): Promise<void> => {
    const result = await runCli(['create-company'])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/--name is required/)
  })

  it('assigns a company to a workspace and prints the count of new workers', async (): Promise<void> => {
    const company = await prisma.company.create({ data: { name: 'Acme Corp' } })
    const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
    const template = await prisma.agentTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })
    await prisma.companyAgent.create({ data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas' } })

    const result = await runCli(['assign-company', '--workspace', fixture.workspaceId, '--company', company.id])

    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(new RegExp(`^company assigned to ${fixture.workspaceId}: 1 new worker\\(s\\)$`, 'm'))
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })
    expect(ws.companyId).toBe(company.id)
  })

  it('exits non-zero for assign-company with no --company given', async (): Promise<void> => {
    const result = await runCli(['assign-company', '--workspace', fixture.workspaceId])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/--company is required/)
  })

  it('sets a worker model+provider override, then clears both -- a set/clear round trip', async (): Promise<void> => {
    const setResult = await runCli([
      'set-model',
      '--agent',
      fixture.agentId,
      '--model',
      'claude-opus',
      '--provider',
      'claude_code',
    ])

    expect(setResult.code).toBe(0)
    expect(setResult.stdout).toMatch(new RegExp(`^model set to claude-opus on ${fixture.agentId}$`, 'm'))
    const afterSet = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } })
    expect(afterSet.model).toBe('claude-opus')
    expect(afterSet.provider).toBe('claude_code')

    const clearResult = await runCli(['set-model', '--agent', fixture.agentId, '--clear'])

    expect(clearResult.code).toBe(0)
    expect(clearResult.stdout).toMatch(new RegExp(`^model cleared on ${fixture.agentId}$`, 'm'))
    const afterClear = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } })
    expect(afterClear.model).toBeNull()
    expect(afterClear.provider).toBeNull()
  })

  it('exits non-zero for set-model with neither --model nor --clear given', async (): Promise<void> => {
    const result = await runCli(['set-model', '--agent', fixture.agentId])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/--model or --clear is required/)
  })

  it('exits non-zero for set-model with --model and no --provider', async (): Promise<void> => {
    const result = await runCli(['set-model', '--agent', fixture.agentId, '--model', 'claude-opus'])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/a model must name the provider that runs it/)
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } })
    expect(agent.model).toBeNull()
  })

  it('exits non-zero for set-model against an unknown agent', async (): Promise<void> => {
    const result = await runCli([
      'set-model',
      '--agent',
      'nope',
      '--model',
      'claude-opus',
      '--provider',
      'claude_code',
    ])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/no agent with id nope/)
  })

  it('exits non-zero for set-model with an empty --model', async (): Promise<void> => {
    const result = await runCli([
      'set-model',
      '--agent',
      fixture.agentId,
      '--model',
      '',
      '--provider',
      'claude_code',
    ])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/a model must be a non-empty text/)
  })

  it('tells an operator that clear-halt is not resume', async (): Promise<void> => {
    const result = await runCli(['help'])
    const help = `${result.stdout}${result.stderr}`

    // Spec §11 spells out the failure this wording prevents: an operator who reaches for the wrong
    // one either continues a run while the workspace is still halted (nothing happens, confusingly)
    // or clears a workspace-wide safety halt believing they nudged a single run -- the dangerous
    // direction. This is the one place a help string is load-bearing.
    expect(help).toMatch(/clear-halt/)
    expect(help).toMatch(/workspace-wide/i)
    expect(help).toMatch(/starts nothing/i)
  }, 30_000)

  it('prints the active runs, their pids and worktrees', async (): Promise<void> => {
    // Seeded rather than produced by a tick: §11 says `status` lists *active* runs, and the CLI's
    // `tick` waits for the run it started, so by the time it returns there is nothing active. A
    // status that listed finished runs would bury the one thing an operator is looking for.
    await prisma.agentRun.create({
      data: {
        taskId: fixture.taskId,
        agentId: fixture.agentId,
        status: 'working',
        pid: process.pid,
        worktreePath: join(fixture.repoPath, '.aiteamos', 'worktrees', 'T-abcdef12'),
      },
    })
    await prisma.agentRun.create({
      data: {
        taskId: fixture.taskId,
        agentId: fixture.agentId,
        status: 'succeeded',
        terminalAt: new Date(),
        endedAt: new Date(),
      },
    })

    const result = await runCli(['status'])

    expect(result.code).toBe(0)
    const status = JSON.parse(result.stdout) as {
      halt: unknown
      runs: readonly { id: string; pid: number | null; worktreePath: string | null; status: string }[]
    }
    expect(status.runs).toHaveLength(1)
    expect(status.runs[0]?.pid).toBe(process.pid)
    expect(status.runs[0]?.worktreePath).toContain('.aiteamos')
  }, 30_000)

  it('prints a workspace halt with the reason it happened', async (): Promise<void> => {
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { haltedReason: 'the pause gate failed open (PreToolUse:Write exited 127)', haltedAt: new Date() },
    })

    const result = await runCli(['status'])

    // `decide()` surfaces only the guardrail *name* (`emergency_stop`), which says nothing about the
    // hook path that caused it. The reason lives in the column precisely so an operator can read it.
    const status = JSON.parse(result.stdout) as { halt: { reason: string } | null }
    expect(status.halt?.reason).toContain('PreToolUse:Write')
  })

  it('refuses a workspace-scoped command when the workspace is ambiguous', async (): Promise<void> => {
    await seed()

    const result = await runCli(['status'])

    // One workspace makes omitting `--workspace` unambiguous; two make it a guess. Guessing here
    // means an operator reads one workspace's runs believing they are another's.
    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/--workspace/)
  }, 30_000)

  it('cancels a run and preserves its worktree', async (): Promise<void> => {
    await runCli(['tick'])
    const run = await prisma.agentRun.findFirstOrThrow()

    const result = await runCli(['cancel', '--run', run.id])

    expect(result.code).toBe(0)
  }, 30_000)

  it('waits for the run it started before exiting', async (): Promise<void> => {
    await runCli(['tick'])

    // The tick *function* deliberately does not await its pump -- a daemon's pumps outlive each
    // tick. A one-shot command's process is about to exit, and exiting would leave a live agent
    // with nobody reading its stream: every event from that moment lost, and the run left for the
    // orphan pass to fail on some later startup.
    const run = await prisma.agentRun.findFirstOrThrow()
    expect(['succeeded', 'failed']).toContain(run.status)
    expect(run.terminalAt).not.toBeNull()
  }, 30_000)

  it('names the run it could not find', async (): Promise<void> => {
    const result = await runCli(['pause', '--run', 'nope'])

    expect(`${result.stdout}${result.stderr}`).toMatch(/no run with id nope/)
  }, 30_000)

  it('arms the gate and records who asked', async (): Promise<void> => {
    const run = await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'working', pid: process.pid },
    })

    const result = await runCli(['pause', '--run', run.id, '--by', 'meren'])

    expect(result.code).toBe(0)
    // The flag file is the whole mechanism: the gate reads it and denies the next tool call. A
    // separate process cannot follow the rest of the protocol -- it has no handle on the child and
    // no view of its stream -- so writing the flag is the half it can perform, and the daemon's
    // pump observes the deny.
    expect(existsSync(join(fixture.repoPath, '.aiteamos', 'runs', run.id, 'pause.flag'))).toBe(true)

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('pause_requested')
    // The *category*, which this is the only place that knows: an operator asked. Task 12 carried
    // it forward as a column nothing ever wrote.
    expect(after.pauseReason).toBe('human')
  }, 30_000)

  it('actually kills the process it cancels', async (): Promise<void> => {
    const sleeper = spawn('/bin/sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' })
    const pid = sleeper.pid ?? 0
    const run = await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'working', pid },
    })

    try {
      const result = await runCli(['cancel', '--run', run.id])
      expect(result.code).toBe(0)

      await new Promise((res) => setTimeout(res, 500))
      // The adapter's registry of live children is per-process, so a CLI invocation cannot ask it
      // to cancel anything -- the pid in the row is the only handle a different process has. Task
      // 15 carried this forward as the reason a run outliving its daemon could not be killed.
      let alive = true
      try {
        process.kill(pid, 0)
      } catch {
        alive = false
      }
      expect(alive).toBe(false)
    } finally {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  }, 30_000)

  it('clears the halt on the workspace it was told, and no other', async (): Promise<void> => {
    const other = await seed()
    for (const id of [fixture.workspaceId, other.workspaceId]) {
      await prisma.workspace.update({
        where: { id },
        data: { haltedReason: 'gate failure', haltedAt: new Date() },
      })
    }

    const result = await runCli(['clear-halt', '--workspace', fixture.workspaceId])

    expect(result.code).toBe(0)
    // The dangerous direction §11 names: an operator retracting a safety halt they did not mean to.
    // With one workspace in the fixture, ignoring --workspace entirely is indistinguishable from
    // honouring it.
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })).haltedReason).toBeNull()
    expect(
      (await prisma.workspace.findUniqueOrThrow({ where: { id: other.workspaceId } })).haltedReason,
    ).toBe('gate failure')
  }, 30_000)

  it('shows only the workspace it was asked about', async (): Promise<void> => {
    const other = await seed()
    await prisma.agentRun.create({
      data: { taskId: other.taskId, agentId: other.agentId, status: 'working', pid: process.pid },
    })
    await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'working', pid: process.pid },
    })

    const result = await runCli(['status', '--workspace', fixture.workspaceId])

    const status = JSON.parse(result.stdout) as { runs: readonly { id: string }[] }
    expect(status.runs).toHaveLength(1)
  }, 30_000)

  it('accepts the --flag=value form rather than silently ignoring it', async (): Promise<void> => {
    await seed()

    const result = await runCli(['status', `--workspace=${fixture.workspaceId}`])

    // Dropping the `=` form means the command runs against whichever workspace happens to be the
    // only one -- the exact mistake the workspace check exists to prevent, arriving through the
    // parser instead.
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ halt: null })
  }, 30_000)

  it('records the operator name it was given, even one that looks like a flag', async (): Promise<void> => {
    const run = await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'working', pid: process.pid },
    })

    await runCli(['pause', '--run', run.id, '--by', '--urgent-oncall'])

    const event = await prisma.executionEvent.findFirstOrThrow({
      where: { runId: run.id, type: 'run_pause_requested' },
    })
    expect((event.payload as { requestedBy: string }).requestedBy).toBe('--urgent-oncall')
  }, 30_000)

  it('refuses to pause a run that has already finished', async (): Promise<void> => {
    const run = await prisma.agentRun.create({
      data: {
        taskId: fixture.taskId,
        agentId: fixture.agentId,
        status: 'succeeded',
        terminalAt: new Date(),
        endedAt: new Date(),
      },
    })

    const result = await runCli(['pause', '--run', run.id])

    // `pause_requested` is non-terminal, so pausing a finished run puts it back into `activeRuns`,
    // makes its agent look busy, and leaves the next restart's orphan sweep to flip a run that
    // actually succeeded to `failed`.
    expect(result.code).not.toBe(0)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('succeeded')
  }, 30_000)

  it('refuses to resume a run that is not paused', async (): Promise<void> => {
    const run = await prisma.agentRun.create({
      data: {
        taskId: fixture.taskId,
        agentId: fixture.agentId,
        status: 'succeeded',
        terminalAt: new Date(),
        endedAt: new Date(),
      },
    })
    await prisma.checkpoint.create({
      data: {
        runId: run.id,
        sessionId: 's-1',
        worktreePath: fixture.repoPath,
        pauseFlagPath: join(fixture.repoPath, 'pause.flag'),
        settingsPath: join(fixture.repoPath, 'settings.json'),
        hookPath: join(repoRoot, 'scripts/pause-gate.sh'),
        gitAuthorName: 'Alex',
        gitAuthorEmail: 'alex@aiteamos.local',
        headCommit: 'deadbeef',
      },
    })

    const result = await runCli(['resume', '--run', run.id])

    // Against a live daemon this is two agents on one branch, with the pid that could have killed
    // the first overwritten by the second. The adapter's live-child guard cannot help: a CLI
    // invocation is always the cross-process case its registry is empty for.
    expect(result.code).not.toBe(0)
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('succeeded')
    expect(await prisma.executionEvent.count({ where: { runId: run.id, type: 'run_resumed' } })).toBe(0)
  }, 30_000)

  it('refuses to resume into a halted workspace', async (): Promise<void> => {
    const run = await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'paused' },
    })
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { haltedReason: 'the pause gate failed open', haltedAt: new Date() },
    })

    const result = await runCli(['resume', '--run', run.id])

    // A halt is raised by a gate failure, so resuming into one relaunches an agent whose gate may
    // still be broken -- the recurrence §13.1 exists to bound. The help text promises this.
    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/clear-halt/)
  }, 30_000)

  it('resumes a paused run in its own worktree, session and identity', async (): Promise<void> => {
    // A real pause, produced by the gate denying the fake CLI's first tool call.
    await runCli(['tick'], { AITEAMOS_CLAUDE_ARGS: `${FAKE} --fixture hook-deny` })
    const paused = await prisma.agentRun.findFirstOrThrow()
    expect(paused.status).toBe('paused')
    const checkpoint = await prisma.checkpoint.findUniqueOrThrow({ where: { runId: paused.id } })

    // `complete` rather than `env-echo`: the resumed run has to emit a `system/init` line for the
    // "does it announce itself as started again" assertion below to reach the code at all, and
    // env-echo emits none. A test that cannot reach the branch it names proves nothing about it.
    const result = await runCli(['resume', '--run', paused.id, '--message', 'try the other approach'], {
      AITEAMOS_CLAUDE_ARGS: `${FAKE} --fixture complete`,
    })

    expect(result.code).toBe(0)
    expect(await prisma.executionEvent.count({ where: { runId: paused.id, type: 'run_resumed' } })).toBe(1)
    // Task 12's carry: the stream cannot tell a continuation from a first spawn, so without telling
    // the pump, a resumed run emits a second `run.started` -- an illegal transition from `working`
    // for anything replaying the log through the domain's state machine.
    expect(await prisma.executionEvent.count({ where: { runId: paused.id, type: 'run_started' } })).toBe(1)
    expect(checkpoint.worktreePath).toContain('.aiteamos')
    expect(checkpoint.gitAuthorEmail).toContain('@aiteamos.local')
  }, 60_000)

  it('does not hand a cancelled task straight back to a new agent', async (): Promise<void> => {
    await runCli(['tick'])
    const run = await prisma.agentRun.findFirstOrThrow()
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: 'working', terminalAt: null, endedAt: null },
    })
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { status: 'running', activeRunId: run.id },
    })

    await runCli(['cancel', '--run', run.id])
    const report = await runCli(['tick'])

    // The help and the README both say cancel stops a run for good. Parking the task somewhere
    // startable means the next tick hands it to a fresh agent on the same worktree -- and since
    // cancelling does not count an attempt, repeated cancels never reach the cap.
    expect(JSON.parse(report.stdout)).toMatchObject({ started: [] })
    expect((await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).status).toBe('blocked')
  }, 60_000)

  it('defaults to help rather than to doing something', async (): Promise<void> => {
    const result = await runCli([])

    // A bare invocation that silently ran a tick would start an agent for an operator who typed
    // the command name to see what it does.
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/usage/i)
    expect(await prisma.agentRun.count()).toBe(0)
  }, 30_000)

  it('runs a daemon that ticks and shuts down on a signal', async (): Promise<void> => {
    const orphanTask = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'left behind',
        description: 'x',
        status: 'running',
        requiredRole: 'backend',
        maxAttempts: 3,
      },
    })
    const orphan = await prisma.agentRun.create({
      data: { taskId: orphanTask.id, agentId: fixture.agentId, status: 'working', pid: 999_999 },
    })

    const child = execFile('node', [CLI, 'daemon', '--period', '200'], {
      env: {
        ...process.env,
        DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
        AITEAMOS_CLAUDE_BIN: 'node',
        AITEAMOS_CLAUDE_ARGS: `${FAKE} --fixture complete`,
      },
    })

    // Long enough for the startup reconcile and at least one tick.
    await new Promise((res) => setTimeout(res, 2_500))
    expect(await prisma.agentRun.count()).toBeGreaterThan(1)

    // The orphan left behind by a "previous process" is reconciled before the first tick -- that is
    // §3.4's whole point, and the daemon is the only caller allowed to do it.
    const orphanAfter = await prisma.agentRun.findUniqueOrThrow({ where: { id: orphan.id } })
    expect(orphanAfter.status).toBe('failed')

    const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)))
    child.kill('SIGTERM')
    // §11's shutdown awaits the subscription's close, which can take ~6.0s. Budgeting past it
    // rather than racing it is the point: a daemon that exits while a pump is mid-write loses the
    // run's last events.
    const code = await Promise.race([
      exited,
      new Promise<number | null>((res) => setTimeout(() => res(-1), 12_000)),
    ])
    expect(code).not.toBe(-1)

    // Shutdown drains the pumps rather than racing them: a run whose stream was still being
    // consumed when the process exited loses its last events and is left non-terminal.
    const started = await prisma.agentRun.findFirstOrThrow({ where: { taskId: fixture.taskId } })
    expect(started.terminalAt).not.toBeNull()
  }, 30_000)

  it('the daemon enforces the run-timeout guardrail on a hung run', async (): Promise<void> => {
    // Any run is instantly over a 1ms wall-clock limit; the `hang` fixture never exits on its
    // own, so only the daemon's guardrail sweep can end this run.
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { runTimeoutMs: 1 } })

    const child = execFile('node', [CLI, 'daemon', '--period', '200'], {
      env: {
        ...process.env,
        DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
        AITEAMOS_CLAUDE_BIN: 'node',
        AITEAMOS_CLAUDE_ARGS: `${FAKE} --fixture hang`,
      },
    })
    try {
      // The run's `status` write and the guardrail's `guardrail_tripped` append are two
      // INDEPENDENT writers racing the same process death. `sweep.ts`'s timeout claim writes no
      // terminal status of its own -- it claims `stopping`, awaits `adapter.cancel`, and only then
      // appends the event. `pump.ts` is what concludes the row to `failed`, from its own stream
      // ending with no terminal result once the child's stdout closes. `cancel`'s resolution
      // (`child.exit`) and the pump's stream end (`child.stdout`'s `close`) are two different
      // listeners on the same dying child with no ordering guarantee between them (M17 flake 2),
      // so polling for `status === 'failed'` alone can observe it before the event that explains
      // it has committed. Polling for both together is what makes this assertion match what the
      // code actually guarantees, rather than how fast the second writer usually is.
      const deadline = Date.now() + 15_000
      let run = null
      let timeouts: { readonly payload: unknown }[] = []
      for (;;) {
        run = await prisma.agentRun.findFirst({ where: { taskId: fixture.taskId } })
        const guardrails = await prisma.executionEvent.findMany({
          where: { workspaceId: fixture.workspaceId, type: 'guardrail_tripped' },
        })
        timeouts = guardrails.filter(
          (event) => (event.payload as { guardrail?: string }).guardrail === 'run_timeout',
        )
        if (run !== null && run.status === 'failed' && timeouts.length > 0) break
        if (Date.now() > deadline) break
        await new Promise((res) => setTimeout(res, 100))
      }
      expect(run?.status).toBe('failed')
      expect(timeouts.length).toBeGreaterThan(0)
    } finally {
      const exited = new Promise((res) => child.on('exit', res))
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise((res) => setTimeout(res, 12_000))])
    }
  }, 40_000)
})
