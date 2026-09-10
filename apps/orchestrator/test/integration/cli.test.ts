import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createSimulation, loadSimulation, recordDecision, startAutoRun, verifyCredentials } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import type { Candidate, Situation } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
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
        SLAVEOFAI_CLAUDE_BIN: 'node',
        SLAVEOFAI_CLAUDE_ARGS: `${FAKE} --fixture complete`,
        SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
        ...extraEnv,
      },
    })
    return { stdout, stderr, code: 0 }
  } catch (error) {
    const shaped = error as { stdout?: string; stderr?: string; code?: number }
    return { stdout: shaped.stdout ?? '', stderr: shaped.stderr ?? '', code: shaped.code ?? 1 }
  }
}

/**
 * Runs the real built CLI with `input` written to its stdin and then closed -- `create-user` and
 * `set-password` read a password off stdin (`readSecretLine`), and `execFile`/`execFileAsync` has
 * no way to feed a child's stdin at all, so those two commands can only be exercised through
 * `spawn` directly.
 */
async function runCliWithStdin(args: readonly string[], input: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolvePromise) => {
    const child = spawn('node', [CLI, ...args], {
      env: {
        ...process.env,
        DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
        SLAVEOFAI_CLAUDE_BIN: 'node',
        SLAVEOFAI_CLAUDE_ARGS: `${FAKE} --fixture complete`,
        SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
        ...extraEnv,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('close', (code) => {
      resolvePromise({ stdout, stderr, code: code ?? 1 })
    })
    child.stdin.end(input)
  })
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-cli-'))
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
  readonly slaveId: string
  readonly teamId: string
  /** A second, empty team on the same workspace -- kept separate from `fixture.teamId` (which
   *  always has `slaveId` on its roster) so `delete-team` here never touches the slave other
   *  cases in this file depend on. */
  readonly emptyTeamId: string
  readonly repoPath: string
}

const repos: string[] = []

async function seed(overrides: { readonly name?: string } = {}): Promise<Fixture> {
  const repoPath = makeRepo()
  repos.push(repoPath)
  const workspace = await prisma.workspace.create({
    data: { name: overrides.name ?? 'Checkout Platform', repoPath, verifyCommands: ['true'], setupCommands: [] },
  })
  // M12 Task 8: no slave in this file names a model anywhere in the chain, so `resolveRuntime`
  // falls all the way to the workspace default -- which needs a `ProviderConfiguration` row to
  // exist at all, or every dispatch here (the real CLI, `dist/cli.js`) refuses instead of
  // starting the run under test.
  await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const emptyTeam = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Design' } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'backend', runtimeRoles: ['backend'] } })
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
  return { workspaceId: workspace.id, taskId: task.id, slaveId: slave.id, teamId: team.id, emptyTeamId: emptyTeam.id, repoPath }
}

/**
 * Parks `taskId` `blocked` at the review cap, exactly the way `review.ts`'s `dispatchReview`
 * does it when the review retry cap is spent -- the ONE park (spec erratum E5) the Supervisor may
 * unblock routinely. `attempt` stays below `maxAttempts` so `unblock_task` (not
 * `raise_max_attempts`) is the routine candidate.
 */
async function blockOnReviewCap(workspaceId: string, taskId: string): Promise<void> {
  await prisma.task.update({
    where: { id: taskId },
    data: { status: 'blocked', activeRunId: null, attempt: 1, maxAttempts: 3 },
  })
  await appendEvent({
    type: 'guardrail.tripped',
    workspaceId,
    taskId,
    actor: 'system',
    payload: { guardrail: 'review_retry_cap_exhausted', detail: 'review retries exhausted' },
  })
}

/** Parks `taskId` `blocked` for a reason that is NOT the review cap -- `task_blocked_human`, the
 *  park a human's own decision moves, never one the Supervisor may unblock by itself. */
async function blockForHuman(taskId: string): Promise<void> {
  await prisma.task.update({
    where: { id: taskId },
    data: { status: 'blocked', activeRunId: null, attempt: 1, maxAttempts: 3 },
  })
}

describe('the orchestrator CLI', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "SimulationModelUsage", "SimulationJournalEntry", "SimulationRun", "SupervisorDecision", "ExecutionEvent", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate", "User" RESTART IDENTITY CASCADE',
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
    expect(await prisma.slaveRun.count()).toBe(1)
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
    await prisma.slaveRun.create({
      data: { taskId: other.id, slaveId: fixture.slaveId, status: 'working', pid: 999_999 },
    })

    await runCli(['tick'])

    // A CLI `tick` may run alongside a live daemon, and Task 15's orphan pass is startup-only for a
    // reason: a run that is mid-spawn is indistinguishable from one it should fail. Reconciling
    // here would fail runs belonging to a daemon that is very much alive.
    const run = await prisma.slaveRun.findFirstOrThrow({ where: { taskId: other.id } })
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

  it('the replan-status help says the board version is taken over EVERY task (erratum E8)', async (): Promise<void> => {
    const result = await runCli(['help'])

    const printed = `${result.stdout}${result.stderr}`
    // The bug this asserts against: the help promised "the highest version stamped on an
    // unfinished task", which is what `boardVersionOf` did BEFORE erratum E8 -- and a board whose
    // tasks had all finished then had no task to take a max over, its version fell to 0, and every
    // finished project re-planned itself on its next tick. The code counts terminal tasks now; the
    // sentence an operator reads has to say so, or `replan-status`'s own output is unreadable.
    expect(printed).not.toMatch(/unfinished task/)
    expect(printed).toMatch(/the highest version stamped on any task, terminal ones included/)
  })

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

  it('sets a workspace goal and prints the version it wrote with that text\'s sha256', async (): Promise<void> => {
    const result = await runCli(['set-goal', '--workspace', fixture.workspaceId, '--goal', 'x'])

    expect(result.code).toBe(0)
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })
    expect(ws.goal).toBe('x')
    // M40 t4: the version is the number the re-plan trigger counts, so it is printed as JSON a
    // caller can read back rather than buried in a sentence.
    const printed = JSON.parse(result.stdout) as { version: number; sha256: string }
    expect(printed.version).toBe(1)
    expect(printed.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(ws.goalVersion).toBe(1)
  })

  it('exits non-zero with the refusal when set-goal is given the text the goal already reads', async (): Promise<void> => {
    // M40 t4 ruling: only the WEB softens `goal_unchanged` into "no change". Here it is a refusal
    // like every other, so a script can tell "the version moved" from "it did not".
    const first = await runCli(['set-goal', '--workspace', fixture.workspaceId, '--goal', 'ship the checkout redesign'])
    expect(first.code).toBe(0)

    const second = await runCli(['set-goal', '--workspace', fixture.workspaceId, '--goal', 'ship the checkout redesign'])

    expect(second.code).not.toBe(0)
    expect(`${second.stdout}${second.stderr}`).toMatch(/already reads exactly this at version 1/)
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })
    expect(ws.goalVersion).toBe(1)
    expect(await prisma.goalVersion.count({ where: { workspaceId: fixture.workspaceId } })).toBe(1)
  })

  it('prints every goal version newest first, with the diff against the version it replaced', async (): Promise<void> => {
    await runCli(['set-goal', '--workspace', fixture.workspaceId, '--goal', 'ship checkout'])
    await runCli(['set-goal', '--workspace', fixture.workspaceId, '--goal', 'ship checkout\nand the refunds flow'])

    const result = await runCli(['goal-history', '--workspace', fixture.workspaceId])

    expect(result.code).toBe(0)
    const history = JSON.parse(result.stdout) as {
      version: number
      text: string
      sha256: string
      setByUserId: string | null
      createdAt: string
      diff: { added: string[]; removed: string[] } | null
    }[]
    expect(history.map((one) => one.version)).toEqual([2, 1])
    expect(history[0]?.text).toBe('ship checkout\nand the refunds flow')
    expect(history[0]?.diff).toEqual({ added: ['and the refunds flow'], removed: [] })
    // v1 is the requirement's beginning: there is nothing it replaced.
    expect(history[1]?.diff).toBeNull()
    expect(history[1]?.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('exits non-zero for goal-history with no --workspace given', async (): Promise<void> => {
    const result = await runCli(['goal-history'])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/--workspace is required/)
  })

  it('cancels a task off the board with its reason', async (): Promise<void> => {
    const result = await runCli([
      'cancel-task',
      '--task',
      fixture.taskId,
      '--reason',
      'the re-plan for goal v2 no longer needs it',
    ])

    expect(result.code).toBe(0)
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('cancelled')
    expect(task.lastRejectionReason).toBe('the re-plan for goal v2 no longer needs it')
    const events = await prisma.executionEvent.findMany({ where: { taskId: fixture.taskId, type: 'task_cancelled' } })
    expect(events).toHaveLength(1)
    expect(events[0]?.actor).toBe('human')
  })

  it('refuses cancel-task on a task the pipeline is already carrying', async (): Promise<void> => {
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'reviewing' } })

    const result = await runCli(['cancel-task', '--task', fixture.taskId, '--reason', 'no longer needed'])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/only a task in backlog, ready or blocked can be cancelled/)
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('reviewing')
  })

  it('exits non-zero for cancel-task with no --reason given', async (): Promise<void> => {
    const result = await runCli(['cancel-task', '--task', fixture.taskId])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/--reason is required/)
  })

  it('prints the re-plan verdict the next tick would reach', async (): Promise<void> => {
    // The fixture's one task is hand-made (`goalVersion` null, which counts as 0), so the first
    // goal version already moves the board's requirement past what produced it.
    await runCli(['set-goal', '--workspace', fixture.workspaceId, '--goal', 'ship checkout'])

    const result = await runCli(['replan-status', '--workspace', fixture.workspaceId])

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      goalVersion: 1,
      boardVersion: 0,
      boardTaskCount: 1,
      goalMoved: true,
      alreadyReplanned: false,
      livePlanningRun: false,
      failedAttempts: 0,
      retryCap: 2,
      halted: null,
      archived: false,
      willReplan: true,
      blockedBy: null,
      intent: { previousVersion: 0, version: 1 },
    })
  })

  it('says a halted workspace will not re-plan, and names the halt as what is in the way', async (): Promise<void> => {
    // Fix round 1, Important 1: `tick` returns before `dispatchPlanning` while a halt stands, so a
    // verdict that ignored it would promise a re-plan nothing was going to start.
    await runCli(['set-goal', '--workspace', fixture.workspaceId, '--goal', 'ship checkout'])
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { haltedReason: 'emergency stop', haltedAt: new Date() },
    })

    const result = await runCli(['replan-status', '--workspace', fixture.workspaceId])

    expect(result.code).toBe(0)
    const verdict = JSON.parse(result.stdout) as { halted: string | null; willReplan: boolean; blockedBy: string | null; intent: unknown }
    expect(verdict.halted).toBe('emergency stop')
    expect(verdict.willReplan).toBe(false)
    expect(verdict.blockedBy).toBe('halted')
    // The re-plan is still DUE -- a halt delays it, it does not cancel the version's claim on one.
    expect(verdict.intent).toEqual({ previousVersion: 0, version: 1 })
  })

  it('says an archived workspace will not re-plan either', async (): Promise<void> => {
    // M27 §3.3: `tick` returns before the world is even loaded for an archived project.
    await runCli(['set-goal', '--workspace', fixture.workspaceId, '--goal', 'ship checkout'])
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { archivedAt: new Date() } })

    const result = await runCli(['replan-status', '--workspace', fixture.workspaceId])

    expect(result.code).toBe(0)
    const verdict = JSON.parse(result.stdout) as { archived: boolean; willReplan: boolean; blockedBy: string | null }
    expect(verdict.archived).toBe(true)
    expect(verdict.willReplan).toBe(false)
    expect(verdict.blockedBy).toBe('archived')
  })

  it('says a current board will not re-plan', async (): Promise<void> => {
    await runCli(['set-goal', '--workspace', fixture.workspaceId, '--goal', 'ship checkout'])
    await prisma.task.update({ where: { id: fixture.taskId }, data: { goalVersion: 1 } })

    const result = await runCli(['replan-status', '--workspace', fixture.workspaceId])

    expect(result.code).toBe(0)
    const verdict = JSON.parse(result.stdout) as { goalMoved: boolean; willReplan: boolean; boardVersion: number; blockedBy: string | null }
    expect(verdict.boardVersion).toBe(1)
    expect(verdict.goalMoved).toBe(false)
    expect(verdict.willReplan).toBe(false)
    // Nothing is DUE, so nothing is in the way -- a different answer from "something is blocking it".
    expect(verdict.blockedBy).toBeNull()
  })

  it('renders the re-plan prompt with --prompt and records no RunContext row for it', async (): Promise<void> => {
    await runCli(['set-goal', '--workspace', fixture.workspaceId, '--goal', 'ship checkout'])
    await prisma.task.update({ where: { id: fixture.taskId }, data: { goalVersion: 1 } })
    await runCli(['set-goal', '--workspace', fixture.workspaceId, '--goal', 'ship checkout and refunds'])

    const before = await prisma.runContext.count()
    const result = await runCli(['replan-status', '--workspace', fixture.workspaceId, '--prompt'])

    expect(result.code).toBe(0)
    const [verdictText, prompt] = result.stdout.split(`${'-'.repeat(40)}\n`)
    expect((JSON.parse(verdictText ?? '') as { willReplan: boolean }).willReplan).toBe(true)
    // What the re-plan run would be told: the new requirement, the wording it replaced, the board
    // it may act on, and the re-plan instructions the trailer carries.
    expect(prompt).toContain('GOAL: ship checkout and refunds')
    expect(prompt).toContain('THE GOAL CHANGED')
    expect(prompt).toContain('Previous goal (v1):')
    expect(prompt).toContain(fixture.taskId)
    expect(prompt).toContain('replan')
    // R4: a preview starts nothing and records nothing -- the row exists for runs that were given
    // a prompt, and no run was.
    expect(await prisma.runContext.count()).toBe(before)
    expect(await prisma.slaveRun.count({ where: { kind: 'planning' } })).toBe(0)
  })

  it('says there is no prompt to preview when no re-plan is pending', async (): Promise<void> => {
    await runCli(['set-goal', '--workspace', fixture.workspaceId, '--goal', 'ship checkout'])
    await prisma.task.update({ where: { id: fixture.taskId }, data: { goalVersion: 1 } })

    const result = await runCli(['replan-status', '--workspace', fixture.workspaceId, '--prompt'])

    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/no re-plan is pending for goal v1/)
    expect(await prisma.runContext.count()).toBe(0)
  })

  it('exits non-zero for set-goal with no --goal given', async (): Promise<void> => {
    const result = await runCli(['set-goal', '--workspace', fixture.workspaceId])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/--goal is required/)
  })

  it('confirms integration on a done task', async (): Promise<void> => {
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'done', integratedAt: null } })

    const result = await runCli(['confirm-integration', '--task', fixture.taskId])

    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/integrated/)
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.integratedAt).not.toBeNull()
  })

  it('exits non-zero for confirm-integration on a task that is not done yet', async (): Promise<void> => {
    // `fixture.taskId` seeds as `ready` (see `seed` above), not `done`.
    const result = await runCli(['confirm-integration', '--task', fixture.taskId])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/only a done task can be confirmed integrated/)
  })

  it('exits non-zero for confirm-integration with no --task given', async (): Promise<void> => {
    const result = await runCli(['confirm-integration'])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/--task is required/)
  })

  it('unblocks a blocked task back to rework', async (): Promise<void> => {
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'blocked', attempt: 1 } })

    const result = await runCli(['unblock-task', '--task', fixture.taskId])

    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/unblocked/)
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('rework')
    expect(task.attempt).toBe(1)
  })

  /**
   * The state M36 t2's ask path leaves behind, written directly: a run `paused` on
   * `waiting_for_answer` with a checkpoint, a task parked `waiting` and still this run's, and the
   * question it is waiting on. Written rather than produced by a real ask because what is under
   * test here is the CLI verb, not the pump.
   */
  async function seedAWaitingRun(): Promise<{ readonly runId: string; readonly questionId: string }> {
    const run = await prisma.slaveRun.create({
      data: {
        taskId: fixture.taskId,
        slaveId: fixture.slaveId,
        status: 'paused',
        pauseReason: 'waiting_for_answer',
        sessionId: 's-1',
        worktreePath: fixture.repoPath,
      },
    })
    await prisma.checkpoint.create({
      data: {
        runId: run.id,
        sessionId: 's-1',
        worktreePath: fixture.repoPath,
        pauseFlagPath: '/tmp/pause.flag',
        settingsPath: '/tmp/settings.json',
        hookPath: '/tmp/pause-gate.sh',
        gitAuthorName: 'Alex',
        gitAuthorEmail: 'alex@slaveofai.local',
        headCommit: 'a'.repeat(40),
        deniedToolUseIds: [],
        dirtyFiles: [],
      },
    })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'waiting', activeRunId: run.id } })
    const question = await prisma.slaveMessage.create({
      data: {
        slaveId: fixture.slaveId,
        workspaceId: fixture.workspaceId,
        senderRunId: run.id,
        taskId: fixture.taskId,
        recipientRole: 'product',
        threadId: 'thread-1',
        kind: 'question',
        body: 'Which queue should retries land on?',
        actor: 'slave',
        expectsReply: true,
      },
    })
    return { runId: run.id, questionId: question.id }
  }

  it('answers a waiting slave as a human and queues its run to resume', async (): Promise<void> => {
    const { runId, questionId } = await seedAWaitingRun()

    const result = await runCli(['answer', '--message', questionId, '--text', 'payments-retry'])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('queued to resume')
    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })
    expect(run.resumeRequestedAt).not.toBeNull()
    expect(run.queuedMessage).toContain('payments-retry')
    const answered = await prisma.slaveMessage.findFirstOrThrow({ where: { kind: 'answer' } })
    expect(answered.actor).toBe('human')
    expect(answered.replyToId).toBe(questionId)
    expect(answered.deliveredAt).not.toBeNull()
  }, 30_000)

  it('treats a blank --by as no name given rather than writing an empty one', async (): Promise<void> => {
    // M42 t1 fix round 1: `--by ""` used to reach `answeredBy` as the empty string, which the
    // answer row accepted and the `slave.message_sent` schema (`z.string().min(1)`) then rejected
    // -- an `appendEvent` throw AFTER the answer was already written, leaving the CLI non-zero over
    // a row it had successfully saved.
    const { questionId } = await seedAWaitingRun()

    const result = await runCli(['answer', '--message', questionId, '--text', 'payments-retry', '--by', ''])

    expect(result.code).toBe(0)
    const event = await prisma.executionEvent.findFirstOrThrow({ where: { type: 'slave_message_sent' }, orderBy: { seq: 'desc' } })
    expect((event.payload as { answeredBy?: string }).answeredBy).toBe('operator')
  }, 30_000)

  it('answers exactly once when the same answer is given twice', async (): Promise<void> => {
    const { runId, questionId } = await seedAWaitingRun()

    await runCli(['answer', '--message', questionId, '--text', 'payments-retry'])
    const second = await runCli(['answer', '--message', questionId, '--text', 'payments-retry'])

    expect(second.code).toBe(0)
    expect(second.stdout).toContain('nothing was resumed')
    expect(await prisma.slaveMessage.count({ where: { kind: 'answer' } })).toBe(1)
    expect(
      await prisma.executionEvent.count({ where: { runId, type: 'run_resume_requested' } }),
    ).toBe(1)
  }, 30_000)

  it('lists the questions a slave is still waiting on, with the id answer needs', async (): Promise<void> => {
    const { questionId } = await seedAWaitingRun()

    const result = await runCli(['messages'])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain(questionId)
    expect(result.stdout).toContain('Which queue should retries land on?')
  }, 30_000)

  it('says so plainly when nobody is waiting on an answer', async (): Promise<void> => {
    const result = await runCli(['messages'])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('no slave is waiting on an answer')
  }, 30_000)

  it('exits non-zero for answer on a message id nobody wrote', async (): Promise<void> => {
    const result = await runCli(['answer', '--message', '00000000-0000-0000-0000-000000000000', '--text', 'x'])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/no message with id/)
  }, 30_000)

  it('exits non-zero for unblock-task on a task that is not blocked', async (): Promise<void> => {
    // `fixture.taskId` seeds as `ready` (see `seed` above), not `blocked`.
    const result = await runCli(['unblock-task', '--task', fixture.taskId])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/only a blocked task can be unblocked/)
  })

  it('exits non-zero for unblock-task with no --task given', async (): Promise<void> => {
    const result = await runCli(['unblock-task'])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/--task is required/)
  })

  it('exits non-zero for unblock-task on a task at its attempt ceiling with no allowance', async (): Promise<void> => {
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { status: 'blocked', attempt: 3, maxAttempts: 3 },
    })

    const result = await runCli(['unblock-task', '--task', fixture.taskId])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/attempt ceiling/)
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('blocked')
  })

  it('unblocks a task at its attempt ceiling given --allow-another-attempt, raising the ceiling by exactly one', async (): Promise<void> => {
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { status: 'blocked', attempt: 3, maxAttempts: 3 },
    })

    const result = await runCli(['unblock-task', '--task', fixture.taskId, '--allow-another-attempt'])

    expect(result.code).toBe(0)
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('rework')
    expect(task.attempt).toBe(3)
    expect(task.maxAttempts).toBe(4)
  })

  it('creates a template', async (): Promise<void> => {
    const result = await runCli(['create-template', '--name', 'Backend Engineer', '--role', 'backend'])

    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/^template .+ created$/m)
    expect(await prisma.slaveTemplate.count()).toBe(1)
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
    const template = await prisma.slaveTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })
    await prisma.companySlave.create({ data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas' } })

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
      '--slave',
      fixture.slaveId,
      '--model',
      'claude-opus',
      '--provider',
      'claude_code',
    ])

    expect(setResult.code).toBe(0)
    expect(setResult.stdout).toMatch(new RegExp(`^model set to claude-opus on ${fixture.slaveId}$`, 'm'))
    const afterSet = await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId } })
    expect(afterSet.model).toBe('claude-opus')
    expect(afterSet.provider).toBe('claude_code')

    const clearResult = await runCli(['set-model', '--slave', fixture.slaveId, '--clear'])

    expect(clearResult.code).toBe(0)
    expect(clearResult.stdout).toMatch(new RegExp(`^model cleared on ${fixture.slaveId}$`, 'm'))
    const afterClear = await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId } })
    expect(afterClear.model).toBeNull()
    expect(afterClear.provider).toBeNull()
  })

  it('exits non-zero for set-model with neither --model nor --clear given', async (): Promise<void> => {
    const result = await runCli(['set-model', '--slave', fixture.slaveId])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/--model or --clear is required/)
  })

  it('exits non-zero for set-model with --model and no --provider', async (): Promise<void> => {
    const result = await runCli(['set-model', '--slave', fixture.slaveId, '--model', 'claude-opus'])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/a model must name the provider that runs it/)
    const slave = await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId } })
    expect(slave.model).toBeNull()
  })

  it('exits non-zero for set-model against an unknown slave', async (): Promise<void> => {
    const result = await runCli([
      'set-model',
      '--slave',
      'nope',
      '--model',
      'claude-opus',
      '--provider',
      'claude_code',
    ])

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/no slave with id nope/)
  })

  it('exits non-zero for set-model with an empty --model', async (): Promise<void> => {
    const result = await runCli([
      'set-model',
      '--slave',
      fixture.slaveId,
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
    await prisma.slaveRun.create({
      data: {
        taskId: fixture.taskId,
        slaveId: fixture.slaveId,
        status: 'working',
        pid: process.pid,
        worktreePath: join(fixture.repoPath, '.slaveofai', 'worktrees', 'T-abcdef12'),
      },
    })
    await prisma.slaveRun.create({
      data: {
        taskId: fixture.taskId,
        slaveId: fixture.slaveId,
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
    expect(status.runs[0]?.worktreePath).toContain('.slaveofai')
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
    await seed({ name: 'Other Workspace' })

    const result = await runCli(['status'])

    // One workspace makes omitting `--workspace` unambiguous; two make it a guess. Guessing here
    // means an operator reads one workspace's runs believing they are another's.
    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/--workspace/)
  }, 30_000)

  it('cancels a run and preserves its worktree', async (): Promise<void> => {
    await runCli(['tick'])
    const run = await prisma.slaveRun.findFirstOrThrow()

    const result = await runCli(['cancel', '--run', run.id])

    expect(result.code).toBe(0)
  }, 30_000)

  it('waits for the run it started before exiting', async (): Promise<void> => {
    await runCli(['tick'])

    // The tick *function* deliberately does not await its pump -- a daemon's pumps outlive each
    // tick. A one-shot command's process is about to exit, and exiting would leave a live slave
    // with nobody reading its stream: every event from that moment lost, and the run left for the
    // orphan pass to fail on some later startup.
    const run = await prisma.slaveRun.findFirstOrThrow()
    expect(['succeeded', 'failed']).toContain(run.status)
    expect(run.terminalAt).not.toBeNull()
  }, 30_000)

  it('names the run it could not find', async (): Promise<void> => {
    const result = await runCli(['pause', '--run', 'nope'])

    expect(`${result.stdout}${result.stderr}`).toMatch(/no run with id nope/)
  }, 30_000)

  it('arms the gate and records who asked', async (): Promise<void> => {
    const run = await prisma.slaveRun.create({
      data: { taskId: fixture.taskId, slaveId: fixture.slaveId, status: 'working', pid: process.pid },
    })

    const result = await runCli(['pause', '--run', run.id, '--by', 'meren'])

    expect(result.code).toBe(0)
    // The flag file is the whole mechanism: the gate reads it and denies the next tool call. A
    // separate process cannot follow the rest of the protocol -- it has no handle on the child and
    // no view of its stream -- so writing the flag is the half it can perform, and the daemon's
    // pump observes the deny.
    expect(existsSync(join(fixture.repoPath, '.slaveofai', 'runs', run.id, 'pause.flag'))).toBe(true)

    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('pause_requested')
    // The *category*, which this is the only place that knows: an operator asked. Task 12 carried
    // it forward as a column nothing ever wrote.
    expect(after.pauseReason).toBe('human')
  }, 30_000)

  it('actually kills the process it cancels', async (): Promise<void> => {
    const sleeper = spawn('/bin/sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' })
    const pid = sleeper.pid ?? 0
    const run = await prisma.slaveRun.create({
      data: { taskId: fixture.taskId, slaveId: fixture.slaveId, status: 'working', pid },
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
    const other = await seed({ name: 'Other Workspace' })
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
    const other = await seed({ name: 'Other Workspace' })
    await prisma.slaveRun.create({
      data: { taskId: other.taskId, slaveId: other.slaveId, status: 'working', pid: process.pid },
    })
    await prisma.slaveRun.create({
      data: { taskId: fixture.taskId, slaveId: fixture.slaveId, status: 'working', pid: process.pid },
    })

    const result = await runCli(['status', '--workspace', fixture.workspaceId])

    const status = JSON.parse(result.stdout) as { runs: readonly { id: string }[] }
    expect(status.runs).toHaveLength(1)
  }, 30_000)

  it('accepts the --flag=value form rather than silently ignoring it', async (): Promise<void> => {
    await seed({ name: 'Other Workspace' })

    const result = await runCli(['status', `--workspace=${fixture.workspaceId}`])

    // Dropping the `=` form means the command runs against whichever workspace happens to be the
    // only one -- the exact mistake the workspace check exists to prevent, arriving through the
    // parser instead.
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ halt: null })
  }, 30_000)

  it('records the operator name it was given, even one that looks like a flag', async (): Promise<void> => {
    const run = await prisma.slaveRun.create({
      data: { taskId: fixture.taskId, slaveId: fixture.slaveId, status: 'working', pid: process.pid },
    })

    await runCli(['pause', '--run', run.id, '--by', '--urgent-oncall'])

    const event = await prisma.executionEvent.findFirstOrThrow({
      where: { runId: run.id, type: 'run_pause_requested' },
    })
    expect((event.payload as { requestedBy: string }).requestedBy).toBe('--urgent-oncall')
  }, 30_000)

  it('refuses to pause a run that has already finished', async (): Promise<void> => {
    const run = await prisma.slaveRun.create({
      data: {
        taskId: fixture.taskId,
        slaveId: fixture.slaveId,
        status: 'succeeded',
        terminalAt: new Date(),
        endedAt: new Date(),
      },
    })

    const result = await runCli(['pause', '--run', run.id])

    // `pause_requested` is non-terminal, so pausing a finished run puts it back into `activeRuns`,
    // makes its slave look busy, and leaves the next restart's orphan sweep to flip a run that
    // actually succeeded to `failed`.
    expect(result.code).not.toBe(0)
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('succeeded')
  }, 30_000)

  it('refuses to resume a run that is not paused', async (): Promise<void> => {
    const run = await prisma.slaveRun.create({
      data: {
        taskId: fixture.taskId,
        slaveId: fixture.slaveId,
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
        gitAuthorEmail: 'alex@slaveofai.local',
        headCommit: 'deadbeef',
      },
    })

    const result = await runCli(['resume', '--run', run.id])

    // Against a live daemon this is two slaves on one branch, with the pid that could have killed
    // the first overwritten by the second. The adapter's live-child guard cannot help: a CLI
    // invocation is always the cross-process case its registry is empty for.
    expect(result.code).not.toBe(0)
    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('succeeded')
    expect(await prisma.executionEvent.count({ where: { runId: run.id, type: 'run_resumed' } })).toBe(0)
  }, 30_000)

  it('refuses to resume into a halted workspace', async (): Promise<void> => {
    const run = await prisma.slaveRun.create({
      data: { taskId: fixture.taskId, slaveId: fixture.slaveId, status: 'paused' },
    })
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { haltedReason: 'the pause gate failed open', haltedAt: new Date() },
    })

    const result = await runCli(['resume', '--run', run.id])

    // A halt is raised by a gate failure, so resuming into one relaunches a slave whose gate may
    // still be broken -- the recurrence §13.1 exists to bound. The help text promises this.
    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/clear-halt/)
  }, 30_000)

  it('resumes a paused run in its own worktree, session and identity', async (): Promise<void> => {
    // A real pause, produced by the gate denying the fake CLI's first tool call.
    await runCli(['tick'], { SLAVEOFAI_CLAUDE_ARGS: `${FAKE} --fixture hook-deny` })
    const paused = await prisma.slaveRun.findFirstOrThrow()
    expect(paused.status).toBe('paused')
    const checkpoint = await prisma.checkpoint.findUniqueOrThrow({ where: { runId: paused.id } })

    // `complete` rather than `env-echo`: the resumed run has to emit a `system/init` line for the
    // "does it announce itself as started again" assertion below to reach the code at all, and
    // env-echo emits none. A test that cannot reach the branch it names proves nothing about it.
    const result = await runCli(['resume', '--run', paused.id, '--message', 'try the other approach'], {
      SLAVEOFAI_CLAUDE_ARGS: `${FAKE} --fixture complete`,
      SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
    })

    expect(result.code).toBe(0)
    expect(await prisma.executionEvent.count({ where: { runId: paused.id, type: 'run_resumed' } })).toBe(1)
    // Task 12's carry: the stream cannot tell a continuation from a first spawn, so without telling
    // the pump, a resumed run emits a second `run.started` -- an illegal transition from `working`
    // for anything replaying the log through the domain's state machine.
    expect(await prisma.executionEvent.count({ where: { runId: paused.id, type: 'run_started' } })).toBe(1)
    expect(checkpoint.worktreePath).toContain('.slaveofai')
    expect(checkpoint.gitAuthorEmail).toContain('@slaveofai.local')
  }, 60_000)

  it('does not hand a cancelled task straight back to a new slave', async (): Promise<void> => {
    await runCli(['tick'])
    const run = await prisma.slaveRun.findFirstOrThrow()
    await prisma.slaveRun.update({
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
    // startable means the next tick hands it to a fresh slave on the same worktree -- and since
    // cancelling does not count an attempt, repeated cancels never reach the cap.
    expect(JSON.parse(report.stdout)).toMatchObject({ started: [] })
    expect((await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).status).toBe('blocked')
    // The Supervisor runs at the end of that same tick and does not undo the park (erratum E5):
    // `cancel` is a person's decision, so `task_blocked_human`'s unblock is a PROPOSAL waiting on a
    // human, not an action. Without E5 the task was back in `rework` here and the next tick handed
    // it to a fresh slave -- and since cancelling costs no attempt, that could repeat forever.
    const decisions = await prisma.supervisorDecision.findMany({ where: { workspaceId: fixture.workspaceId } })
    expect(decisions.length).toBeGreaterThan(0)
    expect(decisions.every((row) => row.status === 'pending' && row.tier !== 'applied')).toBe(true)
  }, 60_000)

  it('defaults to help rather than to doing something', async (): Promise<void> => {
    const result = await runCli([])

    // A bare invocation that silently ran a tick would start a slave for an operator who typed
    // the command name to see what it does.
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/usage/i)
    expect(await prisma.slaveRun.count()).toBe(0)
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
    const orphan = await prisma.slaveRun.create({
      data: { taskId: orphanTask.id, slaveId: fixture.slaveId, status: 'working', pid: 999_999 },
    })

    const child = execFile('node', [CLI, 'daemon', '--period', '200'], {
      env: {
        ...process.env,
        DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
        SLAVEOFAI_CLAUDE_BIN: 'node',
        SLAVEOFAI_CLAUDE_ARGS: `${FAKE} --fixture complete`,
        SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
      },
    })

    // Long enough for the startup reconcile and at least one tick.
    await new Promise((res) => setTimeout(res, 2_500))
    expect(await prisma.slaveRun.count()).toBeGreaterThan(1)

    // The orphan left behind by a "previous process" is reconciled before the first tick -- that is
    // §3.4's whole point, and the daemon is the only caller allowed to do it.
    const orphanAfter = await prisma.slaveRun.findUniqueOrThrow({ where: { id: orphan.id } })
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
    const started = await prisma.slaveRun.findFirstOrThrow({ where: { taskId: fixture.taskId } })
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
        SLAVEOFAI_CLAUDE_BIN: 'node',
        SLAVEOFAI_CLAUDE_ARGS: `${FAKE} --fixture hang`,
        SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
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
        run = await prisma.slaveRun.findFirst({ where: { taskId: fixture.taskId } })
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

  // M37 t3: the three verbs that put a profile, a runtime role set and a run's recorded context
  // on the command line. Real subprocess, like everything else in this file.
  describe('profiles, runtime roles and run context (M37 t3)', () => {
    it('sets a slave profile from a file and clears it again', async (): Promise<void> => {
      const file = join(mkdtempSync(join(tmpdir(), 'slaveofai-profile-')), 'persona.md')
      writeFileSync(file, '# Maya\n\nYou are careful with payments.\n')

      const set = await runCli(['set-profile', '--slave', fixture.slaveId, '--file', file])
      expect(set.code).toBe(0)
      expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId } })).profile).toBe(
        '# Maya\n\nYou are careful with payments.',
      )

      const cleared = await runCli(['set-profile', '--slave', fixture.slaveId, '--clear'])
      expect(cleared.code).toBe(0)
      expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId } })).profile).toBeNull()
    }, 30_000)

    it('sets a template and a catalog slave profile too', async (): Promise<void> => {
      const template = await prisma.slaveTemplate.create({ data: { name: 'Engineer', role: 'backend' } })
      const company = await prisma.company.create({ data: { name: 'Acme' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
      const companySlave = await prisma.companySlave.create({
        data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Maya' },
      })
      const file = join(mkdtempSync(join(tmpdir(), 'slaveofai-profile-')), 'persona.md')
      writeFileSync(file, 'catalog persona')

      expect((await runCli(['set-profile', '--template', template.id, '--file', file])).code).toBe(0)
      expect((await runCli(['set-profile', '--company-slave', companySlave.id, '--file', file])).code).toBe(0)
      expect((await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: template.id } })).profile).toBe('catalog persona')
      expect((await prisma.companySlave.findUniqueOrThrow({ where: { id: companySlave.id } })).profile).toBe('catalog persona')
    }, 30_000)

    it('exits non-zero for an unknown slave, and for neither --file nor --clear', async (): Promise<void> => {
      const file = join(mkdtempSync(join(tmpdir(), 'slaveofai-profile-')), 'persona.md')
      writeFileSync(file, 'text')
      const unknown = await runCli(['set-profile', '--slave', 'nope', '--file', file])
      expect(unknown.code).not.toBe(0)
      expect(unknown.stderr).toContain('nope')

      const neither = await runCli(['set-profile', '--slave', fixture.slaveId])
      expect(neither.code).not.toBe(0)
    }, 30_000)

    it('sets runtime roles, and an empty --roles parks the slave', async (): Promise<void> => {
      const set = await runCli(['set-runtime-roles', '--slave', fixture.slaveId, '--roles', 'backend, reviewer'])
      expect(set.code).toBe(0)
      expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId } })).runtimeRoles).toEqual([
        'backend',
        'reviewer',
      ])

      const parked = await runCli(['set-runtime-roles', '--slave', fixture.slaveId, '--roles', ''])
      expect(parked.code).toBe(0)
      expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId } })).runtimeRoles).toEqual([])

      // And the parked slave is genuinely undispatchable: a tick starts nothing for it.
      expect((await runCli(['tick'])).code).toBe(0)
      expect(await prisma.slaveRun.count()).toBe(0)
    }, 60_000)

    it('exits non-zero for a duplicated runtime role', async (): Promise<void> => {
      const result = await runCli(['set-runtime-roles', '--slave', fixture.slaveId, '--roles', 'backend,backend'])
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain('backend')
      expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId } })).runtimeRoles).toEqual(['backend'])
    }, 30_000)

    it('prints a run context manifest, and its prompt after a rule with --prompt', async (): Promise<void> => {
      const run = await prisma.slaveRun.create({
        data: { taskId: fixture.taskId, slaveId: fixture.slaveId, status: 'succeeded' },
      })
      await prisma.runContext.create({
        data: {
          runId: run.id,
          prompt: 'THE PROMPT THE MODEL SAW',
          // M40 t1: the `task` source carries the sha256 of the task text the run saw.
          sections: {
            kind: 'implementation',
            sections: [{ kind: 'task', taskId: fixture.taskId, sha256: 'd'.repeat(64) }],
          },
        },
      })

      const bare = await runCli(['show-context', '--run', run.id])
      expect(bare.code).toBe(0)
      expect(JSON.parse(bare.stdout)).toEqual({
        kind: 'implementation',
        sections: [{ kind: 'task', taskId: fixture.taskId, sha256: 'd'.repeat(64) }],
      })
      expect(bare.stdout).not.toContain('THE PROMPT THE MODEL SAW')

      const withPrompt = await runCli(['show-context', '--run', run.id, '--prompt'])
      expect(withPrompt.code).toBe(0)
      expect(withPrompt.stdout).toContain('-'.repeat(40))
      expect(withPrompt.stdout).toContain('THE PROMPT THE MODEL SAW')
    }, 30_000)

    it('exits non-zero for a run with no recorded context', async (): Promise<void> => {
      const run = await prisma.slaveRun.create({
        data: { taskId: fixture.taskId, slaveId: fixture.slaveId, status: 'succeeded' },
      })
      const result = await runCli(['show-context', '--run', run.id])
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain(run.id)
    }, 30_000)
  })

  describe('create-workspace', () => {
    it('creates a workspace from a real repo and prints its id', async () => {
      const dir = makeRepo()
      const result = await runCli([
        'create-workspace',
        '--name',
        'Billing',
        '--repo',
        dir,
        '--verify',
        'npm test',
        '--verify',
        'npm run lint',
        '--setup',
        'npm ci',
        '--budget',
        '7',
        '--provider',
        'claude_code',
      ])
      expect(result.code).toBe(0)
      const id = /^workspace (\S+) created$/m.exec(result.stdout)?.[1]
      expect(id).toBeDefined()
      if (id === undefined) throw new Error('unreachable: asserted above')
      const row = await prisma.workspace.findUniqueOrThrow({ where: { id } })
      expect(row).toMatchObject({
        name: 'Billing',
        repoPath: dir,
        verifyCommands: ['npm test', 'npm run lint'],
        setupCommands: ['npm ci'],
        budgetUsd: 7,
      })
    })

    it('refuses a relative path with the refusal text and exit 1', async () => {
      const result = await runCli(['create-workspace', '--name', 'Billing', '--repo', 'repo', '--verify', 'npm test'])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('the repository path must be absolute')
    })

    it('requires --verify', async () => {
      const result = await runCli(['create-workspace', '--name', 'Billing', '--repo', makeRepo()])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('at least one verify command is required')
    })

    it('--no-budget stores null', async () => {
      const result = await runCli(['create-workspace', '--name', 'Free', '--repo', makeRepo(), '--verify', 'true', '--no-budget'])
      expect(result.code).toBe(0)
      expect((await prisma.workspace.findFirstOrThrow({ where: { name: 'Free' } })).budgetUsd).toBeNull()
    })
  })

  // M23 D2: the CLI surfaces for the five roster-editing verbs (`packages/control/src/org.ts`).
  describe('roster editing', () => {
    it('renames a slave', async () => {
      const result = await runCli(['rename-slave', '--slave', fixture.slaveId, '--name', 'Jordan'])

      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(new RegExp(`^slave ${fixture.slaveId} renamed$`, 'm'))
      expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId } })).name).toBe('Jordan')
    })

    it("sets a slave's title, and says it is not what the slave is dispatched as (M37 t3)", async () => {
      const result = await runCli(['set-role', '--slave', fixture.slaveId, '--role', 'frontend'])

      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(new RegExp(`^title set to frontend on ${fixture.slaveId} `, 'm'))
      expect(result.stdout).toContain('set-runtime-roles')
      expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId } })).role).toBe('frontend')
      // And it left the dispatch set alone: `role` is the heading now, nothing more.
      expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId } })).runtimeRoles).toEqual([
        'backend',
      ])
    })

    it('deletes a slave with --yes', async () => {
      const result = await runCli(['delete-slave', '--slave', fixture.slaveId, '--yes'])

      expect(result.code).toBe(0)
      expect(result.stdout).toContain(`slave ${fixture.slaveId} deleted; 0 runs went with it`)
      expect(await prisma.slave.findUnique({ where: { id: fixture.slaveId } })).toBeNull()
    })

    it('refuses to delete a slave without --yes, naming the footprint it would have deleted', async () => {
      const result = await runCli(['delete-slave', '--slave', fixture.slaveId])

      expect(result.code).toBe(1)
      expect(result.stderr).toContain(`refusing without --yes: this would delete slave Alex (${fixture.slaveId}) and 0 runs`)
      expect(await prisma.slave.findUnique({ where: { id: fixture.slaveId } })).not.toBeNull()
    })

    it('deletes a slave WITH its terminal run history with --yes', async () => {
      const task = await prisma.task.create({
        data: {
          workspaceId: fixture.workspaceId,
          title: 'Ship it',
          description: 'ship it',
          maxAttempts: 3,
        },
      })
      await prisma.slaveRun.create({ data: { taskId: task.id, slaveId: fixture.slaveId, status: 'succeeded' } })

      const result = await runCli(['delete-slave', '--slave', fixture.slaveId, '--yes'])

      expect(result.code).toBe(0)
      expect(result.stdout).toContain(`slave ${fixture.slaveId} deleted; 1 run went with it`)
      expect(await prisma.slave.findUnique({ where: { id: fixture.slaveId } })).toBeNull()
      expect(await prisma.slaveRun.count({ where: { slaveId: fixture.slaveId } })).toBe(0)
    })

    it('renames a team', async () => {
      const result = await runCli(['rename-team', '--team', fixture.teamId, '--name', 'Platform'])

      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(new RegExp(`^department ${fixture.teamId} renamed$`, 'm'))
      expect((await prisma.team.findUniqueOrThrow({ where: { id: fixture.teamId } })).name).toBe('Platform')
    })

    it('deletes an empty team with --yes', async () => {
      const result = await runCli(['delete-team', '--team', fixture.emptyTeamId, '--yes'])

      expect(result.code).toBe(0)
      expect(result.stdout).toContain(`department ${fixture.emptyTeamId} deleted; 0 slaves and 0 runs went with it`)
      expect(await prisma.team.findUnique({ where: { id: fixture.emptyTeamId } })).toBeNull()
    })

    it('refuses to delete a team without --yes, naming the footprint it would have deleted', async () => {
      const result = await runCli(['delete-team', '--team', fixture.emptyTeamId])

      expect(result.code).toBe(1)
      expect(result.stderr).toContain(`refusing without --yes: this would delete department Design (${fixture.emptyTeamId}) and 0 slaves, 0 runs`)
      expect(await prisma.team.findUnique({ where: { id: fixture.emptyTeamId } })).not.toBeNull()
    })
  })

  // M27 §3.5/§5.2: the six CLI verbs this milestone added, none of which had a case here (final
  // review, Important 4). Each asserts the preview text a bare invocation prints (the deletes) or
  // the success line (archive/restore/list), plus the database state after `--yes` — the shape the
  // `delete-slave`/`delete-team` cases above already use.
  describe('archive, restore and the catalog deletes', () => {
    interface Catalog {
      readonly companyId: string
      readonly companyTeamId: string
      readonly companySlaveId: string
      readonly templateId: string
    }

    /** One company, one department template, one catalog slave on one slave template — with the
     *  project's own slave linked to that catalog slave, so the previews have a copy to count and
     *  the deletes have a `SetNull` survivor to leave behind. */
    async function seedCatalog(): Promise<Catalog> {
      const template = await prisma.slaveTemplate.create({ data: { name: 'Backend Developer', role: 'backend', description: '' } })
      const company = await prisma.company.create({ data: { name: 'Atlas Software' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Backend' } })
      const companySlave = await prisma.companySlave.create({
        data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Sam' },
      })
      await prisma.slave.update({ where: { id: fixture.slaveId }, data: { companySlaveId: companySlave.id } })
      await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { companyId: company.id } })
      return { companyId: company.id, companyTeamId: companyTeam.id, companySlaveId: companySlave.id, templateId: template.id }
    }

    it('archives a project, naming what stays, and status carries the date inside its JSON', async () => {
      const result = await runCli(['archive-workspace', '--workspace', fixture.workspaceId])

      expect(result.code).toBe(0)
      expect(result.stdout).toContain(
        `project ${fixture.workspaceId} archived: 2 departments, 1 slave, 1 task, 0 runs stay on record`,
      )
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })).archivedAt).not.toBeNull()

      // Final review, minor 6: `archived` rides INSIDE the JSON document. It used to be printed as
      // a bare line ahead of it, which made `status` unparseable for exactly the projects it was
      // added to describe — including for the two `JSON.parse(stdout)` cases in this file.
      // Named explicitly: `resolveWorkspace`'s auto-pick deliberately ignores archived projects
      // (§3.3), so the only way to ask `status` about one is to say which one.
      const status = await runCli(['status', '--workspace', fixture.workspaceId])
      expect(status.code).toBe(0)
      const parsed = JSON.parse(status.stdout) as { archived: string | null; runs: readonly unknown[] }
      expect(parsed.archived).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }, 30_000)

    it('refuses to archive while a run is live, calling it a project rather than a workspace', async () => {
      await prisma.slaveRun.create({ data: { taskId: fixture.taskId, slaveId: fixture.slaveId, status: 'working' } })

      const result = await runCli(['archive-workspace', '--workspace', fixture.workspaceId])

      expect(result.code).toBe(1)
      expect(result.stderr).toContain(`project ${fixture.workspaceId} has 1 live run;`)
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })).archivedAt).toBeNull()
    }, 30_000)

    it('restores an archived project, and status reports it unarchived', async () => {
      await runCli(['archive-workspace', '--workspace', fixture.workspaceId])

      const result = await runCli(['restore-workspace', '--workspace', fixture.workspaceId])

      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(new RegExp(`^project ${fixture.workspaceId} restored$`, 'm'))
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })).archivedAt).toBeNull()
      const parsed = JSON.parse((await runCli(['status', '--workspace', fixture.workspaceId])).stdout) as { archived: string | null }
      expect(parsed.archived).toBeNull()
    }, 30_000)

    it('lists every project and marks the archived ones', async () => {
      await seed({ name: 'Billing' })
      await runCli(['archive-workspace', '--workspace', fixture.workspaceId])

      const result = await runCli(['list-workspaces'])

      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(/^\S+ {2}Billing$/m)
      expect(result.stdout).toMatch(new RegExp(`^${fixture.workspaceId} {2}Checkout Platform {2}\\(archived \\S+\\)$`, 'm'))
    }, 30_000)

    it('delete-company names its templates and catalog slaves without --yes, and detaches the project with it', async () => {
      const catalog = await seedCatalog()

      const preview = await runCli(['delete-company', '--company', catalog.companyId])
      expect(preview.code).toBe(1)
      expect(preview.stderr).toContain(
        `refusing without --yes: this would delete company Atlas Software (${catalog.companyId}) and 1 department template, 1 catalog slave`,
      )
      expect(await prisma.company.count()).toBe(1)

      const result = await runCli(['delete-company', '--company', catalog.companyId, '--yes'])
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(
        `company ${catalog.companyId} deleted; 1 department template and 1 catalog slave went with it, 1 project detached`,
      )
      expect(await prisma.company.count()).toBe(0)
      expect(await prisma.companyTeam.count()).toBe(0)
      expect(await prisma.companySlave.count()).toBe(0)
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })).companyId).toBeNull()
      // The project's own rows are untouched by a catalog delete — that is the whole contract.
      expect(await prisma.slave.count({ where: { id: fixture.slaveId } })).toBe(1)
    }, 30_000)

    it('delete-company-slave prints how many project copies stay, then leaves them behind', async () => {
      const catalog = await seedCatalog()

      const preview = await runCli(['delete-company-slave', '--slave', catalog.companySlaveId])
      expect(preview.code).toBe(1)
      expect(preview.stderr).toContain(
        `refusing without --yes: this would delete catalog slave Sam (${catalog.companySlaveId}); 1 project copy stays`,
      )
      expect(await prisma.companySlave.count()).toBe(1)

      const result = await runCli(['delete-company-slave', '--slave', catalog.companySlaveId, '--yes'])
      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(new RegExp(`^catalog slave ${catalog.companySlaveId} deleted$`, 'm'))
      expect(await prisma.companySlave.findUnique({ where: { id: catalog.companySlaveId } })).toBeNull()
      expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId } })).companySlaveId).toBeNull()
    }, 30_000)

    it('delete-template names its catalog slaves without --yes, and takes them with it', async () => {
      const catalog = await seedCatalog()

      const preview = await runCli(['delete-template', '--template', catalog.templateId])
      expect(preview.code).toBe(1)
      expect(preview.stderr).toContain(
        `refusing without --yes: this would delete template Backend Developer (${catalog.templateId}) and 1 catalog slave`,
      )
      expect(await prisma.slaveTemplate.count()).toBe(1)

      const result = await runCli(['delete-template', '--template', catalog.templateId, '--yes'])
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(`template ${catalog.templateId} deleted; 1 catalog slave went with it`)
      expect(await prisma.slaveTemplate.count()).toBe(0)
      expect(await prisma.companySlave.count()).toBe(0)
      // The project slave keeps the role the template gave it.
      expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId } })).role).toBe('backend')
    }, 30_000)
  })

  // M23 F3: the CLI surfaces for the local-account verbs (`packages/control/src/users.ts`). The
  // password never appears on the command line -- it comes in over stdin, so these cases go
  // through `runCliWithStdin` rather than `runCli`.
  describe('users', () => {
    it('creates a user with the password read from stdin', async () => {
      const result = await runCliWithStdin(['create-user', '--name', 'ada'], 'a reasonably long passphrase\n')

      expect(result.code).toBe(0)
      const id = /^user (\S+) created$/m.exec(result.stdout)?.[1]
      expect(id).toBeDefined()
      const row = await prisma.user.findUniqueOrThrow({ where: { username: 'ada' } })
      expect(row.id).toBe(id)
      expect(row.passwordHash.startsWith('pbkdf2-sha256$')).toBe(true)
    })

    it('only reads the first line of stdin as the password', async () => {
      const result = await runCliWithStdin(['create-user', '--name', 'ada'], 'first line password\nsecond line garbage\n')

      expect(result.code).toBe(0)
      expect(await verifyCredentials('ada', 'first line password')).not.toBeNull()
    })

    it('refuses an empty password with the stdin-usage error, creating nothing', async () => {
      const result = await runCliWithStdin(['create-user', '--name', 'ada'], '')

      expect(result.code).toBe(1)
      expect(result.stderr).toContain(
        'the password is read from stdin: printf "%s\\n" "$PW" | orchestrator create-user --name ada',
      )
      expect(await prisma.user.findUnique({ where: { username: 'ada' } })).toBeNull()
    })

    it('passes a real refusal through refusalText -- invalid_username', async () => {
      const result = await runCliWithStdin(['create-user', '--name', 'Ada!'], 'a reasonably long passphrase\n')

      expect(result.code).toBe(1)
      expect(result.stderr).toContain(
        'a username is 2–32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit',
      )
    })

    it('sets a new password, which then verifies and the old one does not', async () => {
      await runCliWithStdin(['create-user', '--name', 'ada'], 'the original passphrase\n')

      const result = await runCliWithStdin(['set-password', '--name', 'ada'], 'a brand new passphrase\n')

      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(/^password set for ada$/m)
      expect(await verifyCredentials('ada', 'the original passphrase')).toBeNull()
      expect(await verifyCredentials('ada', 'a brand new passphrase')).not.toBeNull()
    })

    it('refuses set-password for an unknown user', async () => {
      const result = await runCliWithStdin(['set-password', '--name', 'nobody'], 'a reasonably long passphrase\n')

      expect(result.code).toBe(1)
      expect(result.stderr).toContain('no user named nobody')
    })

    it('deletes a user with --yes', async () => {
      await runCliWithStdin(['create-user', '--name', 'ada'], 'a reasonably long passphrase\n')

      const result = await runCli(['delete-user', '--name', 'ada', '--yes'])

      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(/^user ada deleted$/m)
      expect(await prisma.user.findUnique({ where: { username: 'ada' } })).toBeNull()
    })

    it('refuses to delete a user without --yes', async () => {
      await runCliWithStdin(['create-user', '--name', 'ada'], 'a reasonably long passphrase\n')

      const result = await runCli(['delete-user', '--name', 'ada'])

      expect(result.code).toBe(1)
      expect(result.stderr).toContain('refusing without --yes: this would delete user ada')
      expect(await prisma.user.findUnique({ where: { username: 'ada' } })).not.toBeNull()
    })

    it('lists users ordered by username, one per line as "username  createdAt"', async () => {
      await runCliWithStdin(['create-user', '--name', 'zoe'], 'a reasonably long passphrase\n')
      await runCliWithStdin(['create-user', '--name', 'ada'], 'a reasonably long passphrase\n')

      const result = await runCli(['list-users'])

      expect(result.code).toBe(0)
      const lines = result.stdout.trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatch(/^ada {2}\S+/)
      expect(lines[1]).toMatch(/^zoe {2}\S+/)
    })

    it('lists nothing for an empty table', async () => {
      const result = await runCli(['list-users'])

      expect(result.code).toBe(0)
      expect(result.stdout.trim()).toBe('')
    })
  })

  describe('simulations', () => {
    async function tradingCompany(): Promise<string> {
      const template = await prisma.slaveTemplate.create({ data: { name: 'Trade Clerk', role: 'clerk' } })
      const company = await prisma.company.create({ data: { name: 'Demo Trading Co.' } })
      for (const [department, slave] of [['Sales', 'Sonia'], ['Purchasing', 'Pete'], ['Operations', 'Olga'], ['Finance', 'Fin']] as const) {
        const team = await prisma.companyTeam.create({ data: { companyId: company.id, name: department } })
        await prisma.companySlave.create({ data: { companyTeamId: team.id, templateId: template.id, name: slave } })
      }
      return company.id
    }
    /** A roster the software sector can staff (design §3.2): a Product slave, a Management slave,
     *  a dedicated reviewer and two more Engineering slaves. The catalog ROLE (on the template, not
     *  the roster row) is where the sector reads an engineer's expertise from. */
    async function softwareCompany(): Promise<string> {
      const company = await prisma.company.create({ data: { name: 'Checkout Platform' } })
      const members = [
        { name: 'John', department: 'Product', role: 'Business Analyst' },
        { name: 'Atlas', department: 'Management', role: 'manager' },
        { name: 'Riley', department: 'Engineering', role: 'reviewer' },
        { name: 'Alex', department: 'Engineering', role: 'Backend' },
        { name: 'Emma', department: 'Engineering', role: 'Frontend' },
      ] as const
      const teams = new Map<string, string>()
      for (const member of members) {
        let teamId = teams.get(member.department)
        if (teamId === undefined) {
          const team = await prisma.companyTeam.create({ data: { companyId: company.id, name: member.department } })
          teamId = team.id
          teams.set(member.department, teamId)
        }
        const template = await prisma.slaveTemplate.create({ data: { name: `Checkout ${member.role}`, role: member.role } })
        await prisma.companySlave.create({ data: { companyTeamId: teamId, templateId: template.id, name: member.name } })
      }
      return company.id
    }
    it('creates, steps and reports a simulation; the status is JSON with the two money figures apart', async () => {
      const companyId = await tradingCompany()
      const created = await runCli(['create-simulation', '--sector', 'trade', '--company', companyId, '--name', 'cli demo', '--policy', 'B'])
      expect(created.code).toBe(0)
      const id = /simulation (\S+) created/.exec(created.stdout)?.[1] ?? ''
      expect(id).not.toBe('')
      const stepped = await runCli(['step-simulation', '--simulation', id, '--until-day', '30'])
      expect(stepped.code).toBe(0)
      expect(stepped.stdout).toContain(`simulation ${id} at day 30 (finished), version 1`)
      const status = await runCli(['simulation-status', '--simulation', id])
      expect(status.code).toBe(0)
      const parsed = JSON.parse(status.stdout) as { summary: { status: string; synthetic: boolean; decisionProvider: string }; headline: { label: string; value: number }[]; modelUsage: { spentUsd: number | null } }
      expect(parsed.summary).toMatchObject({ status: 'finished', synthetic: true, decisionProvider: 'rules' })
      // M31b: the sector's own headline, not a trade-shaped `company` object.
      expect(typeof parsed.headline.find((h) => h.label === 'cash')?.value).toBe('number')
      expect(parsed.modelUsage.spentUsd).toBeNull()
      const again = await runCli(['step-simulation', '--simulation', id, '--steps', '1'])
      expect(again.code).toBe(1)
      expect(again.stderr).toContain('is finished; it cannot be stepped')
    }, 30_000)
    it('refuses an unsupported sector without creating anything', async () => {
      const companyId = await tradingCompany()
      const result = await runCli(['create-simulation', '--company', companyId, '--name', 'x', '--policy', 'A', '--sector', 'retail'])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('cannot run in simulation mode yet')
      expect(await prisma.simulationRun.count()).toBe(0)
    }, 30_000)
    it('refuses to create a simulation without --sector, creating nothing (M31b T4: --sector is required, no default)', async () => {
      const companyId = await tradingCompany()
      const result = await runCli(['create-simulation', '--company', companyId, '--name', 'x', '--policy', 'A'])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('--sector is required')
      expect(await prisma.simulationRun.count()).toBe(0)
    }, 30_000)
    it('creates a software simulation and simulation-status prints its own headline and metric labels generically (M31b T4)', async () => {
      const companyId = await softwareCompany()
      const created = await runCli(['create-simulation', '--sector', 'software', '--company', companyId, '--name', 'sw cli', '--policy', 'A'])
      expect(created.code).toBe(0)
      expect(created.stdout).toContain('simulation')
      expect(created.stdout).toContain('(software, policy A')
      const id = /simulation (\S+) created/.exec(created.stdout)?.[1] ?? ''
      expect(id).not.toBe('')
      const status = await runCli(['simulation-status', '--simulation', id])
      expect(status.code).toBe(0)
      const parsed = JSON.parse(status.stdout) as {
        summary: { sector: string }
        headline: { label: string; value: number }[]
        metricLabels: Record<string, { label: string; kind: string }>
      }
      expect(parsed.summary.sector).toBe('software')
      // The headline is the software plugin's own (queued/in progress/in review/done/open
      // incidents), never trade's cash-and-inventory shape.
      expect(parsed.headline.some((h) => h.label === 'queued')).toBe(true)
      expect(parsed.headline.some((h) => h.label === 'cash')).toBe(false)
      expect(parsed.metricLabels['deliveredTasks']).toEqual({ label: 'delivered', kind: 'count' })
    }, 30_000)
    it('refuses an invalid seed without creating anything', async () => {
      const companyId = await tradingCompany()
      const result = await runCli(['create-simulation', '--sector', 'trade', '--company', companyId, '--name', 'x', '--policy', 'A', '--seed', 'abc'])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('--seed must be an integer')
      expect(await prisma.simulationRun.count()).toBe(0)
    }, 30_000)
    it('an llm run refuses without a cap, creating nothing; with a cap the row carries the llm fields and simulation-status reports spentUsd/capUsd', async () => {
      const companyId = await tradingCompany()
      const missingCap = await runCli(['create-simulation', '--sector', 'trade', '--company', companyId, '--name', 'llm cli', '--policy', 'A', '--decision-provider', 'llm', '--model-provider', 'claude_code', '--model', 'claude-sonnet-4-5'])
      expect(missingCap.code).toBe(1)
      expect(missingCap.stderr).toContain('maxModelCostUsd must be a positive number')
      expect(await prisma.simulationRun.count()).toBe(0)

      const created = await runCli(['create-simulation', '--sector', 'trade', '--company', companyId, '--name', 'llm cli', '--policy', 'A', '--decision-provider', 'llm', '--model-provider', 'claude_code', '--model', 'claude-sonnet-4-5', '--max-model-cost-usd', '2'])
      expect(created.code).toBe(0)
      const id = /simulation (\S+) created/.exec(created.stdout)?.[1] ?? ''
      expect(id).not.toBe('')
      const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
      expect(row).toMatchObject({ decisionProvider: 'llm', modelProvider: 'claude_code', model: 'claude-sonnet-4-5', maxModelCostUsd: 2 })

      const status = await runCli(['simulation-status', '--simulation', id])
      expect(status.code).toBe(0)
      const parsed = JSON.parse(status.stdout) as { modelUsage: { spentUsd: number | null; capUsd: number | null } }
      expect(parsed.modelUsage.capUsd).toBe(2)
      expect(parsed.modelUsage.spentUsd).toBeNull()
    }, 30_000)
    it('tick steps every due auto-run once and reports the counts (M30)', async () => {
      const companyId = await tradingCompany()
      const created = await runCli(['create-simulation', '--sector', 'trade', '--company', companyId, '--name', 'auto', '--policy', 'A'])
      const id = /simulation (\S+) created/.exec(created.stdout)?.[1] ?? ''
      expect(id).not.toBe('')
      // `auto-run-simulation` is Task 6's CLI verb; here the intent is armed straight through
      // control, in-process, against the same TEST_DATABASE_URL the spawned CLI child also uses.
      expect((await startAutoRun(id, { everyMs: 250, untilDay: 3 })).ok).toBe(true)
      await runCli(['tick', '--workspace', fixture.workspaceId])
      await new Promise<void>((resolve) => setTimeout(resolve, 300))
      const second = await runCli(['tick', '--workspace', fixture.workspaceId])
      expect(second.code).toBe(0)
      const parsed = JSON.parse(second.stdout) as { simulations: { candidates: number; stepped: number; halted: number; skippedNoDecider: number } }
      expect(parsed.simulations).toEqual({ candidates: 1, stepped: 1, halted: 0, skippedNoDecider: 0, skippedInFlight: 0, startedModelCalls: 0 })
      const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
      expect(row.simTime).toBe(2)
    }, 30_000)
    it('a one-shot tick never decides for an llm run: it reports skippedNoDecider and spends nothing (M31a)', async () => {
      const companyId = await tradingCompany()
      const created = await createSimulation({ companyId, name: 'llm auto', sector: 'trade', policy: 'A', decisionProvider: 'llm', modelProvider: 'claude_code', model: 'claude-haiku-4-5', maxModelCostUsd: 1 })
      const id = created.ok ? created.value.id : ''
      expect(id).not.toBe('')
      expect((await startAutoRun(id, { everyMs: 250, untilDay: 3 })).ok).toBe(true)
      const result = await runCli(['tick', '--workspace', fixture.workspaceId])
      expect(result.code).toBe(0)
      const parsed = JSON.parse(result.stdout) as { simulations: { candidates: number; stepped: number; skippedNoDecider: number } }
      expect(parsed.simulations).toMatchObject({ candidates: 1, stepped: 0, skippedNoDecider: 1 })
      expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).simTime).toBe(0)
      expect(await prisma.simulationModelUsage.count({ where: { simulationId: id } })).toBe(0)
    }, 30_000)
    it('the daemon decides an llm run through decideWithModel and the fake CLI: the answer is applied and the cost recorded (M31a)', async () => {
      const companyId = await tradingCompany()
      const created = await createSimulation({ companyId, name: 'llm daemon', sector: 'trade', policy: 'A', decisionProvider: 'llm', modelProvider: 'claude_code', model: 'claude-haiku-4-5', maxModelCostUsd: 1 })
      const id = created.ok ? created.value.id : ''
      expect(id).not.toBe('')
      expect((await startAutoRun(id, { everyMs: 250, untilDay: 2 })).ok).toBe(true)
      // The FAKE CLI, driven down the real `decideWithModel` path (the same binary/args seam the
      // adapters use): no real `claude` is spawned and nothing is billed. `--fixture decision`
      // answers with a fenced JSON array holding one `place_purchase` from `fast`.
      const child = execFile('node', [CLI, 'daemon', '--period', '200'], {
        env: {
          ...process.env,
          DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
          SLAVEOFAI_CLAUDE_BIN: 'node',
          SLAVEOFAI_CLAUDE_ARGS: `${FAKE} --fixture decision`,
          SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
        },
      })
      try {
        const deadline = Date.now() + 20_000
        let simTime = 0
        while (Date.now() < deadline && simTime === 0) {
          await new Promise((res) => setTimeout(res, 250))
          simTime = (await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).simTime
        }
        expect(simTime).toBeGreaterThan(0)
        const usage = await prisma.simulationModelUsage.findFirstOrThrow({ where: { simulationId: id }, orderBy: { seq: 'asc' } })
        expect(usage).toMatchObject({ provider: 'claude_code', role: 'purchasing', simTime: 0, costUsd: 0.0038 })
        const decision = await prisma.simulationJournalEntry.findFirstOrThrow({ where: { simulationId: id, kind: 'decision', actorRole: 'purchasing' }, orderBy: { seq: 'asc' } })
        expect(decision.payload).toMatchObject({ provider: 'llm', model: 'claude-haiku-4-5', usageSeq: usage.seq, parseError: null })
        const applied = await prisma.simulationJournalEntry.findMany({ where: { simulationId: id, kind: 'action_applied', actorRole: 'purchasing' } })
        expect(applied).toHaveLength(1)
        expect((applied[0]?.payload as { action: { type: string; params: Record<string, unknown> } }).action).toMatchObject({ type: 'place_purchase', params: { supplierId: 'fast', qty: 50 } })
      } finally {
        const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)))
        child.kill('SIGTERM')
        await Promise.race([exited, new Promise<number | null>((res) => setTimeout(() => res(-1), 12_000))])
      }
    }, 60_000)
    it('compare-simulations prints both runs\' metrics and the b − a deltas as JSON (M30)', async () => {
      const companyId = await tradingCompany()
      const createdA = await runCli(['create-simulation', '--sector', 'trade', '--company', companyId, '--name', 'cmp a', '--policy', 'A'])
      const a = /simulation (\S+) created/.exec(createdA.stdout)?.[1] ?? ''
      expect(a).not.toBe('')
      const createdB = await runCli(['create-simulation', '--sector', 'trade', '--company', companyId, '--name', 'cmp b', '--policy', 'B'])
      const b = /simulation (\S+) created/.exec(createdB.stdout)?.[1] ?? ''
      expect(b).not.toBe('')
      expect((await runCli(['step-simulation', '--simulation', a, '--until-day', '30'])).code).toBe(0)
      expect((await runCli(['step-simulation', '--simulation', b, '--until-day', '30'])).code).toBe(0)
      const result = await runCli(['compare-simulations', '--a', a, '--b', b])
      expect(result.code).toBe(0)
      const parsed = JSON.parse(result.stdout) as { definitionsMatch: boolean; deltas: { purchaseCostMinor: number } }
      expect(parsed.definitionsMatch).toBe(true)
      expect(parsed.deltas.purchaseCostMinor).toBe(425_000)
    }, 30_000)
    it('pauses a simulation (M30)', async () => {
      const companyId = await tradingCompany()
      const created = await runCli(['create-simulation', '--sector', 'trade', '--company', companyId, '--name', 'pause me', '--policy', 'A'])
      const id = /simulation (\S+) created/.exec(created.stdout)?.[1] ?? ''
      expect(id).not.toBe('')
      const result = await runCli(['pause-simulation', '--simulation', id])
      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(new RegExp(`^simulation ${id} paused$`, 'm'))
      const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
      expect(row.status).toBe('paused')
    }, 30_000)
    it('resumes a paused simulation (M30)', async () => {
      const companyId = await tradingCompany()
      const created = await runCli(['create-simulation', '--sector', 'trade', '--company', companyId, '--name', 'resume me', '--policy', 'A'])
      const id = /simulation (\S+) created/.exec(created.stdout)?.[1] ?? ''
      expect((await runCli(['pause-simulation', '--simulation', id])).code).toBe(0)
      const result = await runCli(['resume-simulation', '--simulation', id])
      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(new RegExp(`^simulation ${id} resumed$`, 'm'))
      const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
      expect(row.status).toBe('running')
    }, 30_000)
    it('halts a simulation with a reason (M30)', async () => {
      const companyId = await tradingCompany()
      const created = await runCli(['create-simulation', '--sector', 'trade', '--company', companyId, '--name', 'halt me', '--policy', 'A'])
      const id = /simulation (\S+) created/.exec(created.stdout)?.[1] ?? ''
      const result = await runCli(['halt-simulation', '--simulation', id, '--reason', 'operator judgment call'])
      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(new RegExp(`^simulation ${id} halted: operator judgment call$`, 'm'))
      const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
      expect(row.status).toBe('halted')
      expect(row.haltedReason).toBe('operator judgment call')
    }, 30_000)
    it('injects a supplier delay onto the queue (M30)', async () => {
      const companyId = await tradingCompany()
      const created = await runCli(['create-simulation', '--sector', 'trade', '--company', companyId, '--name', 'inject me', '--policy', 'A'])
      const id = /simulation (\S+) created/.exec(created.stdout)?.[1] ?? ''
      const before = await loadSimulation(id)
      const beforeCount = before.ok ? before.value.state.queue.items.length : -1
      const result = await runCli([
        'inject-simulation-event',
        '--simulation', id,
        '--day', '2',
        '--event', JSON.stringify({ type: 'supplier_delay', supplierId: 'normal', extraDays: 2 }),
      ])
      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(new RegExp(`^event injected into simulation ${id} on day 2$`, 'm'))
      const loaded = await loadSimulation(id)
      expect(loaded.ok && loaded.value.state.queue.items).toHaveLength(beforeCount + 1)
      expect(loaded.ok && loaded.value.state.queue.items.filter((item) => item.time === 2)).toHaveLength(1)
    }, 30_000)
    it('refuses invalid JSON for --event without touching the queue (M30)', async () => {
      const companyId = await tradingCompany()
      const created = await runCli(['create-simulation', '--sector', 'trade', '--company', companyId, '--name', 'inject bad', '--policy', 'A'])
      const id = /simulation (\S+) created/.exec(created.stdout)?.[1] ?? ''
      const before = await loadSimulation(id)
      const beforeCount = before.ok ? before.value.state.queue.items.length : -1
      const result = await runCli(['inject-simulation-event', '--simulation', id, '--day', '1', '--event', '{not json'])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('--event must be JSON')
      const loaded = await loadSimulation(id)
      expect(loaded.ok && loaded.value.state.queue.items).toHaveLength(beforeCount)
    }, 30_000)
    it('clones a simulation into a fresh row at day 0 (M30)', async () => {
      const companyId = await tradingCompany()
      const created = await runCli(['create-simulation', '--sector', 'trade', '--company', companyId, '--name', 'clone source', '--policy', 'A'])
      const id = /simulation (\S+) created/.exec(created.stdout)?.[1] ?? ''
      expect((await runCli(['step-simulation', '--simulation', id, '--until-day', '5'])).code).toBe(0)
      const result = await runCli(['clone-simulation', '--simulation', id, '--name', 'clone target', '--policy', 'B'])
      expect(result.code).toBe(0)
      const cloneId = /simulation (\S+) created/.exec(result.stdout)?.[1] ?? ''
      expect(cloneId).not.toBe('')
      const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id: cloneId } })
      expect(row.clonedFromId).toBe(id)
      expect(row.simTime).toBe(0)
      const cloneLoaded = await loadSimulation(cloneId)
      expect(cloneLoaded.ok && cloneLoaded.value.summary.policy).toBe('B')
    }, 30_000)
    it('starts and stops an auto-run intent (M30)', async () => {
      const companyId = await tradingCompany()
      const created = await runCli(['create-simulation', '--sector', 'trade', '--company', companyId, '--name', 'auto cli', '--policy', 'A'])
      const id = /simulation (\S+) created/.exec(created.stdout)?.[1] ?? ''
      const started = await runCli(['auto-run-simulation', '--simulation', id, '--every-ms', '250', '--until-day', '10'])
      expect(started.code).toBe(0)
      expect(started.stdout).toMatch(new RegExp(`^simulation ${id} auto-running every 250 ms to day 10$`, 'm'))
      const running = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
      expect(running.autoRunEveryMs).toBe(250)
      expect(running.autoRunUntilDay).toBe(10)
      const stopped = await runCli(['stop-auto-run', '--simulation', id])
      expect(stopped.code).toBe(0)
      expect(stopped.stdout).toMatch(new RegExp(`^simulation ${id} auto-run stopped$`, 'm'))
      const cleared = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
      expect(cleared.autoRunEveryMs).toBeNull()
      expect(cleared.autoRunUntilDay).toBeNull()
    }, 30_000)
    it('auto-run-simulation defaults to every 1000 ms until the horizon (M30)', async () => {
      const companyId = await tradingCompany()
      const created = await runCli(['create-simulation', '--sector', 'trade', '--company', companyId, '--name', 'auto default', '--policy', 'A'])
      const id = /simulation (\S+) created/.exec(created.stdout)?.[1] ?? ''
      const loaded = await loadSimulation(id)
      const horizonDays = loaded.ok ? loaded.value.summary.horizonDays : -1
      const result = await runCli(['auto-run-simulation', '--simulation', id])
      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(new RegExp(`^simulation ${id} auto-running every 1000 ms to day ${horizonDays}$`, 'm'))
      const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
      expect(row.autoRunEveryMs).toBe(1000)
      expect(row.autoRunUntilDay).toBe(horizonDays)
    }, 30_000)

    describe('adopt-simulation (M33 §4)', () => {
      it('adopts a software run\'s organisation into a company-less project, printing the assign report and the settings written', async () => {
        const companyId = await softwareCompany()
        const created = await runCli(['create-simulation', '--sector', 'software', '--company', companyId, '--name', 'adopt me', '--policy', 'A'])
        const id = /simulation (\S+) created/.exec(created.stdout)?.[1] ?? ''
        expect(id).not.toBe('')
        const workspace = await prisma.workspace.create({ data: { name: 'Alpha Project', repoPath: '/tmp/x', verifyCommands: [], setupCommands: [] } })

        const result = await runCli(['adopt-simulation', '--simulation', id, '--workspace', workspace.id])

        expect(result.code).toBe(0)
        expect(result.stdout).toContain(`simulation ${id} adopted into ${workspace.id}`)
        expect(result.stdout).toMatch(/\d+ departments?, \d+ workers?/)
        expect(result.stdout).toContain('maxConcurrentRuns')
        expect(result.stdout).toContain('maxAttempts')
        expect(result.stdout).toContain('autoMerge false')
        const row = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
        expect(row.companyId).toBe(companyId)
        expect(row.adoptedFromSimulationId).toBe(id)
        expect(row.autoMerge).toBe(false)
        const slaves = await prisma.slave.findMany({ where: { team: { workspaceId: workspace.id } } })
        expect(slaves.length).toBeGreaterThan(0)
        expect(slaves.some((s) => s.role === 'manager')).toBe(true)
      }, 30_000)

      it('--max-concurrent / --max-attempts / --apply-model are honoured; a refusal writes nothing', async () => {
        const companyId = await softwareCompany()
        const created = await runCli([
          'create-simulation', '--sector', 'software', '--company', companyId, '--name', 'adopt with model', '--policy', 'B',
          '--decision-provider', 'llm', '--model-provider', 'claude_code', '--model', 'claude-opus-4', '--max-model-cost-usd', '5',
        ])
        const id = /simulation (\S+) created/.exec(created.stdout)?.[1] ?? ''
        const workspace = await prisma.workspace.create({ data: { name: 'Beta Project', repoPath: '/tmp/y', verifyCommands: [], setupCommands: [] } })

        const result = await runCli(['adopt-simulation', '--simulation', id, '--workspace', workspace.id, '--max-concurrent', '2', '--max-attempts', '1', '--apply-model'])

        expect(result.code).toBe(0)
        expect(result.stdout).toContain('maxConcurrentRuns 2, maxAttempts 1')
        const row = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
        expect(row.maxConcurrentRuns).toBe(2)
        expect(row.maxAttempts).toBe(1)
        const lead = await prisma.companySlave.findFirst({ where: { companyTeam: { companyId }, name: 'Atlas' } })
        expect(lead?.model).toBe('claude-opus-4')
        expect(lead?.provider).toBe('claude_code')
      }, 30_000)

      it('refuses a trade run\'s organisation with the sector\'s own reason, writing nothing', async () => {
        const companyId = await tradingCompany()
        const created = await runCli(['create-simulation', '--sector', 'trade', '--company', companyId, '--name', 'not adoptable', '--policy', 'A'])
        const id = /simulation (\S+) created/.exec(created.stdout)?.[1] ?? ''
        const workspace = await prisma.workspace.create({ data: { name: 'Gamma Project', repoPath: '/tmp/z', verifyCommands: [], setupCommands: [] } })

        const result = await runCli(['adopt-simulation', '--simulation', id, '--workspace', workspace.id])

        expect(result.code).toBe(1)
        expect(result.stderr).toContain('not software roles')
        const row = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
        expect(row.companyId).toBeNull()
        expect(row.adoptedFromSimulationId).toBeNull()
      }, 30_000)

      it('--simulation and --workspace are required', async () => {
        const missingWorkspace = await runCli(['adopt-simulation', '--simulation', '00000000-0000-4000-8000-00000000dead'])
        expect(missingWorkspace.code).toBe(1)
        expect(missingWorkspace.stderr).toContain('--workspace is required')
        const missingSimulation = await runCli(['adopt-simulation', '--workspace', '00000000-0000-4000-8000-00000000dead'])
        expect(missingSimulation.code).toBe(1)
        expect(missingSimulation.stderr).toContain('--simulation is required')
      }, 30_000)
    })
  })

  describe('the Supervisor CLI verbs (M38 t4)', () => {
    it('supervise --dry-run prints the fresh situations and their rule choice, and writes nothing', async (): Promise<void> => {
      await blockOnReviewCap(fixture.workspaceId, fixture.taskId)

      const result = await runCli(['supervise', '--workspace', fixture.workspaceId, '--dry-run'])

      expect(result.code).toBe(0)
      const preview = JSON.parse(result.stdout) as readonly { situation: Situation; candidates: Candidate[]; ruleChoice: number }[]
      expect(preview).toHaveLength(1)
      expect(preview[0]?.situation.kind).toBe('review_cap_blocked')
      expect(preview[0]?.situation.subjectId).toBe(fixture.taskId)
      expect(preview[0]?.candidates.some((c) => c.action.kind === 'unblock_task')).toBe(true)
      expect(typeof preview[0]?.ruleChoice).toBe('number')
      const chosen = preview[0]?.candidates[preview[0].ruleChoice]
      expect(chosen?.action.kind).toBe('unblock_task')

      // Writes NOTHING: no decision row, no new event beyond the one `blockOnReviewCap` itself
      // wrote, and the task is untouched.
      expect(await prisma.supervisorDecision.count()).toBe(0)
      expect(await prisma.executionEvent.count({ where: { type: 'guardrail_tripped' } })).toBe(1)
      const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
      expect(task.status).toBe('blocked')
    }, 30_000)

    it('supervise --dry-run prints an empty list and writes nothing when the workspace has nothing stuck', async (): Promise<void> => {
      const result = await runCli(['supervise', '--workspace', fixture.workspaceId, '--dry-run'])

      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual([])
      expect(await prisma.supervisorDecision.count()).toBe(0)
    })

    it('supervise applies the routine unblock_task on a review-cap-blocked task', async (): Promise<void> => {
      await blockOnReviewCap(fixture.workspaceId, fixture.taskId)

      const result = await runCli(['supervise', '--workspace', fixture.workspaceId])

      expect(result.code).toBe(0)
      const report = JSON.parse(result.stdout)
      expect(report).toMatchObject({ situations: 1, decided: 1, applied: 1, proposed: 0 })

      const decision = await prisma.supervisorDecision.findFirstOrThrow({
        where: { workspaceId: fixture.workspaceId, situationKind: 'review_cap_blocked' },
      })
      expect(decision.status).toBe('applied')
      expect(decision.tier).toBe('applied')
      expect((decision.action as { kind: string }).kind).toBe('unblock_task')

      const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
      expect(task.status).toBe('rework')
    }, 30_000)

    it('exits non-zero for supervise with no --workspace given, even with exactly one workspace', async (): Promise<void> => {
      const result = await runCli(['supervise'])

      expect(result.code).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toMatch(/--workspace is required/)
    })

    it('lists Supervisor decisions, newest first, narrowed by --pending and --limit', async (): Promise<void> => {
      await blockOnReviewCap(fixture.workspaceId, fixture.taskId)
      const applied = await runCli(['supervise', '--workspace', fixture.workspaceId])
      expect(applied.code).toBe(0)

      const all = await runCli(['supervisor-decisions', '--workspace', fixture.workspaceId])
      expect(all.code).toBe(0)
      const decisions = JSON.parse(all.stdout)
      expect(decisions).toHaveLength(1)
      expect(decisions[0].situationKind).toBe('review_cap_blocked')
      expect(decisions[0].status).toBe('applied')

      // The one decision above is `applied`, not `pending` -- `--pending` narrows to nothing.
      const pending = await runCli(['supervisor-decisions', '--workspace', fixture.workspaceId, '--pending'])
      expect(pending.code).toBe(0)
      expect(JSON.parse(pending.stdout)).toEqual([])

      const limited = await runCli(['supervisor-decisions', '--workspace', fixture.workspaceId, '--limit', '0'])
      expect(limited.code).not.toBe(0)
    }, 30_000)

    /** Records a `pending` `unblock_task` proposal on `fixture.taskId` directly through
     *  `recordDecision`, the way `task_blocked_human` (a park no `unblock_task` may leave
     *  routinely -- spec erratum E5) would actually be proposed. Bypasses `observe`/`candidates`
     *  so the approve/reject tests exercise the CLI verb, not the rules that would have produced
     *  the same shape. */
    async function seedPendingUnblockProposal(): Promise<string> {
      await blockForHuman(fixture.taskId)
      const situation: Situation = {
        kind: 'task_blocked_human',
        subjectId: fixture.taskId,
        summary: 'Task is blocked and nothing but a human decision moves it.',
        facts: { taskId: fixture.taskId },
      }
      const candidates: Candidate[] = [
        { action: { kind: 'unblock_task', taskId: fixture.taskId }, tier: 'proposed', why: 'the task still has attempts left.' },
        { action: { kind: 'escalate_to_human', summary: situation.summary }, tier: 'escalated', why: 'a human decides.' },
        { action: { kind: 'no_action' }, tier: 'noop', why: 'waiting is reasonable.' },
      ]
      const recorded = await recordDecision({
        workspaceId: fixture.workspaceId,
        situation,
        candidates,
        chosenIndex: 0,
        rationale: 'a human should look at this.',
        decidedBy: 'rules',
        modelCostUsd: null,
      })
      if (!recorded.ok) throw new Error(`seedPendingUnblockProposal: recordDecision refused: ${JSON.stringify(recorded.error)}`)
      return recorded.value.id
    }

    it('approves a pending proposal: the action is carried out and the row reads approved, with no principal to name', async (): Promise<void> => {
      const decisionId = await seedPendingUnblockProposal()

      const result = await runCli(['approve-decision', '--id', decisionId])

      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(/approved/)
      const decision = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: decisionId } })
      expect(decision.status).toBe('approved')
      // The CLI has no session and passes no `Principal` (fix round 2) -- the row honestly
      // carries no resolver rather than a name borrowed from an account that did not actually act.
      expect(decision.resolvedByUserId).toBeNull()
      const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
      expect(task.status).toBe('rework')
      const resolved = await prisma.executionEvent.findFirstOrThrow({ where: { type: 'supervisor_resolved' } })
      expect(resolved.actor).toBe('human')
      expect(resolved.userId).toBeNull()
      expect((resolved.payload as { outcome: string }).outcome).toBe('approved')
    }, 30_000)

    it('rejects a pending proposal: the action never runs and the row reads rejected, with no principal to name', async (): Promise<void> => {
      const decisionId = await seedPendingUnblockProposal()

      const result = await runCli(['reject-decision', '--id', decisionId, '--reason', 'not now'])

      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(/rejected/)
      const decision = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: decisionId } })
      expect(decision.status).toBe('rejected')
      expect(decision.resolvedByUserId).toBeNull()
      // The action is never carried out on a rejection -- the task stays exactly where it was.
      const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
      expect(task.status).toBe('blocked')
      const resolved = await prisma.executionEvent.findFirstOrThrow({ where: { type: 'supervisor_resolved' } })
      expect(resolved.userId).toBeNull()
      expect((resolved.payload as { outcome: string; reason: string | null }).reason).toBe('not now')
    }, 30_000)

    /**
     * A `pending` `answer_question` proposal on the question `seedAWaitingRun` left behind (M39
     * t4): the interpretation tier the Supervisor records when the model's citations did not
     * verify, with the drafted answer a human is expected to read, edit and approve.
     */
    async function seedPendingAnswerProposal(questionId: string): Promise<string> {
      const situation: Situation = {
        kind: 'waiting_stale',
        subjectId: questionId,
        summary: 'A slave has been waiting on an answer for two hours.',
        facts: { messageId: questionId },
      }
      const action = { kind: 'answer_question' as const, messageId: questionId }
      const candidates: Candidate[] = [
        { action, tier: 'proposed', why: 'the task description looks like it answers this.' },
        { action: { kind: 'escalate_to_human', summary: situation.summary }, tier: 'escalated', why: 'a human decides.' },
      ]
      const recorded = await recordDecision({
        workspaceId: fixture.workspaceId,
        situation,
        candidates,
        chosenIndex: 0,
        rationale: 'the answer is in the task description.',
        decidedBy: 'model',
        modelCostUsd: 0.01,
        draft: {
          body: 'the model would have said this',
          sources: [],
          rejectedSources: [{ source: { kind: 'task', ref: null, quote: 'not in the task' }, reason: 'quote_not_found' }],
          critical: { lexicon: [], model: false },
          confidence: 'interpretation',
        },
        tier: 'proposed',
      })
      if (!recorded.ok) throw new Error(`seedPendingAnswerProposal: recordDecision refused: ${JSON.stringify(recorded.error)}`)
      return recorded.value.id
    }

    it('approves a drafted answer with an edited body read from --body-file: the answer the slave receives is the human text', async (): Promise<void> => {
      const { questionId } = await seedAWaitingRun()
      const decisionId = await seedPendingAnswerProposal(questionId)
      const file = join(mkdtempSync(join(tmpdir(), 'slaveofai-answer-')), 'answer.md')
      // Untrimmed, like `set-profile --file`: the trailing newline an editor leaves is the
      // operator's text, and this is what proves the CLI does not quietly rewrite it.
      writeFileSync(file, 'land them on payments-retry\n')

      const result = await runCli(['approve-decision', '--id', decisionId, '--body-file', file])

      expect(result.code).toBe(0)
      const answer = await prisma.slaveMessage.findFirstOrThrow({ where: { kind: 'answer' } })
      expect(answer.body).toBe('land them on payments-retry\n')
      expect(answer.replyToId).toBe(questionId)
      // A human approved it, so the row and its envelope read `human` -- not `system`.
      expect(answer.actor).toBe('human')
      const decision = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: decisionId } })
      expect(decision.status).toBe('approved')
      expect((decision.draft as { body: string; editedBody: string }).editedBody).toBe('land them on payments-retry\n')
      // The model's own words stay on the row beside the edit, so a reader can see both.
      expect((decision.draft as { body: string }).body).toBe('the model would have said this')
    }, 30_000)

    it('approves a drafted answer with no --body-file at all: the model draft is what goes out', async (): Promise<void> => {
      const { questionId } = await seedAWaitingRun()
      const decisionId = await seedPendingAnswerProposal(questionId)

      const result = await runCli(['approve-decision', '--id', decisionId])

      expect(result.code).toBe(0)
      const answer = await prisma.slaveMessage.findFirstOrThrow({ where: { kind: 'answer' } })
      expect(answer.body).toBe('the model would have said this')
      expect((await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: decisionId } })).draft).not.toHaveProperty('editedBody')
    }, 30_000)

    it('prints the drafted answer with its confidence and critical flags in supervisor-decisions', async (): Promise<void> => {
      const { questionId } = await seedAWaitingRun()
      await seedPendingAnswerProposal(questionId)

      const result = await runCli(['supervisor-decisions', '--workspace', fixture.workspaceId])

      expect(result.code).toBe(0)
      const decisions = JSON.parse(result.stdout) as readonly {
        draft: { confidence: string; critical: { lexicon: string[]; model: boolean }; body: string } | null
      }[]
      expect(decisions).toHaveLength(1)
      expect(decisions[0]?.draft?.confidence).toBe('interpretation')
      expect(decisions[0]?.draft?.critical).toEqual({ lexicon: [], model: false })
      expect(decisions[0]?.draft?.body).toBe('the model would have said this')
    }, 30_000)

    it('re-addresses a question by hand to a slave who holds the role, moving the row and appending the event', async (): Promise<void> => {
      const { questionId } = await seedAWaitingRun()
      const maya = await prisma.slave.create({
        data: { teamId: fixture.teamId, name: 'Maya', role: 'product', runtimeRoles: ['product'] },
      })

      const result = await runCli(['reassign-question', '--message', questionId, '--to', maya.id, '--by', 'eren'])

      expect(result.code).toBe(0)
      expect(result.stdout).toContain(maya.id)
      const question = await prisma.slaveMessage.findUniqueOrThrow({ where: { id: questionId } })
      expect(question.recipientSlaveId).toBe(maya.id)
      // Both columns, always: a row addressed to a worker AND a role would still sit in every
      // holder of the old role's inbox.
      expect(question.recipientRole).toBeNull()
      const event = await prisma.executionEvent.findFirstOrThrow({ where: { type: 'slave_message_reassigned' } })
      expect(event.actor).toBe('human')
      expect(event.payload).toMatchObject({
        messageId: questionId,
        decisionId: null,
        from: { role: 'product', slaveId: null },
        to: { slaveId: maya.id },
        actor: 'eren',
      })
    }, 30_000)

    it('exits non-zero when the re-address target may not answer the question, moving nothing', async (): Promise<void> => {
      const { questionId } = await seedAWaitingRun()
      // Holds no role at all, so the question would land in front of a worker that can never be
      // dispatched it -- `reassign_not_permitted`.
      const parked = await prisma.slave.create({ data: { teamId: fixture.teamId, name: 'Parked', role: 'design', runtimeRoles: [] } })

      const result = await runCli(['reassign-question', '--message', questionId, '--to', parked.id])

      expect(result.code).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toMatch(/cannot be re-addressed/)
      const question = await prisma.slaveMessage.findUniqueOrThrow({ where: { id: questionId } })
      expect(question.recipientSlaveId).toBeNull()
      expect(question.recipientRole).toBe('product')
      expect(await prisma.executionEvent.count({ where: { type: 'slave_message_reassigned' } })).toBe(0)
    }, 30_000)

    it('exits non-zero for approve-decision on an unknown id', async (): Promise<void> => {
      const result = await runCli(['approve-decision', '--id', 'nope'])

      expect(result.code).not.toBe(0)
      expect(result.stderr).toMatch(/decision_not_found|nope/)
    })

    it('set-supervisor --disable stops supervise from deciding or writing anything', async (): Promise<void> => {
      await blockOnReviewCap(fixture.workspaceId, fixture.taskId)

      const disabled = await runCli(['set-supervisor', '--workspace', fixture.workspaceId, '--disable'])
      expect(disabled.code).toBe(0)
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })).supervisorEnabled).toBe(false)

      const result = await runCli(['supervise', '--workspace', fixture.workspaceId])
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ situations: 0, decided: 0, applied: 0, proposed: 0 })
      expect(await prisma.supervisorDecision.count()).toBe(0)
      const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
      expect(task.status).toBe('blocked')
    }, 30_000)

    it('set-supervisor --enable turns it back on', async (): Promise<void> => {
      await runCli(['set-supervisor', '--workspace', fixture.workspaceId, '--disable'])

      const result = await runCli(['set-supervisor', '--workspace', fixture.workspaceId, '--enable'])

      expect(result.code).toBe(0)
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })).supervisorEnabled).toBe(true)
    })

    it('set-supervisor --profile-file writes the profile from the file', async (): Promise<void> => {
      const dir = mkdtempSync(join(tmpdir(), 'slaveofai-supervisor-profile-'))
      const profilePath = join(dir, 'profile.md')
      writeFileSync(profilePath, 'Be terse. Never raise attempt caps without asking.\n')

      const result = await runCli(['set-supervisor', '--workspace', fixture.workspaceId, '--profile-file', profilePath])

      expect(result.code).toBe(0)
      const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })
      expect(workspace.supervisorProfile).toBe('Be terse. Never raise attempt caps without asking.')
      rmSync(dir, { recursive: true, force: true })
    })

    it('set-supervisor --clear-profile clears a previously set profile', async (): Promise<void> => {
      await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { supervisorProfile: 'old persona' } })

      const result = await runCli(['set-supervisor', '--workspace', fixture.workspaceId, '--clear-profile'])

      expect(result.code).toBe(0)
      const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })
      expect(workspace.supervisorProfile).toBeNull()
    })

    it('refuses set-supervisor with no flag at all', async (): Promise<void> => {
      const result = await runCli(['set-supervisor', '--workspace', fixture.workspaceId])

      expect(result.code).not.toBe(0)
      expect(result.stderr).toMatch(/one of --enable, --disable, --profile-file or --clear-profile is required/)
    })

    it('refuses set-supervisor given both --profile-file and --clear-profile', async (): Promise<void> => {
      const dir = mkdtempSync(join(tmpdir(), 'slaveofai-supervisor-profile-'))
      const profilePath = join(dir, 'profile.md')
      writeFileSync(profilePath, 'x')

      const result = await runCli(['set-supervisor', '--workspace', fixture.workspaceId, '--profile-file', profilePath, '--clear-profile'])

      expect(result.code).not.toBe(0)
      expect(result.stderr).toMatch(/exactly one of --profile-file or --clear-profile/)
      rmSync(dir, { recursive: true, force: true })
    })

    it('refuses set-supervisor given both --enable and --disable', async (): Promise<void> => {
      // The `--flag=value` form, not two bare flags back to back: `parseArgs`'s own documented
      // idiom (`--workspace=<id>`'s test above) is what lets both register here at all -- a bare
      // `--enable` immediately followed by another `--flag` reads that flag's own name as
      // `--enable`'s VALUE (`setFlag`'s "whatever follows, even if it starts with `--`"), so two
      // adjacent bare booleans can never both land in `flags`. Neither flag's stated behaviour
      // consults its value, only its presence, so `=1` exercises the exclusivity check exactly.
      const result = await runCli(['set-supervisor', '--workspace', fixture.workspaceId, '--enable=1', '--disable=1'])

      expect(result.code).not.toBe(0)
      expect(result.stderr).toMatch(/--enable and --disable are exclusive/)
    })
  })
})
