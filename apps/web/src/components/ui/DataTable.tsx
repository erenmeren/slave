import { SECTION_LABEL_CLASS } from './SectionLabel'

/**
 * The handoff data table (spec §3): an explicit `grid-template-columns` shared between the header
 * and every row rather than an actual `<table>` — matches the mockups' grid-row layouts (e.g. the
 * slaves table's `200px 130px 120px 1fr 110px 90px 80px`). `columns` is passed straight through to
 * both `DataTable` and each `Row` so they line up.
 */
export function DataTable({
  columns,
  header,
  children,
}: {
  readonly columns: string
  readonly header: ReadonlyArray<string>
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    // `overflow-x-auto`, not `overflow-hidden` (M44 final review, minor c): the Slaves table's
    // nine tracks add up to ~1030px of FIXED width, and a hidden overflow simply CUT the last
    // three columns off a narrow window with no way to reach them. Clipping is unchanged wherever
    // the table fits -- a non-`visible` overflow on one axis computes the other to `auto`, so the
    // rounded card still clips its rows' corners.
    <div data-testid="data-table" className="flex flex-col overflow-x-auto rounded-card border border-line bg-bg-2">
      <div data-testid="data-table-header" className="grid gap-2 border-b border-line px-3 py-2" style={{ gridTemplateColumns: columns }}>
        {header.map((label) => (
          <span key={label} data-testid="data-table-header-cell" className={SECTION_LABEL_CLASS}>
            {label}
          </span>
        ))}
      </div>
      <div data-testid="data-table-rows" className="flex flex-col">
        {children}
      </div>
    </div>
  )
}

/**
 * One `DataTable` row — a grid using the same `columns` template as the header.
 *
 * `last` exists because `last:border-b-0` is a CSS `:last-child` selector, and a caller that wraps
 * each row in its own element (`CatalogImports`, `WorkforceCatalog` — both wrap so the row can
 * carry a second identity without renaming the `data-table-row` handle four gates read) makes
 * every `Row` the only child of its wrapper. `:last-child` then matched ALL of them and the table
 * lost every separator (M46 t4 fix round 1).
 *
 * So `last` has THREE states, not two (M46 final wave, I1). Omitting it means "my rows are direct
 * children of the row list": the row keeps the `:last-child` rule it always had. Passing it means
 * "I wrap my rows, so the selector cannot see position" — the caller owns the separator, and the
 * `:last-child` rule must not ship at all. Round 1 kept emitting it next to `border-b` on the
 * non-last rows, and since each of those is the only child of its wrapper,
 * `.last\:border-b-0:last-child` (0,2,0) still beat `.border-b` (0,1,0): the separator was still
 * missing from every row of every wrapping table.
 */
export function Row({
  columns,
  last,
  children,
}: {
  readonly columns: string
  readonly last?: boolean
  readonly children: React.ReactNode
}): React.JSX.Element {
  const border =
    last === undefined ? 'border-b border-white/[0.05] last:border-b-0' : last ? '' : 'border-b border-white/[0.05]'
  return (
    <div
      data-testid="data-table-row"
      className={`grid items-center gap-2 px-3 py-2 ${border}`}
      style={{ gridTemplateColumns: columns }}
    >
      {children}
    </div>
  )
}
