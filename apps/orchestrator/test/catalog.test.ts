import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readCatalogDirectory } from '../src/catalog.js'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function makeCatalog(files: Readonly<Record<string, string>>, divisions?: Readonly<Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), 'catalog-m42-'))
  dirs.push(root)
  if (divisions !== undefined) writeFileSync(join(root, 'divisions.json'), JSON.stringify({ _note: 'x', divisions }))
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }
  return root
}

const PERSONA = '---\nname: Core Builder\n---\n\nBody.\n'

describe('readCatalogDirectory', () => {
  it('names the catalog after the directory and builds a sourceId per persona', () => {
    const root = makeCatalog({ 'engineering/core-builder.md': PERSONA })

    const walk = readCatalogDirectory(root)

    expect(walk.catalog).toBe(root.split('/').at(-1))
    expect(walk.entries).toHaveLength(1)
    expect(walk.entries[0]).toMatchObject({
      division: 'engineering',
      slug: 'core-builder',
      sourceId: `${walk.catalog}/engineering/core-builder`,
      text: PERSONA,
    })
  })

  it('reads divisions.json to learn which top-level directories are divisions', () => {
    const root = makeCatalog(
      { 'engineering/one.md': PERSONA, 'outputs/two.md': PERSONA },
      { engineering: { label: 'Engineering' } },
    )

    const walk = readCatalogDirectory(root)

    // Not every top-level directory is a division: a catalog that says so is believed.
    expect(walk.entries.map((entry) => entry.division)).toEqual(['engineering'])
  })

  it('treats every subdirectory as a division when there is no divisions.json', () => {
    const root = makeCatalog({ 'engineering/one.md': PERSONA, 'testing/two.md': PERSONA })

    expect(readCatalogDirectory(root).entries.map((entry) => entry.division).sort()).toEqual(['engineering', 'testing'])
  })

  it('falls back to every subdirectory when divisions.json is malformed', () => {
    const root = makeCatalog({ 'engineering/one.md': PERSONA, 'testing/two.md': PERSONA })
    writeFileSync(join(root, 'divisions.json'), '{ not json at all')

    expect(readCatalogDirectory(root).entries.map((entry) => entry.division).sort()).toEqual(['engineering', 'testing'])
  })

  it('honours an explicit division filter over both', () => {
    const root = makeCatalog({ 'engineering/one.md': PERSONA, 'testing/two.md': PERSONA })

    expect(readCatalogDirectory(root, { divisions: ['testing'] }).entries.map((entry) => entry.slug)).toEqual(['two'])
  })

  it('recurses one level for a tool subfolder and keeps it in the slug', () => {
    const root = makeCatalog({ 'engineering/tooling/builder.md': PERSONA })

    expect(readCatalogDirectory(root).entries[0]).toMatchObject({ division: 'engineering', slug: 'tooling/builder' })
  })

  it('skips the catalog documentation and anything that is not Markdown', () => {
    const root = makeCatalog({
      'engineering/README.md': '# not a persona\n',
      'engineering/CONTRIBUTING.md': '# not a persona\n',
      'engineering/notes.txt': 'x',
      'engineering/one.md': PERSONA,
    })

    expect(readCatalogDirectory(root).entries.map((entry) => entry.slug)).toEqual(['one'])
  })

  it('takes an explicit catalog name over the directory basename', () => {
    const root = makeCatalog({ 'engineering/one.md': PERSONA })

    expect(readCatalogDirectory(root, { catalog: 'named' }).entries[0]?.sourceId).toBe('named/engineering/one')
  })

  it('hands the file over byte for byte, CRLF included', () => {
    // `sourceSha256` is taken over exactly this string, and it is what decides "unchanged" on the
    // next import. Normalising line endings here would make every re-import of a catalog written
    // on another machine look like a change -- and, worse, would make it look like NO change after
    // a file was genuinely rewritten with different endings and different words.
    const crlf = '---\r\nname: Core Builder\r\n---\r\n\r\nBody.\r\n'
    const root = makeCatalog({ 'engineering/one.md': crlf })

    expect(readCatalogDirectory(root).entries[0]?.text).toBe(crlf)
  })
})
