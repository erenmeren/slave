import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { CatalogEntry } from '@slave-of-ai/control'

export interface CatalogWalk {
  readonly catalog: string
  /** The divisions this walk actually read, in the order it read them. Reported rather than
   *  inferred from `entries`: a real division that happens to hold no persona is still a division
   *  the operator named correctly, and `--role-map`'s "is this a division?" check must not call it
   *  unknown. */
  readonly divisions: readonly string[]
  /** Explicit `--division` names with no directory behind them, dropped rather than walked. */
  readonly missingDivisions: readonly string[]
  /** M2 fix round 2: `divisions.json` names with no directory behind them, when the manifest
   *  parsed but not one of its declared divisions exists on disk -- a distinct case from
   *  `missingDivisions`, which is about what the OPERATOR typed rather than what the catalog
   *  itself declares. Non-empty only when `options.divisions` was not given (an explicit
   *  `--division` list is checked against disk directly and never consults the manifest). */
  readonly staleManifestDivisions: readonly string[]
  /** M46 R4: the commit of the catalog checkout, or null when the directory is not inside a git
   *  work tree -- which is the ordinary case for a directory copied off a share. Read ONCE per
   *  walk: `sourceId` and `sourceSha256` identify a file and its bytes, and neither says which
   *  version of the catalog those bytes came from. */
  readonly revision: string | null
  /** M46 R4/E15: the licence a LICENSE file at the catalog root names, `MIT License` -> `MIT`.
   *  Attribution in metadata; no licence text is copied anywhere and nothing is vendored. */
  readonly license: string | null
  readonly entries: readonly CatalogEntry[]
}

/** Whether one path is a directory that can be read at all -- `statSync` in a `try`, because the
 *  question "does this exist" and the question "may I read it" have the same answer here: no. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The files a catalog keeps for its own readers rather than for a slave, in every catalog that
 *  has them. Matched case-insensitively: the same document is `README.md` in one catalog and
 *  `Readme.md` in the next. */
const NOT_PERSONAS = new Set(['readme.md', 'contributing.md', 'security.md'])

/**
 * Which top-level directories hold personas.
 *
 * A catalog that ships a `divisions.json` is believed, because not every top-level directory is a
 * division -- rendered output, playbooks, scripts and examples all live beside them in the shape
 * this milestone was designed against. Its structure is `{ divisions: { "<dir>": {...} } }`, so the
 * set is that object's KEYS. A missing, unreadable or malformed file is not a failure: the walk
 * falls back to "every subdirectory", which is what a catalog with no manifest means.
 *
 * A manifest that PARSED is a different story even when every name it lists is stale (M2 fix round
 * 2): that is not "no manifest", so falling back to "every subdirectory" would silently import
 * directories the operator never declared and give no sign the manifest is out of date. `stale`
 * carries exactly those declared-but-nonexistent names back to `readCatalogDirectory`, which
 * reports them and imports nothing for them, rather than guessing "every subdirectory" instead.
 */
function divisionsOf(dir: string): { readonly usable: readonly string[]; readonly stale: readonly string[] } {
  const subdirectories = readdirSync(dir, { withFileTypes: true })
    .filter((item) => item.isDirectory() && !item.name.startsWith('.'))
    .map((item) => item.name)
    .sort()
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'divisions.json'), 'utf8'))
    const declared =
      typeof parsed === 'object' &&
      parsed !== null &&
      'divisions' in parsed &&
      typeof parsed.divisions === 'object' &&
      parsed.divisions !== null
        ? Object.keys(parsed.divisions)
        : []
    // A declared name with no directory behind it is dropped rather than walked: `readdirSync` on
    // a path that does not exist throws, and a stale manifest entry -- among others that ARE
    // usable -- is not a reason to fail an import of the divisions that DO exist.
    const usable = declared.filter((name) => subdirectories.includes(name))
    if (usable.length > 0) return { usable, stale: [] }
    // Nothing declared exists on disk. `declared.length === 0` means the file did not even declare
    // a `divisions` object worth reading -- indistinguishable from malformed -- so that case still
    // falls back; every OTHER declared-but-entirely-stale case is reported rather than guessed at.
    return declared.length > 0 ? { usable: [], stale: declared } : { usable: subdirectories, stale: [] }
  } catch {
    return { usable: subdirectories, stale: [] }
  }
}

/**
 * The commit the catalog is checked out at, when there is one.
 *
 * `git`, in a `try`, in the APPLICATION -- never in `packages/domain`, which imports no Node
 * built-in at all because `apps/web`'s client bundle imports it. Three ordinary situations give
 * null and none of them is an error: the directory is not a work tree, `git` is not installed,
 * and a fresh repository has no commit for `rev-parse HEAD` to resolve.
 */
function revisionOf(root: string): string | null {
  try {
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return head === '' ? null : head
  } catch {
    return null
  }
}

/** The catalog's licence, from the FIRST non-empty line of the first LICENSE file at its root.
 *  `MIT License` -> `MIT`; anything else short enough to be a licence name is kept as written;
 *  anything longer is null, because the first line of a licence TEXT is not a licence name. */
function licenseOf(root: string): string | null {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    let text: string
    try {
      text = readFileSync(join(root, name), 'utf8')
    } catch {
      continue
    }
    const first = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '')
    if (first === undefined) return null
    const named = /^(.{1,60}?)\s+Licen[cs]e$/i.exec(first)
    if (named !== null) return named[1] as string
    return first.length <= 60 ? first : null
  }
  return null
}

/** Every `.md` persona under one division, one level of subfolder included -- some catalogs group a
 *  division's personas by the tool they are written for. */
function personasUnder(divisionDir: string): readonly { readonly slug: string; readonly path: string }[] {
  const found: { slug: string; path: string }[] = []
  for (const item of readdirSync(divisionDir, { withFileTypes: true })) {
    if (item.name.startsWith('.')) continue
    if (item.isFile()) {
      if (!item.name.endsWith('.md') || NOT_PERSONAS.has(item.name.toLowerCase())) continue
      found.push({ slug: item.name.slice(0, -3), path: join(divisionDir, item.name) })
      continue
    }
    if (!item.isDirectory()) continue
    // ONE level, not a full recursion: a tool subfolder is a real shape, and a `sourceId` is
    // `<catalog>/<division>/<slug>` -- an arbitrarily deep tree would put slashes in the slug
    // that no operator could map back to a division.
    for (const nested of readdirSync(join(divisionDir, item.name), { withFileTypes: true })) {
      // The same dotfile guard the loop above has (fix round 1, minor 5): an editor's swap file
      // and a half-written `.draft.md` are as ordinary one level down as they are beside it.
      if (nested.name.startsWith('.')) continue
      if (!nested.isFile() || !nested.name.endsWith('.md') || NOT_PERSONAS.has(nested.name.toLowerCase())) continue
      found.push({ slug: `${item.name}/${nested.name.slice(0, -3)}`, path: join(divisionDir, item.name, nested.name) })
    }
  }
  return found.sort((left, right) => left.slug.localeCompare(right.slug))
}

/**
 * Reads a catalog directory into the entries `importCatalog` takes (M42 §2).
 *
 * The walk lives HERE, not in `packages/control` and certainly not in `packages/domain`: the domain
 * touches no disk at all (it is imported by the web's client bundle) and the control package's
 * verbs take data, so the one place that knows what a catalog looks like on a filesystem is the
 * application an operator runs.
 *
 * The catalog's NAME defaults to the directory's basename, resolved at runtime and never written
 * down anywhere: the first segment of every `sourceId` is a fact about the operator's disk, not a
 * constant this repository gets to choose.
 *
 * The file's text is handed over byte for byte -- no line-ending normalisation, no trimming.
 * `sourceSha256` is taken over exactly this string and is what decides "unchanged" on the next
 * import, so any rewriting here would either invent changes or hide them.
 */
export function readCatalogDirectory(
  dir: string,
  options?: { readonly catalog?: string; readonly divisions?: readonly string[] },
): CatalogWalk {
  const root = resolve(dir)
  const catalog = options?.catalog ?? basename(root)
  // An explicit `--division` list is checked against disk directly and never consults the
  // manifest at all -- `staleManifestDivisions` is a fact about `divisions.json`, which this branch
  // never reads. Read once, not once per field: `divisionsOf` walks the directory and re-reads the
  // manifest file itself.
  const manifest = options?.divisions === undefined ? divisionsOf(root) : undefined
  const staleManifestDivisions = manifest?.stale ?? []
  const requested = options?.divisions ?? manifest?.usable ?? []

  // A `--division` naming a directory that is not there is DROPPED and reported, not walked (fix
  // round 1, minor 3): `readdirSync` throws ENOENT, and one mistyped name in
  // `--division engineering,testng,design` used to abort the walk so that nothing at all was
  // imported. The two divisions the operator spelled correctly still are, and the CLI prints the
  // typo. Nothing is filtered out of the `divisionsOf` path by this -- every name there came from
  // a `readdirSync` of the root a moment ago.
  const divisions = requested.filter((division) => isDirectory(join(root, division)))
  const missingDivisions = requested.filter((division) => !divisions.includes(division))

  const entries: CatalogEntry[] = []
  for (const division of divisions) {
    for (const persona of personasUnder(join(root, division))) {
      entries.push({
        sourceId: `${catalog}/${division}/${persona.slug}`,
        division,
        slug: persona.slug,
        path: persona.path,
        text: readFileSync(persona.path, 'utf8'),
      })
    }
  }
  return {
    catalog,
    divisions,
    missingDivisions,
    staleManifestDivisions,
    revision: revisionOf(root),
    license: licenseOf(root),
    entries,
  }
}
