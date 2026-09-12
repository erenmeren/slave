import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refusalText, runFilePaths, type ModelDecider } from '@slave-of-ai/control'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, type DomainEventType } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import {
  ANSWER_BLOCK_OPEN,
  ASK_BLOCK_OPEN,
  runId as brandRunId,
  workspaceId as brandWorkspaceId,
  runContextManifestSchema,
} from '@slave-of-ai/domain'
import {
  ClaudeCodeAdapter,
  buildRegistry,
  type AdapterRegistry,
  type SlaveRuntimeAdapter,
  type StartRunInput,
} from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRunUnlessArchived } from '../../src/runs.js'
import { drainPumps, tick, type TickDeps } from '../../src/tick.js'

/**
 * Every `workspaceStats` call this file makes, in order (M39 §4).
 *
 * The leaf module is mocked rather than the package entry because BOTH readers have to be seen at
 * once: `apps/orchestrator/src/world.ts` imports it through `@slave-of-ai/control`, and
 * `packages/control/src/supervisorWorld.ts` imports it as `./stats.js` from inside that same
 * package. They resolve to one file, so one pass-through wrapper counts both -- which is the only
 * way "the tick reads the workspace once" is a claim a test can actually check rather than assert.
 * The wrapper changes nothing: it records the workspace id and delegates.
 */
const statsCalls: string[] = []
vi.mock('../../../../packages/control/dist/stats.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../packages/control/dist/stats.js')>()
  return {
    ...actual,
    workspaceStats: (...args: Parameters<typeof actual.workspaceStats>) => {
      statsCalls.push(args[0])
      return actual.workspaceStats(...args)
    },
  }
})

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const REAL_GATE = join(repoRoot, 'scripts/pause-gate.sh')

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

/** A real repository, because `provisionWorktree` uses real git and this is the seam under test. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-tick-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'initial'], dir)
  return dir
}

interface Fixture {
  readonly workspaceId: string
  readonly taskId: string
  readonly slaveId: string
  readonly repoPath: string
}

async function seed(options: { readonly setupCommands?: readonly string[] } = {}): Promise<Fixture> {
  const repoPath = makeRepo()
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath,
      baseBranch: 'main',
      verifyCommands: ['true'],
      setupCommands: [...(options.setupCommands ?? [])],
    },
  })
  // M12 Task 8: this fixture's slave names no model anywhere in the chain, so `resolveRuntime`
  // falls all the way to the workspace default -- which does not exist unless a
  // `ProviderConfiguration` row does. Without this, every dispatch in this file refuses
  // (`workspaceDefaultProvider` returns `null`) instead of starting the run under test.
  await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const slave = await prisma.slave.create({
    data: { teamId: team.id, name: 'Alex', role: 'backend', runtimeRoles: ['backend'] },
  })
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
  return { workspaceId: workspace.id, taskId: task.id, slaveId: slave.id, repoPath }
}

async function eventTypesFor(workspaceId: string): Promise<readonly DomainEventType[]> {
  const rows = await prisma.executionEvent.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
  return rows.map((row): DomainEventType => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] as DomainEventType)
}

const keyOf = (taskId: string): string => `T-${taskId.slice(0, 8)}`

/**
 * `deps.registry` for a test that only ever runs against one adapter instance (the ordinary case
 * pre-Task-8, when every run resolves to `'claude_code'` regardless of what `kind` is asked for).
 */
function singleAdapterRegistry(adapter: SlaveRuntimeAdapter): AdapterRegistry {
  return { resolve: () => adapter }
}

interface Recorder {
  readonly adapter: SlaveRuntimeAdapter
  readonly starts: StartRunInput[]
  readonly cancelled: string[]
}

/**
 * The real adapter with the three methods the tick uses observed, and `events()` optionally made to
 * throw -- which is the cheapest way to reach the "something failed after the process was already
 * spawned" path deterministically. Only those methods are implemented because only those are
 * called; the cast is what says so out loud rather than stubbing four more to satisfy a type.
 */
function recordingAdapter(
  options: {
    readonly failEvents?: boolean
    /** Runs INSIDE `start`, before the child is spawned -- the only place a test can observe what
     *  the system had already done by the time the model was handed its prompt (M37 §1). */
    readonly onStart?: (input: StartRunInput) => Promise<void>
  } = {},
): Recorder {
  const inner = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'complete'], hookPath: REAL_GATE })
  const starts: StartRunInput[] = []
  const cancelled: string[] = []
  const adapter = {
    id: inner.id,
    getCapabilities: () => inner.getCapabilities(),
    start: async (input: StartRunInput) => {
      starts.push(input)
      if (options.onStart !== undefined) await options.onStart(input)
      return inner.start(input)
    },
    events: (runId: string) => {
      if (options.failEvents === true) throw new Error('events exploded after the child was spawned')
      return inner.events(runId as never)
    },
    cancel: async (runId: string) => {
      cancelled.push(runId)
      return inner.cancel(runId as never)
    },
  } as unknown as SlaveRuntimeAdapter
  return { adapter, starts, cancelled }
}

describe('tick', () => {
  let fixture: Fixture
  let deps: TickDeps
  const repos: string[] = []

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "SlaveMessage", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
    repos.push(fixture.repoPath)
    deps = {
      workspaceId: brandWorkspaceId(fixture.workspaceId),
      registry: singleAdapterRegistry(
        new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'complete'], hookPath: REAL_GATE }),
      ),
    }
  })

  afterEach(async (): Promise<void> => {
    // The pumps outlive the tick by design, and a pump still writing while the next test truncates
    // is a cross-test failure that reads as a bug in whichever test runs second.
    await drainPumps()
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true })
    await prisma.$disconnect()
  })

  it('starts a run for a ready task and records its pid and worktree', async (): Promise<void> => {
    const report = await tick(deps)

    expect(report.started).toHaveLength(1)
    const run = await prisma.slaveRun.findFirstOrThrow()
    expect(run.pid).toBeGreaterThan(0)
    expect(run.worktreePath).toContain(join('.slaveofai', 'worktrees'))
  })

  describe("the recipient's next run sees the question (M36 t3)", () => {
    /** A question from somebody else, addressed to the slave this fixture is about to dispatch. */
    async function askTheFixtureSlave(body: string): Promise<string> {
      const team = await prisma.team.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
      const asker = await prisma.slave.create({ data: { teamId: team.id, name: 'Maya', role: 'product', runtimeRoles: ['product'] } })
      // `pauseReason` matters, not just `paused`: a question is pending only while its asker is
      // still waiting on it (`stillPendingQuestion`, packages/control/src/messaging.ts), which is
      // exactly the state `ask.ts` parks a run in.
      const askerRun = await prisma.slaveRun.create({
        data: { slaveId: asker.id, status: 'paused', pauseReason: 'waiting_for_answer', kind: 'planning' },
      })
      const message = await prisma.slaveMessage.create({
        data: {
          slaveId: asker.id,
          workspaceId: fixture.workspaceId,
          senderRunId: askerRun.id,
          recipientSlaveId: fixture.slaveId,
          threadId: 'thread-1',
          kind: 'question',
          body,
          actor: 'slave',
          expectsReply: true,
        },
      })
      return message.id
    }

    it('puts the pending question, its id and the answer envelope in the prompt', async (): Promise<void> => {
      const messageId = await askTheFixtureSlave('Which queue should retries land on?')
      const recorder = recordingAdapter()

      await tick({ ...deps, registry: singleAdapterRegistry(recorder.adapter) })

      const prompt = recorder.starts[0]?.prompt ?? ''
      expect(prompt).toContain('Which queue should retries land on?')
      expect(prompt).toContain(messageId)
      expect(prompt).toContain('Maya (product)')
      expect(prompt).toContain(ANSWER_BLOCK_OPEN)
      // The task itself is still there, under the inbox.
      expect(prompt).toContain('Add the thing')

      // M37 t2: which ids the prompt carried is recorded on `RunContext`'s `inbox` section source
      // -- the durable record `SlaveRun.suppliedMessageIds` used to be, now written BEFORE the
      // spawn rather than after it.
      const run = await prisma.slaveRun.findFirstOrThrow({ where: { taskId: fixture.taskId } })
      const context = await prisma.runContext.findUniqueOrThrow({ where: { runId: run.id } })
      expect(runContextManifestSchema.parse(context.sections).sections).toContainEqual({
        kind: 'inbox',
        messageIds: [messageId],
      })
    })

    it('has recorded what the run sees before the child is spawned, and hands the model exactly that', async (): Promise<void> => {
      await prisma.slave.update({ where: { id: fixture.slaveId }, data: { profile: 'You are Alex, and you test first.' } })
      const observed: { readonly prompt: string; readonly recorded: string | undefined }[] = []
      const recorder = recordingAdapter({
        onStart: async (input): Promise<void> => {
          // Spec §1, "record before spawn": a run without a row never spawned. Asserted from
          // inside `start`, because after the tick returns every order is indistinguishable.
          const row = await prisma.runContext.findUnique({ where: { runId: input.runId } })
          observed.push({ prompt: input.prompt, recorded: row?.prompt })
        },
      })

      await tick({ ...deps, registry: singleAdapterRegistry(recorder.adapter) })

      expect(observed).toHaveLength(1)
      expect(observed[0]?.recorded).toBe(observed[0]?.prompt)
      expect(observed[0]?.prompt).toContain('You are Alex, and you test first.')
    })

    it('leaves an ordinary prompt alone when nothing is pending and there is nobody to ask', async (): Promise<void> => {
      const recorder = recordingAdapter()

      await tick({ ...deps, registry: singleAdapterRegistry(recorder.adapter) })

      // The fixture's slave is the only one in this workspace, so there is no roster to offer and
      // no ask protocol to teach -- an offer the system would refuse anyway is not made.
      expect(recorder.starts[0]?.prompt).toBe('Task: Add the thing\n\nmake it work')
    })

    it('teaches an implementation run the ask envelope, and names the peers it may address (final review)', async (): Promise<void> => {
      const team = await prisma.team.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
      await prisma.slave.create({ data: { teamId: team.id, name: 'Maya', role: 'product', runtimeRoles: ['product'] } })
      const recorder = recordingAdapter()

      await tick({ ...deps, registry: singleAdapterRegistry(recorder.adapter) })

      const prompt = recorder.starts[0]?.prompt ?? ''
      expect(prompt).toContain(ASK_BLOCK_OPEN)
      expect(prompt).toContain('Maya')
      expect(prompt).toContain('product')
      // The task is still the last thing the slave reads.
      expect(prompt.endsWith('Task: Add the thing\n\nmake it work')).toBe(true)
    })

    it('does not carry a question that has already been answered', async (): Promise<void> => {
      const messageId = await askTheFixtureSlave('Which queue should retries land on?')
      const question = await prisma.slaveMessage.findUniqueOrThrow({ where: { id: messageId } })
      await prisma.slaveMessage.create({
        data: {
          slaveId: fixture.slaveId,
          workspaceId: fixture.workspaceId,
          recipientSlaveId: question.slaveId,
          threadId: question.threadId,
          replyToId: question.id,
          kind: 'answer',
          body: 'payments-retry',
          actor: 'slave',
        },
      })
      const recorder = recordingAdapter()

      await tick({ ...deps, registry: singleAdapterRegistry(recorder.adapter) })

      expect(recorder.starts[0]?.prompt).not.toContain('Which queue should retries land on?')
    })
  })

  it('writes the run its worktree and remembers the branch on the task', async (): Promise<void> => {
    await tick(deps)

    const run = await prisma.slaveRun.findFirstOrThrow()
    const task = await prisma.task.findFirstOrThrow()

    // The key is derived from the task id rather than its title: a title is mutable and the key
    // has to be reproducible on the task's second run, or the rework case can never match its own
    // previous worktree.
    expect(run.worktreePath).toContain(keyOf(task.id))
    expect(task.branch).toBe(`slaveofai/${keyOf(task.id)}-add-the-thing`)
  })

  it('keeps the settings file and the pause flag out of the worktree', async (): Promise<void> => {
    await tick(deps)

    const run = await prisma.slaveRun.findFirstOrThrow()
    const worktreePath = run.worktreePath ?? ''

    // Task 14 runs verify inside the worktree, and Task 11 already flagged `.slaveofai/` as
    // untracked content in the operator's own repository. A settings file or a flag written into
    // the worktree makes every verify run see a dirty tree it did not create.
    const inWorktree = readdirSync(worktreePath)
    expect(inWorktree).not.toContain('settings.json')
    expect(inWorktree).not.toContain('pause.flag')
    expect(git(['status', '--porcelain'], worktreePath)).toBe('')
  })

  it('writes the resolved permission matrix into the run dir at dispatch (M18 Task 5)', async (): Promise<void> => {
    // A denied OPERATION that maps to real Claude Code tools (`resolveGrants` through the domain's
    // `TOOLS_BY_KIND`): `run_commands` -> the whole shell.
    await prisma.slavePermission.create({ data: { slaveId: fixture.slaveId, kind: 'run_commands', mode: 'deny' } })

    await tick(deps)

    const run = await prisma.slaveRun.findFirstOrThrow()
    // M52 R4 -- THE PIN THIS MILESTONE MOVES. `runFilePaths` is asked where the run directory is
    // rather than told: it is no longer `<repo>/.slaveofai/runs/<id>` but a directory outside the
    // repository entirely, because a worker that can delete its own verdict disarms itself, and
    // under default-deny that is a bypass of everything rather than a hole.
    const { runDir } = runFilePaths(fixture.repoPath, brandRunId(run.id))
    expect(runDir.startsWith(fixture.repoPath)).toBe(false)
    expect(existsSync(join(fixture.repoPath, '.slaveofai', 'runs'))).toBe(false)

    const written = JSON.parse(readFileSync(join(runDir, 'permissions.json'), 'utf8')) as {
      version: number
      runId: string
      tokenHash: string
      enforce: string
      grants: readonly string[]
      allow: readonly { tool: string; kind: string }[]
    }
    expect(written.version).toBe(2)
    expect(written.runId).toBe(run.id)
    expect(written.enforce).toBe('all-tools')
    // M52 R2: an ALLOW list. The implementation baseline minus the denied kind -- read and write,
    // and not one member of the shell family.
    expect(written.grants).toEqual(['read_repo', 'write_repo'])
    const allowed = written.allow.map((entry) => entry.tool)
    // M52 fix round 1 (the C1 classification): `run_commands` covers everything that can DO work
    // or spawn work that can -- the shell, a subagent, a skill, a workflow, the schedulers -- so
    // denying it denies the whole family, and this list is `TOOLS_BY_KIND.run_commands` in order.
    for (const tool of [
      'Bash',
      'BashOutput',
      'KillShell',
      'Task',
      'TaskStop',
      'Skill',
      'Workflow',
      'SendMessage',
      'EnterWorktree',
      'ExitWorktree',
      'EnterPlanMode',
      'ExitPlanMode',
      'CronCreate',
      'CronDelete',
      'CronList',
      'ScheduleWakeup',
      'RemoteTrigger',
      'PushNotification',
      'ReportFindings',
      'DesignSync',
    ]) {
      expect(allowed, tool).not.toContain(tool)
    }
    expect(allowed).toContain('Read')
    expect(allowed).toContain('Write')

    // M52 R4: the HASH of this spawn's token is on the row and in the file, and they agree. The
    // plaintext is in one child's environment and nowhere else -- not here.
    expect(written.tokenHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(run.runTokenHash).toBe(written.tokenHash)
  })

  it('writes an armed-but-empty permissions.json when nothing is denied (M18 Task 5)', async (): Promise<void> => {
    await tick(deps)

    const run = await prisma.slaveRun.findFirstOrThrow()
    const { runDir } = runFilePaths(fixture.repoPath, brandRunId(run.id))
    const written = JSON.parse(readFileSync(join(runDir, 'permissions.json'), 'utf8')) as {
      version: number
      grants: readonly string[]
    }
    // Present and armed. Under M52 R2 the file is no longer "empty means nothing denied" but the
    // whole verdict: an unedited matrix resolves to the implementation BASELINE, and an absent file
    // is no longer a permissive state at all -- it stops the run.
    expect(written.version).toBe(2)
    expect(written.grants).toEqual(['read_repo', 'write_repo', 'run_commands'])
  })

  it('emits guardrail.tripped and starts nothing when decide halts', async (): Promise<void> => {
    // Spend past the workspace's budget on a run that already concluded: money is spent whether or
    // not the run is still going, which is why `loadWorld` sums every run regardless of status.
    await prisma.slaveRun.create({
      data: {
        taskId: fixture.taskId,
        slaveId: fixture.slaveId,
        status: 'succeeded',
        costUsd: 999,
        terminalAt: new Date(),
      },
    })

    const report = await tick(deps)

    expect(report.started).toEqual([])
    expect(report.halted).not.toBeNull()
    expect(await eventTypesFor(fixture.workspaceId)).toContain('guardrail.tripped')
  })

  it('skips an archived workspace without loading the world', async (): Promise<void> => {
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { archivedAt: new Date() } })
    const report = await tick(deps)
    expect(report.skipped).toBe('archived')
    expect(report.started).toEqual([])
    expect(await prisma.slaveRun.count()).toBe(0)
  })

  // M27 final review, ruling R15. The tick above never reaches the insert -- it skips an archived
  // project before `loadWorld` -- so it cannot cover the window the fix is for: a dispatch that
  // already read an unarchived workspace and is about to write the run. The helper IS that window,
  // so it is called directly against a workspace archived under it, which is what an archive
  // committing mid-dispatch looks like from the insert's side.
  it('createRunUnlessArchived writes no run once the project is archived (M27 §8)', async (): Promise<void> => {
    const started = await createRunUnlessArchived(fixture.workspaceId, {
      taskId: fixture.taskId,
      slaveId: fixture.slaveId,
      status: 'starting',
    })
    expect(started).not.toBeNull()
    expect(await prisma.slaveRun.count()).toBe(1)

    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { archivedAt: new Date() } })

    const refused = await createRunUnlessArchived(fixture.workspaceId, {
      taskId: fixture.taskId,
      slaveId: fixture.slaveId,
      status: 'starting',
    })
    expect(refused).toBeNull()
    // Still the one row from before the archive: the refusal is the absence of a write, not a
    // failed run recorded against the task.
    expect(await prisma.slaveRun.count()).toBe(1)
  })

  it('createRunUnlessArchived writes no run for a workspace that is gone', async (): Promise<void> => {
    const refused = await createRunUnlessArchived('00000000-0000-4000-8000-000000000000', {
      taskId: fixture.taskId,
      slaveId: fixture.slaveId,
      status: 'starting',
    })
    expect(refused).toBeNull()
    expect(await prisma.slaveRun.count()).toBe(0)
  })

  it('does not repeat guardrail.tripped on a second tick while still halted', async (): Promise<void> => {
    await prisma.slaveRun.create({
      data: {
        taskId: fixture.taskId,
        slaveId: fixture.slaveId,
        status: 'succeeded',
        costUsd: 999,
        terminalAt: new Date(),
      },
    })

    await tick(deps)
    const afterFirst = (await eventTypesFor(fixture.workspaceId)).filter((t) => t === 'guardrail.tripped').length
    await tick(deps)
    const afterSecond = (await eventTypesFor(fixture.workspaceId)).filter((t) => t === 'guardrail.tripped').length

    // `decide()` returns `halt` on every tick the condition holds, but the *news* is the
    // transition. At the default 1000ms period a halt waiting for an operator would otherwise
    // write one event per second, forever, into an append-only log.
    expect(afterSecond).toBe(afterFirst)
  })

  it('pauses every active run once the budget is exhausted, and does not re-pause on the next tick', async (): Promise<void> => {
    const activeRun = await prisma.slaveRun.create({
      data: { taskId: fixture.taskId, slaveId: fixture.slaveId, status: 'working', costUsd: 999 },
    })

    await tick(deps)

    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: activeRun.id } })
    expect(after.status).toBe('pause_requested')
    expect(after.pauseReason).toBe('guardrail')

    // The fan-out lives inside the halt's one-shot -- a second tick observing the same halt must
    // not try to pause an already-`pause_requested` run again.
    await tick(deps)
    const stillOnce = await prisma.slaveRun.findUniqueOrThrow({ where: { id: activeRun.id } })
    expect(stillOnce.status).toBe('pause_requested')
  })

  it('announces the budget warning exactly once, and the durable check survives a restart', async (): Promise<void> => {
    // 85% of the default $20 budget: past BUDGET_WARNING_RATIO (0.8) but short of exhausted, so
    // this must not halt scheduling.
    await prisma.slaveRun.create({
      data: {
        taskId: fixture.taskId,
        slaveId: fixture.slaveId,
        status: 'succeeded',
        costUsd: 17,
        terminalAt: new Date(),
      },
    })

    const warningEvents = async (): Promise<number> => {
      const rows = await prisma.executionEvent.findMany({
        where: { workspaceId: fixture.workspaceId, type: 'guardrail_tripped' },
      })
      return rows.filter((event) => (event.payload as { guardrail?: string }).guardrail === 'budget_warning').length
    }

    await tick(deps)
    await tick(deps)
    expect(await warningEvents()).toBe(1)

    // Restart semantics (spec §5): the one-shot must be a durable existence check, not ANY
    // in-memory latch. A real restart is simulated by discarding every module-level state:
    // `vi.resetModules()` plus a fresh import re-evaluates tick.ts and everything it pulls in,
    // so a Map-based latch would come back empty, re-announce, and fail the count below --
    // `resetTickObservation()` alone cannot falsify that implementation. The drain first: the
    // fresh module has its own pumps set, invisible to the static `drainPumps` in afterEach.
    await drainPumps()
    vi.resetModules()
    const fresh = await import('../../src/tick.js')
    await fresh.tick(deps)
    expect(await warningEvents()).toBe(1)
  })

  describe('the Supervisor runs at the end of the tick (M38 t3)', () => {
    /** A second task, parked `blocked` at the review cap -- one situation, whose catalogue starts
     *  with the routine `unblock_task`. */
    async function parkedAtTheReviewCap(): Promise<string> {
      const task = await prisma.task.create({
        data: {
          workspaceId: fixture.workspaceId,
          title: 'Fix the flake',
          description: 'it fails on CI only',
          status: 'blocked',
          requiredRole: 'backend',
          attempt: 1,
          maxAttempts: 3,
        },
      })
      await prisma.executionEvent.create({
        data: {
          workspaceId: fixture.workspaceId,
          taskId: task.id,
          type: 'guardrail_tripped',
          actor: 'system',
          payload: { guardrail: 'review_retry_cap_exhausted', detail: 'out of review retries' },
        },
      })
      return task.id
    }

    it('decides by the rules when the daemon wired no decider, and reports what it did', async (): Promise<void> => {
      const blocked = await parkedAtTheReviewCap()

      const report = await tick(deps)

      expect(report.supervisor).toMatchObject({ situations: 1, decided: 1, applied: 1, modelCalls: 0, rulesOnly: true })
      const decision = await prisma.supervisorDecision.findFirstOrThrow()
      expect(decision.decidedBy).toBe('rules')
      expect((await prisma.task.findUniqueOrThrow({ where: { id: blocked } })).status).toBe('rework')
    })

    it('asks the decider the daemon threaded through, with the model the CLI named', async (): Promise<void> => {
      await parkedAtTheReviewCap()
      const prompts: string[] = []
      const supervisorDecider: ModelDecider = (input) => {
        prompts.push(input.prompt)
        return Promise.resolve({
          kind: 'answer',
          text: '{"candidateIndex": 0, "rationale": "an attempt is left, so send it back to rework"}',
          costUsd: 0.02,
          tokens: { input: 10, output: 5 },
          numTurns: 1,
        })
      }

      const report = await tick({ ...deps, supervisorDecider, supervisorModel: 'claude-sonnet-5' })

      expect(report.supervisor).toMatchObject({ decided: 1, modelCalls: 1, rulesOnly: false })
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain('"candidateIndex"')
      const decision = await prisma.supervisorDecision.findFirstOrThrow()
      expect(decision.decidedBy).toBe('model')
      expect(decision.modelCostUsd).toBe(0.02)
    })

    it('supervises a halted workspace too, by the rules, and escalates the halt itself', async (): Promise<void> => {
      // Spec §5 as clarified in fix round 1: the halt branch returns early, and the Supervisor
      // still runs on it -- a halted workspace is the one an operator most needs a decision about.
      await prisma.workspace.update({
        where: { id: fixture.workspaceId },
        data: { haltedReason: 'consecutive_failures', haltedAt: new Date() },
      })
      const prompts: string[] = []
      const supervisorDecider: ModelDecider = (input) => {
        prompts.push(input.prompt)
        return Promise.resolve({
          kind: 'answer',
          text: '{"candidateIndex": 0, "rationale": "never asked"}',
          costUsd: 1,
          tokens: null,
          numTurns: 1,
        })
      }

      const report = await tick({ ...deps, supervisorDecider, supervisorModel: 'claude-sonnet-5' })

      expect(report.halted).not.toBeNull()
      expect(report.supervisor).toMatchObject({ decided: 1, proposed: 1, applied: 0, modelCalls: 0, rulesOnly: true })
      // Not one model call: spending money to think about a workspace a guardrail has already
      // stopped is exactly the wrong move, and the gate is what says so.
      expect(prompts).toEqual([])
      const rows = await prisma.supervisorDecision.findMany({ where: { workspaceId: fixture.workspaceId } })
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        situationKind: 'workspace_halted',
        tier: 'escalated',
        status: 'pending',
        decidedBy: 'rules',
        modelCalled: false,
      })
      expect(rows[0]?.action).toMatchObject({ kind: 'escalate_to_human' })
    })

    /** A decider that answers if it is ever asked -- so "no model call" is a fact about the gate,
     *  not about the fixture having nothing to say. */
    function watchfulDecider(): { readonly decider: ModelDecider; readonly prompts: string[] } {
      const prompts: string[] = []
      return {
        prompts,
        decider: (input) => {
          prompts.push(input.prompt)
          return Promise.resolve({
            kind: 'answer',
            text: '{"candidateIndex": 0, "rationale": "never asked"}',
            costUsd: 1,
            tokens: null,
            numTurns: 1,
          })
        },
      }
    }

    /** Spends `usd` on a concluded run of this workspace -- what the budget guardrail reads. */
    async function spend(usd: number): Promise<void> {
      await prisma.slaveRun.create({
        data: { slaveId: fixture.slaveId, status: 'succeeded', kind: 'implementation', costUsd: usd, terminalAt: new Date() },
      })
    }

    /**
     * Erratum E7. `tick()` halts on five guardrail breaches and only ONE of them (an emergency
     * stop) writes `Workspace.haltedReason` -- so before this, a budget-exhausted or circuit-broken
     * workspace reached the Supervisor looking perfectly healthy: no `workspace_halted`, routine
     * actions applying, and the model seam open. The halt the Supervisor sees is now the
     * scheduler's own guardrail evaluation, minus concurrency.
     */
    it('sees an exhausted budget as a halt even though nothing wrote haltedReason', async (): Promise<void> => {
      const blocked = await parkedAtTheReviewCap()
      await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { budgetUsd: 1 } })
      await spend(2)
      const watcher = watchfulDecider()

      const report = await tick({ ...deps, supervisorDecider: watcher.decider, supervisorModel: 'claude-sonnet-5' })

      expect(report.halted).toBe('budget_exhausted')
      expect(report.supervisor).toMatchObject({ decided: 2, applied: 0, proposed: 2, modelCalls: 0, rulesOnly: true })
      expect(watcher.prompts).toEqual([])
      const rows = await prisma.supervisorDecision.findMany({ where: { workspaceId: fixture.workspaceId } })
      const halt = rows.find((row) => row.situationKind === 'workspace_halted')
      expect(halt).toMatchObject({ tier: 'escalated', status: 'pending', decidedBy: 'rules', modelCalled: false })
      expect(halt?.action).toMatchObject({ kind: 'escalate_to_human' })
      // And the action that WOULD have been routine here is offered as a proposal instead: a halted
      // workspace is one a guardrail stopped, so the Supervisor may only say what it would do. With
      // no routine candidate left to pick, the rules escalate rather than choose a proposal on a
      // human's behalf -- so the row is an escalation whose catalogue records the unblock as
      // `proposed`, and nothing was applied.
      const capped = rows.find((row) => row.situationKind === 'review_cap_blocked')
      expect(capped?.status).toBe('pending')
      expect(capped?.tier).not.toBe('applied')
      expect((capped?.candidates as { action: { kind: string }; tier: string }[])[0]).toMatchObject({
        action: { kind: 'unblock_task' },
        tier: 'proposed',
      })
      expect((await prisma.task.findUniqueOrThrow({ where: { id: blocked } })).status).toBe('blocked')
    })

    it('sees a tripped circuit breaker as a halt too', async (): Promise<void> => {
      const blocked = await parkedAtTheReviewCap()
      for (let index = 0; index < 3; index += 1) {
        await prisma.slaveRun.create({
          data: {
            slaveId: fixture.slaveId,
            status: 'failed',
            kind: 'implementation',
            terminalAt: new Date(Date.now() - index * 60_000),
          },
        })
      }
      const watcher = watchfulDecider()

      const report = await tick({ ...deps, supervisorDecider: watcher.decider, supervisorModel: 'claude-sonnet-5' })

      expect(report.halted).toBe('circuit_breaker')
      expect(watcher.prompts).toEqual([])
      const rows = await prisma.supervisorDecision.findMany({ where: { workspaceId: fixture.workspaceId } })
      expect(rows.find((row) => row.situationKind === 'workspace_halted')).toMatchObject({
        tier: 'escalated',
        status: 'pending',
        decidedBy: 'rules',
        modelCalled: false,
      })
      expect((await prisma.task.findUniqueOrThrow({ where: { id: blocked } })).status).toBe('blocked')
    })

    it('does not call a workspace merely at its concurrency cap halted, and still applies a routine unblock', async (): Promise<void> => {
      const blocked = await parkedAtTheReviewCap()
      await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { maxConcurrentRuns: 1 } })
      await prisma.slaveRun.create({
        data: { slaveId: fixture.slaveId, status: 'working', kind: 'implementation' },
      })

      const report = await tick(deps)

      // `decide()` HAS halted scheduling -- and the Supervisor deliberately disagrees: a workspace
      // at its run cap is busy, not stuck. Escalating that would put a proposal in front of a human
      // every time the machine was working, and freeze every routine action while it did.
      expect(report.halted).toBe('concurrency')
      const rows = await prisma.supervisorDecision.findMany({ where: { workspaceId: fixture.workspaceId } })
      expect(rows.map((row) => row.situationKind)).toEqual(['review_cap_blocked'])
      expect(rows[0]).toMatchObject({ tier: 'applied', status: 'applied' })
      expect((await prisma.task.findUniqueOrThrow({ where: { id: blocked } })).status).toBe('rework')
    })

    it('reports a supervisor that decided nothing on the paths that never reach it', async (): Promise<void> => {
      await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { archivedAt: new Date() } })

      const report = await tick(deps)

      expect(report.skipped).toBe('archived')
      expect(report.supervisor).toEqual({
        situations: 0,
        decided: 0,
        applied: 0,
        proposed: 0,
        skippedCooldown: 0,
        modelCalls: 0,
        rulesOnly: true,
        answered: 0,
        drafted: 0,
        pruned: 0,
      })
    })

    it('reads the workspace stats ONCE per tick, and the Supervisor decides from that reading', async (): Promise<void> => {
      // M39 §4. The scheduler's `loadWorld` and the Supervisor's `loadSupervisorWorld` both need
      // the limits, the run counts, the streak and the halt, and before this the tick paid for both
      // -- the most expensive query in either loader, twice a second on a daemon. Passing the
      // snapshot through is also the more honest reading: the halt the Supervisor sees is the one
      // `decide()` acted on this tick.
      await parkedAtTheReviewCap()
      statsCalls.length = 0

      const report = await tick(deps)

      expect(report.supervisor).toMatchObject({ decided: 1 })
      expect(statsCalls).toEqual([fixture.workspaceId])
    })
  })

  it('records a provisioning failure as a failed run that counts as an attempt', async (): Promise<void> => {
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { setupCommands: ['exit 3'] },
    })

    await tick(deps)

    const run = await prisma.slaveRun.findFirstOrThrow()
    expect(run.status).toBe('failed')
    const task = await prisma.task.findFirstOrThrow()
    expect(task.attempt).toBe(1)
    expect(await eventTypesFor(fixture.workspaceId)).toContain('run.failed')
  })

  it('starts no second run on the next tick after a gate failure halted the workspace', async (): Promise<void> => {
    // The halt Task 12's pump writes on a gate failure is the same `Workspace.haltedReason` column
    // `decide()` reads as `stats.emergencyStopped` -- this is the tick's side of proving a halted
    // workspace stays uncontrollable-run-free.
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { haltedReason: 'gate failure', haltedAt: new Date() },
    })

    const report = await tick(deps)

    expect(report.started).toEqual([])
  })

  it('gives a reworked task a second run instead of burning its attempts on provisioning', async (): Promise<void> => {
    await tick(deps)
    await drainPumps()

    // The first run's worktree and branch are still on disk -- §7.4 preserves them on purpose --
    // and `decide()` lists `rework` in STARTABLE, so the second run arrives at provisioning with
    // the same key. Treating that as a provisioning failure counts an attempt without a run, and
    // the task reaches its cap without a second slave ever starting.
    await prisma.slaveRun.deleteMany({})
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { status: 'rework', attempt: 1, lastRejectionReason: 'verify failed: npm test' },
    })

    const report = await tick(deps)

    expect(report.started).toHaveLength(1)
    const task = await prisma.task.findFirstOrThrow()
    expect(task.attempt).toBe(1) // the failed verify's attempt, not a second one for provisioning
    const run = await prisma.slaveRun.findFirstOrThrow()
    expect(run.status).not.toBe('failed')
  })

  it('adopts the reworked worktree even when the task has been renamed since', async (): Promise<void> => {
    await tick(deps)
    await drainPumps()
    const branchAfterFirst = (await prisma.task.findFirstOrThrow()).branch

    await prisma.slaveRun.deleteMany({})
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { status: 'rework', attempt: 1, title: 'Completely different title now' },
    })

    const report = await tick(deps)

    // Re-deriving the slug from the title would compute a *different* branch, so the existing
    // worktree would report `directory` rather than `both` and an ordinary rework would escalate.
    // The branch is read back from the task, which is why it is persisted at all.
    expect(report.started).toHaveLength(1)
    expect((await prisma.task.findFirstOrThrow()).branch).toBe(branchAfterFirst)
  })

  it("escalates leftovers that are not this task's own previous attempt", async (): Promise<void> => {
    // A `ready` task -- never provisioned -- with a directory sitting at its worktree path. That
    // is wreckage §7.4 preserved for an operator, not a rework, and handing it to a slave would
    // give the run someone else's tree.
    mkdirSync(join(fixture.repoPath, '.slaveofai', 'worktrees', keyOf(fixture.taskId)), {
      recursive: true,
    })

    const report = await tick(deps)

    expect(report.started).toEqual([])
    const run = await prisma.slaveRun.findFirstOrThrow()
    expect(run.status).toBe('failed')
    const task = await prisma.task.findFirstOrThrow()
    expect(task.attempt).toBe(1)
    expect(await eventTypesFor(fixture.workspaceId)).toContain('run.failed')
  })

  it('refuses to adopt a valid worktree for a task that is not reworking', async (): Promise<void> => {
    await tick(deps)
    await drainPumps()

    // A genuine, registered worktree on the right branch -- everything `adoptWorktree` verifies --
    // but the task is `ready`, not `rework`. Only a rework means "my own previous attempt left
    // this"; a ready task with a worktree is state nobody can account for, and §7.4 preserved it
    // for an operator to look at rather than for the next slave to inherit.
    //
    // The bare-directory case above cannot pin this: `adoptWorktree` rejects an unregistered path
    // on its own, so dropping the rework guard still fails there. This is the shape where adopting
    // would otherwise succeed.
    await prisma.slaveRun.deleteMany({})
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { status: 'ready', activeRunId: null },
    })

    const report = await tick(deps)

    expect(report.started).toEqual([])
    const run = await prisma.slaveRun.findFirstOrThrow()
    expect(run.status).toBe('failed')
  })

  it('starts nothing while the workspace is already at its concurrency limit', async (): Promise<void> => {
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { maxConcurrentRuns: 1 },
    })
    const otherTask = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'already running',
        description: 'holds the only slot',
        status: 'running',
        requiredRole: 'backend',
        maxAttempts: 3,
      },
    })
    await prisma.slaveRun.create({
      data: { taskId: otherTask.id, slaveId: fixture.slaveId, status: 'working' },
    })

    const report = await tick(deps)

    // `decide()` enforces this, and that is the point: the tick executes the command list rather
    // than iterating tasks itself, so it cannot start a run the scheduler did not ask for.
    expect(report.started).toEqual([])
  })

  it('returns before the run it started has finished', async (): Promise<void> => {
    const report = await tick(deps)

    // The pump outlives the tick by design (spec §5.6). Awaiting it would make one tick as long as
    // one run, and the sweep, the reconcile pass and every other workspace would wait behind it.
    expect(report.started).toHaveLength(1)
    const run = await prisma.slaveRun.findFirstOrThrow()
    expect(['starting', 'working']).toContain(run.status)
  })

  it('does not start a second run for the same task on the next tick', async (): Promise<void> => {
    const first = await tick(deps)
    expect(first.started).toHaveLength(1)

    // A second idle slave exists, and `decide()` treats `ready` and `rework` as startable -- so a
    // task the tick left in either would be handed straight to that slave one second later, and
    // the same work would be done twice on two branches.
    const team = await prisma.team.findFirstOrThrow()
    await prisma.slave.create({ data: { teamId: team.id, name: 'Blair', role: 'backend', runtimeRoles: ['backend'] } })

    const second = await tick(deps)

    expect(second.started).toEqual([])
    expect(await prisma.slaveRun.count()).toBe(1)
  })

  it('refuses -- as an attempted run that failed, not a silent skip -- when the workspace has no configured default provider', async (): Promise<void> => {
    // `seed()` gives this workspace a `ProviderConfiguration` row; removing it reproduces a
    // workspace nothing has configured at all, and the fixture slave names no model/provider
    // anywhere in its own chain either -- so `resolveRuntime` has nothing to fall back to.
    await prisma.providerConfiguration.deleteMany({ where: { workspaceId: fixture.workspaceId } })

    const report = await tick(deps)

    expect(report.started).toEqual([])
    const run = await prisma.slaveRun.findFirstOrThrow()
    // An ATTEMPTED run that failed (spec §13), exactly like a worktree that could not be
    // provisioned -- not the silent "nothing to attempt" `decide()` produces for an all-busy
    // roster, because unlike busyness this will not resolve itself on the next tick.
    expect(run.status).toBe('failed')
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.attempt).toBe(1)
    const failures = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, runId: run.id, type: 'run_failed' },
    })
    expect(failures).toHaveLength(1)
    expect((failures[0]?.payload as { reason: string }).reason).toContain(
      'no configured default provider',
    )
  })

  it('refuses with the spec-verbatim invalid_provider text when the chain names a provider this process has no adapter for', async (): Promise<void> => {
    // A `ProviderKind` the type system accepts but this registry was never given an adapter for --
    // exactly Task 7's ledger gap: `isProviderKind` (write time) only checks union membership, so
    // writing this pair succeeds, and dispatch (this task) is the first thing that can tell the
    // difference between "known kind" and "configured kind".
    await prisma.slave.update({ where: { id: fixture.slaveId }, data: { model: 'whatever', provider: 'cursor' } })
    // The REAL registry, not the test's own `singleAdapterRegistry` stub (which ignores `kind`
    // entirely and would silently paper over exactly the bug under test here) -- built with only
    // `claude_code` configured, matching production today (Cursor is Task 12's).
    const realRegistry = buildRegistry({ claudeCode: { command: 'node', extraArgs: [FAKE, '--fixture', 'complete'], hookPath: REAL_GATE } })

    const report = await tick({ ...deps, registry: realRegistry })

    expect(report.started).toEqual([])
    const run = await prisma.slaveRun.findFirstOrThrow()
    expect(run.status).toBe('failed')
    const failures = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, runId: run.id, type: 'run_failed' },
    })
    expect(failures).toHaveLength(1)
    expect((failures[0]?.payload as { reason: string }).reason).toBe(
      refusalText({ kind: 'invalid_provider', provider: 'cursor' }),
    )
  })

  it('refuses with the spec-verbatim unmeasurable_budget text when a budgeted workspace resolves a cost-blind runtime', async (): Promise<void> => {
    // Spec §6's dispatch-time half (M12 Task 9, ruling R9). The re-check exists because resolution
    // crosses four levels: a template edit can turn a workspace that was valid when it was
    // configured into one whose workers run on a runtime that reports no spend, and the write-time
    // refusal cannot see an edit made after it ran.
    //
    // The registry here DOES resolve `cursor`, unlike the `invalid_provider` test above -- with
    // no adapter registered for it, dispatch would refuse for that other reason first and this
    // check would never be reached, so a registry that stops at `invalid_provider` would prove
    // nothing about this one.
    await prisma.slave.update({ where: { id: fixture.slaveId }, data: { model: 'whatever', provider: 'cursor' } })
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { budgetUsd: 20 } })
    const recorder = recordingAdapter()
    const costBlindRegistry: AdapterRegistry = { resolve: () => recorder.adapter }

    const report = await tick({ ...deps, registry: costBlindRegistry })

    expect(report.started).toEqual([])
    // Never spawned: the refusal has to land before the process, or the money is already spent.
    expect(recorder.starts).toEqual([])
    const run = await prisma.slaveRun.findFirstOrThrow()
    expect(run.status).toBe('failed')
    const failures = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, runId: run.id, type: 'run_failed' },
    })
    expect(failures).toHaveLength(1)
    // Compared against `refusalText()` IMPORTED, never hand-copied, and asserted on the TEXT
    // rather than only on `status === 'failed'` -- a test that `throw new Error('boom')` would
    // pass is not a test (Task 8's fix round F3).
    expect((failures[0]?.payload as { reason: string }).reason).toBe(
      refusalText({ kind: 'unmeasurable_budget', workspaceId: fixture.workspaceId, provider: 'cursor' }),
    )
  })

  it('dispatches that same cost-blind runtime freely once the workspace has no budget', async (): Promise<void> => {
    // The other half of the ruling, and the half that makes §10's milestone gate buildable at all:
    // an unbudgeted workspace runs a cost-blind provider without complaint.
    await prisma.slave.update({ where: { id: fixture.slaveId }, data: { model: 'whatever', provider: 'cursor' } })
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { budgetUsd: null } })
    const recorder = recordingAdapter()
    const costBlindRegistry: AdapterRegistry = { resolve: () => recorder.adapter }

    const report = await tick({ ...deps, registry: costBlindRegistry })

    expect(report.started).toHaveLength(1)
    const run = await prisma.slaveRun.findFirstOrThrow()
    expect(run.provider).toBe('cursor')
  })

  it('kills the slave it just spawned when the start fails after the spawn', async (): Promise<void> => {
    const recorder = recordingAdapter({ failEvents: true })

    const report = await tick({ ...deps, registry: singleAdapterRegistry(recorder.adapter) })

    // The window between `adapter.start()` returning and the row being updated is the one place a
    // live child can be orphaned: the run row goes terminal with no pid, and §3.4's startup sweep
    // only looks at NON-terminal runs with dead pids, so nothing in the system can ever find it
    // again. Meanwhile the task goes back to the startable set and the next slave joins it in the
    // same worktree.
    expect(report.started).toEqual([])
    expect(recorder.starts).toHaveLength(1)
    expect(recorder.cancelled).toEqual([recorder.starts[0]?.runId])

    const run = await prisma.slaveRun.findFirstOrThrow()
    expect(run.status).toBe('failed')
  })

  it('starts one run, not two, when two ticks overlap', async (): Promise<void> => {
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { setupCommands: ['sleep 1'] },
    })
    const team = await prisma.team.findFirstOrThrow()
    await prisma.slave.create({ data: { teamId: team.id, name: 'Blair', role: 'backend', runtimeRoles: ['backend'] } })

    // Spec §3.1 runs this on a 1000ms timer while provisioning is awaited inline and a setup
    // command may take minutes -- so overlapping ticks are the normal case on the first real
    // workspace, not an edge one. Both load the same world and `decide()` hands both the same
    // `start_run`.
    const [first, second] = await Promise.all([tick(deps), tick(deps)])

    expect([...first.started, ...second.started]).toHaveLength(1)
    const runs = await prisma.slaveRun.findMany()
    expect(runs.filter((r) => r.status !== 'failed')).toHaveLength(1)

    // And the loser must not rewrite the winner's task. Asserted after the drain rather than at
    // the moment the ticks return, because the winner's pump may legitimately conclude and verify
    // at any point after -- `running` here would be a race, not a property. Every shape the loser
    // could leave is still visible in the final state: a rewrite to `ready`/`rework` makes
    // `advance` refuse and the task never reaches `done`, a burned attempt shows in the counter,
    // and a lingering `activeRunId` shows as the run `advance` would have cleared.
    await drainPumps()
    const task = await prisma.task.findFirstOrThrow()
    // The pipeline flip (M8a): a green verify hands the task to review, not to `done` -- so the
    // race's winner is visible here as `reviewing`, not `done`.
    expect(task.status).toBe('reviewing')
    expect(task.attempt).toBe(0)
    expect(task.activeRunId).toBeNull()

    // No reviewer-role slave exists in this fixture. `dispatchReviews` runs on every tick (it is
    // part of `tick()` itself, spec §3.2/Task 5) and escalates that once rather than trying forever
    // -- proving the task is not just parked in `reviewing` but visibly stuck for an operator.
    await tick(deps)
    const guardrails = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, type: 'guardrail_tripped' },
    })
    const noReviewerEvents = guardrails.filter(
      (event) => (event.payload as { guardrail?: string }).guardrail === 'no_reviewer',
    )
    expect(noReviewerEvents).toHaveLength(1)
  })

  it('does not turn the leftovers it refused into leftovers it will adopt', async (): Promise<void> => {
    await tick(deps)
    await drainPumps()
    await prisma.slaveRun.deleteMany({})
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { status: 'ready', activeRunId: null },
    })

    await tick(deps) // refuses: a `ready` task's worktree is unaccounted-for state

    // ...but if the refusal parks the task in `rework`, the next tick meets the guard's own
    // precondition and adopts the very tree it just called wreckage. The property has to survive
    // more than one tick to be a property at all.
    const report = await tick(deps)

    expect(report.started).toEqual([])
    // And the Supervisor -- running at the end of every one of those ticks -- did not undo the
    // park either (erratum E5). `task_blocked_human` is a person's park, so its `unblock_task` is
    // a PROPOSAL: the row waits for a human and the task stays `blocked`, where the guard put it.
    expect((await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).status).toBe('blocked')
    const proposals = await prisma.supervisorDecision.findMany({ where: { workspaceId: fixture.workspaceId } })
    expect(proposals.length).toBeGreaterThan(0)
    expect(proposals.every((row) => row.status === 'pending')).toBe(true)
  })

  it('re-runs the setup commands when it adopts a worktree', async (): Promise<void> => {
    const log = join(fixture.repoPath, 'setup-log')
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { setupCommands: [`echo ran >> ${log}`] },
    })

    await tick(deps)
    await drainPumps()
    await prisma.slaveRun.deleteMany({})
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { status: 'rework', attempt: 1, activeRunId: null },
    })

    await tick(deps)

    // The commonest route to adopt is a setup command that failed, because that is exactly what
    // leaves a half-provisioned worktree behind (§7.4). Adopting without re-running setup starts an
    // slave in a tree with no node_modules, which then fails verify for reasons that have nothing
    // to do with its work.
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('keeps the verify feedback when an infrastructure failure interrupts a rework', async (): Promise<void> => {
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { status: 'rework', attempt: 1, lastRejectionReason: 'verify failed: 3 assertions in cart.spec.ts' },
    })
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { setupCommands: ['exit 3'] },
    })

    await tick(deps)

    // `lastRejectionReason` is the slave-facing channel: the `rejection` section puts it in front
    // of the next run as the thing to fix first. An orchestrator-side failure overwriting it both destroys the
    // real feedback §8 requires and instructs the next slave to go and fix a setup command.
    const task = await prisma.task.findFirstOrThrow()
    expect(task.lastRejectionReason).toContain('cart.spec.ts')
  })

  it('puts the previous rejection in front of the next run', async (): Promise<void> => {
    const recorder = recordingAdapter()
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { status: 'rework', attempt: 1, lastRejectionReason: 'verify failed: cart totals are wrong' },
    })

    await tick({ ...deps, registry: singleAdapterRegistry(recorder.adapter) })

    // Spec §8's loop is the reason `lastRejectionReason` exists: a rework that does not tell the
    // slave what broke is a re-roll, not a fix.
    expect(recorder.starts[0]?.prompt).toContain('cart totals are wrong')
  })

  it('announces a halt again after the first one was cleared', async (): Promise<void> => {
    const exhaust = async (): Promise<void> => {
      await prisma.slaveRun.create({
        data: {
          taskId: fixture.taskId,
          slaveId: fixture.slaveId,
          status: 'succeeded',
          costUsd: 999,
          terminalAt: new Date(),
        },
      })
    }

    await exhaust()
    await tick(deps)
    const afterFirst = (await eventTypesFor(fixture.workspaceId)).filter((t) => t === 'guardrail.tripped').length

    // The operator raises the budget -- the §11 `clear-halt` shape of the same thing -- and the
    // workspace halts again later. Tracking only the `false -> true` edge without ever re-arming
    // means the second halt is never announced at all.
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { budgetUsd: 100_000 } })
    await tick(deps)
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { budgetUsd: 1 } })
    await tick(deps)

    const afterThird = (await eventTypesFor(fixture.workspaceId)).filter((t) => t === 'guardrail.tripped').length
    expect(afterThird).toBe(afterFirst + 1)
  })

  it('fails a task that has used its last attempt, and says so', async (): Promise<void> => {
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { setupCommands: ['exit 3'] },
    })
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { attempt: 2, maxAttempts: 3 },
    })

    await tick(deps)

    // The attempt cap is what stops a permanently unprovisionable task being handed to a slave
    // every second forever. Off by one here gives every task one extra start and nothing notices.
    const task = await prisma.task.findFirstOrThrow()
    expect(task.attempt).toBe(3)
    expect(task.status).toBe('failed')
    expect(await eventTypesFor(fixture.workspaceId)).toContain('task.failed')
  })

  it("leaves the operator's own repository clean", async (): Promise<void> => {
    await tick(deps)

    // Everything the orchestrator writes lands under `.slaveofai/` in the workspace's repo -- the
    // worktrees, the per-run settings file, the pause flag -- and none of it belongs to the
    // operator. Left untracked it shows in every `git status` they run, and a routine
    // `git clean -fdx` deletes the worktree directories while `.git/worktrees/` metadata survives.
    expect(git(['status', '--porcelain'], fixture.repoPath)).toBe('')
  })

  it('records that the task started', async (): Promise<void> => {
    await tick(deps)

    // This is the only producer of `task.started` in the product, and M4 reads it.
    expect(await eventTypesFor(fixture.workspaceId)).toContain('task.started')
  })

  it('drainPumps waits for the run it started', async (): Promise<void> => {
    await tick(deps)
    await drainPumps()

    // The drain is the daemon's shutdown join point and the tests' guard against truncating a
    // table under a live write. A drain that returns immediately is worse than none, because
    // everything downstream believes it.
    const run = await prisma.slaveRun.findFirstOrThrow()
    expect(['succeeded', 'failed']).toContain(run.status)
  })

  it('counts a roleless task instead of dropping it, and still starts the rest', async (): Promise<void> => {
    await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'nobody can pick this up',
        description: 'no required role',
        status: 'ready',
        maxAttempts: 3,
      },
    })

    const report = await tick(deps)

    expect(report.skippedNoRole).toBe(1)
    expect(report.started).toHaveLength(1)
  })
})
