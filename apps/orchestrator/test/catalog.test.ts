import { execFileSync } from 'node:child_process'
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

  it('recurses one level for a tool subfolder and keeps it in the slug and the sourceId', () => {
    const root = makeCatalog({ 'engineering/tooling/builder.md': PERSONA })

    const walk = readCatalogDirectory(root)

    expect(walk.entries[0]).toMatchObject({
      division: 'engineering',
      slug: 'tooling/builder',
      sourceId: `${walk.catalog}/engineering/tooling/builder`,
    })
  })

  it('skips a dotfile inside a tool subfolder, exactly as it does beside it', () => {
    // An editor's swap file and a half-written draft are as ordinary one level down as they are at
    // the top of a division, and `.draft.md` ends in `.md` like everything else here.
    const root = makeCatalog({ 'engineering/tooling/.draft.md': PERSONA, 'engineering/tooling/builder.md': PERSONA })

    expect(readCatalogDirectory(root).entries.map((entry) => entry.slug)).toEqual(['tooling/builder'])
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

  it('drops an explicit division with no directory behind it and imports the rest', () => {
    // ENOENT on one mistyped `--division` used to abort the whole walk, so a run that named three
    // divisions and misspelled one imported NOTHING. The typo is reported instead, and the
    // divisions that do exist are still read.
    const root = makeCatalog({ 'engineering/one.md': PERSONA })

    const walk = readCatalogDirectory(root, { divisions: ['engineering', 'no-such-division'] })

    expect(walk.entries.map((entry) => entry.slug)).toEqual(['one'])
    expect(walk.divisions).toEqual(['engineering'])
    expect(walk.missingDivisions).toEqual(['no-such-division'])
  })

  it('counts a real division with no persona in it as resolved, not missing', () => {
    // What `--role-map` checks its keys against: a division that exists and happens to be empty is
    // not a name the operator got wrong.
    const root = makeCatalog({ 'engineering/one.md': PERSONA })
    mkdirSync(join(root, 'design'), { recursive: true })

    const walk = readCatalogDirectory(root)

    expect([...walk.divisions].sort()).toEqual(['design', 'engineering'])
    expect(walk.missingDivisions).toEqual([])
    expect(walk.entries.map((entry) => entry.slug)).toEqual(['one'])
  })

  it('takes an explicit catalog name over the directory basename', () => {
    const root = makeCatalog({ 'engineering/one.md': PERSONA })

    expect(readCatalogDirectory(root, { catalog: 'named' }).entries[0]?.sourceId).toBe('named/engineering/one')
  })

  it('reports every division as stale, and imports nothing, when divisions.json parsed but names nothing on disk (M2)', () => {
    // The manifest parsed cleanly -- this is NOT the "missing, unreadable or malformed" case that
    // falls back to "every subdirectory". Every name it lists is stale, and falling back anyway
    // would silently import directories the operator never declared, with no sign the manifest is
    // out of date.
    const root = makeCatalog({ 'engineering/one.md': PERSONA }, { lost: { label: 'Lost' } })

    const walk = readCatalogDirectory(root)

    expect(walk.divisions).toEqual([])
    expect(walk.missingDivisions).toEqual([])
    expect(walk.staleManifestDivisions).toEqual(['lost'])
    expect(walk.entries).toEqual([])
  })

  it('an explicit --division list never consults the manifest, so it reports missing rather than stale', () => {
    const root = makeCatalog({ 'engineering/one.md': PERSONA }, { lost: { label: 'Lost' } })

    const walk = readCatalogDirectory(root, { divisions: ['engineering', 'lost'] })

    expect(walk.divisions).toEqual(['engineering'])
    expect(walk.missingDivisions).toEqual(['lost'])
    expect(walk.staleManifestDivisions).toEqual([])
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

describe('readCatalogDirectory and the source record (M46 R4)', () => {
  /** A real one-commit work tree in a temp directory. `-c user.*` on the command rather than in a
   *  config file: this repository's own identity must not decide whether the fixture commits. */
  const commit = (dir: string): string => {
    execFileSync('git', ['init', '-q', dir])
    execFileSync('git', ['-C', dir, 'add', '-A'])
    execFileSync('git', [
      '-C', dir,
      '-c', 'user.email=gate@example.invalid',
      '-c', 'user.name=Gate',
      // `--no-verify` and an empty hooks path: the operator's global hooks are not this fixture's
      // business, and a `commit-msg` hook somewhere on the machine must not fail the test suite.
      '-c', 'core.hooksPath=',
      'commit', '-q', '--no-verify', '-m', 'fixture',
    ])
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  }

  it('reads the checkout commit when the directory is inside a git work tree', () => {
    const dir = makeCatalog({ 'engineering/one.md': '---\nname: One\n---\n\nbody\n' })
    const head = commit(dir)

    expect(readCatalogDirectory(dir).revision).toBe(head)
  })

  it('reads a licence from the first line of LICENSE, and turns "MIT License" into "MIT"', () => {
    const dir = makeCatalog({
      'engineering/one.md': '---\nname: One\n---\n\nbody\n',
      LICENSE: 'MIT License\n\nCopyright (c) 2026 Somebody\n',
    })

    expect(readCatalogDirectory(dir).license).toBe('MIT')
  })

  it('reads LICENSE.md and LICENSE.txt too, and keeps a short line that is not "<name> License"', () => {
    const md = makeCatalog({ 'engineering/one.md': '---\nname: One\n---\n\nbody\n', 'LICENSE.md': '\n\nApache Licence\n' })
    expect(readCatalogDirectory(md).license).toBe('Apache')

    const txt = makeCatalog({ 'engineering/one.md': '---\nname: One\n---\n\nbody\n', 'LICENSE.txt': 'CC0-1.0\n' })
    expect(readCatalogDirectory(txt).license).toBe('CC0-1.0')
  })

  it('gives null for both when there is no work tree and no LICENSE', () => {
    const dir = makeCatalog({ 'engineering/one.md': '---\nname: One\n---\n\nbody\n' })

    const walk = readCatalogDirectory(dir)
    expect(walk.revision).toBeNull()
    expect(walk.license).toBeNull()
  })

  it('gives null for a licence line nobody can read as one', () => {
    const dir = makeCatalog({ 'engineering/one.md': '---\nname: One\n---\n\nbody\n', LICENSE: `${'x'.repeat(200)}\n` })

    expect(readCatalogDirectory(dir).license).toBeNull()
  })
})
