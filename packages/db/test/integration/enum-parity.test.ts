import {
  BREAKER_LEVELS,
  COST_PROVENANCE_WORD,
  DECIDERS,
  DECISION_STATUSES,
  DUPLICATE_BASES,
  DUPLICATE_CLASSES,
  EVIDENCE_OUTCOMES,
  EXTERNAL_EVENT_KINDS,
  EXTERNAL_SOURCES,
  INTAKE_ROLES,
  INTAKE_STATUSES,
  MEMORY_SCOPES,
  MEMORY_SOURCE_KINDS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  PERMISSION_KINDS,
  PERMISSION_PROVIDERS,
  PERMISSION_RUN_KINDS,
  SITUATION_KINDS,
  SKILL_GRANT_MODES,
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

  // M58 (fix round 1, Minor 10). `SkillGrantMode` is this milestone's one new Postgres enum and it
  // arrived with no domain union to pin it to: `PersonSkill.mode` is what says whether a row grants
  // a skill or takes a persona's away, and a third member added to one side and not the other is a
  // runtime insert failure nothing else here would catch.
  it('SkillGrantMode matches SKILL_GRANT_MODES, member for member', async () => {
    expect(await enumValues('SkillGrantMode')).toEqual([...SKILL_GRANT_MODES].sort())
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

  // M54: the four new enums. Two are pinned against the DOMAIN's own arrays, because pure functions
  // in `packages/domain` decide from them; two are pinned against LITERALS, because they are spelled
  // in `packages/control/src/triggers.ts` (plan erratum E9) and `packages/db` cannot import that
  // package -- it imports THIS one. `CredentialKind`'s assertion above is the same shape for the
  // same reason.
  it('ExternalSource matches EXTERNAL_SOURCES, member for member', async () => {
    expect(await enumValues('ExternalSource')).toEqual([...EXTERNAL_SOURCES].sort())
  })

  it('ExternalEventKind matches EXTERNAL_EVENT_KINDS, member for member', async () => {
    expect(await enumValues('ExternalEventKind')).toEqual([...EXTERNAL_EVENT_KINDS].sort())
  })

  it('InboundEventStatus is the three a row moves through, and it moves at most once', async () => {
    expect(await enumValues('InboundEventStatus')).toEqual(['actioned', 'ignored', 'received'])
  })

  it('ExternalIgnoredReason is the five a delivery can be ignored for (fix-wave erratum E25)', async () => {
    expect(await enumValues('ExternalIgnoredReason')).toEqual([
      'hook_mismatch',
      'request_refused',
      'unmapped_repository',
      'unrecognised_event',
      'workspace_archived',
    ])
  })

  it('ProviderKind matches the domain\u2019s PERMISSION_PROVIDERS, so the permission tables key on the same two', async () => {
    expect(await enumValues('ProviderKind')).toEqual([...PERMISSION_PROVIDERS].sort())
  })

  // M52 fix round 1 (review m6): `BASELINE_GRANTS` is a total `Record` over `PERMISSION_RUN_KINDS`,
  // so a FOURTH `RunKind` member that reached Prisma and not the domain would make
  // `BASELINE_GRANTS[runKind]` `undefined`, `new Set(undefined)` empty, and every run of that kind
  // silently deny-all. Nothing in TypeScript catches that; this line does.
  it('RunKind matches the domain\u2019s PERMISSION_RUN_KINDS, so no run kind can have a deny-all baseline', async () => {
    expect(await enumValues('RunKind')).toEqual([...PERMISSION_RUN_KINDS].sort())
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

  // M53 R3: the two enums the fact table is typed on. The first is derived rather than spelled --
  // `EVIDENCE_OUTCOMES` is RunStatus minus the non-terminal statuses, and asserting that against
  // Postgres is what stops a tenth `RunStatus` member quietly becoming an outcome nobody decided on.
  it('EvidenceOutcome matches EVIDENCE_OUTCOMES, member for member', async () => {
    expect(await enumValues('EvidenceOutcome')).toEqual([...EVIDENCE_OUTCOMES].sort())
  })

  // M53 plan erratum E14: `CostProvenance` is a TYPE, so the only total value over it in the tree
  // is `COST_PROVENANCE_WORD` -- which R6 moved into the domain beside the type for exactly this.
  it('EvidenceCostProvenance matches CostProvenance member for member, via the one label table', async () => {
    expect(await enumValues('EvidenceCostProvenance')).toEqual(Object.keys(COST_PROVENANCE_WORD).sort())
  })

  // M55 R5: the two new Postgres enums, pinned against the DOMAIN's own arrays rather than against
  // literals -- `classifyPair` is a pure function in `packages/domain` that DECIDES from both, which
  // is plan erratum E9's own rule for where a vocabulary lives and therefore what it is pinned
  // against. A fourth class that reached the union and not the enum would compile clean and fail at
  // the first `writeTemplateDuplicates`, in production, in the middle of a three-hundred-row import.
  it('DuplicateClass matches DUPLICATE_CLASSES, member for member', async () => {
    expect(await enumValues('DuplicateClass')).toEqual([...DUPLICATE_CLASSES].sort())
  })

  it('DuplicateBasis matches DUPLICATE_BASES, member for member', async () => {
    expect(await enumValues('DuplicateBasis')).toEqual([...DUPLICATE_BASES].sort())
  })

  // M59 R1/R2: the two intake enums. Pinned against the DOMAIN's arrays rather than literals,
  // because `INTAKE_STATUS_LABEL` is a total `Record` over the first of them and a member that
  // reached Postgres without reaching the domain would render as a blank word on the drawer --
  // and one that reached the domain without reaching Postgres would throw on the first insert.
  it('IntakeStatus matches INTAKE_STATUSES, member for member', async () => {
    expect(await enumValues('IntakeStatus')).toEqual([...INTAKE_STATUSES].sort())
  })

  it('IntakeRole matches INTAKE_ROLES, member for member', async () => {
    expect(await enumValues('IntakeRole')).toEqual([...INTAKE_ROLES].sort())
  })
})
