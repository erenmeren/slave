/**
 * The handoff data table (spec §3): an explicit `grid-template-columns` shared between the header
 * and every row rather than an actual `<table>` — matches the mockups' grid-row layouts (e.g. the
 * agents table's `200px 130px 120px 1fr 110px 90px 80px`). `columns` is passed straight through to
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
    <div data-testid="data-table" className="flex flex-col overflow-hidden rounded-card border border-line bg-bg-2">
      <div data-testid="data-table-header" className="grid gap-2 border-b border-line px-3 py-2" style={{ gridTemplateColumns: columns }}>
        {header.map((label) => (
          <span key={label} data-testid="data-table-header-cell" className="font-mono text-[9px] uppercase tracking-[.09em] text-text-3">
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

/** One `DataTable` row — a grid using the same `columns` template as the header. */
export function Row({
  columns,
  children,
}: {
  readonly columns: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      data-testid="data-table-row"
      className="grid items-center gap-2 border-b border-white/[0.05] px-3 py-2 last:border-b-0"
      style={{ gridTemplateColumns: columns }}
    >
      {children}
    </div>
  )
}
