import { prisma } from '@slave-of-ai/db/client'
import { BROKER_TIMEOUT_MS } from '@slave-of-ai/domain'
import { runTokenHash } from '@slave-of-ai/providers'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { type BrokerExecutor, runBrokeredOperation } from '../../src/broker.js'
import { addCredential, bindBrokerOp } from '../../src/credential.js'
import { clearSlavePermission, setSlavePermission } from '../../src/permission.js'

/**
 * The AUTHORISER (M52 R3), against a real database. Nothing here spawns anything: the executor is a
 * spy, for the reason `ModelDecider` is one -- `packages/control` hands out an argv and takes an
 * outcome, and the process is `apps/orchestrator`'s.
 *
 * Two placeholders and no secrets: `TOKEN` is 64 hex characters of one repeated pair, and the
 * variable the credential names is exported as `'tok'` only so the "is it set on this host" question
 * has a yes to give. Neither is a value anything real ever held.
 */
const TOKEN = 'f0'.repeat(32)
const PARAMS = { environment: 'staging', digest: 'a1b2c3d' }

let workspaceId: string
let otherWorkspaceId: string
let slaveId: string
let runId: string
let executed: unknown[] = []

const executor: BrokerExecutor = async (input) => {
  executed.push(input)
  return { exitCode: 0, durationMs: 12, output: 'deployed' }
}

/** The `broker.*` rows this file reads back, with the payload typed -- Prisma hands back a
 *  `JsonValue` and every assertion here is about named fields inside it. */
async function brokerEvent(type: 'broker_executed' | 'broker_refused'): Promise<{
  readonly runId: string | null
  readonly payload: Record<string, unknown>
}> {
  const row = await prisma.executionEvent.findFirstOrThrow({ where: { type } })
  return { runId: row.runId, payload: row.payload as Record<string, unknown> }
}

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "BrokerBinding", "Credential", "SlavePermission", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )
  executed = []
  process.env['FAKE_DEPLOY_TOKEN'] = 'tok'

  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath: '/tmp/broker', verifyCommands: ['true'], setupCommands: [] },
  })
  workspaceId = workspace.id
  otherWorkspaceId = (
    await prisma.workspace.create({
      data: { name: 'Billing', repoPath: '/tmp/broker-other', verifyCommands: ['true'], setupCommands: [] },
    })
  ).id
  const team = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
  slaveId = (await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })).id
  const task = await prisma.task.create({
    data: { workspaceId, title: 'Ship it', description: 'ship', status: 'running', maxAttempts: 3 },
  })
  runId = (
    await prisma.slaveRun.create({
      data: {
        taskId: task.id,
        slaveId,
        kind: 'implementation',
        status: 'working',
        runTokenHash: runTokenHash(TOKEN),
      },
      select: { id: true },
    })
  ).id

  await setSlavePermission(slaveId, 'deploy_release', 'allow')
  await addCredential(workspaceId, { name: 'deploy', kind: 'deploy_token', envVar: 'FAKE_DEPLOY_TOKEN' })
  await bindBrokerOp(workspaceId, {
    op: 'deploy_release',
    command: ['/abs/fake-deploy.sh'],
    credentialName: 'deploy',
  })
})

afterAll(async (): Promise<void> => {
  delete process.env['FAKE_DEPLOY_TOKEN']
  await prisma.$disconnect()
})

describe('runBrokeredOperation', () => {
  it('runs the bound command, names the credential’s VARIABLE and never its value, and returns the bounded output', async (): Promise<void> => {
    const result = await runBrokeredOperation(
      { runToken: TOKEN, op: 'deploy_release', params: { environment: 'staging', digest: 'a1b2c3d' } },
      { execute: executor },
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ op: 'deploy_release', exitCode: 0, durationMs: 12, output: 'deployed' })
    expect(executed).toEqual([
      {
        command: ['/abs/fake-deploy.sh'],
        credentialEnvVar: 'FAKE_DEPLOY_TOKEN',
        params: { SLAVEOFAI_BROKER_PARAM_ENVIRONMENT: 'staging', SLAVEOFAI_BROKER_PARAM_DIGEST: 'a1b2c3d' },
        timeoutMs: BROKER_TIMEOUT_MS,
      },
    ])
    // The whole point of the shape above: the secret is not in it. `control` reads the variable's
    // name, asks whether it is set, and never holds what is in it.
    expect(JSON.stringify(executed)).not.toContain('tok"')
  })

  it('appends broker.executed with the environment verbatim, the params HASHED, and no output anywhere', async (): Promise<void> => {
    await runBrokeredOperation(
      { runToken: TOKEN, op: 'deploy_release', params: { environment: 'staging', digest: 'a1b2c3d' } },
      { execute: executor },
    )
    const event = await brokerEvent('broker_executed')
    expect(event.payload).toEqual({
      op: 'deploy_release',
      environment: 'staging',
      paramsHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      exitCode: 0,
      durationMs: 12,
    })
    expect(event.runId).toBe(runId)
    // Every event this run produced, serialised whole. `seq` is a `bigint`, which `JSON.stringify`
    // refuses, so it is rendered as text -- the point of the scan is the STRINGS in the log.
    const all = JSON.stringify(await prisma.executionEvent.findMany(), (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    )
    expect(all).not.toContain('tok')
    expect(all).not.toContain('deployed')
    expect(all).not.toContain('/abs/fake-deploy.sh')
  })

  it('refuses an unknown token as identity_mismatch, runs nothing, and records NOTHING', async (): Promise<void> => {
    const result = await runBrokeredOperation({ runToken: 'a'.repeat(64), op: 'deploy_release', params: PARAMS }, { execute: executor })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'broker_refused', op: 'deploy_release', reason: 'identity_mismatch' })
    expect(executed).toHaveLength(0)
    // A forged token that produced a timeline entry would let anyone who can write a line into the
    // channel write into a project's history.
    expect(await prisma.executionEvent.count({ where: { type: 'broker_refused' } })).toBe(0)
  })

  it('refuses a token whose run is CONCLUDED as run_not_live', async (): Promise<void> => {
    await prisma.slaveRun.update({ where: { id: runId }, data: { status: 'succeeded' } })
    const result = await runBrokeredOperation({ runToken: TOKEN, op: 'deploy_release', params: PARAMS }, { execute: executor })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatchObject({ reason: 'run_not_live' })
    expect((await brokerEvent('broker_refused')).payload).toEqual({ op: 'deploy_release', reason: 'run_not_live' })
  })

  it('refuses a worker without the grant as permission_denied, and records broker.refused', async (): Promise<void> => {
    await clearSlavePermission(slaveId, 'deploy_release')
    const result = await runBrokeredOperation({ runToken: TOKEN, op: 'deploy_release', params: PARAMS }, { execute: executor })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatchObject({ reason: 'permission_denied' })
    expect((await brokerEvent('broker_refused')).payload).toEqual({ op: 'deploy_release', reason: 'permission_denied' })
  })

  it('refuses a worker whose grant was taken back with a deny, not only one that never had it', async (): Promise<void> => {
    await setSlavePermission(slaveId, 'deploy_release', 'deny')
    const result = await runBrokeredOperation({ runToken: TOKEN, op: 'deploy_release', params: PARAMS }, { execute: executor })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatchObject({ reason: 'permission_denied' })
  })

  it('refuses an op with no binding in THIS project as not_brokered, even when another project has one', async (): Promise<void> => {
    await prisma.brokerBinding.deleteMany({ where: { workspaceId } })
    await bindBrokerOp(otherWorkspaceId, { op: 'deploy_release', command: ['/bin/true'] })
    const result = await runBrokeredOperation({ runToken: TOKEN, op: 'deploy_release', params: PARAMS }, { execute: executor })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatchObject({ reason: 'not_brokered' })
    expect(executed).toHaveLength(0)
  })

  it('refuses when the bound credential’s variable is unset on this host, and never invents an empty one', async (): Promise<void> => {
    delete process.env['FAKE_DEPLOY_TOKEN']
    const result = await runBrokeredOperation({ runToken: TOKEN, op: 'deploy_release', params: PARAMS }, { execute: executor })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatchObject({ reason: 'credential_unset' })
    expect(executed).toHaveLength(0)
  })

  it('refuses parameters the manifest does not accept, naming nothing about them', async (): Promise<void> => {
    for (const params of [{ environment: 'https://evil', digest: 'a1b2c3d' }, { environment: 'staging' }, { environment: 'staging', digest: 'a1b2c3d', url: 'x' }]) {
      const result = await runBrokeredOperation({ runToken: TOKEN, op: 'deploy_release', params }, { execute: executor })
      expect(result.ok, JSON.stringify(params)).toBe(false)
      if (!result.ok) expect(result.error).toMatchObject({ reason: 'invalid_params' })
    }
    expect(executed).toHaveLength(0)
    // The refusal names the op and the reason and nothing else: no field name, no offered value.
    expect((await brokerEvent('broker_refused')).payload).toEqual({ op: 'deploy_release', reason: 'invalid_params' })
  })

  it('refuses an op the manifest does not carry, before it reads a single row', async (): Promise<void> => {
    const result = await runBrokeredOperation({ runToken: TOKEN, op: 'rm_rf', params: {} }, { execute: executor })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatchObject({ reason: 'not_brokered' })
    // Question 1 has no run to file an event against, and did not go looking for one.
    expect(await prisma.executionEvent.count({ where: { type: 'broker_refused' } })).toBe(0)
  })

  it('refuses an ARCHIVED project as simulation -- nothing crosses, belt and braces', async (): Promise<void> => {
    await prisma.workspace.update({ where: { id: workspaceId }, data: { archivedAt: new Date() } })
    const result = await runBrokeredOperation({ runToken: TOKEN, op: 'deploy_release', params: PARAMS }, { execute: executor })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatchObject({ reason: 'simulation' })
    expect((await brokerEvent('broker_refused')).payload).toEqual({ op: 'deploy_release', reason: 'simulation' })
  })

  it('records a NON-ZERO exit as an execution, not a refusal -- the operation ran and it failed', async (): Promise<void> => {
    const result = await runBrokeredOperation({ runToken: TOKEN, op: 'deploy_release', params: PARAMS }, {
      execute: async () => ({ exitCode: 3, durationMs: 5, output: 'boom' }),
    })
    expect(result.ok).toBe(true)
    expect((await brokerEvent('broker_executed')).payload).toMatchObject({ exitCode: 3 })
    expect(await prisma.executionEvent.count({ where: { type: 'broker_refused' } })).toBe(0)
  })

  it('hashes the params identically for two calls that asked for the same thing, and differently otherwise', async (): Promise<void> => {
    await runBrokeredOperation({ runToken: TOKEN, op: 'deploy_release', params: { environment: 'staging', digest: 'a1b2c3d' } }, { execute: executor })
    await runBrokeredOperation({ runToken: TOKEN, op: 'deploy_release', params: { digest: 'a1b2c3d', environment: 'staging' } }, { execute: executor })
    await runBrokeredOperation({ runToken: TOKEN, op: 'deploy_release', params: { environment: 'prod', digest: 'a1b2c3d' } }, { execute: executor })
    const hashes = (await prisma.executionEvent.findMany({ where: { type: 'broker_executed' }, orderBy: { seq: 'asc' } })).map(
      (event) => (event.payload as { paramsHash: string }).paramsHash,
    )
    expect(hashes[0]).toBe(hashes[1])
    expect(hashes[2]).not.toBe(hashes[0])
  })
})
