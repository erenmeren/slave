import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addCredential,
  bindBrokerOp,
  runFilePaths,
  setSlavePermission,
  type BrokerExecutor,
} from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { runId as brandRunId, workspaceId as brandWorkspaceId } from '@slave-of-ai/domain'
import { brokerChannelPathFor, brokerReplyPathFor, runTokenHash } from '@slave-of-ai/providers'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { realBrokerExecutor, resetBrokerCursors, serveBrokerRequests } from '../../src/broker.js'
import { COMMAND_OUTPUT_LIMIT } from '../../src/shell.js'

/**
 * The ORCHESTRATOR's half of the broker (M52 R3): the per-tick pass that reads a worker's channel
 * and the executor that actually spawns what survives authorisation.
 *
 * Two placeholders and no secrets, exactly as `packages/control`'s own broker test states it:
 * `TOKEN`/`OTHER_TOKEN` are 64 hex characters of one repeated pair, and the variable the credential
 * names holds a string that says what it is. Neither is a value anything real ever held, and the
 * assertions below check that neither reaches a reply file.
 */
const TOKEN = 'f0'.repeat(32)
const OTHER_TOKEN = '9c'.repeat(32)
const ID = 'ab'.repeat(16)
const OTHER_ID = 'cd'.repeat(16)
const PARAMS = { environment: 'staging', digest: 'a1b2c3d' }
const CREDENTIAL_PLACEHOLDER = 'not-a-real-secret'

let workspaceId: string
let slaveId: string
let runId: string
let otherRunId: string
let runDir: string
let otherRunDir: string
let executions = 0

const dirs: string[] = []
const previousStateDir = process.env['SLAVEOFAI_STATE_DIR']

/** Counts, and answers the way a bound deploy script that worked would. One executor rather than
 *  the two the plan sketched: every case that asserts "nothing ran" reads the same counter. */
const fakeExecutor: BrokerExecutor = async () => {
  executions += 1
  return { exitCode: 0, durationMs: 12, output: 'deployed' }
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** One line, exactly as the thin client appends it. */
function appendRequest(dir: string, request: Record<string, unknown>): void {
  appendFileSync(brokerChannelPathFor(dir), `${JSON.stringify(request)}\n`)
}

function readReply(dir: string, requestId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(brokerReplyPathFor(dir, requestId), 'utf8')) as Record<string, unknown>
}

/** A script the executor can be pointed at: absolute, executable, and outside every worktree. */
function script(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}`, { mode: 0o700 })
  chmodSync(path, 0o700)
  return path
}

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "BrokerBinding", "Credential", "SlavePermission", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )
  executions = 0
  resetBrokerCursors()
  process.env['FAKE_DEPLOY_TOKEN'] = CREDENTIAL_PLACEHOLDER
  // Every run directory this file reads lands under a temp root, so a pass here can never see a
  // real run's channel on this machine and a real daemon can never see one of these.
  process.env['SLAVEOFAI_STATE_DIR'] = tempDir('slaveofai-broker-state-')
  const repoPath = tempDir('slaveofai-broker-repo-')

  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath, verifyCommands: ['true'], setupCommands: [] },
  })
  workspaceId = workspace.id
  const team = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
  slaveId = (await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })).id
  const task = await prisma.task.create({
    data: { workspaceId, title: 'Ship it', description: 'ship', status: 'running', maxAttempts: 3 },
  })
  runId = (
    await prisma.slaveRun.create({
      data: { taskId: task.id, slaveId, kind: 'implementation', status: 'working', runTokenHash: runTokenHash(TOKEN) },
      select: { id: true },
    })
  ).id
  otherRunId = (
    await prisma.slaveRun.create({
      data: { taskId: task.id, slaveId, kind: 'implementation', status: 'working', runTokenHash: runTokenHash(OTHER_TOKEN) },
      select: { id: true },
    })
  ).id

  await setSlavePermission(slaveId, 'deploy_release', 'allow')
  await addCredential(workspaceId, { name: 'deploy', kind: 'deploy_token', envVar: 'FAKE_DEPLOY_TOKEN' })
  await bindBrokerOp(workspaceId, { op: 'deploy_release', command: ['/abs/fake-deploy.sh'], credentialName: 'deploy' })

  runDir = runFilePaths(repoPath, brandRunId(runId)).runDir
  otherRunDir = runFilePaths(repoPath, brandRunId(otherRunId)).runDir
})

afterAll(async (): Promise<void> => {
  delete process.env['FAKE_DEPLOY_TOKEN']
  if (previousStateDir === undefined) delete process.env['SLAVEOFAI_STATE_DIR']
  else process.env['SLAVEOFAI_STATE_DIR'] = previousStateDir
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  await prisma.$disconnect()
})

describe('serveBrokerRequests', () => {
  it('serves one request and writes the reply beside it', async (): Promise<void> => {
    appendRequest(runDir, { requestId: ID, runId, op: 'deploy_release', params: PARAMS, runToken: TOKEN })

    const served = await serveBrokerRequests({ workspaceId: brandWorkspaceId(workspaceId), execute: fakeExecutor })

    expect(served).toEqual([ID])
    expect(readReply(runDir, ID)).toEqual({ requestId: ID, ok: true, exitCode: 0, output: 'deployed', reason: null })
    // The two things that must never be in a file a worker can read back: its own token and the
    // credential the operation was run with.
    const written = readFileSync(brokerReplyPathFor(runDir, ID), 'utf8')
    expect(written).not.toContain(TOKEN)
    expect(written).not.toContain(CREDENTIAL_PLACEHOLDER)
  })

  it('serves a request EXACTLY ONCE, however many times the pass runs -- the reply file is the key', async (): Promise<void> => {
    appendRequest(runDir, { requestId: ID, runId, op: 'deploy_release', params: PARAMS, runToken: TOKEN })

    await serveBrokerRequests({ workspaceId: brandWorkspaceId(workspaceId), execute: fakeExecutor })
    await serveBrokerRequests({ workspaceId: brandWorkspaceId(workspaceId), execute: fakeExecutor })
    await serveBrokerRequests({ workspaceId: brandWorkspaceId(workspaceId), execute: fakeExecutor })

    expect(executions).toBe(1)
  })

  it('serves nothing twice after a DAEMON RESTART, which re-reads the channel from byte zero', async (): Promise<void> => {
    appendRequest(runDir, { requestId: ID, runId, op: 'deploy_release', params: PARAMS, runToken: TOKEN })
    await serveBrokerRequests({ workspaceId: brandWorkspaceId(workspaceId), execute: fakeExecutor })

    // What a restart does to this module's in-memory offsets: they are gone, and the channel is
    // read from byte zero again.
    resetBrokerCursors()
    await serveBrokerRequests({ workspaceId: brandWorkspaceId(workspaceId), execute: fakeExecutor })

    expect(executions).toBe(1)
  })

  it('REFUSES a line whose runId is not the directory it was found in (plan erratum E15)', async (): Promise<void> => {
    // A token lifted from a sibling's channel, replayed on the thief's OWN channel so the output
    // would be delivered to the thief. The token is real and the run it names is live; what is
    // wrong is only that the line is in the wrong directory.
    appendRequest(runDir, { requestId: ID, runId: otherRunId, op: 'deploy_release', params: PARAMS, runToken: OTHER_TOKEN })

    await serveBrokerRequests({ workspaceId: brandWorkspaceId(workspaceId), execute: fakeExecutor })

    expect(readReply(runDir, ID)).toMatchObject({ ok: false, reason: 'identity_mismatch' })
    expect(executions).toBe(0)
    // And nothing was written into the run the line claimed to be.
    expect(existsSync(brokerReplyPathFor(otherRunDir, ID))).toBe(false)
  })

  it('REFUSES a line carrying the wrong token, and says so in the reply the worker reads', async (): Promise<void> => {
    appendRequest(runDir, { requestId: ID, runId, op: 'deploy_release', params: PARAMS, runToken: 'a'.repeat(64) })

    await serveBrokerRequests({ workspaceId: brandWorkspaceId(workspaceId), execute: fakeExecutor })

    expect(readReply(runDir, ID)).toMatchObject({ ok: false, reason: 'identity_mismatch' })
    expect(executions).toBe(0)
  })

  it('ignores a line that is not JSON, a line over the cap, and a request id that is not 32 hex', async (): Promise<void> => {
    const channel = brokerChannelPathFor(runDir)
    appendFileSync(channel, 'not json\n')
    appendFileSync(
      channel,
      `${JSON.stringify({ requestId: '../escape', runId, op: 'deploy_release', params: PARAMS, runToken: TOKEN })}\n`,
    )
    appendFileSync(channel, `${'x'.repeat(9000)}\n`)

    await serveBrokerRequests({ workspaceId: brandWorkspaceId(workspaceId), execute: fakeExecutor })

    // Not one reply, and not one file whose name came from a line the pass could not read: a line
    // that is not a request has no `requestId` to answer.
    expect(readdirSync(runDir).filter((name) => name.startsWith('broker-'))).toHaveLength(0)
    expect(executions).toBe(0)
  })

  it('does not read the channel of a run that is over', async (): Promise<void> => {
    await prisma.slaveRun.update({ where: { id: runId }, data: { status: 'succeeded' } })
    appendRequest(runDir, { requestId: ID, runId, op: 'deploy_release', params: PARAMS, runToken: TOKEN })

    await serveBrokerRequests({ workspaceId: brandWorkspaceId(workspaceId), execute: fakeExecutor })

    expect(existsSync(brokerReplyPathFor(runDir, ID))).toBe(false)
    expect(executions).toBe(0)
  })

  it('serves two runs’ channels in one pass without crossing them', async (): Promise<void> => {
    appendRequest(runDir, { requestId: ID, runId, op: 'deploy_release', params: PARAMS, runToken: TOKEN })
    appendRequest(otherRunDir, {
      requestId: OTHER_ID,
      runId: otherRunId,
      op: 'deploy_release',
      params: PARAMS,
      runToken: OTHER_TOKEN,
    })

    const served = await serveBrokerRequests({ workspaceId: brandWorkspaceId(workspaceId), execute: fakeExecutor })

    expect([...served].sort()).toEqual([ID, OTHER_ID].sort())
    expect(executions).toBe(2)
    expect(readReply(runDir, ID)).toMatchObject({ ok: true })
    expect(readReply(otherRunDir, OTHER_ID)).toMatchObject({ ok: true })
    // Each reply is in the directory its request came from, and in no other.
    expect(existsSync(brokerReplyPathFor(otherRunDir, ID))).toBe(false)
    expect(existsSync(brokerReplyPathFor(runDir, OTHER_ID))).toBe(false)
  })

  it('never throws out of the pass, whatever the executor does', async (): Promise<void> => {
    appendRequest(runDir, { requestId: ID, runId, op: 'deploy_release', params: PARAMS, runToken: TOKEN })

    await expect(
      serveBrokerRequests({
        workspaceId: brandWorkspaceId(workspaceId),
        execute: async () => {
          throw new Error('boom')
        },
      }),
    ).resolves.toEqual([ID])

    expect(readReply(runDir, ID)).toMatchObject({ ok: false })
  })
})

describe('realBrokerExecutor', () => {
  it('runs argv with ONLY the environment it built -- no inheritance of this process’s secrets', async (): Promise<void> => {
    process.env['LEAKED_INTO_THE_DAEMON'] = 'yes'
    const dir = tempDir('slaveofai-broker-exec-')
    try {
      const outcome = await realBrokerExecutor({
        command: [script(dir, 'dump.sh', 'env\n')],
        credentialEnvVar: 'FAKE_DEPLOY_TOKEN',
        params: { SLAVEOFAI_BROKER_PARAM_ENVIRONMENT: 'staging' },
        timeoutMs: 5_000,
      })

      expect(outcome.exitCode).toBe(0)
      // The op's parameters, and the ONE credential the binding named, read at execution time.
      expect(outcome.output).toContain('SLAVEOFAI_BROKER_PARAM_ENVIRONMENT=staging')
      expect(outcome.output).toContain(`FAKE_DEPLOY_TOKEN=${CREDENTIAL_PLACEHOLDER}`)
      // And nothing else the daemon holds. `DATABASE_URL` is the one that matters most and is
      // always set in this suite, so it is asserted by name beside the planted marker.
      expect(outcome.output).not.toContain('LEAKED_INTO_THE_DAEMON')
      expect(outcome.output).not.toContain('DATABASE_URL')
    } finally {
      delete process.env['LEAKED_INTO_THE_DAEMON']
    }
  })

  it('carries no credential at all when the binding named none', async (): Promise<void> => {
    const dir = tempDir('slaveofai-broker-exec-')
    const outcome = await realBrokerExecutor({
      command: [script(dir, 'dump.sh', 'env\n')],
      credentialEnvVar: null,
      params: {},
      timeoutMs: 5_000,
    })

    expect(outcome.output).not.toContain(CREDENTIAL_PLACEHOLDER)
    expect(outcome.output).not.toContain('FAKE_DEPLOY_TOKEN')
  })

  it('quotes each argv element, so a path with a space is one word and not two', async (): Promise<void> => {
    const dir = tempDir('slaveofai-broker-exec-')
    const path = script(dir, 'a script with spaces.sh', 'printf "%s\\n" "$1"\n')

    const outcome = await realBrokerExecutor({
      command: [path, "it's one argument"],
      credentialEnvVar: null,
      params: {},
      timeoutMs: 5_000,
    })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.output).toBe("it's one argument")
  })

  it('bounds the output at COMMAND_OUTPUT_LIMIT, from the FRONT', async (): Promise<void> => {
    const dir = tempDir('slaveofai-broker-exec-')
    const outcome = await realBrokerExecutor({
      command: [script(dir, 'loud.sh', `head -c 40000 /dev/zero | tr '\\0' 'a'\nprintf 'THE_LAST_THING\\n'\n`)],
      credentialEnvVar: null,
      params: {},
      timeoutMs: 10_000,
    })

    // The tail survives and the head does not: the last thing a failing command printed is almost
    // always the reason it failed.
    expect(outcome.output).toContain('THE_LAST_THING')
    expect(outcome.output.length).toBeLessThanOrEqual(COMMAND_OUTPUT_LIMIT + 64)
    expect(outcome.output.startsWith('…(truncated')).toBe(true)
  }, 15_000)

  it('kills the process GROUP on timeout and reports a null exit code', async (): Promise<void> => {
    const dir = tempDir('slaveofai-broker-exec-')
    const pidFile = join(dir, 'grandchild.pid')
    const outcome = await realBrokerExecutor({
      // A backgrounded grandchild: the thing a single-pid kill leaves running. It is in the
      // spawned shell's process GROUP, so the group kill takes it too.
      command: [script(dir, 'slow.sh', 'sleep 30 &\necho $! > "$SLAVEOFAI_BROKER_PARAM_PIDFILE"\nsleep 30\n')],
      credentialEnvVar: null,
      params: { SLAVEOFAI_BROKER_PARAM_PIDFILE: pidFile },
      timeoutMs: 400,
    })

    expect(outcome.exitCode).toBeNull()
    // The worker is told, rather than being handed an empty answer with no exit status.
    expect(outcome.output).toContain('timed out')

    const grandchild = Number(readFileSync(pidFile, 'utf8').trim())
    expect(Number.isInteger(grandchild)).toBe(true)
    await expect.poll(() => isGone(grandchild), { timeout: 5_000 }).toBe(true)
  }, 15_000)
})

/** Whether a pid is no longer running. Signal 0 is the question, never a kill. */
function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}
