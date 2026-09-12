import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { addCredential, bindBrokerOp, listBrokerBindings, listCredentials } from '../../src/credential.js'

/**
 * The two CONFIGURATION verbs behind the broker (M52 R3), against a real database.
 *
 * Every case here is about what is NOT stored: there is no column a secret could go in, nothing
 * reads the variable a credential names, and a binding carries argv rather than a shell string. The
 * environment variable names below are all `FAKE_*` or single letters and none of them is ever
 * exported by this file -- a fixture that set one would be a value in a test, which is the thing
 * this milestone is about not having.
 */
let workspaceId: string
let otherWorkspaceId: string

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "BrokerBinding", "Credential", "SlavePermission", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )
  workspaceId = (
    await prisma.workspace.create({
      data: { name: 'Checkout Platform', repoPath: '/tmp/credential', verifyCommands: ['true'], setupCommands: [] },
    })
  ).id
  otherWorkspaceId = (
    await prisma.workspace.create({
      data: { name: 'Billing', repoPath: '/tmp/credential-other', verifyCommands: ['true'], setupCommands: [] },
    })
  ).id
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('addCredential', () => {
  it('stores a NAME and an environment variable, and there is no column a value could go in', async (): Promise<void> => {
    const result = await addCredential(workspaceId, { name: 'deploy', kind: 'deploy_token', envVar: 'FAKE_DEPLOY_TOKEN' })
    expect(result.ok).toBe(true)
    const row = await prisma.credential.findFirstOrThrow({ where: { workspaceId } })
    expect(row.envVar).toBe('FAKE_DEPLOY_TOKEN')
    expect(Object.keys(row)).toEqual(['id', 'workspaceId', 'name', 'kind', 'envVar', 'createdAt'])
  })

  it('refuses an envVar that is not a plausible environment variable name', async (): Promise<void> => {
    for (const bad of ['lower case', 'HAS-DASH', '1LEADING', '', 'A'.repeat(129)]) {
      expect((await addCredential(workspaceId, { name: `c-${bad}`, kind: 'api_key', envVar: bad })).ok, bad).toBe(false)
    }
  })

  it('refuses a second credential with the same name in one project, and allows it in another', async (): Promise<void> => {
    await addCredential(workspaceId, { name: 'deploy', kind: 'deploy_token', envVar: 'A' })
    expect((await addCredential(workspaceId, { name: 'deploy', kind: 'deploy_token', envVar: 'B' })).ok).toBe(false)
    expect((await addCredential(otherWorkspaceId, { name: 'deploy', kind: 'deploy_token', envVar: 'B' })).ok).toBe(true)
  })

  it('never reads the variable it names -- adding a credential for an unset variable succeeds', async (): Promise<void> => {
    delete process.env['NOT_SET_ANYWHERE']
    expect((await addCredential(workspaceId, { name: 'x', kind: 'api_key', envVar: 'NOT_SET_ANYWHERE' })).ok).toBe(true)
  })

  it('refuses a blank name, a kind outside the three, and a project that does not exist', async (): Promise<void> => {
    expect((await addCredential(workspaceId, { name: '  ', kind: 'api_key', envVar: 'A' })).ok).toBe(false)
    expect((await addCredential(workspaceId, { name: 'n', kind: 'vault' as 'api_key', envVar: 'A' })).ok).toBe(false)
    const gone = await addCredential('00000000-0000-4000-8000-000000000000', {
      name: 'n',
      kind: 'api_key',
      envVar: 'A',
    })
    expect(gone.ok).toBe(false)
    if (!gone.ok) expect(gone.error.kind).toBe('workspace_not_found')
  })

  it('lists what a project has, by name, and never the other project’s', async (): Promise<void> => {
    await addCredential(workspaceId, { name: 'deploy', kind: 'deploy_token', envVar: 'FAKE_DEPLOY_TOKEN' })
    await addCredential(otherWorkspaceId, { name: 'billing', kind: 'api_key', envVar: 'FAKE_BILLING_KEY' })
    expect((await listCredentials(workspaceId)).map((row) => [row.name, row.kind, row.envVar])).toEqual([
      ['deploy', 'deploy_token', 'FAKE_DEPLOY_TOKEN'],
    ])
  })
})

describe('bindBrokerOp', () => {
  it('binds an op to argv and a credential by NAME', async (): Promise<void> => {
    await addCredential(workspaceId, { name: 'deploy', kind: 'deploy_token', envVar: 'FAKE_DEPLOY_TOKEN' })
    const result = await bindBrokerOp(workspaceId, {
      op: 'deploy_release',
      command: ['/abs/fake-deploy.sh'],
      credentialName: 'deploy',
    })
    expect(result.ok).toBe(true)
    const row = await prisma.brokerBinding.findFirstOrThrow({ where: { workspaceId } })
    expect(row.command).toEqual(['/abs/fake-deploy.sh'])
    expect(row.credentialId).not.toBeNull()
  })

  it('refuses an op the static manifest does not carry -- a binding for a verb nothing can run is a trap', async (): Promise<void> => {
    const result = await bindBrokerOp(workspaceId, { op: 'rm_rf', command: ['/bin/true'] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('broker_refused')
  })

  it('refuses an empty argv, and a first element that is not an absolute path', async (): Promise<void> => {
    expect((await bindBrokerOp(workspaceId, { op: 'deploy_release', command: [] })).ok).toBe(false)
    expect((await bindBrokerOp(workspaceId, { op: 'deploy_release', command: ['fake-deploy.sh'] })).ok).toBe(false)
  })

  it('refuses a credential name this project does not have, with a 404-shaped refusal', async (): Promise<void> => {
    const result = await bindBrokerOp(workspaceId, { op: 'deploy_release', command: ['/bin/true'], credentialName: 'nope' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('credential_not_found')
  })

  it('rebinds in place -- one binding per op per project', async (): Promise<void> => {
    await bindBrokerOp(workspaceId, { op: 'deploy_release', command: ['/bin/true'] })
    await bindBrokerOp(workspaceId, { op: 'deploy_release', command: ['/bin/false'] })
    const rows = await prisma.brokerBinding.findMany({ where: { workspaceId } })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.command).toEqual(['/bin/false'])
  })

  it('lists this project’s bindings with the credential’s NAME, never its variable’s value', async (): Promise<void> => {
    await addCredential(workspaceId, { name: 'deploy', kind: 'deploy_token', envVar: 'FAKE_DEPLOY_TOKEN' })
    await bindBrokerOp(workspaceId, { op: 'deploy_release', command: ['/abs/fake-deploy.sh'], credentialName: 'deploy' })
    await bindBrokerOp(otherWorkspaceId, { op: 'deploy_release', command: ['/bin/true'] })
    expect(await listBrokerBindings(workspaceId)).toEqual([
      { op: 'deploy_release', command: ['/abs/fake-deploy.sh'], credentialName: 'deploy', envVar: 'FAKE_DEPLOY_TOKEN' },
    ])
  })
})
