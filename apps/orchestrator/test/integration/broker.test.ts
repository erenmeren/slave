import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
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
import { brokerChannelPathFor, brokerClaimPathFor, brokerReplyPathFor, runTokenHash } from '@slave-of-ai/providers'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { realBrokerExecutor, resetBrokerCursors, serveBrokerRequests } from '../../src/broker.js'
import { COMMAND_OUTPUT_LIMIT } from '../../src/shell.js'
import { sweep } from '../../src/sweep.js'
import type { SlaveRuntimeAdapter } from '@slave-of-ai/providers'

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

  it('serves nothing for a project that has never used the broker, and CREATES nothing', async (): Promise<void> => {
    // Both live runs, with their scratch directories not yet made -- which is every run that has
    // not paused and has never had a file written for it.
    rmSync(runDir, { recursive: true, force: true })
    rmSync(otherRunDir, { recursive: true, force: true })

    const served = await serveBrokerRequests({ workspaceId: brandWorkspaceId(workspaceId), execute: fakeExecutor })

    expect(served).toEqual([])
    expect(executions).toBe(0)
    // Fix round 1: the pass is a READER. It used to derive the path through `runFilePaths`, which
    // `mkdirSync`s -- synchronous work on the event loop, once per live run, every pass, making
    // directories for runs that had asked for nothing.
    expect(existsSync(runDir)).toBe(false)
    expect(existsSync(otherRunDir)).toBe(false)
  })

  it('leaves a CLAIM beside every reply, so a crash cannot look like an unserved request', async (): Promise<void> => {
    appendRequest(runDir, { requestId: ID, runId, op: 'deploy_release', params: PARAMS, runToken: TOKEN })

    await serveBrokerRequests({ workspaceId: brandWorkspaceId(workspaceId), execute: fakeExecutor })

    expect(existsSync(brokerClaimPathFor(runDir, ID))).toBe(true)
    expect(existsSync(brokerReplyPathFor(runDir, ID))).toBe(true)
    // The claim names the request and the op and nothing else -- above all not the token.
    const claim = readFileSync(brokerClaimPathFor(runDir, ID), 'utf8')
    expect(JSON.parse(claim)).toMatchObject({ requestId: ID, op: 'deploy_release' })
    expect(claim).not.toContain(TOKEN)
  })

  it('answers a CLAIMED but unanswered request without ever running it again', async (): Promise<void> => {
    // Exactly what a daemon that died between the child exiting and the reply landing leaves
    // behind, and exactly what a `writeReply` that failed leaves behind: a claim, no reply.
    writeFileSync(brokerClaimPathFor(runDir, ID), `${JSON.stringify({ requestId: ID, op: 'deploy_release' })}\n`)
    appendRequest(runDir, { requestId: ID, runId, op: 'deploy_release', params: PARAMS, runToken: TOKEN })

    const served = await serveBrokerRequests({ workspaceId: brandWorkspaceId(workspaceId), execute: fakeExecutor })

    expect(served).toEqual([ID])
    expect(executions).toBe(0)
    const reply = readReply(runDir, ID)
    expect(reply).toMatchObject({ ok: false, reason: 'internal_error' })
    // The sentence has to say the thing an operator needs to act on: nobody knows whether it ran.
    expect(String(reply['output'])).toContain('UNKNOWN')
  })

  it('does not re-execute after a worker truncates its own channel and deletes its reply', async (): Promise<void> => {
    // TWO requests first, so the byte cursor sits past both of them.
    appendRequest(runDir, { requestId: ID, runId, op: 'deploy_release', params: PARAMS, runToken: TOKEN })
    appendRequest(runDir, { requestId: OTHER_ID, runId, op: 'deploy_release', params: PARAMS, runToken: TOKEN })
    await serveBrokerRequests({ workspaceId: brandWorkspaceId(workspaceId), execute: fakeExecutor })
    expect(executions).toBe(2)

    // The worker owns this directory. It deletes the answer it did not like and rewrites the
    // channel SHORTER than the cursor, which is how a file "shrinks" -- and a shrunken channel is
    // re-read from byte zero, so the offset cannot be what stops the second execution.
    unlinkSync(brokerReplyPathFor(runDir, ID))
    writeFileSync(brokerChannelPathFor(runDir), '')
    appendRequest(runDir, { requestId: ID, runId, op: 'deploy_release', params: PARAMS, runToken: TOKEN })

    await serveBrokerRequests({ workspaceId: brandWorkspaceId(workspaceId), execute: fakeExecutor })

    // The CLAIM is. It survived the worker's tidy-up, because it is not the file the worker was
    // deleting, and the answer says the outcome is unknown rather than running the deploy again.
    expect(executions).toBe(2)
    expect(readReply(runDir, ID)).toMatchObject({ ok: false, reason: 'internal_error' })
  })

  it('REFUSES a sibling’s real token on this run’s OWN channel -- the attack the runId check cannot see', async (): Promise<void> => {
    // Final review Important 1. The thief writes into its own directory and names its own run, so
    // both halves of the `runId` comparison agree and it passes; the only thing that is wrong is
    // the TOKEN, which belongs to a live sibling. Before `expectedRunId` this line executed the
    // operation under the sibling's grants and wrote the output here, which is the delivery the
    // erratum exists to prevent.
    appendRequest(runDir, { requestId: ID, runId, op: 'deploy_release', params: PARAMS, runToken: OTHER_TOKEN })

    await serveBrokerRequests({ workspaceId: brandWorkspaceId(workspaceId), execute: fakeExecutor })

    expect(readReply(runDir, ID)).toMatchObject({ ok: false, reason: 'identity_mismatch' })
    expect(executions).toBe(0)
    // Nothing reached the run whose token was stolen, and the refusal is filed against the run that
    // wrote the line -- the only run this process is entitled to write history for.
    expect(existsSync(brokerReplyPathFor(otherRunDir, ID))).toBe(false)
    const event = await prisma.executionEvent.findFirstOrThrow({ where: { type: 'broker_refused' } })
    expect(event.runId).toBe(runId)
    expect(event.payload).toEqual({ op: 'deploy_release', reason: 'identity_mismatch' })
  })

  it('files broker.refused against the directory’s run when a line claims a different one', async (): Promise<void> => {
    appendRequest(runDir, { requestId: ID, runId: otherRunId, op: 'deploy_release', params: PARAMS, runToken: OTHER_TOKEN })

    await serveBrokerRequests({ workspaceId: brandWorkspaceId(workspaceId), execute: fakeExecutor })

    // The one attack this milestone's erratum is named for, and until fix round 1 its only record
    // was a file in the attacker's own directory that the attacker could delete.
    const event = await prisma.executionEvent.findFirstOrThrow({ where: { type: 'broker_refused' } })
    expect(event.runId).toBe(runId)
    expect(event.slaveId).toBe(slaveId)
    expect(event.payload).toEqual({ op: 'deploy_release', reason: 'identity_mismatch' })
    expect(event.actor).toBe('slave')
  })

  it('is NOT part of sweep(): a slow operation and a sweep do not wait for each other', async (): Promise<void> => {
    appendRequest(runDir, { requestId: ID, runId, op: 'deploy_release', params: PARAMS, runToken: TOKEN })
    const finished: string[] = []
    const registry = { resolve: () => ({ cancel: async (): Promise<void> => undefined }) as unknown as SlaveRuntimeAdapter }

    const serving = serveBrokerRequests({
      workspaceId: brandWorkspaceId(workspaceId),
      execute: async () => {
        executions += 1
        await new Promise<void>((settle) => setTimeout(settle, 500))
        return { exitCode: 0, durationMs: 500, output: 'deployed' }
      },
    }).then((): void => {
      finished.push('broker')
    })
    const report = await sweep({ workspaceId: brandWorkspaceId(workspaceId), registry })
    finished.push('sweep')
    await serving

    // The sweep finished first, with a half-second operation still running beside it.
    expect(finished).toEqual(['sweep', 'broker'])
    // And it served nothing itself: `SweepReport` has no `brokerServed` any more.
    expect(report).not.toHaveProperty('brokerServed')
    expect(executions).toBe(1)
  }, 15_000)
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
