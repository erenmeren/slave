import {
  BREAKER_LEVELS,
  DECIDERS,
  DECISION_STATUSES,
  MEMORY_SCOPES,
  MEMORY_SOURCE_KINDS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  PERMISSION_KINDS,
  PERMISSION_PROVIDERS,
  SITUATION_KINDS,
  SLAVE_LIFECYCLES,
  TIERS,
  executionEventSchema,
} from '@slave-of-ai/domain'
import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../src/client.js'
import { ACTORS, EVENT_TYPE_BY_DOMAIN_TYPE, RUN_STATUSES, TASK_STATUSES } from '../../src/enums.js'

async function enumValues(name: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ value: string }[]>(
    `SELECT unnest(enum_range(NULL::"${name}"))::text AS value`,
  )
  return rows.map((row) => row.value).sort()
}

describe('database enums match the domain unions', () => {
  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('TaskStatus matches, member for member', async () => {
    expect(await enumValues('TaskStatus')).toEqual([...TASK_STATUSES].sort())
  })

  it('RunStatus matches, member for member', async () => {
    expect(await enumValues('RunStatus')).toEqual([...RUN_STATUSES].sort())
  })

  it('Actor matches, member for member', async () => {
    expect(await enumValues('Actor')).toEqual([...ACTORS].sort())
  })

  it('EventType is exactly the domain union, never wider', async () => {
    const domainTypes = Object.keys(EVENT_TYPE_BY_DOMAIN_TYPE).sort()
    expect(await enumValues('EventType')).toEqual(domainTypes)
  })

  // M38 t1: the Supervisor's four enums. Nothing in TypeScript ties a Prisma enum to the domain
  // union it mirrors -- adding an eleventh `SituationKind` and forgetting the enum compiles clean
  // and fails at the first `recordDecision` insert, in production, on a workspace that was already
  // stuck. These four assertions are the only thing that catches it. (`ACTION_KINDS` has no
  // Postgres enum of its own on purpose: an `Action` lives inside the `action` JSONB column,
  // validated at read by `actionSchema`, not as a column type -- so there is no fifth assertion.)
  it('SupervisorSituationKind matches SITUATION_KINDS, member for member', async () => {
    expect(await enumValues('SupervisorSituationKind')).toEqual([...SITUATION_KINDS].sort())
  })

  it('SupervisorTier matches TIERS, member for member', async () => {
    expect(await enumValues('SupervisorTier')).toEqual([...TIERS].sort())
  })

  it('SupervisorDecisionStatus matches DECISION_STATUSES, member for member', async () => {
    expect(await enumValues('SupervisorDecisionStatus')).toEqual([...DECISION_STATUSES].sort())
  })

  it('SupervisorDecider matches DECIDERS, member for member', async () => {
    expect(await enumValues('SupervisorDecider')).toEqual([...DECIDERS].sort())
  })

  // M49 R1: the four memory enums. Same reason as the Supervisor's four -- nothing in TypeScript
  // ties a Prisma enum to the domain union it mirrors, and a missing member fails at the first
  // INSERT rather than at build.
  it('MemoryType matches MEMORY_TYPES, member for member', async () => {
    expect(await enumValues('MemoryType')).toEqual([...MEMORY_TYPES].sort())
  })

  it('MemoryScope matches MEMORY_SCOPES, member for member', async () => {
    expect(await enumValues('MemoryScope')).toEqual([...MEMORY_SCOPES].sort())
  })

  it('MemoryStatus matches MEMORY_STATUSES, member for member', async () => {
    expect(await enumValues('MemoryStatus')).toEqual([...MEMORY_STATUSES].sort())
  })

  it('MemorySourceKind matches MEMORY_SOURCE_KINDS, member for member', async () => {
    expect(await enumValues('MemorySourceKind')).toEqual([...MEMORY_SOURCE_KINDS].sort())
  })

  // M50 R1: the lifecycle enum. Same reason as the Supervisor's four and M49's -- nothing in
  // TypeScript ties a Prisma enum to the domain union it mirrors, and a missing member fails at the
  // first INSERT rather than at build.
  it('SlaveLifecycle matches SLAVE_LIFECYCLES, member for member', async () => {
    expect(await enumValues('SlaveLifecycle')).toEqual([...SLAVE_LIFECYCLES].sort())
  })

  // M51 R2: the breaker's own enum. Same reason as the Supervisor's four and the memory four --
  // nothing in TypeScript ties a Prisma enum to the domain union it mirrors, and a missing member
  // fails at the first `slaveRun.update` rather than at build.
  it('BreakerLevel matches BREAKER_LEVELS, member for member', async () => {
    expect(await enumValues('BreakerLevel')).toEqual([...BREAKER_LEVELS].sort())
  })

  // M52 R1/R3: the two new Postgres enums, held to the domain's lists for
  // `SupervisorSituationKind`'s reason -- nothing in TypeScript ties a Prisma enum to the union it
  // mirrors, and a seventh permission kind that reached the union and not the enum compiles clean
  // and fails at the first `setSlavePermission`, in production, on a worker somebody was trying to
  // unblock.
  it('PermissionKind matches PERMISSION_KINDS, member for member', async () => {
    expect(await enumValues('PermissionKind')).toEqual([...PERMISSION_KINDS].sort())
  })

  it('CredentialKind is the three the operator can name', async () => {
    expect(await enumValues('CredentialKind')).toEqual(['api_key', 'deploy_token', 'git_token'])
  })

  it('ProviderKind matches the domain\u2019s PERMISSION_PROVIDERS, so the permission tables key on the same two', async () => {
    expect(await enumValues('ProviderKind')).toEqual([...PERMISSION_PROVIDERS].sort())
  })

  // The test above pins the database enum to `EVENT_TYPE_BY_DOMAIN_TYPE`, a hand-maintained
  // map. That map is in turn pinned to the live Zod union only by the `satisfies` clause in
  // `enums.ts` — a compile-time check. Delete that one clause and the two tests above would
  // both stay green while the map silently drifted from the schema. This test reads the
  // discriminant values directly off `executionEventSchema` at runtime, so it pins the database
  // enum to the schema itself, independent of the map and independent of `tsc`.
  it('EventType matches the live Zod union directly, independent of the hand-maintained map', async () => {
    const schemaTypes = executionEventSchema.options.map((option) => option.shape.type.value).sort()
    expect(await enumValues('EventType')).toEqual(schemaTypes)
  })
})
