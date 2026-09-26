'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { WorkforceCatalogFilters } from '@slave-of-ai/control'
import { duplicateBasisLabel, duplicateClassLabel, type CapabilityRecord } from '@slave-of-ai/domain'
import type { CatalogRowView, WorkforceCatalogView } from '../../server/org'
import type { SkillCatalogueRow } from '../../server/persons'
import type { CardSkillRow } from '../../lib/cardSkills'
import { catalogFilterParams } from '../../lib/catalogFilters'
import type { PageKeep } from '../../lib/pageKeep'
import { plural } from '../../lib/plural'
import { sendControl } from '../../lib/postControl'
import { useCatalogFilters } from '../../hooks/useCatalogFilters'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { DangerConfirm } from '../ui/DangerConfirm'
import { EmptyState } from '../ui/EmptyState'
import { LoadingState } from '../ui/LoadingState'
import { StatusPill } from '../ui/StatusPill'
import { CatalogFilterBar } from './CatalogFilterBar'
import { ProfileDrawer } from './ProfileDrawer'
import { TemplateForm } from './TemplateForm'
import { WorkforceCard, WorkforceCardGrid, type SkillWriteOutcome } from './WorkforceCard'

/**
 * R8 (2026-09-20 catalogue capability mapping): what the drawer's mapping line says, off the SAME
 * fields the two row-click `setOpen` sites below read off a row -- one place, so they cannot
 * disagree. (The THIRD `setOpen` site, `onOpenTemplate`, does not call this -- fix round 1, I4 --
 * because it does not know the OTHER template's mapping state; see the comment there.)
 *
 * Four states, in this precedence order (fix round 1, I1):
 * 1. never mapped AND inactive -- the pass and `capabilities map` both skip an inactive row, so
 *    promising a re-map "on its next pass" would be a promise that pass never keeps until somebody
 *    activates the row first.
 * 2. never mapped (active or not) -- "not yet mapped", never "stale": a null `capabilityMappedAt`
 *    trivially disagrees with any computed hash, and that disagreement is not what "stale" means.
 * 3. `capabilityMappingStale` (the read model already checked `active` before setting this).
 * 4. otherwise mapped and current.
 */
const capabilityMappingOf = (row: CatalogRowView): 'mapped' | 'stale' | 'none' | 'inactive' =>
  !row.active && row.capabilityMappedAt === null
    ? 'inactive'
    : row.capabilityMappedAt === null
      ? 'none'
      : row.capabilityMappingStale
        ? 'stale'
        : 'mapped'

/** What the profile drawer opens with. */
interface OpenProfile {
  readonly id: string
  readonly name: string
  readonly capabilityKeys: readonly string[]
  /** R8: the half of `capabilityKeys` a model chose, and whether that mapping is current. */
  readonly mappedCapabilityKeys: readonly string[]
  readonly capabilityMapping: 'mapped' | 'stale' | 'none' | 'inactive'
  readonly defaultSkillIds: readonly string[]
  readonly hiredCount: number
}

/** A catalog row as the drawer's argument -- one function, so the card body and the name button
 *  cannot open two different drawers for one row. */
const openOf = (row: CatalogRowView): OpenProfile => ({
  id: row.id,
  name: row.name,
  capabilityKeys: row.capabilityKeys,
  mappedCapabilityKeys: row.mappedCapabilityKeys,
  capabilityMapping: capabilityMappingOf(row),
  defaultSkillIds: row.defaultSkillIds,
  hiredCount: row.hiredCount,
})

/**
 * Patches ONE persona row's chips from a successful `SkillWriteOutcome` (controller ruling F2):
 * every write a persona card makes PATCHes that persona's own skill list (task-7-report.md's "fix
 * round 1" rule), so patching the row the write targets is the WHOLE of what changed -- no re-read,
 * which is what lets a write on a card past the first page leave every earlier page mounted.
 */
function patchedSkills(current: readonly CardSkillRow[], outcome: SkillWriteOutcome): readonly CardSkillRow[] {
  if (outcome.kind === 'removed') return current.filter((skill) => skill.skillId !== outcome.skillId)
  if (outcome.kind === 'refused') return current
  return [...current.filter((skill) => skill.skillId !== outcome.skill.skillId), outcome.skill]
}

/**
 * The row after a card write, with `defaultSkillIds` DERIVED from the patched chips (final review,
 * finding 1): the drawer's editor PATCHes the whole set it is handed, so an id list left behind by
 * a card write would silently undo that write on the drawer's next save.
 */
function patchedRow(row: CatalogRowView, outcome: SkillWriteOutcome): CatalogRowView {
  const skills = patchedSkills(row.skills, outcome)
  return { ...row, skills, defaultSkillIds: skills.map((skill) => skill.skillId) }
}

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
 * Each template is a persona CARD (workforce cards §2) on the card grid: its skills with their
 * source, its specialties, the first steps of its workflow and "+ skill" -- a skill linked from the
 * card goes to the persona, as a delta. The card's wrapper keeps `catalog-row-<id>` and the name
 * keeps `catalog-open-<id>`, the two handles every catalog gate drives; the activation toggle, the
 * customised / raw-override / duplicate chips, the source, the default model and the delete are the
 * row's own controls, moved onto the card whole.
 */
export function WorkforceCatalog({
  initial,
  taxonomy = [],
  skillCatalogue = [],
  keep,
  trustInitial = true,
  urlSync = true,
}: {
  readonly initial: WorkforceCatalogView
  /** The capability taxonomy, read once by the page beside the catalog (M47 §2) -- what turns the
   *  drawer's `capabilityKeys` into words. Defaults to empty, where every key prints as itself. */
  readonly taxonomy?: readonly CapabilityRecord[]
  readonly skillCatalogue?: readonly SkillCatalogueRow[]
  /** Where the loaded list waits while the Catalog tab is unmounted -- see {@link PageKeep}. */
  readonly keep?: PageKeep<WorkforceCatalogView>
  /** Whether `initial` answers the URL this mounts under -- `PeopleCards`' prop of the same name. */
  readonly trustInitial?: boolean
  /** False for the hire sheet (final review, finding 3): its filters are its own, never the URL's. */
  readonly urlSync?: boolean
}): React.JSX.Element {
  const router = useRouter()
  const { filters, setFilters } = useCatalogFilters(urlSync)
  const [page, setPage] = useState<WorkforceCatalogView>(() => keep?.current?.view ?? initial)
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
  const [open, setOpen] = useState<OpenProfile | null>(null)

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
   * After a card write is REFUSED, the row's cached skills cannot be trusted either
   * (task-7-report.md's rule for `kind: 'refused'`) -- but re-reading must not reset the list to
   * page one (controller ruling F2). This re-fetches from the top and then follows the same cursor
   * chain a person's own "Show more" clicks already walked, until it has read back at least `keep`
   * rows or run out of pages, so a refusal on a card past the first page never drops the pages
   * before it. Guarded by the same `latest` sequence `reload` uses, so an ordinary filter-driven
   * reload in flight still wins over this, and vice versa. The profile drawer's `onChanged` uses
   * it too (final review, finding 1), for the same reason: its row may be past page one.
   *
   * Fix round 1 (coordinator review, Important): a network failure or a malformed body used to
   * reject `fetchPage`'s promise with nothing to catch it -- an unhandled rejection, unlike `reload`
   * in this same file and every `sendControl`/`postControl`/`postJson` call this app makes. `fetchPage`
   * now catches both (a rejected `fetch` and a throwing `response.json()`) into the same `null` its
   * `!response.ok` branch already returned, and a `null` surfaces `reload`'s own failure state
   * (`catalog-stale`) rather than silently leaving the write's own error as the only sign anything
   * went wrong -- without touching `page.rows`, so the pages already loaded stay exactly as they were.
   */
  const resyncAfterRefusal = useCallback((next: WorkforceCatalogFilters, keep: number): void => {
    const id = latest.current + 1
    latest.current = id
    const fetchPage = async (cursor?: string): Promise<WorkforceCatalogView | null> => {
      const params = catalogFilterParams(next)
      if (cursor !== undefined) params.set('cursor', cursor)
      const query = params.toString()
      try {
        const response = await fetch(query === '' ? '/api/org/catalog' : `/api/org/catalog?${query}`)
        return response.ok ? ((await response.json()) as WorkforceCatalogView) : null
      } catch {
        return null
      }
    }
    const failed = (): void => {
      if (id !== latest.current) return
      setStaleError(true)
    }
    void (async (): Promise<void> => {
      let view = await fetchPage()
      if (view === null) {
        failed()
        return
      }
      if (id !== latest.current) return
      let rows = view.rows
      while (rows.length < keep && view.nextCursor !== null) {
        const more = await fetchPage(view.nextCursor)
        if (more === null) {
          failed()
          return
        }
        if (id !== latest.current) return
        view = more
        rows = [...rows, ...more.rows]
      }
      if (id !== latest.current) return
      setStaleError(false)
      setPage({ ...view, rows })
    })()
  }, [])

  /**
   * Seeded from the server on the first render; re-read whenever the filters move. The first pass
   * does NOT fetch when the URL carried no filter -- `initial` IS that answer, and asking for it
   * again would be a second identical query on every page load -- unless `initial` is not trusted,
   * or this is a REMOUNT (final review, finding 2): that starts from the kept list and re-reads the
   * same range, or page one when a shared filter moved while the tab was away.
   *
   * A ref rather than a `mounted` state flag: setting state inside the effect would re-run it with
   * the same filters and issue exactly the fetch this guard exists to avoid.
   */
  const firstPass = useRef(true)
  useEffect(() => {
    if (firstPass.current) {
      firstPass.current = false
      const kept = keep?.current ?? null
      if (kept !== null) {
        if (kept.query === catalogFilterParams(filters).toString()) resyncAfterRefusal(filters, kept.view.rows.length)
        else reload(filters)
        return
      }
      if (trustInitial && Object.keys(filters).length === 0) return
    }
    reload(filters)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `keep`/`trustInitial` are read on the first pass only
  }, [filters, reload, resyncAfterRefusal])

  useEffect(() => {
    if (keep !== undefined) keep.current = { view: page, query: catalogFilterParams(filters).toString() }
  }, [keep, page, filters])

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
        <EmptyState
          testId="catalog-empty"
          message="no template matches these filters."
          action={
            Object.keys(filters).length > 0 ? (
              <Button variant="ghost" size="sm" data-testid="catalog-empty-clear" onClick={() => setFilters({})}>
                Clear filters
              </Button>
            ) : null
          }
        />
      ) : (
        <div data-testid="workforce-catalog">
          <WorkforceCardGrid>
            {page.rows.map((row) => (
              <WorkforceCard
                key={row.id}
                variant="persona"
                testId={`catalog-row-${row.id}`}
                data={{ 'data-mapping-quality': row.mappingQuality ?? '' }}
                tone={row.active ? 'done' : 'idle'}
                name={row.name}
                summary={row.summary}
                // R6 files an imported row under its DIVISION; a hand-made one has none and falls
                // back to the role it was typed with. The raw role stays one hover away (M44 R5).
                division={row.sourceDivision ?? row.role}
                divisionTitle={row.role}
                capabilityKeys={row.capabilityKeys}
                capabilityText={row.capabilities}
                taxonomy={taxonomy}
                skills={row.skills}
                workflow={row.workflowPreview}
                target={{ kind: 'persona', templateId: row.id }}
                catalogue={skillCatalogue}
                openTestId={`catalog-open-${row.id}`}
                onOpen={() => setOpen(openOf(row))}
                onChanged={(outcome) => {
                  // Controller ruling F2: a refusal is the one outcome this row's own cached
                  // skills cannot settle -- everything else patches in place, below.
                  if (outcome.kind === 'refused') {
                    resyncAfterRefusal(filters, page.rows.length)
                    return
                  }
                  setPage((current) => ({
                    ...current,
                    rows: current.rows.map((candidate) =>
                      candidate.id === row.id ? patchedRow(candidate, outcome) : candidate,
                    ),
                  }))
                }}
                header={
                  <div className="flex min-w-0 flex-wrap items-center gap-1">
                    {/* M55 R2/R6: the Hirable toggle, kept on the card (spec §2). A WORD, never
                      * `true`; the boolean on `data-active`; `stopPropagation` so activating a
                      * persona does not also open its drawer behind the click. */}
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
                      >
                        <StatusPill tone={row.active ? 'done' : 'idle'} label={row.active ? 'active' : 'inactive'} />
                      </button>
                    </span>
                    {row.overriddenFields.length > 0 && <Chip testId={`catalog-overridden-${row.id}`}>customised</Chip>}
                    {row.rawOverride && <Chip testId={`catalog-raw-override-${row.id}`}>raw override</Chip>}
                    {row.duplicate !== null && (
                      /* M55 R6/R9, unchanged: the class as the first half of a sentence and the other
                       * row's NAME as the second, the raw class/basis/score one attribute away, R9's
                       * sentence in the title. */
                      <span
                        data-testid={`catalog-duplicate-${row.id}`}
                        data-class={row.duplicate.class}
                        data-basis={row.duplicate.basis}
                        data-score={String(row.duplicate.score)}
                        title={
                          `${duplicateBasisLabel(row.duplicate.basis)} · ${row.duplicate.score.toFixed(3)} — ` +
                          'evidence is recorded per profile, so two rows split their own record.'
                        }
                        className="inline-flex min-w-0 items-center truncate rounded-chip border border-line bg-bg-2 px-2 py-0.5 text-xs text-text-2"
                      >
                        {`${duplicateClassLabel(row.duplicate.class)} ${row.duplicate.otherName}`}
                        {row.duplicateCount > 1 && ` +${String(row.duplicateCount - 1)}`}
                      </span>
                    )}
                  </div>
                }
                footer={
                  <>
                    <span data-testid={`catalog-source-${row.id}`} title={row.sourceId ?? 'made here'} className="min-w-0 truncate font-mono">
                      {row.source === 'imported' ? `imported · ${row.sourceRepository ?? 'unknown'}` : 'local'}
                    </span>
                    <span className="font-mono">
                      {row.defaultModel === null
                        ? '—'
                        : `${row.defaultModel}${row.defaultProvider === null ? '' : ` · ${row.defaultProvider}`}`}
                    </span>
                    {/* The delete is an action ON the card, not a way INTO it. */}
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
                  </>
                }
              />
            ))}
          </WorkforceCardGrid>
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
          // Re-reads the LOADED range, never page one (F2; final review, finding 1): a drawer open
          // on a "Show more" row must still find that row -- and its fresh skill list -- afterwards.
          onChanged={() => resyncAfterRefusal(filters, page.rows.length)}
          /* M55 R6: the drawer's Duplicates group names the other template as a BUTTON that opens
           * ITS drawer. The keys come off the loaded page when the row is on it; a row that is not
           * (the pair points past the first hundred) opens with none, and the drawer's "Matchable
           * capabilities" block simply does not render -- everything else in it is fetched by id.
           *
           * Fix round 1, I4: `capabilityMapping` is hardcoded `'mapped'` and `mappedCapabilityKeys`
           * empty here -- NOT `capabilityMappingOf(candidate)` -- because this path does not know
           * the OTHER template's mapping state. `candidate` is this page's OWN filtered/paged read;
           * the pair's other side is commonly not on it, and even when it happens to be, treating
           * that as authoritative would be the same "row it has not loaded" problem one click later.
           * `'mapped'` keeps the guard (`capabilityKeys.length > 0 || capabilityMapping !== 'mapped'`)
           * riding on `capabilityKeys` alone, same as every row before R8 touched that guard: the
           * block renders when there are keys to show and stays hidden otherwise. */
          onOpenTemplate={(id, name) => {
            const candidate = page.rows.find((row) => row.id === id)
            setOpen({
              id,
              name,
              capabilityKeys: candidate?.capabilityKeys ?? [],
              mappedCapabilityKeys: [],
              capabilityMapping: 'mapped',
              defaultSkillIds: candidate?.defaultSkillIds ?? [],
              hiredCount: candidate?.hiredCount ?? 0,
            })
          }}
        />
      )}
    </div>
  )
}
