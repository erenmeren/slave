'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { WorkforceCatalogFilters } from '@slave-of-ai/control'
import { duplicateBasisLabel, duplicateClassLabel, type CapabilityRecord } from '@slave-of-ai/domain'
import type { CatalogRowView, WorkforceCatalogView } from '../../server/org'
import { catalogFilterParams } from '../../lib/catalogFilters'
import { plural } from '../../lib/plural'
import { sendControl } from '../../lib/postControl'
import { useCatalogFilters } from '../../hooks/useCatalogFilters'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
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
const COLUMNS = '1fr 110px 1.4fr 1.3fr 150px 130px 90px 90px'
const HEADER = ['Name', 'Division', 'Summary', 'Capabilities', 'Source', 'Default model', 'Hirable', ''] as const

/** How many capability chips fit a row before the rest becomes a count. */
const CHIPS = 3

/** R8 (2026-09-20 catalogue capability mapping): what the drawer's mapping line says, off the
 *  SAME two fields every `setOpen` site below reads off a row -- one place, so the three sites
 *  (the row, its name button, and a duplicate pair's "open the other one") cannot disagree. */
const capabilityMappingOf = (row: CatalogRowView): 'mapped' | 'stale' | 'none' =>
  row.capabilityMappingStale ? 'stale' : row.capabilityMappedAt === null ? 'none' : 'mapped'

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
export function WorkforceCatalog({
  initial,
  taxonomy = [],
  skillCatalogue = [],
}: {
  readonly initial: WorkforceCatalogView
  /** The capability taxonomy, read once by the page beside the catalog (M47 §2) -- what turns the
   *  drawer's `capabilityKeys` into words. Defaults to empty, where every key prints as itself. */
  readonly taxonomy?: readonly CapabilityRecord[]
  readonly skillCatalogue?: readonly { readonly skillId: string; readonly name: string; readonly providerName: string }[]
}): React.JSX.Element {
  const router = useRouter()
  const { filters, setFilters } = useCatalogFilters()
  const [page, setPage] = useState<WorkforceCatalogView>(initial)
  const [staleError, setStaleError] = useState(false)
  /**
   * What a refused WRITE said, in the words the control layer used (fix round 1, item 3).
   *
   * The only write this component owns is the activation toggle, and it used to swallow its refusal:
   * a 404 on a row somebody deleted in another tab, or a 401 on an expired session, looked exactly
   * like a click that did not register. The row's word is still only re-read on success -- what is
   * added is the sentence saying why it did not move. `DangerConfirm` shows the delete's refusal
   * itself, which is why the toggle is the one control here that needed a slot of its own.
   */
  const [writeError, setWriteError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [open, setOpen] = useState<{
    readonly id: string
    readonly name: string
    readonly capabilityKeys: readonly string[]
    /** R8: the half of `capabilityKeys` a model chose, and whether that mapping is current. */
    readonly mappedCapabilityKeys: readonly string[]
    readonly capabilityMapping: 'mapped' | 'stale' | 'none'
    readonly defaultSkillIds: readonly string[]
    readonly hiredCount: number
  } | null>(null)

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
  const reload: (next: WorkforceCatalogFilters, options?: { attemptsLeft?: number; cursor?: string }) => void =
    useCallback((next: WorkforceCatalogFilters, options: { attemptsLeft?: number; cursor?: string } = {}): void => {
      const params = catalogFilterParams(next)
      // The cursor is NOT one of `catalogFilterParams`' seven: it is a position in an answer, not a
      // filter, and writing it into the address bar would make a shared link open on page two of a
      // list whose page one the reader never saw.
      if (options.cursor !== undefined) params.set('cursor', options.cursor)
      const query = params.toString()
      const id = latest.current + 1
      latest.current = id
      setRefreshing(true)
      const failed = (): void => {
        if ((options.attemptsLeft ?? 0) > 0) {
          reload(next, { ...options, attemptsLeft: (options.attemptsLeft ?? 0) - 1 })
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
          // A cursored answer EXTENDS what is on screen; an uncursored one replaces it. Anything
          // else would make `Show more` flash the list away and redraw it.
          setPage((current) => (options.cursor === undefined ? view : { ...view, rows: [...current.rows, ...view.rows] }))
        })
        .catch(() => {
          if (id !== latest.current) return
          failed()
        })
    }, [])

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
      <CatalogFilterBar filters={filters} facets={page.facets} taxonomy={taxonomy} onChange={setFilters} />
      {staleError && (
        <Alert variant="error" testId="catalog-stale">
          could not refresh the catalog — showing the last answer.
        </Alert>
      )}
      {/* The refusal's own sentence, from `refusalText` through the route: a word a person can act
        * on, never a kind or a status code (`docs/ia.md` rule 3). */}
      {writeError !== null && (
        <Alert variant="error" testId="catalog-error">
          {writeError}
        </Alert>
      )}
      <span data-testid="catalog-count" className="text-xs text-text-3">
        {/* Two sentences and not one (M55 R3): `N templates` when what is on screen IS the whole
          * answer -- which is what `gate:m46-workforce-catalog` stage 2b reads -- and
          * `showing N of M templates` when it is not, because a count that silently means "the
          * first hundred" is a number that lies. */}
        {page.rows.length >= page.total
          ? plural(page.total, 'template')
          : `showing ${String(page.rows.length)} of ${plural(page.total, 'template')}`}
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
                onClick={() =>
                  setOpen({
                    id: row.id,
                    name: row.name,
                    capabilityKeys: row.capabilityKeys,
                    mappedCapabilityKeys: row.mappedCapabilityKeys,
                    capabilityMapping: capabilityMappingOf(row),
                    defaultSkillIds: row.defaultSkillIds,
                    hiredCount: row.hiredCount,
                  })
                }
              >
                {/* `last` because this `Row` is the only child of its wrapper, so its own
                  * `:last-child` selector would match every row and draw no separator at all. */}
                <Row columns={COLUMNS} last={index === page.rows.length - 1}>
                  <span className="flex min-w-0 flex-col">
                    <button
                      type="button"
                      data-testid={`catalog-open-${row.id}`}
                      onClick={() =>
                  setOpen({
                    id: row.id,
                    name: row.name,
                    capabilityKeys: row.capabilityKeys,
                    mappedCapabilityKeys: row.mappedCapabilityKeys,
                    capabilityMapping: capabilityMappingOf(row),
                    defaultSkillIds: row.defaultSkillIds,
                    hiredCount: row.hiredCount,
                  })
                }
                      className="truncate text-left text-sm text-text-1 hover:text-text-2"
                    >
                      {row.name}
                    </button>
                    <span className="flex gap-1">
                      {row.overriddenFields.length > 0 && (
                        <Chip testId={`catalog-overridden-${row.id}`}>customised</Chip>
                      )}
                      {row.rawOverride && <Chip testId={`catalog-raw-override-${row.id}`}>raw override</Chip>}
                      {row.duplicate !== null && (
                        /* M55 R6/R9. The CLASS as the first half of a sentence and the other row's
                         * NAME as the second; the raw class, basis and score one attribute away; and
                         * the `title` carrying the sentence R9 requires, because the consequence of
                         * an undetected duplicate is a split record and the person looking at this
                         * chip is the person who can act on it. Both labels go through the domain's
                         * guards (final wave, minor 12): the row came off the wire, and a class this
                         * bundle does not know would otherwise read `undefined`. */
                        <span
                          data-testid={`catalog-duplicate-${row.id}`}
                          data-class={row.duplicate.class}
                          data-basis={row.duplicate.basis}
                          data-score={String(row.duplicate.score)}
                          title={
                            `${duplicateBasisLabel(row.duplicate.basis)} · ${row.duplicate.score.toFixed(3)} — ` +
                            'evidence is recorded per profile, so two rows split their own record.'
                          }
                          className="inline-flex items-center rounded-chip border border-line bg-bg-2 px-2 py-0.5 text-xs text-text-2"
                        >
                          {`${duplicateClassLabel(row.duplicate.class)} ${row.duplicate.otherName}`}
                          {row.duplicateCount > 1 && ` +${String(row.duplicateCount - 1)}`}
                        </span>
                      )}
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
                  {/* M55 R2/R6. A WORD, never `true`; the boolean on `data-active`; and
                    * `stopPropagation`, the same thing the delete control beside it does, so
                    * activating a row does not also open its drawer behind the click. */}
                  <span onClick={(event) => event.stopPropagation()}>
                    <button
                      type="button"
                      data-testid={`catalog-activate-${row.id}`}
                      data-active={String(row.active)}
                      aria-pressed={row.active}
                      title={row.activationChangedBy === null ? 'nobody has changed this' : `last changed by ${row.activationChangedBy}`}
                      onClick={() => {
                        void sendControl(`/api/org/templates/${row.id}/activation`, {
                          method: 'POST',
                          body: { active: !row.active },
                        }).then((error) => {
                          setWriteError(error)
                          if (error === null) reload(filters)
                        })
                      }}
                      className={`rounded-bubble border px-[9px] py-[3px] font-mono text-[10px] font-medium transition-colors ${
                        row.active ? 'border-text-1 bg-bg-2 text-text-1' : 'border-line bg-bg-1 text-text-3 hover:text-text-2'
                      }`}
                    >
                      {row.active ? 'active' : 'inactive'}
                    </button>
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
      {page.nextCursor !== null && (
        <Button
          variant="ghost"
          size="sm"
          data-testid="catalog-more"
          disabled={refreshing}
          onClick={() => {
            // Read at CLICK time rather than at render time -- and narrowed here rather than by the
            // `!== null` above, because `exactOptionalPropertyTypes` will not take an optional
            // `cursor` that is present and undefined, which is what `?? undefined` would hand it.
            const cursor = page.nextCursor
            if (cursor !== null) reload(filters, { cursor })
          }}
        >
          Show more
        </Button>
      )}
      {/* One retry: the row an operator just created is not in the answer already on screen, so
        * a failed refetch here would hide their own template behind a stale-data band. */}
      <TemplateForm onCreated={() => reload(filters, { attemptsLeft: 1 })} />
      {open !== null && (
        <ProfileDrawer
          key={open.id}
          templateId={open.id}
          name={open.name}
          capabilityKeys={open.capabilityKeys}
          mappedCapabilityKeys={open.mappedCapabilityKeys}
          capabilityMapping={open.capabilityMapping}
          taxonomy={taxonomy}
          defaultSkillIds={page.rows.find((row) => row.id === open.id)?.defaultSkillIds ?? open.defaultSkillIds}
          hiredCount={page.rows.find((row) => row.id === open.id)?.hiredCount ?? open.hiredCount}
          skillCatalogue={skillCatalogue}
          onClose={() => setOpen(null)}
          onChanged={() => reload(filters)}
          /* M55 R6: the drawer's Duplicates group names the other template as a BUTTON that opens
           * ITS drawer. The keys come off the loaded page when the row is on it; a row that is not
           * (the pair points past the first hundred) opens with none, and the drawer's "Matchable
           * capabilities" block simply does not render -- everything else in it is fetched by id. */
          onOpenTemplate={(id, name) => {
            const candidate = page.rows.find((row) => row.id === id)
            setOpen({
              id,
              name,
              capabilityKeys: candidate?.capabilityKeys ?? [],
              mappedCapabilityKeys: candidate?.mappedCapabilityKeys ?? [],
              capabilityMapping: candidate === undefined ? 'none' : capabilityMappingOf(candidate),
              defaultSkillIds: candidate?.defaultSkillIds ?? [],
              hiredCount: candidate?.hiredCount ?? 0,
            })
          }}
        />
      )}
    </div>
  )
}
