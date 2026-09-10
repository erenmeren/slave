import { readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { CatalogEntry } from '@slave-of-ai/control'

export interface CatalogWalk {
  readonly catalog: string
  readonly entries: readonly CatalogEntry[]
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
 */
function divisionsOf(dir: string): readonly string[] {
  const subdirectories = readdirSync(dir, { withFileTypes: true })
    .filter((item) => item.isDirectory() && !item.name.startsWith('.'))
    .map((item) => item.name)
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
    // a path that does not exist throws, and a stale manifest entry is not a reason to fail an
    // import of the divisions that DO exist.
    const usable = declared.filter((name) => subdirectories.includes(name))
    return usable.length > 0 ? usable : subdirectories
  } catch {
    return subdirectories
  }
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
  const divisions = options?.divisions ?? divisionsOf(root)

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
  return { catalog, entries }
}
