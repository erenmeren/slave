import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prisma } from '@slave-of-ai/db/client'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * The M40 follow-up migration that UN-stamps hand-made tasks, executed as the file on disk.
 *
 * The same idiom as `provider-backfill.test.ts` and for the same reason (spec erratum E2): the
 * migration is the artifact under test, so a test that re-typed its `UPDATE` in TypeScript would
 * stay green against SQL that had drifted, was never applied, or was deleted. The directory is
 * found by SUFFIX so the timestamp prefix stays Prisma's to change.
 *
 * What it repairs: `20260910120000_m40_requirement_versioning`'s backfill stamped EVERY task of a
 * goal-bearing workspace `goalVersion = 1`, including the ones a person typed in. Spec §1 says a
 * hand-made task is derived from no goal at all and carries a null stamp -- a `1` there tells the
 * re-plan trigger the board has caught up with version 1 and hands the Supervisor a version nobody
 * ever chose for it.
 */
const MIGRATIONS_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../db/prisma/migrations')

function unstampSql(): string {
  const dir = readdirSync(MIGRATIONS_DIR).find((name) => name.endsWith('_m40_unstamp_hand_made'))
  if (dir === undefined) throw new Error(`no *_m40_unstamp_hand_made migration exists in ${MIGRATIONS_DIR}`)
  return readFileSync(path.join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8')
}

async function makeTask(
  workspaceId: string,
  title: string,
  createdBy: 'human' | 'slave',
  goalVersion: number | null,
): Promise<string> {
  const task = await prisma.task.create({
    data: { workspaceId, title, description: 'seeded by the test', status: 'backlog', maxAttempts: 3, createdBy, goalVersion },
  })
  return task.id
}

const stampOf = async (taskId: string): Promise<number | null> =>
  (await prisma.task.findUniqueOrThrow({ where: { id: taskId }, select: { goalVersion: true } })).goalVersion

describe('the M40 hand-made-task un-stamp migration', () => {
  let workspaceId: string

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "Task", "Workspace" RESTART IDENTITY CASCADE')
    const workspace = await prisma.workspace.create({
      data: {
        name: 'checkout-platform',
        repoPath: '/tmp/checkout-platform',
        verifyCommands: ['true'],
        setupCommands: [],
        goal: 'Ship the checkout redesign',
        goalVersion: 1,
      },
    })
    workspaceId = workspace.id
  })

  it('takes the version off a task a HUMAN made and leaves the planned ones stamped', async (): Promise<void> => {
    // Exactly the state the first M40 migration leaves behind on a real database.
    const handMade = await makeTask(workspaceId, 'Fix the flaky test', 'human', 1)
    const planned = await makeTask(workspaceId, 'Expose the API', 'slave', 1)

    await prisma.$executeRawUnsafe(unstampSql())

    expect(await stampOf(handMade)).toBeNull()
    // The plan's own tasks are what version 1 really did produce: the repair must not reach them.
    expect(await stampOf(planned)).toBe(1)
  })

  it('leaves a hand-made task stamped with any LATER version alone', async (): Promise<void> => {
    // The `= 1` bound is what makes this a repair of the backfill rather than a blanket erasure:
    // a stamp no backfill could have written is evidence, and evidence is not silently discarded.
    const handMade = await makeTask(workspaceId, 'Fix the flaky test', 'human', 3)

    await prisma.$executeRawUnsafe(unstampSql())

    expect(await stampOf(handMade)).toBe(3)
  })

  it('changes nothing on a second run', async (): Promise<void> => {
    const handMade = await makeTask(workspaceId, 'Fix the flaky test', 'human', 1)
    const planned = await makeTask(workspaceId, 'Expose the API', 'slave', 1)

    await prisma.$executeRawUnsafe(unstampSql())
    await prisma.$executeRawUnsafe(unstampSql())

    expect(await stampOf(handMade)).toBeNull()
    expect(await stampOf(planned)).toBe(1)
  })
})
