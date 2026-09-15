import { createHmac } from 'node:crypto'
import { prisma } from '@slave-of-ai/db/client'

/**
 * The world M54's control tests run against (Task 2).
 *
 * Three projects -- one mapped, one to map a second repository into, one archived -- plus one
 * mapping and one repository name nobody mapped. Every case either asserts what this seed produces
 * or edits ONE row and asserts what changed, which keeps each case a statement about one rule rather
 * than about a fixture.
 *
 * THE SECRET IS A FIXTURE CONSTANT SET ON `process.env` BY THE TEST, and is never stored: the whole
 * point of `secretEnvVar` is that the row holds a NAME. Each file deletes the variable in an
 * `afterEach`, so a test that forgets to set it reads `secret_unset` rather than a stale value left
 * by its neighbour.
 */
export interface TriggersFixture {
  readonly workspaceId: string
  readonly otherWorkspaceId: string
  readonly archivedWorkspaceId: string
  readonly hookId: string
  readonly repository: string
  readonly unmappedRepository: string
}

export const TRIGGERS_ENV_VAR = 'SLAVEOFAI_TEST_HOOK_SECRET'
export const TRIGGERS_SECRET = 'a-secret-nothing-in-this-repository-stores'
export const TRIGGERS_REPOSITORY = 'acme/checkout'
export const TRIGGERS_UNMAPPED_REPOSITORY = 'acme/nobody-mapped-this'

const TRUNCATE =
  'TRUNCATE TABLE "InboundEvent", "ExternalRepository", "GoalVersion", "ExecutionEvent", "SlaveRun", "Task", "Slave", "Person", "Team", "Workspace", "User" RESTART IDENTITY CASCADE'

export async function seedTriggersFixture(): Promise<TriggersFixture> {
  await prisma.$executeRawUnsafe(TRUNCATE)
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/m54-triggers-repo',
      verifyCommands: ['true'],
      setupCommands: [],
      goal: 'Make checkout reliable.',
      goalVersion: 1,
    },
  })
  await prisma.goalVersion.create({
    data: { workspaceId: workspace.id, version: 1, text: 'Make checkout reliable.', sha256: 'seed-v1' },
  })
  const other = await prisma.workspace.create({
    data: { name: 'Billing', repoPath: '/tmp/m54-triggers-repo-2', verifyCommands: ['true'], setupCommands: [] },
  })
  const archived = await prisma.workspace.create({
    data: {
      name: 'Retired Project',
      repoPath: '/tmp/m54-triggers-repo-3',
      verifyCommands: ['true'],
      setupCommands: [],
      goal: 'Keep the lights on.',
      goalVersion: 1,
      archivedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  })
  const mapping = await prisma.externalRepository.create({
    data: {
      workspaceId: workspace.id,
      source: 'github',
      repositoryFullName: TRIGGERS_REPOSITORY,
      secretEnvVar: TRIGGERS_ENV_VAR,
    },
  })
  return {
    workspaceId: workspace.id,
    otherWorkspaceId: other.id,
    archivedWorkspaceId: archived.id,
    hookId: mapping.hookId,
    repository: TRIGGERS_REPOSITORY,
    unmappedRepository: TRIGGERS_UNMAPPED_REPOSITORY,
  }
}

/** The header a real sender computes, over the exact bytes it is about to send. Written here so
 *  every case signs the way the route verifies. */
export function signBody(body: Uint8Array, secret = TRIGGERS_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

/** A delivery body as BYTES -- what the route hands to the verifier, and what the signature is over
 *  (plan erratum E3). */
export function bodyOf(payload: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload))
}
