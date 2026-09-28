import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConductCatalogue, loadRepositoryFacts } from '../../src/conductFacts.js'

const TRUNCATE = 'TRUNCATE TABLE "SlaveTemplate" RESTART IDENTITY CASCADE'

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

/** A real repository, with `main` as its branch (as `planning.test.ts`'s `makeRepo` also makes it),
 *  two Python source files and a binary large enough that the symbol-read size cap should skip it
 *  on size alone. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-conduct-facts-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src/cli.py'), 'def main():\n  pass\n')
  writeFileSync(join(dir, 'src/report.py'), 'def render():\n  pass\n')
  writeFileSync(join(dir, 'data.bin'), Buffer.alloc(200 * 1024, 7))
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'initial'], dir)
  return dir
}

describe('loadRepositoryFacts', () => {
  it('lists every tracked file at ref and renders symbols only for known source files', async () => {
    const repo = makeRepo()
    try {
      const facts = await loadRepositoryFacts(repo, 'main')

      expect(facts.files).toEqual(expect.arrayContaining(['src/cli.py', 'src/report.py', 'data.bin']))
      expect(facts.map).toContain('src/cli.py (')
      expect(facts.map).toContain(': main')
      expect(facts.map).toMatch(/data\.bin \(\d+ B\)$/mu) // listed, no symbols
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('loadConductCatalogue', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  afterEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
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

    expect(templateIds).toEqual(new Set([active.id]))
    expect(text).toContain(active.id)
    expect(text).not.toContain('Inactive Persona')
  })
})
