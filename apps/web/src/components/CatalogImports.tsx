'use client'

import { DUPLICATE_CLASS_LABEL, type DuplicateCounts } from '@slave-of-ai/domain'
import { DataTable, Row } from './ui/DataTable'

/** One `CatalogImport` row, as `server/org.ts`'s `listCatalogImports` hands it over. */
export interface CatalogImportRow {
  readonly id: string
  readonly catalog: string
  readonly directory: string
  readonly by: string | null
  readonly finishedAt: string
  readonly created: number
  readonly updated: number
  readonly unchanged: number
  readonly skipped: number
  /** M55 R7, plan erratum E9: what the run's duplicate pass noticed. Three zeroes for every import
   *  recorded before that milestone, which is true -- nothing was looking. */
  readonly duplicates: DuplicateCounts
}

const COLUMNS = '150px 1fr 110px 70px 70px 80px 70px 70px 70px 90px'

/**
 * The last header is READ OUT OF THE LABEL TABLE, and the other two are not (fix round 1,
 * important 1).
 *
 * `packages/domain/src/catalog/duplicate.ts` states R6's rule in its own words: no surface prints
 * `exact`, `near`, `overlapping`, `content_hash` or `capability_keys` as visible text, "and a label
 * identical to its member is that member printed". `Overlapping` was that member with one capital
 * letter, on the very tab the milestone's gate scans for the word. `Same` and `Similar` are English
 * for what their columns count and collide with no member at all; the third column's word comes from
 * the table that exists precisely so nobody has to invent one.
 */
const HEADER = [
  'When',
  'Catalog',
  'By',
  'Created',
  'Updated',
  'Unchanged',
  'Skipped',
  'Same',
  'Similar',
  DUPLICATE_CLASS_LABEL.overlapping,
] as const

/** The three duplicate columns say what they COUNT, never the raw class member (`docs/ia.md` rule
 *  3) -- and each cell's `title` carries the class's own label table sentence, so the word on the
 *  header and the word on a catalog row's chip are one vocabulary. */
const DUPLICATE_COLUMN_TITLE: Readonly<Record<keyof DuplicateCounts, string>> = {
  exact: `${DUPLICATE_CLASS_LABEL.exact} another row: the same persona text, or the same name`,
  near: `${DUPLICATE_CLASS_LABEL.near} another row: most of the same text`,
  overlapping: `${DUPLICATE_CLASS_LABEL.overlapping} another row: most of the same capabilities`,
}

/**
 * The last ten catalog imports (M42 §2), read only.
 *
 * There is no import FORM here on purpose: a catalog is a path on the daemon host's disk, exactly
 * as the skill catalog is, and a browser cannot see it. The operator runs `import-catalog` and this
 * panel is where the result is legible afterwards.
 *
 * Each row is wrapped in its own `data-testid` element rather than passed one: `Row` renders a
 * fixed `data-testid="data-table-row"` and forwards nothing else, and giving it a second identity
 * would change a handle every other table's tests already read. The price of that wrapper is that
 * `Row` cannot see its own position any more, which is what `last` is for.
 */
export function CatalogImports({ imports }: { readonly imports: readonly CatalogImportRow[] }): React.JSX.Element {
  if (imports.length === 0) {
    return (
      <p data-testid="catalog-imports" className="text-xs text-text-3">
        no catalog has been imported yet. Run{' '}
        <code className="font-mono">npm run orchestrator -- import-catalog --dir &lt;path&gt;</code> on the host.
      </p>
    )
  }
  return (
    <div data-testid="catalog-imports">
      <DataTable columns={COLUMNS} header={[...HEADER]}>
        {imports.map((row, index) => (
          <div key={row.id} data-testid={`catalog-import-${row.id}`}>
            {/* `last` because this row is the only child of its wrapper, so `Row`'s own
             *  `:last-child` selector would match every one of them and draw no separator at all
             *  (M46 t4 fix round 1). */}
            <Row columns={COLUMNS} last={index === imports.length - 1}>
              {/* The timestamp as the CLI's `list-imports` prints it, minus the `T` and the
               *  milliseconds -- the same run, told the same way in both places. */}
              <span className="font-mono text-xs text-text-2">{row.finishedAt.slice(0, 19).replace('T', ' ')}</span>
              <span className="truncate text-sm text-text-1" title={row.directory}>
                {row.catalog}
              </span>
              <span className="truncate text-text-2">{row.by ?? '—'}</span>
              {/* The counts carry one shared testid so a test can read them AS A SEQUENCE:
               *  asserting that a row's text merely contains "2" is satisfied by the year in its
               *  own timestamp, which is no assertion at all (fix round 1, important 1). */}
              <span data-testid="catalog-import-count" className="text-text-2">
                {row.created}
              </span>
              <span data-testid="catalog-import-count" className="text-text-2">
                {row.updated}
              </span>
              <span data-testid="catalog-import-count" className="text-text-2">
                {row.unchanged}
              </span>
              <span data-testid="catalog-import-count" className="text-text-2">
                {row.skipped}
              </span>
              {/* The three the duplicate pass noticed, in the same sequence the CLI prints them
               *  (M55 R7 / erratum E9): seven numbers here and seven in `list-imports`, out of one
               *  recorded report. */}
              <span data-testid="catalog-import-count" title={DUPLICATE_COLUMN_TITLE.exact} className="text-text-2">
                {row.duplicates.exact}
              </span>
              <span data-testid="catalog-import-count" title={DUPLICATE_COLUMN_TITLE.near} className="text-text-2">
                {row.duplicates.near}
              </span>
              <span data-testid="catalog-import-count" title={DUPLICATE_COLUMN_TITLE.overlapping} className="text-text-2">
                {row.duplicates.overlapping}
              </span>
            </Row>
          </div>
        ))}
      </DataTable>
    </div>
  )
}
