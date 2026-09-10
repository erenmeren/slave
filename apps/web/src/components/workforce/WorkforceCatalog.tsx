'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { WorkforceCatalogFilters } from '@slave-of-ai/control'
import type { WorkforceCatalogView } from '../../server/org'
import { catalogFilterParams } from '../../lib/catalogFilters'
import { plural } from '../../lib/plural'
import { sendControl } from '../../lib/postControl'
import { useCatalogFilters } from '../../hooks/useCatalogFilters'
import { Alert } from '../ui/Alert'
import { Chip } from '../ui/Chip'
import { DangerConfirm } from '../ui/DangerConfirm'
import { DataTable, Row } from '../ui/DataTable'
import { EmptyState } from '../ui/EmptyState'
import { LoadingState } from '../ui/LoadingState'
import { CatalogFilterBar } from './CatalogFilterBar'
import { ProfileDrawer } from './ProfileDrawer'
import { TemplateForm } from './TemplateForm'

/**
 * `DataTable`, not a bespoke grid (plan erratum E13): `gate:m11-shell` creates a template through
 * the form below and then waits for a `data-table-row` carrying its name. The COLUMNS are free to
 * change -- the Catalog tab is not one of `gate:m14-fidelity`'s screenshots, which take
 * `/workforce`'s DEFAULT tab (Slaves) -- but the primitive is not.
 */
const COLUMNS = '1fr 110px 1.6fr 1.4fr 150px 140px 90px'
const HEADER = ['Name', 'Division', 'Summary', 'Capabilities', 'Source', 'Default model', ''] as const

/** How many capability chips fit a row before the rest becomes a count. */
const CHIPS = 3

/**
 * The Workforce Catalog (M46 R6): every template a company can be staffed from, searchable and
 * filterable, each row opening the specialist profile behind it.
 *
 * Rows come from `/api/org/catalog` rather than from a page prop, seeded by the server's first
 * read -- of the SAME filters this component parses out of the URL (`/workforce/page.tsx` reads
 * them with `parseCatalogFilters` too, M46 final wave M1), so a shared `?q=` link opens on the
 * rows its filter bar says it is showing rather than on the whole catalog. That is what lets a
 * filter change, a template creation and an override all refresh the list without
 * `router.refresh()` re-running the Workforce page's eight loaders.
 *
 * The `workforce-catalog` handle and each row's `catalog-row-<id>` are WRAPPERS around the
 * `DataTable`/`Row` primitives rather than props passed into them: an element carries one
 * `data-testid`, `gate:m11-shell` reads `data-table-row` on this very surface, and renaming the
 * handle a gate already drives to add one of our own would have been a rename dressed as a
 * feature. `CatalogImports.tsx` wraps its own rows for exactly this reason.
 */
export function WorkforceCatalog({ initial }: { readonly initial: WorkforceCatalogView }): React.JSX.Element {
  const router = useRouter()
  const { filters, setFilters } = useCatalogFilters()
  const [page, setPage] = useState<WorkforceCatalogView>(initial)
  const [staleError, setStaleError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [open, setOpen] = useState<{ readonly id: string; readonly name: string } | null>(null)

  /**
   * The rows that render are the LATEST request's answer, never merely the last one to arrive
   * (fix round 1, important 1).
   *
   * The search box issues one request per keystroke, so `?q=buil` and `?q=builder` are in flight
   * together as a matter of course. Without a sequence the slower answer wins whichever query it
   * belongs to, and the list shows rows nobody asked for under a search box that says something
   * else -- a wrong list is worse than a slow one, because nothing on screen says it is wrong.
   *
   * A monotonic id rather than an `AbortController`: a superseded response here is not a resource
   * to reclaim, it is an answer to ignore, and ignoring it is one comparison with no second code
   * path for "the request was cancelled" to go wrong in.
   *
   * `attemptsLeft` is the other half of the same idea, for the one caller that cannot simply show
   * the last answer: a template an operator just CREATED is not in the last answer, so a failed
   * refetch there would hide the row they made behind a stale-data band. It retries once.
   */
  const latest = useRef(0)
  const reload: (next: WorkforceCatalogFilters, attemptsLeft?: number) => void = useCallback(
    (next: WorkforceCatalogFilters, attemptsLeft = 0): void => {
      const query = catalogFilterParams(next).toString()
      const id = latest.current + 1
      latest.current = id
      setRefreshing(true)
      const failed = (): void => {
        if (attemptsLeft > 0) {
          reload(next, attemptsLeft - 1)
          return
        }
        setRefreshing(false)
        setStaleError(true)
      }
      void fetch(query === '' ? '/api/org/catalog' : `/api/org/catalog?${query}`)
        .then(async (response) => (response.ok ? ((await response.json()) as WorkforceCatalogView) : null))
        .then((view) => {
          // Superseded: a newer request is already in flight, and its answer is the one this list
          // is going to show. Say nothing -- not even that this one failed.
          if (id !== latest.current) return
          if (view === null) {
            failed()
            return
          }
          setRefreshing(false)
          setStaleError(false)
          setPage(view)
        })
        .catch(() => {
          if (id !== latest.current) return
          failed()
        })
    },
    [],
  )

  /**
   * Seeded from the server on the first render; re-read whenever the filters move. The first pass
   * does NOT fetch when the URL carried no filter -- `initial` IS that answer, and asking for it
   * again would be a second identical query on every page load.
   *
   * A ref rather than a `mounted` state flag: setting state inside the effect would re-run it with
   * the same filters and issue exactly the fetch this guard exists to avoid.
   */
  const firstPass = useRef(true)
  useEffect(() => {
    if (firstPass.current) {
      firstPass.current = false
      if (Object.keys(filters).length === 0) return
    }
    reload(filters)
  }, [filters, reload])

  return (
    <div className="flex flex-col gap-3">
      <CatalogFilterBar filters={filters} facets={page.facets} onChange={setFilters} />
      {staleError && (
        <Alert variant="error" testId="catalog-stale">
          could not refresh the catalog — showing the last answer.
        </Alert>
      )}
      <span data-testid="catalog-count" className="text-xs text-text-3">
        {plural(page.rows.length, 'template')}
      </span>
      {/* The rows below are the PREVIOUS answer while this is up: a list that empties itself on
        * every keystroke is harder to read than one that lags by a request. */}
      {refreshing && <LoadingState testId="catalog-loading" message="reading the catalog…" />}
      {page.rows.length === 0 ? (
        <EmptyState testId="catalog-empty" message="no template matches these filters." />
      ) : (
        <div data-testid="workforce-catalog">
          <DataTable columns={COLUMNS} header={[...HEADER]}>
            {page.rows.map((row, index) => (
              /* The row OPENS the drawer on a click anywhere, and the name is a real button so a
               * keyboard reaches it too -- `AllSlavesTable`'s `worker-row-button` idiom. The
               * wrapper takes no `role="button"` on purpose: the delete control lives inside it,
               * and a button inside a button is not a thing a screen reader can describe. */
              <div
                key={row.id}
                data-testid={`catalog-row-${row.id}`}
                data-mapping-quality={row.mappingQuality ?? ''}
                onClick={() => setOpen({ id: row.id, name: row.name })}
              >
                {/* `last` because this `Row` is the only child of its wrapper, so its own
                  * `:last-child` selector would match every row and draw no separator at all. */}
                <Row columns={COLUMNS} last={index === page.rows.length - 1}>
                  <span className="flex min-w-0 flex-col">
                    <button
                      type="button"
                      data-testid={`catalog-open-${row.id}`}
                      onClick={() => setOpen({ id: row.id, name: row.name })}
                      className="truncate text-left text-sm text-text-1 hover:text-text-2"
                    >
                      {row.name}
                    </button>
                    <span className="flex gap-1">
                      {row.overriddenFields.length > 0 && (
                        <Chip testId={`catalog-overridden-${row.id}`}>customised</Chip>
                      )}
                      {row.rawOverride && <Chip testId={`catalog-raw-override-${row.id}`}>raw override</Chip>}
                    </span>
                  </span>
                  {/* R6 says DIVISION, which is what an imported row is filed under; a
                    * hand-made template has none, so it falls back to the role it was typed with.
                    * The raw role stays one hover away either way (M44 R5). */}
                  <Chip title={row.role}>{row.sourceDivision ?? row.role}</Chip>
                  <span className="truncate text-text-2">{row.summary}</span>
                  <span className="flex min-w-0 flex-wrap items-center gap-1">
                    {row.capabilities.slice(0, CHIPS).map((capability) => (
                      <Chip key={capability} testId="catalog-capability-chip">
                        {capability}
                      </Chip>
                    ))}
                    {row.capabilities.length > CHIPS && (
                      <span data-testid="catalog-capability-more" className="text-[10px] text-text-3">
                        +{row.capabilities.length - CHIPS}
                      </span>
                    )}
                  </span>
                  <span
                    data-testid={`catalog-source-${row.id}`}
                    title={row.sourceId ?? 'made here'}
                    className="truncate font-mono text-[10px] text-text-3"
                  >
                    {row.source === 'imported' ? `imported · ${row.sourceRepository ?? 'unknown'}` : 'local'}
                  </span>
                  <span className="font-mono text-xs text-text-2">
                    {row.defaultModel === null
                      ? '—'
                      : `${row.defaultModel}${row.defaultProvider === null ? '' : ` · ${row.defaultProvider}`}`}
                  </span>
                  {/* The delete is an action ON the row, not a way INTO it: without this the
                    * confirm click would also open the drawer behind the thing it is confirming. */}
                  <span onClick={(event) => event.stopPropagation()}>
                    <DangerConfirm
                      label="delete"
                      testId="template-delete"
                      confirmText={`deletes ${row.name} and its ${plural(row.catalogSlaveCount, 'catalog slave')}; project slaves keep their role`}
                      onConfirm={async () => {
                        const error = await sendControl(`/api/org/templates/${row.id}`, { method: 'DELETE' })
                        if (error === null) {
                          reload(filters)
                          router.refresh()
                        }
                        return error
                      }}
                    />
                  </span>
                </Row>
              </div>
            ))}
          </DataTable>
        </div>
      )}
      {/* One retry: the row an operator just created is not in the answer already on screen, so
        * a failed refetch here would hide their own template behind a stale-data band. */}
      <TemplateForm onCreated={() => reload(filters, 1)} />
      {open !== null && (
        <ProfileDrawer
          key={open.id}
          templateId={open.id}
          name={open.name}
          onClose={() => setOpen(null)}
          onChanged={() => reload(filters)}
        />
      )}
    </div>
  )
}
