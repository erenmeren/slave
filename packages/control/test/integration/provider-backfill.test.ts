import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prisma } from '@ai-team-os/db/client'
import { beforeEach, describe, expect, it } from 'vitest'
import { workspaceDefaultProvider } from '../../src/runtime.js'

/**
 * The C1 backfill migration, executed as the file on disk rather than as a re-typed copy.
 *
 * The migration is the artifact under test: a test that re-states its INSERT in TypeScript would
 * stay green against a migration whose SQL had drifted, was never applied, or was deleted -- which
 * is precisely the failure C1 describes (a shipped database nobody re-checked). So the SQL is read
 * from `packages/db/prisma/migrations/*_m12_provider_configuration_backfill/migration.sql` and run
 * verbatim through `$executeRawUnsafe`. The directory is located by SUFFIX, not by its full name,
 * because the timestamp prefix is Prisma's and must be free to change if this migration is ever
 * re-cut ahead of another.
 */
const MIGRATIONS_DIR = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../db/prisma/migrations',
)

function backfillSql(): string {
  const dir = readdirSync(MIGRATIONS_DIR).find((name) => name.endsWith('_m12_provider_configuration_backfill'))
  if (dir === undefined) {
    throw new Error(`no *_m12_provider_configuration_backfill migration exists in ${MIGRATIONS_DIR}`)
  }
  return readFileSync(path.join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8')
}

async function makeWorkspace(name: string): Promise<string> {
  const workspace = await prisma.workspace.create({
    data: { name, repoPath: `/tmp/${name}`, verifyCommands: ['true'], setupCommands: [] },
  })
  return workspace.id
}

/**
 * A pre-M12 database is one whose workspaces have no `ProviderConfiguration` row at all -- nothing
 * wrote that table before this milestone (`packages/control/src/org.ts` says so in as many words).
 * Creating a workspace and writing no configuration for it reproduces that state exactly, which is
 * why these tests need no fixture beyond `prisma.workspace.create`.
 */
describe('the M12 provider-configuration backfill migration', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ProviderConfiguration", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  it('gives a workspace that predates M12 the claude_code default it has always in fact been running', async (): Promise<void> => {
    const workspaceId = await makeWorkspace('checkout-platform')
    // The C1 symptom, asserted before the repair so the test cannot pass vacuously: with no row,
    // the chain's last link is a refusal and every dispatch for this workspace throws.
    expect(await workspaceDefaultProvider(workspaceId)).toBeNull()

    await prisma.$executeRawUnsafe(backfillSql())

    expect(await workspaceDefaultProvider(workspaceId)).toBe('claude_code')
  })

  it('adds no second row when it is applied again', async (): Promise<void> => {
    const workspaceId = await makeWorkspace('checkout-platform')

    await prisma.$executeRawUnsafe(backfillSql())
    await prisma.$executeRawUnsafe(backfillSql())

    const rows = await prisma.providerConfiguration.findMany({ where: { workspaceId } })
    expect(rows).toHaveLength(1)
    // A second row would not merely be untidy: `workspaceDefaultProvider` refuses a workspace with
    // more than one configured kind, so a non-idempotent backfill would re-create C1's outage in
    // the other direction.
    expect(await workspaceDefaultProvider(workspaceId)).toBe('claude_code')
  })

  it('leaves a workspace that already chose a provider alone', async (): Promise<void> => {
    const workspaceId = await makeWorkspace('checkout-platform')
    await prisma.providerConfiguration.create({ data: { workspaceId, kind: 'cursor', settings: {} } })

    await prisma.$executeRawUnsafe(backfillSql())

    expect(await workspaceDefaultProvider(workspaceId)).toBe('cursor')
  })

  it('backfills only the workspaces that need it, in a database that holds both', async (): Promise<void> => {
    const legacyId = await makeWorkspace('legacy')
    const configuredId = await makeWorkspace('configured')
    await prisma.providerConfiguration.create({ data: { workspaceId: configuredId, kind: 'cursor', settings: {} } })

    await prisma.$executeRawUnsafe(backfillSql())

    expect(await workspaceDefaultProvider(legacyId)).toBe('claude_code')
    expect(await workspaceDefaultProvider(configuredId)).toBe('cursor')
  })
})
