import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Checkpoint } from '../../src/claude/checkpoint.js'

/**
 * Pins `packages/providers`' `Checkpoint` interface against `packages/db`'s `Checkpoint` Prisma
 * model. The two shapes are deliberately duplicated (see `checkpoint.ts`'s own docstring for why
 * `src` may never import `@ai-team-os/db`) -- what is not acceptable is letting them drift apart
 * silently. This is the one place in `packages/providers` where a *test* importing `packages/db`
 * is correct rather than a violation of that boundary: it needs a real database to prove the
 * round trip, which is also why it lives in the integration project (`vitest.config.ts`'s
 * `integration` project, not `unit`) rather than beside the rest of this package's tests.
 *
 * Every field on `Checkpoint` is set here, deliberately, to a value that would not equal a
 * zero-value/default (`numTurns: 0`, `cumulativeCostUsd: 0`, empty arrays, `null` fields) if the
 * write silently dropped it -- an empty-array default and a genuinely-empty array read back are
 * indistinguishable, which is why the array fields are non-empty and the nullable fields are
 * exercised in their non-null form here. A second test below exercises the null/empty case
 * specifically, which `packages/db`'s own `checkpoint.test.ts` already covers on the Prisma side
 * but is worth confirming still round-trips starting from this package's own `Checkpoint` values.
 *
 * Fix round 2, finding C: a prior version of this file claimed the `data: { ...checkpoint, runId
 * }` spread below would fail to typecheck if a field existed on one side only. There was no such
 * spread -- both `data:` blocks enumerated all eleven (then fifteen) fields by hand -- and the
 * reviewer confirmed a spread would not have caught it anyway (TypeScript does not run
 * excess-property checking through a spread of a variable). `checkpointCreateFields` below is the
 * actual mechanism: its return expression carries a `satisfies Record<keyof Checkpoint, unknown>`
 * clause, which *is* checked against an object literal the same way a direct type annotation is
 * -- every key of `Checkpoint` must be present (a field added to `Checkpoint` and not listed here
 * is a missing-property error) and no key outside `Checkpoint` may appear (an excess-property
 * error), while `satisfies` (unlike a plain `: Type` annotation) leaves each field's own literal
 * type intact rather than widening it to `unknown`, so the result still flows into
 * `prisma.checkpoint.create`'s `data:` argument with real, checkable types. One function, shared
 * by both tests below (dissolves the verbatim duplication the two `data:` blocks used to be) --
 * see the mutation proof in the m3 fix-round-2 report for `npm run typecheck` failing and passing
 * on either side of a throwaway field added to `Checkpoint` only.
 */

async function seedRun(): Promise<string> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'w-providers-checkpoint-pin',
      repoPath: '/tmp/repo-providers-pin',
      verifyCommands: ['npm test'],
      setupCommands: ['npm ci'],
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'Backend' } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Do the thing',
      description: 'Do the thing well',
      maxAttempts: workspace.maxAttempts,
    },
  })
  const run = await prisma.agentRun.create({ data: { taskId: task.id, agentId: agent.id } })
  return run.id
}

/**
 * Every field of `Checkpoint`, enumerated by hand and checked exhaustively against
 * `keyof Checkpoint` via the `satisfies` clause below -- see this file's own docstring for why
 * this, and not the spread a previous version of this file described, is what makes the pinning
 * test catch a field added to `Checkpoint` and nowhere else.
 */
function checkpointCreateFields(checkpoint: Checkpoint) {
  return {
    sessionId: checkpoint.sessionId,
    worktreePath: checkpoint.worktreePath,
    pauseFlagPath: checkpoint.pauseFlagPath,
    lastToolUseId: checkpoint.lastToolUseId,
    lastToolName: checkpoint.lastToolName,
    numTurns: checkpoint.numTurns,
    deniedToolUseIds: [...checkpoint.deniedToolUseIds],
    headCommit: checkpoint.headCommit,
    dirtyFiles: [...checkpoint.dirtyFiles],
    cumulativeCostUsd: checkpoint.cumulativeCostUsd,
    cumulativeTokens: checkpoint.cumulativeTokens,
    settingsPath: checkpoint.settingsPath,
    hookPath: checkpoint.hookPath,
    gitAuthorName: checkpoint.gitAuthorName,
    gitAuthorEmail: checkpoint.gitAuthorEmail,
    // M10 §6's model field, added after this file's own docstring was written -- the `satisfies`
    // clause below is exactly what caught its absence here: a field added to `Checkpoint` and not
    // listed in this function is a missing-property error, by design. `?? null`, not the bare
    // property, because the Prisma column is `string | null` (no `undefined` in its type) while
    // `Checkpoint.model` is optional -- matching `pump.ts`'s own `spawn.model ?? null` convention.
    model: checkpoint.model ?? null,
    // M12 Task 6's provider field, added the same way `model` was and caught here the same way --
    // same `?? null` convention, same reason.
    provider: checkpoint.provider ?? null,
  } satisfies Record<keyof Checkpoint, unknown>
}

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Checkpoint", "AgentRun", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('Checkpoint shape pinning (providers interface <-> db model)', () => {
  it('writes a Checkpoint built from the providers interface through Prisma and reads every field back unchanged', async (): Promise<void> => {
    const runId = await seedRun()

    // Built purely from the providers `Checkpoint` interface -- no field here is copied from, or
    // checked against, the Prisma model's own shape. If a field existed on the interface and not
    // here, this object literal itself would fail to typecheck (missing required property).
    const checkpoint: Checkpoint = {
      sessionId: 'session-pin-123',
      worktreePath: '/tmp/worktrees/pin-run-1',
      pauseFlagPath: '/tmp/worktrees/pin-run-1/.aiteamos-pause',
      lastToolUseId: 'toolu_01PINABC',
      lastToolName: 'Edit',
      numTurns: 9,
      deniedToolUseIds: ['toolu_01PINDEF', 'toolu_01PINGHI'],
      headCommit: 'f00dcafebabe1234567890abcdef1234567890ab',
      dirtyFiles: ['src/pin.ts', 'src/pin.test.ts'],
      cumulativeCostUsd: 3.1415,
      cumulativeTokens: 98765,
      // Fix round 1's four spawn-critical fields. Non-empty and distinct from the second test's
      // values below -- an empty-string default and a genuinely-empty string read back are just
      // as indistinguishable as an empty array is, so these are set the same way the rest of this
      // test's non-zero/non-empty values are.
      settingsPath: '/tmp/worktrees/pin-run-1/.claude/settings.json',
      hookPath: '/tmp/worktrees/pin-run-1/.claude/pause-gate.sh',
      gitAuthorName: 'Pin Author',
      gitAuthorEmail: 'pin-author@example.com',
      // M10 §6. Set here so this test also proves the non-null case round-trips; the second test
      // below leaves it unset entirely, proving the legacy/never-set case.
      model: 'claude-pin-model',
      // M12 Task 6, same reasoning as `model` immediately above.
      provider: 'claude_code',
    }

    const created = await prisma.checkpoint.create({
      data: { runId, ...checkpointCreateFields(checkpoint) },
    })

    const found = await prisma.checkpoint.findUniqueOrThrow({ where: { id: created.id } })

    // Every field on the providers `Checkpoint` interface, checked individually rather than via
    // a single `toMatchObject` -- a bulk comparison would still pass if both sides happened to
    // drop the same field, which is exactly the silent-drift case this test exists to catch.
    expect(found.sessionId).toBe(checkpoint.sessionId)
    expect(found.worktreePath).toBe(checkpoint.worktreePath)
    expect(found.pauseFlagPath).toBe(checkpoint.pauseFlagPath)
    expect(found.lastToolUseId).toBe(checkpoint.lastToolUseId)
    expect(found.lastToolName).toBe(checkpoint.lastToolName)
    expect(found.numTurns).toBe(checkpoint.numTurns)
    expect(found.deniedToolUseIds).toEqual([...checkpoint.deniedToolUseIds])
    expect(found.headCommit).toBe(checkpoint.headCommit)
    expect(found.dirtyFiles).toEqual([...checkpoint.dirtyFiles])
    expect(found.cumulativeCostUsd).toBe(checkpoint.cumulativeCostUsd)
    expect(found.cumulativeTokens).toBe(checkpoint.cumulativeTokens)
    expect(found.settingsPath).toBe(checkpoint.settingsPath)
    expect(found.hookPath).toBe(checkpoint.hookPath)
    expect(found.gitAuthorName).toBe(checkpoint.gitAuthorName)
    expect(found.gitAuthorEmail).toBe(checkpoint.gitAuthorEmail)
    expect(found.model).toBe(checkpoint.model)
    expect(found.provider).toBe(checkpoint.provider)
  })

  it('round-trips the nullable fields and empty arrays a Checkpoint with no denials yet actually has', async (): Promise<void> => {
    const runId = await seedRun()

    const checkpoint: Checkpoint = {
      sessionId: 'session-pin-456',
      worktreePath: '/tmp/worktrees/pin-run-2',
      pauseFlagPath: '/tmp/worktrees/pin-run-2/.aiteamos-pause',
      lastToolUseId: null,
      lastToolName: null,
      numTurns: 0,
      deniedToolUseIds: [],
      headCommit: 'cafef00d',
      dirtyFiles: [],
      cumulativeCostUsd: 0,
      cumulativeTokens: 0,
      // Unlike lastToolUseId/deniedToolUseIds above, these four have no null/empty variant on
      // `Checkpoint` -- they are required strings with no zero value that means anything -- so
      // this second test still exercises them with real, non-empty values (distinct from the
      // first test's, so a value bleeding across tests would also be caught).
      settingsPath: '/tmp/worktrees/pin-run-2/.claude/settings.json',
      hookPath: '/tmp/worktrees/pin-run-2/.claude/pause-gate.sh',
      gitAuthorName: 'Second Pin Author',
      gitAuthorEmail: 'second-pin-author@example.com',
      // `model` deliberately omitted -- the legacy/never-set case; `undefined` here must round-trip
      // as a `null` column, not a write failure.
      // `provider` likewise omitted, same reasoning.
    }

    const created = await prisma.checkpoint.create({
      data: { runId, ...checkpointCreateFields(checkpoint) },
    })

    const found = await prisma.checkpoint.findUniqueOrThrow({ where: { id: created.id } })

    expect(found.lastToolUseId).toBeNull()
    expect(found.lastToolName).toBeNull()
    expect(found.numTurns).toBe(0)
    expect(found.deniedToolUseIds).toEqual([])
    expect(found.dirtyFiles).toEqual([])
    expect(found.cumulativeCostUsd).toBe(0)
    expect(found.cumulativeTokens).toBe(0)
    expect(found.settingsPath).toBe(checkpoint.settingsPath)
    expect(found.hookPath).toBe(checkpoint.hookPath)
    expect(found.gitAuthorName).toBe(checkpoint.gitAuthorName)
    expect(found.gitAuthorEmail).toBe(checkpoint.gitAuthorEmail)
    expect(found.model).toBeNull()
    expect(found.provider).toBeNull()
  })
})
