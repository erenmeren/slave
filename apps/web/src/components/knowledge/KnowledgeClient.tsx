'use client'

import { useRef, useState } from 'react'
import {
  MEMORY_SCOPES,
  MEMORY_SCOPE_LABEL,
  MEMORY_STATUSES,
  MEMORY_STATUS_LABEL,
  MEMORY_TYPES,
  MEMORY_TYPE_LABEL,
  type MemoryScope,
  type MemoryStatus,
  type MemoryType,
} from '@slave-of-ai/domain'
// Type-only, so nothing from `server/memory.ts` -- and nothing under it, control and the Prisma
// client -- reaches the client bundle. The rule `OrganizationClient` states for `OrganizationView`.
import type { KnowledgeRow, KnowledgeView } from '../../server/memory'
import { useKnowledgeFilters } from '../../hooks/useKnowledgeFilters'
import { knowledgeFilterParams, type KnowledgeFilters } from '../../lib/knowledgeFilters'
import { postControl } from '../../lib/postControl'
import { CapabilityChips } from '../organization/CapabilityChips'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { DangerConfirm } from '../ui/DangerConfirm'
import { DataTable } from '../ui/DataTable'
import { DetailsGroup } from '../ui/DetailsGroup'
import { Drawer } from '../ui/Drawer'
import { EmptyState } from '../ui/EmptyState'
import { FieldLabel, INPUT_SHELL, SelectField } from '../ui/FormControls'
import { PageShell } from '../ui/PageShell'
import { Panel } from '../ui/Panel'
import { SectionLabel } from '../ui/SectionLabel'
import { Segmented } from '../ui/Segmented'
import { StatusPill, type StatusTone } from '../ui/StatusPill'

/**
 * The row grid every `knowledge-row` article already drew (M57 R10): a fixed classification
 * rail, the substance in the middle, and the live actions on the right. `DataTable`'s own
 * `columns`/`header` line up with this same template (M61 Task 10) -- the article's markup
 * inside each row is unchanged; only the list around it is now `DataTable`'s virtualized body.
 */
const ROW_COLUMNS = '110px minmax(0,1fr) 190px'
const ROW_HEADER = ['kind', 'memory', 'actions'] as const

/**
 * The virtualizer's starting guess for one row's height (M61 Task 10) -- unlike `PeopleTable`'s
 * `--row-h` (a fixed, single-line 40/34px table row), a knowledge row is a multi-line card whose
 * height genuinely varies with its body text and with whether its `DetailsGroup` fold is open.
 *
 * Scope fix (controller Ruling 10): `DataTable`'s `virtualized.dynamic: true` below is what
 * actually corrects this estimate now, per row, once each row paints -- the same
 * `measureElement` idiom `activity/Timeline.tsx` already uses for its own variable-height cards.
 * This constant is only ever the FIRST guess a row is positioned at before it is measured (three
 * classification chips beside a title, a body line, a provenance chip and three stacked actions
 * -- a "live" row's typical shape); it no longer has to be exactly right for rows to stop
 * overlapping.
 */
const ESTIMATED_ROW_HEIGHT = 200

/**
 * The tone a memory's life is painted in. Literal per status (Tailwind v4 generates only what it
 * can read as text), and deliberately not four shades of one colour: a claim WAITING on a person
 * and a claim somebody withdrew are two different things to do next.
 */
const STATUS_TONE: Readonly<Record<MemoryStatus, StatusTone>> = {
  candidate: 'waiting',
  verified: 'done',
  superseded: 'idle',
  removed: 'blocked',
}

/** The two statuses a person can still act on. Everything else is frozen by construction --
 *  `supersedeMemory` and `removeMemory` both refuse a row that has already moved. */
const LIVE: readonly MemoryStatus[] = ['verified', 'candidate']

/**
 * What the status select shows when the LINK carries more than one status.
 *
 * A single select cannot say "removed and superseded", and showing the default option while the
 * page renders two statuses would be the filter bar lying about its own list -- the same failure
 * as a stale response winning. Picking any real option below replaces the list with that one
 * status, so this value is never something a person can choose, only something the bar can report.
 */
const SEVERAL = '__several'

/** The one value the status select shows for the list the page is actually filtered by. */
function statusValue(statuses: readonly MemoryStatus[] | undefined): string {
  if (statuses === undefined || statuses.length === 0) return ''
  // `statuses[0]` under `noUncheckedIndexedAccess` is `string | undefined` even here, so the
  // fallback is the one the length test already proved cannot be reached.
  return statuses.length === 1 ? (statuses[0] ?? '') : SEVERAL
}

type QuickView = 'all' | 'verified' | 'candidate'

/**
 * The README's segmented All / Verified / Candidates (M57 R21), reading the SAME `filters.statuses`
 * the granular status select already owns -- a second, independent filter dimension here would be
 * a second place `?status=` could disagree with itself. `All` is exactly the select's own blank
 * option: no `status` on the wire, which the route already answers with the live ones (verified
 * plus the candidates waiting on a person) -- not literally "every status", but the ALL a person
 * reaches for from this control. A link carrying anything else (`superseded`, `removed`, several at
 * once) has no segment of its own; the granular select underneath still shows and answers it.
 */
function quickViewOf(statuses: readonly MemoryStatus[] | undefined): QuickView {
  if (statuses === undefined || statuses.length === 0) return 'all'
  if (statuses.length === 1 && statuses[0] === 'verified') return 'verified'
  if (statuses.length === 1 && statuses[0] === 'candidate') return 'candidate'
  return 'all'
}

/**
 * The Knowledge tab (M49 R6): what this project has learnt, where each piece came from, and what a
 * person can do about it.
 *
 * One row per memory, in the words a person reads -- the type, the scope and the status are LABELS
 * and the keys stay in `title` and on `data-` attributes (`docs/ia.md` rule 3). The provenance
 * sentence is the DOMAIN's (`provenanceLine`), which is the same sentence the prompt's stamp and
 * the CLI's `memories list` print: three readings of where a fact came from would eventually be
 * three different answers.
 *
 * Nothing here deletes anything. Verify promotes a candidate, Correct writes a NEW memory and
 * stamps the old one `superseded`, and Remove stamps `removed` with the reason a person typed --
 * all three rows stay in the table and are one filter away (D11).
 *
 * Another party's text -- `memory.title`, `memory.body`, the provenance line, a removal reason --
 * goes in as JSX children, never as elements (`ProjectBrief`'s stated rule).
 */
export function KnowledgeClient({
  workspaceId,
  initial,
}: {
  readonly workspaceId: string
  readonly initial: KnowledgeView
}): React.JSX.Element {
  const [view, setView] = useState<KnowledgeView>(initial)
  // Seeded from the URL and written back to it, so a filtered page is a link somebody can share
  // and the server render is already the rows this bar claims to be showing.
  const { filters, setFilters } = useKnowledgeFilters(workspaceId)
  /** The one memory currently writing. Per-row rather than per-page: verifying one claim must not
   *  grey out the row beside it. */
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const [stale, setStale] = useState(false)
  const [correcting, setCorrecting] = useState<KnowledgeRow | null>(null)
  const [draft, setDraft] = useState<{ title: string; body: string }>({ title: '', body: '' })
  const [correctError, setCorrectError] = useState<string | null>(null)
  const [correctPending, setCorrectPending] = useState(false)
  const [reasons, setReasons] = useState<Readonly<Record<string, string>>>({})

  /**
   * The rows that render are the LATEST request's answer, never merely the last one to arrive
   * (fix round 1, Important 1 -- `WorkforceCatalog`'s own monotonic id).
   *
   * The search box issues one request per keystroke, so `?q=check` and `?q=checkout` are in flight
   * together as a matter of course. Without a sequence the slower answer wins whichever query it
   * belongs to, and the page shows rows nobody asked for under a filter bar that says something
   * else -- a wrong list is worse than a slow one, because nothing on screen says it is wrong.
   *
   * A monotonic id rather than an `AbortController`: a superseded response here is not a resource
   * to reclaim, it is an answer to ignore, and ignoring it is one comparison with no second code
   * path for "the request was cancelled" to go wrong in. A superseded FAILURE is ignored too --
   * the newer request is the one this page is waiting on, and a stale band about a query nobody is
   * showing is noise.
   */
  const latest = useRef(0)

  /** Re-read this page. The rows already on screen stay until the new ones land: a page that
   *  empties itself between a click and its answer is harder to read than one that lags by a
   *  request, and a failed refetch says so rather than showing nothing (`OrganizationClient`). */
  const reload = async (next: KnowledgeFilters): Promise<void> => {
    const query = knowledgeFilterParams(next).toString()
    const id = latest.current + 1
    latest.current = id
    try {
      const response = await fetch(`/api/w/${workspaceId}/memories${query === '' ? '' : `?${query}`}`)
      if (!response.ok) {
        if (id === latest.current) setStale(true)
        return
      }
      const answer = (await response.json()) as KnowledgeView
      // Superseded: a newer request is already in flight, and its answer is the one this page is
      // going to show. Say nothing -- not even that this one arrived.
      if (id !== latest.current) return
      setView(answer)
      setStale(false)
    } catch {
      if (id === latest.current) setStale(true)
    }
  }

  /** A filter moves the page immediately -- the state, the address bar and the request, in that
   *  order -- and asks the route with the NEW value, built here rather than read back off
   *  `filters`, which React has not written yet at this point. */
  const apply = (next: KnowledgeFilters): void => {
    setFilters(next)
    void reload(next)
  }

  /**
   * One dimension changes. A control set to its empty option means "no filter on this dimension",
   * which is the ABSENCE of the key and never an empty value: `{ type: undefined }` still has a
   * `type`, `knowledgeFilterParams` would have to know that, and the route would read `type=` on
   * the wire.
   */
  const pick = <K extends keyof KnowledgeFilters>(key: K, value: KnowledgeFilters[K] | undefined): void => {
    const { [key]: _gone, ...rest } = filters
    apply(value === undefined ? (rest as KnowledgeFilters) : ({ ...rest, [key]: value } as KnowledgeFilters))
  }

  const verify = async (row: KnowledgeRow): Promise<void> => {
    setBusyId(row.memory.id)
    setErrors((was) => {
      const { [row.memory.id]: _gone, ...rest } = was
      return rest
    })
    const result = await postControl(`/api/w/${workspaceId}/memories/${row.memory.id}/verify`)
    setBusyId(null)
    if (!result.ok) {
      setErrors((was) => ({ ...was, [row.memory.id]: result.error }))
      return
    }
    await reload(filters)
  }

  const save = async (): Promise<void> => {
    if (correcting === null) return
    setCorrectPending(true)
    setCorrectError(null)
    const result = await postControl(`/api/w/${workspaceId}/memories/${correcting.memory.id}/supersede`, {
      title: draft.title,
      body: draft.body,
    })
    setCorrectPending(false)
    if (!result.ok) {
      setCorrectError(result.error)
      return
    }
    setCorrecting(null)
    await reload(filters)
  }

  /** `DangerConfirm`'s contract: the refusal TEXT on a refusal (it shows it and stays open), null
   *  when it is done. The reason is the one a person typed beside the button -- an empty one is
   *  refused by `removeMemory` itself, and that refusal is the sentence shown. */
  const remove = async (row: KnowledgeRow): Promise<string | null> => {
    const result = await postControl(`/api/w/${workspaceId}/memories/${row.memory.id}/remove`, {
      reason: reasons[row.memory.id] ?? '',
    })
    if (!result.ok) return result.error
    await reload(filters)
    return null
  }

  /**
   * One `knowledge-row` article, drawn by index -- `DataTable`'s `virtualized.render` (M61 Task
   * 10, copied from `PeopleTable`'s own wiring). The markup below is byte-identical to what this
   * component's `view.rows.map` rendered directly before this task; only the list around it
   * changed. Kept as a function rather than inlined so the same JSX serves `virtualized.render`.
   */
  const renderRow = (index: number): React.ReactNode => {
    const row = view.rows[index]
    if (row === undefined) return null
    const { memory } = row
    const live = LIVE.includes(memory.status)
    return (
      <article
        key={memory.id}
        data-testid="knowledge-row"
        data-memory-id={memory.id}
        data-memory-type={memory.type}
        data-memory-status={memory.status}
        data-memory-scope={memory.scope}
        className="flex flex-col overflow-hidden rounded-panel border border-line bg-bg-1 shadow-resting"
      >
        {/* The README's three-column row (M57 R10): a fixed classification rail, the
          * substance in the middle, and the live actions on the right -- `190px` is the
          * remove-reason input's own width below, not a coincidence. */}
        <div className="grid grid-cols-[110px_minmax(0,1fr)_190px] gap-[14px] border-b border-line px-4 py-3">
          <div className="flex flex-col items-start gap-1.5">
            <Chip testId="knowledge-type" title={memory.type}>
              {row.typeLabel}
            </Chip>
            <Chip testId="knowledge-scope" title={memory.scope}>
              {row.scopeLabel}
            </Chip>
            <StatusPill tone={STATUS_TONE[memory.status]} label={row.statusLabel} title={memory.status} />
          </div>

          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="min-w-0 text-sm text-text-1">{memory.title}</span>
            <p className="text-xs text-text-2">{memory.body}</p>
            <div className="flex flex-wrap items-center gap-2">
              <span data-testid="knowledge-provenance" className="text-[11px] text-text-3">
                {row.provenance}
              </span>
              <Chip testId="knowledge-confidence" title={memory.confidence}>
                {row.confidenceLabel}
              </Chip>
            </div>
            {memory.removedReason !== null && (
              <span data-testid="knowledge-removed-reason" className="text-[11px] text-tone-blocked">
                withdrawn: {memory.removedReason}
              </span>
            )}
          </div>

          {live && (
            <div className="flex flex-col items-start gap-2">
              {memory.status === 'candidate' && (
                <Button
                  variant="primary"
                  size="sm"
                  data-testid="knowledge-verify"
                  disabled={busyId === memory.id}
                  onClick={() => void verify(row)}
                >
                  Verify
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                data-testid="knowledge-correct"
                onClick={() => {
                  setCorrecting(row)
                  setDraft({ title: memory.title, body: memory.body })
                  setCorrectError(null)
                }}
              >
                Correct
              </Button>
              <input
                data-testid="knowledge-remove-reason"
                value={reasons[memory.id] ?? ''}
                onChange={(event) => setReasons((was) => ({ ...was, [memory.id]: event.target.value }))}
                placeholder="why withdraw this?"
                aria-label="why withdraw this"
                className={`${INPUT_SHELL} w-[190px] text-xs`}
              />
              <DangerConfirm
                label="Remove"
                testId="knowledge-remove"
                confirmText="remove"
                confirmName="confirm removing this memory"
                onConfirm={async () => remove(row)}
              />
            </div>
          )}
        </div>

        {errors[memory.id] !== undefined && (
          <span role="alert" data-testid="knowledge-error" className="px-4 pt-3 text-[11px] text-tone-blocked">
            {errors[memory.id]}
          </span>
        )}

        {/* Folded, never hidden: the ids, the raw source kind and the capability keys live
          * INSIDE the group, so the row above stays a sentence a person reads
          * (`DetailsGroup`'s own rule). */}
        <div className="px-4 pb-3 pt-3">
          <DetailsGroup group="provenance" title="Where this came from">
            <dl data-testid="knowledge-chain" className="flex flex-col gap-1 font-mono text-[10px] text-text-3">
              <ChainRow label="replaced" ids={row.supersedesIds} titles={view.memoryTitles} />
              <ChainRow
                label="replaced by"
                ids={memory.supersededById === null ? [] : [memory.supersededById]}
                titles={view.memoryTitles}
              />
              <ChainRow label="summarises" ids={memory.sourceIds} titles={view.memoryTitles} />
              <Fact label="this memory">{memory.id}</Fact>
              <Fact label="source">{memory.provenance.sourceKind}</Fact>
              {memory.provenance.sourceRef !== null && <Fact label="reference">{memory.provenance.sourceRef}</Fact>}
              {memory.provenance.runId !== null && <Fact label="run">{memory.provenance.runId}</Fact>}
              {memory.provenance.goalVersion !== null && (
                <Fact label="goal version">{String(memory.provenance.goalVersion)}</Fact>
              )}
              {row.taskTitle !== null && <Fact label="task">{row.taskTitle}</Fact>}
            </dl>
            {row.capabilities.length > 0 && (
              <div className="flex flex-col gap-1">
                <SectionLabel>asked for by</SectionLabel>
                <CapabilityChips capabilities={row.capabilities} max={row.capabilities.length} />
              </div>
            )}
          </DetailsGroup>
        </div>
      </article>
    )
  }

  return (
    <PageShell flush>
      <div className="flex min-h-0 flex-1 flex-col gap-[11px] px-[20px] pt-[16px]">
        {stale && (
          <Alert variant="error" testId="knowledge-stale">
            could not refresh this page — showing the last answer.
          </Alert>
        )}

        <Panel title="what this project knows">
          {/* The README's segmented All / Verified / Candidates (M57 R21), `ui/Segmented` so the
            * primitive is written once. The granular `status` select below still reaches
            * `superseded`/`removed`/several at once -- this is the common-case shortcut over it,
            * not a second filter dimension. */}
          <div className="pb-2">
            <Segmented
              options={[
                { id: 'all', label: 'All' },
                { id: 'verified', label: 'Verified', count: view.counts.verified },
                { id: 'candidate', label: 'Candidates', count: view.counts.candidates },
              ]}
              value={quickViewOf(filters.statuses)}
              onChange={(next) => pick('statuses', next === 'all' ? undefined : [next])}
              ariaLabel="Knowledge status"
              testIdPrefix="knowledge-filter-view"
            />
          </div>
          <div className="flex flex-wrap items-end gap-2">
            {/* The kit's own field shell (M16 §2), not three hand-rolled `<select>`s: the testid,
              * the value and the handler ride through `selectProps` untouched, and the radius and
              * the focus ring are the ones every other form on this app already wears. The cast is
              * `NewSlaveDrawer`'s and `DepartmentsTable`'s -- `SelectHTMLAttributes` has no index
              * signature, so an object LITERAL carrying `data-testid` trips the excess-property
              * check even though the attribute spreads onto the element perfectly well. */}
            <SelectField
              label="scope"
              selectProps={{
                'data-testid': 'knowledge-filter-scope',
                value: filters.scope ?? '',
                onChange: (event) => pick('scope', asMember<MemoryScope>(event.target.value, MEMORY_SCOPES)),
              } as React.SelectHTMLAttributes<HTMLSelectElement>}
            >
              <option value="">Anybody&apos;s</option>
              {MEMORY_SCOPES.map((scope) => (
                <option key={scope} value={scope}>
                  {MEMORY_SCOPE_LABEL[scope]}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="kind"
              selectProps={{
                'data-testid': 'knowledge-filter-type',
                value: filters.type ?? '',
                onChange: (event) => pick('type', asMember<MemoryType>(event.target.value, MEMORY_TYPES)),
              } as React.SelectHTMLAttributes<HTMLSelectElement>}
            >
              <option value="">Any kind</option>
              {MEMORY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {MEMORY_TYPE_LABEL[type]}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="status"
              selectProps={{
                'data-testid': 'knowledge-filter-status',
                value: statusValue(filters.statuses),
                onChange: (event) => {
                  const one = asMember<MemoryStatus>(event.target.value, MEMORY_STATUSES)
                  pick('statuses', one === undefined ? undefined : [one])
                },
              } as React.SelectHTMLAttributes<HTMLSelectElement>}
            >
              <option value="">Verified and waiting</option>
              {MEMORY_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {MEMORY_STATUS_LABEL[status]}
                </option>
              ))}
              {/* Only while the LINK carries several -- never a thing to choose, only a thing the
                * bar can honestly report about itself. */}
              {statusValue(filters.statuses) === SEVERAL && (
                <option value={SEVERAL}>Several ({(filters.statuses ?? []).length})</option>
              )}
            </SelectField>
            <label className="flex flex-col gap-1">
              <FieldLabel>search the titles</FieldLabel>
              <input
                data-testid="knowledge-filter-q"
                value={filters.q ?? ''}
                onChange={(event) => pick('q', event.target.value.trim() === '' ? undefined : event.target.value)}
                placeholder="a word in the title"
                className={INPUT_SHELL}
              />
            </label>
            {/* Counted over the whole project, never over the rows a filter left: the two numbers
              * here are the two the Overview's own knowledge line prints. */}
            <span
              data-testid="knowledge-counts"
              title="counted over this project’s own memories, whatever the filters above show"
              className="pb-1.5 text-xs text-text-3"
            >
              {view.counts.verified} verified · {view.counts.candidates} candidates
            </span>
          </div>
        </Panel>

        {view.rows.length === 0 ? (
          <Panel>
            <EmptyState
              testId="knowledge-empty"
              message="this project knows nothing yet — a passed verification is the first thing that writes here"
            />
          </Panel>
        ) : (
          <div data-testid="knowledge-rows" className="flex min-h-0 flex-1 flex-col">
            <DataTable
              columns={ROW_COLUMNS}
              header={[...ROW_HEADER]}
              virtualized={{ rowHeight: ESTIMATED_ROW_HEIGHT, count: view.rows.length, render: renderRow, dynamic: true }}
            />
          </div>
        )}
      </div>

      <Drawer
        open={correcting !== null}
        onClose={() => setCorrecting(null)}
        label="Correct this memory"
        testId="knowledge-correct-drawer"
      >
        <SectionLabel>correct this memory</SectionLabel>
        {/* Said out loud, because it is the whole shape of this action: the old row is KEPT. */}
        <span className="text-xs text-text-3">
          the memory you are correcting is kept and marked as replaced — nothing is deleted.
        </span>
        <label className="flex flex-col gap-1">
          <FieldLabel>title</FieldLabel>
          <input
            data-testid="knowledge-correct-title"
            value={draft.title}
            onChange={(event) => setDraft((was) => ({ ...was, title: event.target.value }))}
            className={INPUT_SHELL}
          />
        </label>
        <label className="flex flex-col gap-1">
          <FieldLabel>what is true instead</FieldLabel>
          <textarea
            data-testid="knowledge-correct-body"
            value={draft.body}
            rows={8}
            onChange={(event) => setDraft((was) => ({ ...was, body: event.target.value }))}
            className={INPUT_SHELL}
          />
        </label>
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" data-testid="knowledge-correct-save" disabled={correctPending} onClick={() => void save()}>
            {correctPending ? 'saving…' : 'Save the correction'}
          </Button>
          <Button variant="ghost" size="sm" data-testid="knowledge-correct-cancel" onClick={() => setCorrecting(null)}>
            Cancel
          </Button>
        </div>
        {correctError !== null && (
          <span role="alert" data-testid="knowledge-correct-error" className="text-xs text-tone-blocked">
            {correctError}
          </span>
        )}
      </Drawer>
    </PageShell>
  )
}

/** A `<select>`'s value back as the union member it came from, or `undefined` for the empty option
 *  -- and for a value no union member matches, which is a `<select>` nobody built but a DOM
 *  somebody could have edited. */
function asMember<T extends string>(value: string, known: readonly string[]): T | undefined {
  return known.includes(value) ? (value as T) : undefined
}

/** One `id — title` line of the chain, or nothing at all: an empty heading is a promise this row
 *  cannot keep. The id is always printed, because an id is findable and an invented title is not. */
function ChainRow({
  label,
  ids,
  titles,
}: {
  readonly label: string
  readonly ids: readonly string[]
  readonly titles: Readonly<Record<string, string>>
}): React.JSX.Element | null {
  if (ids.length === 0) return null
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-text-3">{label}</dt>
      {ids.map((id) => (
        <dd key={id} data-testid="knowledge-chain-link" data-memory-id={id} className="text-text-2">
          {id}
          {titles[id] === undefined ? '' : ` — ${titles[id]}`}
        </dd>
      ))}
    </div>
  )
}

function Fact({ label, children }: { readonly label: string; readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex gap-2">
      <dt className="text-text-3">{label}</dt>
      <dd className="min-w-0 break-all text-text-2">{children}</dd>
    </div>
  )
}
