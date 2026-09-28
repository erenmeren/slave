import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConductCatalogue, loadRepositoryFacts } from '../../src/conductFacts.js'

/**
 * This suite's own `SlaveTemplate` rows, deleted by name rather than by `TRUNCATE ... CASCADE`.
 * `SlaveTemplate` truncated CASCADE reaches `RunbookTemplate` (and through it `Workspace`),
 * `Person` (`HiredPersons`), `TemplateSkill`, `TemplateDuplicate` and `CollaborationHint` -- every
 * one of them outside this test's own data, exactly the past defect
 * `packages/control/test/integration/org.test.ts:16-20` documents (M48 final review I2). Nothing
 * else references these two rows (they are created fresh, under names nothing else uses), so a
 * plain delete by name has no cascade to name at all.
 */
const TEMPLATE_NAMES = ['Active Persona', 'Inactive Persona']

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

/** A real repository, with `main` as its branch (as `planning.test.ts`'s `makeRepo` also makes it):
 *  two small Python source files, one Python source file over the symbol-read size cap, and a
 *  binary large enough that the cap would skip it too, if its extension did not already. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-conduct-facts-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src/cli.py'), 'def main():\n  pass\n')
  writeFileSync(join(dir, 'src/report.py'), 'def render():\n  pass\n')
  // A known extension (`.py`) with a real top-level `def`, but past the 64 KB symbol-read cap --
  // proves the cap is read from the blob's SIZE, not just steered around by extension.
  writeFileSync(join(dir, 'src/big.py'), `def large():\n  pass\n${'# padding\n'.repeat(8_000)}`)
  writeFileSync(join(dir, 'data.bin'), Buffer.alloc(200 * 1024, 7))
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'initial'], dir)
  return dir
}

describe('loadRepositoryFacts', () => {
  it('lists every tracked file at ref and renders symbols only for known, small-enough source files', async () => {
    const repo = makeRepo()
    try {
      const facts = await loadRepositoryFacts(repo, 'main')

      expect(facts.files).toEqual(expect.arrayContaining(['src/cli.py', 'src/report.py', 'src/big.py', 'data.bin']))
      expect(facts.map).toContain('src/cli.py (')
      expect(facts.map).toContain(': main')
      expect(facts.map).toMatch(/data\.bin \(\d+ B\)$/mu) // listed, no symbols: unknown extension
      expect(facts.map).toMatch(/src\/big\.py \(\d+ B\)$/mu) // listed, no symbols: over the size cap
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('loadConductCatalogue', () => {
  beforeEach(async (): Promise<void> => {
    // Defensive: repairs a leftover from a previous run this suite crashed out of, same reason
    // `beforeEach` truncates elsewhere in the codebase. Not a TRUNCATE -- see TEMPLATE_NAMES.
    await prisma.slaveTemplate.deleteMany({ where: { name: { in: TEMPLATE_NAMES } } })
  })

  afterEach(async (): Promise<void> => {
    await prisma.slaveTemplate.deleteMany({ where: { name: { in: TEMPLATE_NAMES } } })
  })

  it('shows only the active template, both in the rendered text and in templateIds', async () => {
    const active = await prisma.slaveTemplate.create({
      data: {
        name: 'Active Persona',
        role: 'backend',
        description: 'Active Persona does one thing.',
        capabilityKeys: ['backend.services'],
        sourceDivision: 'engineering',
        active: true,
      },
    })
    await prisma.slaveTemplate.create({
      data: {
        name: 'Inactive Persona',
        role: 'backend',
        description: 'Inactive Persona does one thing.',
        capabilityKeys: ['backend.services'],
        sourceDivision: 'engineering',
        active: false,
      },
    })

    const { text, templateIds } = await loadConductCatalogue()

    // `.has`/`.not.toContain` rather than a strict-equality snapshot of the whole set: cleanup here
    // is scoped to this test's own two rows (see TEMPLATE_NAMES above), not a table-wide TRUNCATE,
    // so the table may hold other active templates this test never created and must not assert
    // about either way.
    expect(templateIds.has(active.id)).toBe(true)
    expect(text).toContain(active.id)
    expect(text).not.toContain('Inactive Persona')
  })
})
