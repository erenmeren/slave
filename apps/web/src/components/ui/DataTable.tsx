'use client'

import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { SECTION_LABEL_CLASS } from './SectionLabel'
import { ScrollArea } from './ScrollArea'

/**
 * The handoff data table (spec §3): an explicit `grid-template-columns` shared between the header
 * and every row rather than an actual `<table>` — matches the mockups' grid-row layouts (e.g. the
 * slaves table's `200px 130px 120px 1fr 110px 90px 80px`). `columns` is passed straight through to
 * both `DataTable` and each `Row` so they line up.
 *
 * `virtualized` (M61 R16) swaps the plain `children` body for a `useVirtualizer` viewport -- same
 * idiom `activity/Timeline.tsx` already uses on its own bare scroll element, here run inside
 * `ui/ScrollArea` instead. The head renders exactly as before either way; only the body's DOM
 * strategy changes, so a caller with a handful of rows never has to opt in.
 *
 * `virtualized.dynamic` (M61 Task 10 scope fix, controller Ruling 10) opts a caller INTO
 * `Timeline.tsx`'s own `measureElement` idiom instead of trusting `rowHeight` as a fixed row
 * size -- see its own doc comment below for why this is opt-in rather than the only mode.
 */
export function DataTable({
  columns,
  header,
  virtualized,
  children,
}: {
  readonly columns: string
  readonly header: ReadonlyArray<string>
  /** When set, the body renders `count` rows through `useVirtualizer` instead of `children` --
   *  `render(index)` draws one row (typically a `Row` with this same `columns` template), and only
   *  the rows within (or near) the scrolled viewport ever mount. */
  readonly virtualized?: {
    readonly rowHeight: number
    readonly count: number
    readonly render: (index: number) => React.ReactNode
    /**
     * Opt-in dynamic sizing (M61 Task 10 scope fix, controller Ruling 10): when true, every row
     * wrapper also carries `ref={virtualizer.measureElement}` -- the standard
     * `@tanstack/react-virtual` "dynamic" idiom `activity/Timeline.tsx` already uses on its own
     * bare scroll element. `rowHeight` (`estimateSize`) stays only the INITIAL guess; once a
     * row's actual rendered height is measured, the virtualizer corrects its cache and every row
     * after it repositions from the corrected `virtualRow.start` -- which is what stops a row
     * whose content varies (wrapped text, an optional line, a fold that can open) from
     * overlapping its neighbour.
     *
     * Default false/absent, and deliberately not the only mode: `PeopleTable`'s rows are fixed,
     * single-line `--row-h` height by design, and its own test file mocks
     * `HTMLElement.prototype.offsetHeight` to one constant for every element to fake a bounded
     * jsdom viewport. `measureElement`'s own jsdom fallback (no `ResizeObserver` there) reads
     * that same `offsetHeight` -- wired in unconditionally, every People row would "measure" at
     * the mocked VIEWPORT height instead of the `rowHeight` estimate those tests are keyed to,
     * changing what their virtualization-count assertions actually test. `KnowledgeClient` is
     * the first caller to pass `dynamic: true`; `PeopleTable` and its test are untouched.
     */
    readonly dynamic?: boolean
  }
  readonly children?: React.ReactNode
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const virtualizer = useVirtualizer({
    count: virtualized?.count ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => virtualized?.rowHeight ?? 0,
  })

  return (
    // `overflow-x-auto`, not `overflow-hidden` (M44 final review, minor c): the Slaves table's
    // nine tracks add up to ~1030px of FIXED width, and a hidden overflow simply CUT the last
    // three columns off a narrow window with no way to reach them. Clipping is unchanged wherever
    // the table fits -- a non-`visible` overflow on one axis computes the other to `auto`, so the
    // rounded card still clips its rows' corners.
    <div data-testid="data-table" className="flex flex-col overflow-x-auto rounded-control border border-line bg-bg-2">
      <div data-testid="data-table-header" className="grid gap-2 border-b border-line px-3 py-2" style={{ gridTemplateColumns: columns }}>
        {header.map((label) => (
          <span key={label} data-testid="data-table-header-cell" className={SECTION_LABEL_CLASS}>
            {label}
          </span>
        ))}
      </div>
      {virtualized === undefined ? (
        <div data-testid="data-table-rows" className="flex flex-col">
          {children}
        </div>
      ) : (
        <ScrollArea ref={scrollRef} testId="data-table-rows" className="flex flex-col">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                {...(virtualized.dynamic === true ? { ref: virtualizer.measureElement } : {})}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)` }}
              >
                {virtualized.render(virtualRow.index)}
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
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
    last === undefined ? 'border-b border-line last:border-b-0' : last ? '' : 'border-b border-line'
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
