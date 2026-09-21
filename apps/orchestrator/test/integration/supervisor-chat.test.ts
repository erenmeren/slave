import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  drainSupervisorChatCalls,
  listDecisions,
  listSupervisorMessages,
  sendSupervisorMessage,
  tickSupervisorChat,
  writePermissionsFile,
} from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildDeciderRegistry } from '../../src/cli.js'

/**
 * The Supervisor conversation answered by the REAL wiring (F R2/R4/R5): `buildDeciderRegistry()`
 * as the daemon builds it, `decideWithModel`/`decideWithCursor` as it really spawns them, and a
 * fake vendor CLI at the end of each. Nothing here is scripted in process -- the control package's
 * own `supervisor-chat.test.ts` covers the tick against an `async () => …`, and what is left
 * unproven by that is exactly this file's subject: that the registry the CLI assembles, the flags
 * it spawns with and the arm the fake answers on line up.
 *
 * `tickSupervisorChat` is driven directly rather than through `runDaemon`: the daemon's own pass
 * (the printed line and the shutdown drain) is `daemon.test.ts`' subject, and a daemon here would
 * add a subscription, a loop per project and a period to wait out for nothing this file asserts.
 *
 * Under `test/integration/` for `adapter-registry.test.ts`' reason: importing `cli.js` pulls the
 * Prisma client in. Importing it runs nothing -- `main()` is guarded by the `argv[1]` check at the
 * bottom of that file.
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
/** The print-mode Cursor fake (F R5). Its default `answer` fixture already carries a reply
 *  envelope, and -- measured, not chosen -- no cost field of any name. */
const FAKE_CURSOR = join(repoRoot, 'packages/providers/test/fake-cursor-print.mjs')

/** Every variable a case here sets, restored afterwards: `process.env` is process-wide and the
 *  registry reads it at CALL time, inside the closure, exactly as the daemon's does. */
const TOUCHED = [
  'SLAVEOFAI_REQUIRE_FAKE_CLI',
  'SLAVEOFAI_CLAUDE_BIN',
  'SLAVEOFAI_CLAUDE_ARGS',
  'SLAVEOFAI_CURSOR_BIN',
  'SLAVEOFAI_CURSOR_ARGS',
]
const saved = new Map<string, string | undefined>(TOUCHED.map((name) => [name, process.env[name]]))

/** FILE level, so both describes below get it: the integration project is single-threaded, but
 *  `process.env` is still process-wide and a case that armed the fakes must not decide what the
 *  next FILE sees. */
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

/** Points both binaries at their fakes, the shape every other orchestrator test spawns the CLI
 *  with. `node <fake.mjs>` is what `SLAVEOFAI_*_ARGS` is for: it rides through as `extraArgs` on
 *  every decision call, which is the ONLY channel that reaches one (M39 erratum E6). */
function useFakes(claudeArgs: readonly string[] = ['--fixture', 'complete']): void {
  process.env['SLAVEOFAI_REQUIRE_FAKE_CLI'] = '1'
  process.env['SLAVEOFAI_CLAUDE_BIN'] = 'node'
  process.env['SLAVEOFAI_CLAUDE_ARGS'] = [FAKE_CLAUDE, ...claudeArgs].join(' ')
  process.env['SLAVEOFAI_CURSOR_BIN'] = 'node'
  process.env['SLAVEOFAI_CURSOR_ARGS'] = FAKE_CURSOR
}

/** The actions the fake's chat arm puts in its reply -- base64 on argv, for the reason that file's
 *  `chatActions` gives: no environment variable reaches a decision call's child. */
const chatActions = (actions: readonly unknown[]): readonly string[] => [
  '--chat-actions-json-base64',
  Buffer.from(JSON.stringify(actions), 'utf8').toString('base64'),
]

const GOAL_REQUEST = 'ship the pricing page before the checkout rewrite'

describe('the Supervisor conversation, end to end through the real registry', () => {
  let workspaceId: string
  let repoPath: string

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "SupervisorMessage", "SupervisorDecision", "GoalVersion", "Task", "Slave", "Person", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
    )
    repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-chat-orchestrator-'))
    const workspace = await prisma.workspace.create({
      data: {
        name: 'Checkout Platform',
        repoPath,
        verifyCommands: ['npm test'],
        setupCommands: [],
        // `recordDecision` refuses on a project whose Supervisor is off, so an action a reply asks
        // for would never become a decision at all.
        supervisorEnabled: true,
      },
    })
    workspaceId = workspace.id
    useFakes()
  })

  afterEach(async (): Promise<void> => {
    await drainSupervisorChatCalls()
    rmSync(repoPath, { recursive: true, force: true })
  })

  /** One message, and the reply the tick settles for it. Drained, because the call is detached. */
  async function turn(text: string): Promise<void> {
    const sent = await sendSupervisorMessage(workspaceId, { text })
    if (!sent.ok) throw new Error(JSON.stringify(sent.error))
    await tickSupervisorChat({
      now: new Date(),
      by: 'supervisor-chat.test',
      deciders: buildDeciderRegistry(),
      defaultModel: 'claude-sonnet-5',
    })
    await drainSupervisorChatCalls()
  }

  it('answers a waiting turn with the fake CLI, priced and not sourced', async (): Promise<void> => {
    await turn('why is nothing running?')

    const [question, reply] = await listSupervisorMessages(workspaceId)
    expect(question).toMatchObject({ role: 'human', status: 'sent', text: 'why is nothing running?' })
    expect(reply).toMatchObject({
      role: 'supervisor',
      status: 'answered',
      text: 'On it.',
      // The chat arm's own cost line: a Claude turn is MEASURED, which is the half of erratum E2
      // the Cursor case below is the other half of.
      modelCostUsd: 0.01,
      unmeasured: false,
      // The fake cites nothing, and a reply that cites nothing is an ordinary reply.
      sourced: false,
      actions: null,
      failureReason: null,
    })
  })

  it('applies the action a reply asked for when the project is on act, and the goal changes', async (): Promise<void> => {
    await prisma.workspace.update({ where: { id: workspaceId }, data: { supervisorAutonomy: 'act' } })
    useFakes(['--fixture', 'complete', ...chatActions([{ kind: 'request_goal_change', request: GOAL_REQUEST }])])

    await turn('do the pricing page first, please')

    const reply = (await listSupervisorMessages(workspaceId))[1]
    expect(reply?.status).toBe('answered')
    expect(reply?.actions).toMatchObject([
      { action: { kind: 'request_goal_change', request: GOAL_REQUEST }, tier: 'applied' },
    ])
    // R3's whole point: the conversation borrows the Supervisor's authority, so `act` means the
    // goal really moved -- `requestChange` amends the standing goal and writes a version.
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
    expect(workspace.goal).toContain(GOAL_REQUEST)
    const versions = await prisma.goalVersion.findMany({ where: { workspaceId } })
    expect(versions).toHaveLength(1)
    expect(versions[0]?.request).toBe(GOAL_REQUEST)
    // Applied, so there is nothing left waiting on a person.
    expect(await listDecisions(workspaceId, { pending: true })).toHaveLength(0)
  })

  it('proposes the same action on a project that is on propose, and the goal does not move', async (): Promise<void> => {
    useFakes(['--fixture', 'complete', ...chatActions([{ kind: 'request_goal_change', request: GOAL_REQUEST }])])

    await turn('do the pricing page first, please')

    const reply = (await listSupervisorMessages(workspaceId))[1]
    // The turn is ANSWERED either way: a proposal is what the reply came to, not a failure of it.
    expect(reply?.status).toBe('answered')
    expect(reply?.actions).toMatchObject([
      { action: { kind: 'request_goal_change', request: GOAL_REQUEST }, tier: 'proposed' },
    ])
    const pending = await listDecisions(workspaceId, { pending: true })
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ situationKind: 'operator_request', status: 'pending' })
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).goal).toBeNull()
    expect(await prisma.goalVersion.count({ where: { workspaceId } })).toBe(0)
  })

  it('answers a Cursor project through the Cursor fake, with no price anybody could read', async (): Promise<void> => {
    await prisma.workspace.update({ where: { id: workspaceId }, data: { supervisorProvider: 'cursor' } })

    await turn('who is working on what?')

    const reply = (await listSupervisorMessages(workspaceId))[1]
    expect(reply).toMatchObject({
      status: 'answered',
      // The fake's own envelope: this reply could only have come from the Cursor entry of the
      // registry, which is what makes the provider column real.
      text: 'from cursor',
      // Erratum E2: `cursor-agent` reports no cost field of any name, so the turn is unmeasured
      // rather than free.
      modelCostUsd: null,
      unmeasured: true,
    })
  })
})

describe('buildDeciderRegistry', () => {
  /**
   * R7 at the ORCHESTRATOR's level (fix round 1, M3). The provider package proves what
   * `decideWithModel` does with `tools: 'read-only'`, and control proves the tick asks for it; what
   * neither can see is whether THIS file hands over the run gate rather than the deny-all one.
   *
   * Measured from inside the child, which is the only place a spawn's three halves are all
   * visible: `--fixture env-echo --env-out <path>` dumps its own argv, environment, cwd and the
   * parsed `--settings` file (`dumpChildEnv`). The permissions file is written with the control
   * layer's own `writePermissionsFile`, granting the `planning` baseline (`read_repo`), because the
   * run gate's pre-flight runs the REAL `scripts/pause-gate.sh` and a call armed with nothing would
   * never reach the spawn this case is about.
   */
  it('arms a read-only turn with the RUN gate, the read-only tools and the gate channels', async (): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), 'slaveofai-read-only-turn-'))
    try {
      const dumpPath = join(dir, 'child.jsonl')
      useFakes(['--fixture', 'env-echo', '--env-out', dumpPath])
      const runToken = randomBytes(32).toString('hex')
      const permissionsFilePath = writePermissionsFile(dir, {
        rows: [],
        provider: 'claude_code',
        runKind: 'planning',
        runId: 'm-read-only-turn',
        runToken,
      })

      await buildDeciderRegistry().claude_code({
        model: 'claude-sonnet-5',
        prompt: 'what does the screenshot show?',
        maxBudgetUsd: 1,
        tools: 'read-only',
        cwd: dir,
        permissionsFilePath,
        runToken,
      })

      const dump = JSON.parse(readFileSync(dumpPath, 'utf8').trim()) as {
        argv: readonly string[]
        env: Record<string, string>
        cwd: string
        settings: unknown
      }
      // The one word that changes between the two modes.
      expect(dump.argv[dump.argv.indexOf('--tools') + 1]).toBe('Read,Glob,Grep')
      // The RUN gate, not the deny-all one: this is the whole of what R7 buys and the one thing
      // only this file decides.
      const settings = JSON.stringify(dump.settings)
      expect(settings).toContain('pause-gate.sh')
      expect(settings).not.toContain('deny-all-gate.sh')
      // The two channels the gate reads. The token is `<present>` because the fake redacts it at
      // write time -- the NAME is what the assertion needs, and a live token on disk is what it
      // must not put there.
      expect(dump.env['SLAVEOFAI_PERMISSIONS_FILE']).toBe(permissionsFilePath)
      expect(dump.env['SLAVEOFAI_RUN_TOKEN']).toBe('<present>')
      // The repository, not the call's throwaway directory: it is where a path the person attached
      // resolves.
      expect(dump.cwd).toBe(realpathSync(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * I1: the refusal is asked HERE, before either closure exists, because only the `claude_code`
   * entry reaches `claudeCommand()` -- which raises it. Without this a process told it must not
   * reach a vendor account could build the registry, never make a Claude call, and spawn the real
   * `cursor-agent` for a chat turn on a project whose provider column says `cursor`.
   * `adapter-registry.test.ts`' own case, for the other registry.
   */
  it('refuses to build anything at all when the fake CLI was demanded and not supplied', (): void => {
    process.env['SLAVEOFAI_REQUIRE_FAKE_CLI'] = '1'
    process.env['SLAVEOFAI_CLAUDE_BIN'] = 'node'
    process.env['SLAVEOFAI_CURSOR_BIN'] = '/usr/local/bin/cursor-agent'

    expect(() => buildDeciderRegistry()).toThrow(/SLAVEOFAI_CURSOR_BIN/u)
  })

  it('refuses before it builds either entry, not at the call that would have spawned', (): void => {
    process.env['SLAVEOFAI_REQUIRE_FAKE_CLI'] = '1'
    process.env['SLAVEOFAI_CLAUDE_BIN'] = 'node'
    delete process.env['SLAVEOFAI_CURSOR_BIN']

    // The throw is the FUNCTION's, so there is no registry to hold and no cursor closure anybody
    // could call: a refusal that only arrived at the first Claude call would leave the Cursor entry
    // live and spawning.
    expect(() => buildDeciderRegistry()).toThrow(/SLAVEOFAI_CURSOR_BIN/u)
  })
})
