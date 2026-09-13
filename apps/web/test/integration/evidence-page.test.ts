import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildEvidencePage } from '../../src/server/evidence'
import { seedWorkspace, truncateAll, type ProjectFixture } from './projectFixture'

/**
 * The Evidence tab's read (M53 R11, R12).
 *
 * `EvidenceRecord.runId` is a plain `@unique` column and not a foreign key (only `workspaceId` is a
 * relation), so these facts are written directly rather than driven through a pipeline: what is
 * under test here is the VIEW -- the labels, the `Insufficient evidence` substitution, the sort
 * caption and the chips -- over counts `packages/control/test/integration/evidence-read.test.ts`
 * already pins against the SQL that produces them.
 *
 * `truncateAll` does not name `EvidenceRecord`, and does not have to: the row's one relation is to
 * `Workspace`, and `TRUNCATE ... CASCADE` reaches every table whose FK points at a truncated one.
 */
const DEFAULT_PROFILE_KEY = 'template:t-backend'
const DEFAULT_PROFILE_NAME = 'Backend Developer'
const DEFAULT_REPOSITORY = '/srv/checkout'

interface SeedOptions {
  /** The domains every seeded row carries. Defaults to the reserved `general` (R2: never empty). */
  readonly domains?: readonly string[]
  readonly model?: string | null
  /** How many of the rows carry a VERDICT in each of the three judgement columns (R3: each settles
   *  independently, so a row with eight attempts and two integrations is ordinary). Defaults to
   *  every row judged on all three. */
  readonly judged?: { readonly firstPass: number; readonly review: number; readonly integration: number }
  /** How the `count` rows split across the three provenances (R6). Defaults to all reported. */
  readonly reported?: number
  readonly estimated?: number
  readonly unmeasured?: number
  readonly profileKey?: string
  readonly profileName?: string
}

let seq = 0

async function seedEvidence(fixture: ProjectFixture, count: number, options: SeedOptions = {}): Promise<void> {
  const judged = options.judged ?? { firstPass: count, review: count, integration: count }
  const reported = options.reported ?? count
  const estimated = options.estimated ?? 0
  for (let index = 0; index < count; index += 1) {
    seq += 1
    const provenance = index < reported ? 'reported' : index < reported + estimated ? 'estimated' : 'unmeasured'
    await prisma.evidenceRecord.create({
      data: {
        runId: `run-${String(seq)}`,
        workspaceId: fixture.workspaceId,
        slaveId: fixture.slaveId,
        taskId: null,
        profileKey: options.profileKey ?? DEFAULT_PROFILE_KEY,
        profileName: options.profileName ?? DEFAULT_PROFILE_NAME,
        model: options.model === undefined ? 'claude-sonnet-4-20250514' : options.model,
        repositoryKey: DEFAULT_REPOSITORY,
        domains: [...(options.domains ?? ['general'])],
        runKind: 'implementation',
        attempt: 1,
        outcome: 'succeeded',
        verifiedFirstPass: index < judged.firstPass ? true : null,
        reviewRejected: index < judged.review ? false : null,
        integrated: index < judged.integration ? true : null,
        reworkCycles: 0,
        humanInterventions: 0,
        recoveries: 0,
        durationMs: 60_000,
        actualCostUsd: provenance === 'unmeasured' ? null : 1.5,
        costProvenance: provenance,
      },
    })
  }
}

/** R1: a hand-made worker's profile key, which the table has to mark so a reader does not take it
 *  for a persona record. */
async function seedBespokeEvidence(fixture: ProjectFixture, count: number): Promise<void> {
  await seedEvidence(fixture, count, { profileKey: `slave:${fixture.slaveId}`, profileName: 'Alex' })
}

/** Two profiles with the SAME attempt count, so only the name can decide the order. */
async function seedTwoProfiles(fixture: ProjectFixture, counts: { readonly ann: number; readonly zed: number }): Promise<void> {
  await seedEvidence(fixture, counts.zed, { profileKey: 'template:t-zed', profileName: 'Zed' })
  await seedEvidence(fixture, counts.ann, { profileKey: 'template:t-ann', profileName: 'Ann' })
}

describe('buildEvidencePage (M53 R11, R12)', () => {
  let fixture: ProjectFixture

  beforeEach(async (): Promise<void> => {
    await truncateAll()
    fixture = await seedWorkspace()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('answers two tables, deliberately -- profile performance and model performance are two questions', async (): Promise<void> => {
    await seedEvidence(fixture, 6)
    const page = await buildEvidencePage({ domain: null })
    expect(page.byProfile).toHaveLength(1)
    expect(page.byModel).toHaveLength(1)
  })

  it('replaces EVERY rate with the words when the row attempted count is thin (R11)', async (): Promise<void> => {
    await seedEvidence(fixture, 2)
    const row = (await buildEvidencePage({ domain: null })).byProfile[0]
    expect(row?.insufficient).toBe(true)
    expect(row?.firstPass.pct).toBeNull()
    expect(row?.reviewRejected.pct).toBeNull()
    expect(row?.integrated.pct).toBeNull()
    // The COUNTS stay: they are facts, and only the rates are claims.
    expect(row?.attempted).toBe(2)
    expect(row?.firstPass.judged).toBe(2)
  })

  it('replaces ONE rate whose own denominator is thin while its neighbours stay percentages (R11)', async (): Promise<void> => {
    await seedEvidence(fixture, 8, { judged: { firstPass: 8, review: 8, integration: 2 } })
    const row = (await buildEvidencePage({ domain: null })).byProfile[0]
    expect(row?.insufficient).toBe(false)
    expect(row?.firstPass.pct).not.toBeNull()
    expect(row?.integrated.pct).toBeNull()
    expect(row?.integrated.judged).toBe(2)
  })

  it('carries the LABEL and never a bare key for every cell a person reads (ia.md rule 3)', async (): Promise<void> => {
    await seedEvidence(fixture, 6, { domains: ['qa'] })
    const page = await buildEvidencePage({ domain: null })
    expect(page.byProfile[0]?.name).toBe('Backend Developer')
    expect(page.byProfile[0]?.profileKey).toMatch(/^template:/u)
    expect(page.domains.map((one) => one.label)).toContain('QA')
  })

  it('marks a bespoke profile, so a reader does not take it for a persona record (R1)', async (): Promise<void> => {
    await seedBespokeEvidence(fixture, 6)
    expect((await buildEvidencePage({ domain: null })).byProfile[0]?.bespoke).toBe(true)
  })

  it('names the null model group in words in the by-model table (R1)', async (): Promise<void> => {
    await seedEvidence(fixture, 6, { model: null })
    expect((await buildEvidencePage({ domain: null })).byModel[0]?.label).toBe('Model not recorded')
    expect((await buildEvidencePage({ domain: null })).byModel[0]?.model).toBeNull()
  })

  it('splits the money three ways with the three words, and never sums them into one (R6)', async (): Promise<void> => {
    await seedEvidence(fixture, 6, { reported: 2, estimated: 3, unmeasured: 1 })
    const row = (await buildEvidencePage({ domain: null })).byProfile[0]
    expect(row?.reportedUsd).not.toBeNull()
    expect(row?.estimatedUsd).not.toBeNull()
    expect(row?.unmeasuredRuns).toBe(1)
  })

  /**
   * The chip vocabulary is the TAXONOMY's own, plus the reserved `general` (R2) -- see the ruling in
   * `src/server/evidence.ts`. Every domain a fact can carry is a `Capability.domain` by construction,
   * so a chip list built this way can never miss one, which is the safe direction for a filter: an
   * empty chip says honestly that nothing touched that domain, a missing chip is a filter nobody can
   * reach.
   */
  it('offers a chip for every domain the taxonomy declares, and always the reserved general', async (): Promise<void> => {
    await seedEvidence(fixture, 3, { domains: ['backend'] })
    const page = await buildEvidencePage({ domain: null })
    expect(page.domains.map((one) => one.domain)).toContain('backend')
    expect(page.domains.map((one) => one.domain)).toContain('general')
    expect(page.domains.map((one) => one.label)).toContain('General')
  })

  it('narrows both tables to one domain by containment, and counts a two-domain run under either', async (): Promise<void> => {
    await seedEvidence(fixture, 3, { domains: ['backend', 'qa'] })
    await seedEvidence(fixture, 2, { domains: ['docs'], profileKey: 'template:t-docs', profileName: 'Tech Writer' })
    expect((await buildEvidencePage({ domain: 'backend' })).byProfile.map((one) => one.name)).toEqual(['Backend Developer'])
    expect((await buildEvidencePage({ domain: 'qa' })).byProfile[0]?.attempted).toBe(3)
    expect((await buildEvidencePage({ domain: 'docs' })).byProfile.map((one) => one.name)).toEqual(['Tech Writer'])
  })

  it('sorts by attempted descending then by NAME ascending, and says so in the caption (R11)', async (): Promise<void> => {
    await seedTwoProfiles(fixture, { ann: 2, zed: 2 })
    const page = await buildEvidencePage({ domain: null })
    expect(page.byProfile.map((one) => one.name)).toEqual(['Ann', 'Zed'])
    expect(page.sortCaption).toMatch(/most runs first/iu)
    expect(page.sortCaption).toMatch(/name/iu)
  })

  it('hands the sample floor to the page rather than making it guess one', async (): Promise<void> => {
    expect((await buildEvidencePage({ domain: null })).minSample).toBe(5)
  })
})
