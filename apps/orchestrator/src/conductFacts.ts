import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  CONDUCT_CATALOGUE_MAX_CHARS,
  REPO_MAP_MAX_CHARS,
  REPO_MAP_MAX_FILES,
  REPO_MAP_SYMBOL_FILES_MAX,
  renderCatalogue,
  renderRepositoryMap,
  topLevelSymbols,
  type RepoFileEntry,
} from '@slave-of-ai/domain'
import { prisma } from '@slave-of-ai/db/client'

const run = promisify(execFile)
const SYMBOL_FILE_MAX_BYTES = 64 * 1024

/** The languages `topLevelSymbols` reads; any other file is listed with its size only. */
const KNOWN = /\.(?:[cm]?[jt]sx?|py|go|rs)$/u

/**
 * What the conductor is shown about the repository (spec R2) and what ownership is validated
 * against (spec R3): the files of `ref` -- the base branch, never a worktree's uncommitted state --
 * read with `git ls-tree`, so nothing is checked out. Symbols come from the first
 * REPO_MAP_SYMBOL_FILES_MAX small files, read as blobs.
 *
 * `promisify(execFile)` rather than the repository's `gitIn` (`@slave-of-ai/control`): `gitIn`
 * returns stdout, but with no way to raise its 1 MiB default `maxBuffer` -- and `ls-tree -r -l` on
 * a real repository, or `cat-file blob` on a file just under the symbol-read size cap, both exceed
 * that routinely. Neither call needs `gitIn`'s identity flags either: both are read-only.
 */
export async function loadRepositoryFacts(
  repoPath: string,
  ref: string,
): Promise<{ readonly files: readonly string[]; readonly map: string }> {
  const { stdout } = await run('git', ['-C', repoPath, 'ls-tree', '-r', '-l', '--full-name', ref], { maxBuffer: 64 * 1024 * 1024 })
  const blobs = stdout
    .split('\n')
    .flatMap((line) => {
      const match = /^\d+ blob ([0-9a-f]+)\s+(\d+|-)\t(.+)$/u.exec(line)
      return match === null ? [] : [{ sha: match[1] ?? '', bytes: Number(match[2]), path: match[3] ?? '' }]
    })
  const files = blobs.map((b) => b.path)
  const entries: RepoFileEntry[] = []
  let symbolReads = 0
  for (const blob of blobs.slice(0, REPO_MAP_MAX_FILES)) {
    let symbols: readonly string[] = []
    if (symbolReads < REPO_MAP_SYMBOL_FILES_MAX && blob.bytes <= SYMBOL_FILE_MAX_BYTES && KNOWN.test(blob.path)) {
      symbolReads += 1
      const { stdout: blobText } = await run('git', ['-C', repoPath, 'cat-file', 'blob', blob.sha], { maxBuffer: SYMBOL_FILE_MAX_BYTES * 2 })
      symbols = topLevelSymbols(blob.path, blobText)
    }
    entries.push({ path: blob.path, bytes: blob.bytes, symbols })
  }
  return { files, map: renderRepositoryMap(entries, files.length, REPO_MAP_MAX_CHARS) }
}

/**
 * The personas the conductor may staff a package with (plan decision D2): active templates, the
 * same gate `loadCatalogEntries` applies to Supervisor hiring (M55 R2).
 */
export async function loadConductCatalogue(): Promise<{ readonly text: string; readonly templateIds: ReadonlySet<string> }> {
  const templates = await prisma.slaveTemplate.findMany({
    where: { active: true },
    select: { id: true, name: true, sourceDivision: true, capabilityKeys: true },
    orderBy: { name: 'asc' },
  })
  const text = renderCatalogue(
    templates.map((t) => ({ templateId: t.id, name: t.name, division: t.sourceDivision, capabilities: t.capabilityKeys })),
    CONDUCT_CATALOGUE_MAX_CHARS,
  )
  // Only the templates the model was SHOWN are valid answers: a persona cut by the budget is one
  // it cannot have chosen on purpose.
  const shown = new Set(text.split('\n').map((line) => line.split(' | ')[0] ?? '').filter((id) => id !== ''))
  return { text, templateIds: shown }
}
