'use client'

import { useState } from 'react'
import {
  MEMORY_SCOPES,
  MEMORY_SCOPE_LABEL,
  MEMORY_STATUSES,
  MEMORY_STATUS_LABEL,
  MEMORY_TYPES,
  MEMORY_TYPE_LABEL,
  type MemoryStatus,
} from '@slave-of-ai/domain'
// Type-only, so nothing from `server/memory.ts` -- and nothing under it, control and the Prisma
// client -- reaches the client bundle. The rule `OrganizationClient` states for `OrganizationView`.
import type { KnowledgeRow, KnowledgeView } from '../../server/memory'
import { postControl } from '../../lib/postControl'
import { CapabilityChips } from '../organization/CapabilityChips'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { DangerConfirm } from '../ui/DangerConfirm'
import { DetailsGroup } from '../ui/DetailsGroup'
import { Drawer } from '../ui/Drawer'
import { EmptyState } from '../ui/EmptyState'
import { FieldLabel, INPUT_SHELL } from '../ui/FormControls'
import { PageShell } from '../ui/PageShell'
import { Panel } from '../ui/Panel'
import { SectionLabel } from '../ui/SectionLabel'
import { StatusPill, type StatusTone } from '../ui/StatusPill'

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

interface Filters {
  readonly scope: string
  readonly type: string
  readonly status: string
  readonly q: string
}

const NO_FILTERS: Filters = { scope: '', type: '', status: '', q: '' }

/** The query string the route reads, built from the four controls. An empty control sends NOTHING
 *  rather than an empty value -- `status` absent is what asks the route for its own default (the
 *  verified rows plus the candidates waiting on a person). */
function toQuery(filters: Filters): string {
  const params = new URLSearchParams()
  if (filters.scope !== '') params.set('scope', filters.scope)
  if (filters.type !== '') params.set('type', filters.type)
  if (filters.status !== '') params.set('status', filters.status)
  if (filters.q.trim() !== '') params.set('q', filters.q.trim())
  return params.toString()
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
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
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

  /** Re-read this page. The rows already on screen stay until the new ones land: a page that
   *  empties itself between a click and its answer is harder to read than one that lags by a
   *  request, and a failed refetch says so rather than showing nothing (`OrganizationClient`). */
  const reload = async (next: Filters): Promise<void> => {
    const query = toQuery(next)
    try {
      const response = await fetch(`/api/w/${workspaceId}/memories${query === '' ? '' : `?${query}`}`)
      if (!response.ok) {
        setStale(true)
        return
      }
      setView((await response.json()) as KnowledgeView)
      setStale(false)
    } catch {
      setStale(true)
    }
  }

  /** A filter moves the page immediately and asks the route with the NEW value -- read off the
   *  event rather than off `filters`, which React has not written yet at this point. */
  const change = (patch: Partial<Filters>): void => {
    const next = { ...filters, ...patch }
    setFilters(next)
    void reload(next)
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

  return (
    <PageShell flush>
      <div className="flex flex-col gap-[11px] px-[20px] pt-[16px]">
        {stale && (
          <Alert variant="error" testId="knowledge-stale">
            could not refresh this page — showing the last answer.
          </Alert>
        )}

        <Panel title="what this project knows">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <FieldLabel>scope</FieldLabel>
              <select
                data-testid="knowledge-filter-scope"
                value={filters.scope}
                onChange={(event) => change({ scope: event.target.value })}
                className={INPUT_SHELL}
              >
                <option value="">Anybody&apos;s</option>
                {MEMORY_SCOPES.map((scope) => (
                  <option key={scope} value={scope}>
                    {MEMORY_SCOPE_LABEL[scope]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <FieldLabel>kind</FieldLabel>
              <select
                data-testid="knowledge-filter-type"
                value={filters.type}
                onChange={(event) => change({ type: event.target.value })}
                className={INPUT_SHELL}
              >
                <option value="">Any kind</option>
                {MEMORY_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {MEMORY_TYPE_LABEL[type]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <FieldLabel>status</FieldLabel>
              <select
                data-testid="knowledge-filter-status"
                value={filters.status}
                onChange={(event) => change({ status: event.target.value })}
                className={INPUT_SHELL}
              >
                <option value="">Verified and waiting</option>
                {MEMORY_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {MEMORY_STATUS_LABEL[status]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <FieldLabel>search the titles</FieldLabel>
              <input
                data-testid="knowledge-filter-q"
                value={filters.q}
                onChange={(event) => change({ q: event.target.value })}
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
              {view.counts.verified} verified · {view.counts.candidates} waiting on you
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
          <div data-testid="knowledge-rows" className="flex flex-col gap-[11px]">
            {view.rows.map((row) => {
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
                  className="flex flex-col gap-2 rounded-panel border border-line bg-bg-1 p-4 shadow-resting"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip testId="knowledge-type" title={memory.type}>
                      {row.typeLabel}
                    </Chip>
                    <span className="min-w-0 flex-1 text-sm text-text-1">{memory.title}</span>
                    <Chip testId="knowledge-scope" title={memory.scope}>
                      {row.scopeLabel}
                    </Chip>
                    <StatusPill tone={STATUS_TONE[memory.status]} label={row.statusLabel} title={memory.status} />
                  </div>

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

                  {live && (
                    <div className="flex flex-wrap items-center gap-2">
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

                  {errors[memory.id] !== undefined && (
                    <span role="alert" data-testid="knowledge-error" className="text-[11px] text-tone-blocked">
                      {errors[memory.id]}
                    </span>
                  )}

                  {/* Folded, never hidden: the ids, the raw source kind and the capability keys live
                    * INSIDE the group, so the row above stays a sentence a person reads
                    * (`DetailsGroup`'s own rule). */}
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
                </article>
              )
            })}
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
