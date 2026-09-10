'use client'

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
}

const COLUMNS = '150px 1fr 110px 90px 90px 90px 90px'
const HEADER = ['When', 'Catalog', 'By', 'Created', 'Updated', 'Unchanged', 'Skipped'] as const

/**
 * The last ten catalog imports (M42 §2), read only.
 *
 * There is no import FORM here on purpose: a catalog is a path on the daemon host's disk, exactly
 * as the skill catalog is, and a browser cannot see it. The operator runs `import-catalog` and this
 * panel is where the result is legible afterwards.
 *
 * Each row is wrapped in its own `data-testid` element rather than passed one: `Row` renders a
 * fixed `data-testid="data-table-row"` and forwards nothing else, and giving it a second identity
 * would change a handle every other table's tests already read.
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
        {imports.map((row) => (
          <div key={row.id} data-testid={`catalog-import-${row.id}`}>
            <Row columns={COLUMNS}>
              {/* The timestamp as the CLI's `list-imports` prints it, minus the `T` and the
               *  milliseconds -- the same run, told the same way in both places. */}
              <span className="font-mono text-xs text-text-2">{row.finishedAt.slice(0, 19).replace('T', ' ')}</span>
              <span className="truncate text-sm text-text-1" title={row.directory}>
                {row.catalog}
              </span>
              <span className="truncate text-text-2">{row.by ?? '—'}</span>
              <span className="text-text-2">{row.created}</span>
              <span className="text-text-2">{row.updated}</span>
              <span className="text-text-2">{row.unchanged}</span>
              <span className="text-text-2">{row.skipped}</span>
            </Row>
          </div>
        ))}
      </DataTable>
    </div>
  )
}
