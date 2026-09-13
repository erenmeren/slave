'use client'

import { useState } from 'react'
import { SLAVE_LIFECYCLE_LABEL } from '@slave-of-ai/domain'
// Type-only, so nothing from `server/organization.ts` -- and nothing under it, control and the
// Prisma client -- reaches the client bundle. The rule `SupervisorPanel.tsx` states for
// `SupervisorView`.
import type { OrganizationPreference, OrganizationView } from '../../server/organization'
import { plural } from '../../lib/plural'
import { postControl, sendControl } from '../../lib/postControl'
import { ProposalRow } from '../SupervisorPanel'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { DataTable, Row } from '../ui/DataTable'
import { DetailsGroup } from '../ui/DetailsGroup'
import { EmptyState } from '../ui/EmptyState'
import { INPUT_SHELL } from '../ui/FormControls'
import { PageShell } from '../ui/PageShell'
import { Panel } from '../ui/Panel'
import { SectionLabel } from '../ui/SectionLabel'
import { CapabilityChips } from './CapabilityChips'

/** `gate:m11-shell` and four M46 tests read `data-table-row` on tables built this way; the columns
 *  are free to move, the primitive is not (`WorkforceCatalog`'s own note). */
const COLUMNS = '1fr 90px 1.6fr 1.8fr 90px'
const HEADER = ['Worker', 'Lifecycle', 'Provides', 'Why they are here', 'Doing'] as const

/** How many advisory edges stand open. Five is what fits under the roster without turning the page
 *  into a list of suggestions; past it the group is folded and says how to open it. */
const ADVICE_OPEN_MAX = 5

/**
 * The Organization tab (M47 R6): who works on this project, why each of them was chosen, what they
 * can be asked for, and what the board still needs that nobody here provides.
 *
 * Three parts, in the order a person asks them: the ROSTER, then what is MISSING -- with the
 * Supervisor's own proposals answerable in place, through the routes M38/M39 already own -- and
 * last the ADVICE a persona's profile carries. Nothing on this page dispatches anybody: the
 * collaboration edges are advisory by construction (R5) and are captioned as such, and the only
 * writes here are the approve and reject a proposal already had on the Overview.
 *
 * The coverage summary is `teamPlanOf`'s, computed once by `buildOrganization` -- the SAME plan
 * `candidates` makes its offers from. Two computations of "what is missing" would eventually
 * disagree in front of a person, and the one on the page would be the one nobody could act on.
 */
export function OrganizationClient({
  workspaceId,
  initial,
}: {
  readonly workspaceId: string
  readonly initial: OrganizationView
}): React.JSX.Element {
  const [view, setView] = useState<OrganizationView>(initial)
  /** The one proposal currently writing. Per-row rather than per-page: two needs are two
   *  independent decisions, and answering one must not grey out the other. */
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const [stale, setStale] = useState(false)

  /** Re-read this page after a write. The rows already on screen stay until the new ones land: a
   *  page that empties itself between an approval and its answer is harder to read than one that
   *  lags by a request, and a failed refetch says so rather than showing nothing. */
  const reload = async (): Promise<void> => {
    try {
      const response = await fetch(`/api/w/${workspaceId}/organization`)
      if (!response.ok) {
        setStale(true)
        return
      }
      setView((await response.json()) as OrganizationView)
      setStale(false)
    } catch {
      setStale(true)
    }
  }

  const send = async (decisionId: string, path: string, body?: Record<string, unknown>): Promise<void> => {
    setBusyId(decisionId)
    setErrors((was) => {
      const { [decisionId]: _gone, ...rest } = was
      return rest
    })
    const result = await postControl(`/api/w/${workspaceId}/supervisor/decisions/${decisionId}/${path}`, body)
    setBusyId(null)
    if (!result.ok) {
      setErrors((was) => ({ ...was, [decisionId]: result.error }))
      return
    }
    await reload()
  }

  const nobodyHere = view.workers.length === 0

  return (
    <PageShell flush>
      <div className="flex flex-col gap-[11px] px-[20px] pt-[16px]">
        {stale && (
          <Alert variant="error" testId="organization-stale">
            could not refresh this page — showing the last answer.
          </Alert>
        )}

        <Panel title="who works on this">
          {nobodyHere ? (
            <EmptyState
              testId="organization-empty"
              message="nobody is on this project yet. A plan that asks for a capability is what puts somebody here."
            />
          ) : (
            <div data-testid="organization-rows">
              <DataTable columns={COLUMNS} header={[...HEADER]}>
                {view.workers.map((worker, index) => (
                  // The wrapper carries the row's own identity, so the `data-table-row` handle
                  // four gates read stays exactly where it is (`WorkforceCatalog`'s idiom).
                  // A released worker's row is greyed and carries the state a stylesheet and a
                  // gate can both read -- it is still here, and still findable (D7).
                  <div
                    key={worker.slaveId}
                    data-testid={`organization-row-${worker.slaveId}`}
                    data-released={worker.released === null ? undefined : 'true'}
                    className={worker.released === null ? undefined : 'opacity-60'}
                  >
                    {/* `last` because this `Row` is the only child of its wrapper, so its own
                      * `:last-child` selector would match every row and draw no separator. */}
                    <Row columns={COLUMNS} last={index === view.workers.length - 1}>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm text-text-1">{worker.name}</span>
                        {/* The role a person reads, with the runtime roles that actually decide
                          * dispatch one hover away (M44 R5). */}
                        <span
                          title={worker.runtimeRoles.join(', ')}
                          className="truncate font-mono text-[10px] text-text-3"
                        >
                          {worker.roleLabel}
                        </span>
                      </span>
                      <span data-testid={`organization-lifecycle-${worker.slaveId}`}>
                        {/* The WORD, with the raw value in `title` (`docs/ia.md` rule 3). An
                          * ephemeral worker gets the `waiting` tone -- the one tone in the palette
                          * that already means "this is temporary and somebody will have to act" --
                          * so a temporary specialist is visible in a glance down the column. */}
                        <Chip {...(worker.lifecycle === 'ephemeral' ? { tone: 'waiting' as const } : {})} title={worker.lifecycle}>
                          {SLAVE_LIFECYCLE_LABEL[worker.lifecycle]}
                        </Chip>
                      </span>
                      <CapabilityChips capabilities={worker.capabilities} />
                      {/* Another party's sentence -- a MODEL may have written this one -- as JSX
                        * children, so it is characters on the page and never elements (spec §1). */}
                      <span data-testid={`organization-why-${worker.slaveId}`} className="text-xs text-text-2">
                        {worker.why}
                      </span>
                      {worker.released === null ? (
                        <span
                          data-testid={`organization-doing-${worker.slaveId}`}
                          className={`text-xs ${worker.doing === null ? 'text-text-3' : 'text-tone-working'}`}
                        >
                          {worker.doing ?? 'Idle'}
                        </span>
                      ) : (
                        // The engagement ended, so "Idle" would be a lie about a worker that is not
                        // waiting for anything. The DATE, with the sentence the release was recorded
                        // with one hover away.
                        <span
                          data-testid={`organization-released-${worker.slaveId}`}
                          title={worker.released.reason}
                          className="text-xs text-text-3"
                        >
                          Released {worker.released.at.slice(0, 10)}
                        </span>
                      )}
                    </Row>
                  </div>
                ))}
              </DataTable>
            </div>
          )}
        </Panel>

        {(view.needs.length > 0 || view.pendingElsewhere > 0) && (
          <Panel title="what this project still needs">
            {view.needs.length > 0 && (
            <div data-testid="organization-needs" className="flex flex-col gap-3">
              {view.needs.map((need) => (
                <section
                  key={need.capability}
                  data-testid={`organization-need-${need.capability}`}
                  className="flex flex-col gap-1 rounded border border-line p-2"
                >
                  <span className="flex items-baseline gap-2">
                    {/* The label, with the key still reachable (`docs/ia.md` rule 3). */}
                    <span title={need.capability} className="text-sm text-text-1">
                      {need.label}
                    </span>
                    <span className="font-mono text-[10px] text-text-3">{plural(need.readyTasks, 'ready task')}</span>
                  </span>
                  <span className="text-xs text-text-2">{need.summary}</span>
                  {/* M53 R9: the decision lives where the staffing decision is READ. Two controls
                    * and no third: a picker that names a profile or a model, and a clear. There is
                    * no "prefer for every project" and no priority -- one decision per capability
                    * per project is the whole of the table. */}
                  <StaffingPreferenceControl
                    workspaceId={workspaceId}
                    capability={need.capability}
                    capabilityLabel={need.label}
                    templates={view.templates}
                    preference={need.preference}
                    onChanged={() => void reload()}
                  />
                  {need.decisions.map((decision) => (
                    // A one-item `<ul>` per decision, because `ProposalRow` IS the `<li>` (the
                    // M45 timeline wraps it exactly this way).
                    <ul key={decision.id} className="flex flex-col gap-1">
                      {/* The SAME row the Supervisor panel and the M45 timeline render, so a
                        * proposal reads and is answered identically wherever it is shown. */}
                      <ProposalRow
                        decision={decision}
                        // The panel's mailbox is not on this page; a drafted answer shows its own
                        // summary rather than a question invented here.
                        questions={[]}
                        taskTitles={view.taskTitles}
                        busy={busyId === decision.id}
                        onApprove={(body) => void send(decision.id, 'approve', body === undefined ? undefined : { body })}
                        onReject={(reason) => void send(decision.id, 'reject', reason.trim() === '' ? undefined : { reason })}
                      />
                      {errors[decision.id] !== undefined && (
                        <li role="alert" data-testid="organization-error" className="text-[11px] text-tone-blocked">
                          {errors[decision.id]}
                        </li>
                      )}
                    </ul>
                  ))}
                </section>
              ))}
            </div>
            )}
            {/* A proposal recorded against a capability somebody has since been given the role for
              * (fix round 1, minor 4): no need row above carries it, and it is still waiting on a
              * person. The COUNT and where to answer it -- never a second Approve, which would be a
              * second place to keep the decision queue in step. */}
            {view.pendingElsewhere > 0 && (
              <span data-testid="organization-pending-elsewhere" className="text-xs text-text-3">
                {plural(view.pendingElsewhere, 'staffing proposal')}{' '}
                {view.pendingElsewhere === 1 ? 'is' : 'are'} waiting on the Overview: the gap each was
                made about is no longer one.
              </span>
            )}
          </Panel>
        )}

        {view.covered.length > 0 && (
          <Panel title="what this project is covered for">
            {/* D36: the control sits here TOO, and not only on the need rows -- a person's most
              * likely reason to ask for somebody is that the current holder is not working out, and
              * a capability with a holder has no need row at all. */}
            <ul data-testid="organization-covered" className="flex flex-col gap-1.5">
              {view.covered.map((one) => (
                <li key={one.capability} className="flex flex-wrap items-center gap-2">
                  <Chip title={one.capability} tone="done">
                    {one.label} · {nameOf(one.by, view)}
                  </Chip>
                  <StaffingPreferenceControl
                    workspaceId={workspaceId}
                    capability={one.capability}
                    capabilityLabel={one.label}
                    templates={view.templates}
                    preference={one.preference}
                    onChanged={() => void reload()}
                  />
                </li>
              ))}
            </ul>
          </Panel>
        )}

        {view.unfillable.length > 0 && (
          <Alert variant="notice" testId="organization-unfillable">
            nobody on this project, on the company roster or in the catalog provides{' '}
            {view.unfillable.map((one) => one.label).join(', ')}. A capability nobody anywhere has is
            not a staffing decision anybody can take from here.
          </Alert>
        )}

        {view.hints.length > 0 && (
          <Panel>
            {/* Folded once there is more than a handful (fix round 1, minor 6): a persona may carry
              * thirty handoff sentences, and thirty of them under a roster of three is a page about
              * advice. `DetailsGroup` renders its children only while open, which is exactly the
              * behaviour wanted here -- nothing below is fetched or measured. */}
            <DetailsGroup group="collaboration" title="Who to consult" defaultOpen={view.hints.length <= ADVICE_OPEN_MAX}>
              <ul className="flex flex-col gap-1">
                {view.hints.map((hint, index) => (
                  <li
                    key={`${hint.slaveId}-${String(index)}`}
                    data-testid="organization-hint"
                    data-capability={hint.capability ?? ''}
                    className="flex flex-col gap-0.5"
                  >
                    <span className="font-mono text-[10px] text-text-3">
                      {nameOf(hint.slaveId, view)}
                      {hint.targetTemplateName === null ? '' : ` → ${hint.targetTemplateName}`}
                      {/* The LABEL, with the key on `data-capability` above (`docs/ia.md` rule 3):
                        * the chips two panels up read `API design`, and this line read
                        * `backend.api-design` for the same capability. */}
                      {hint.capabilityLabel === null ? '' : ` · ${hint.capabilityLabel}`}
                    </span>
                    {/* A persona's own sentence, as characters (spec §1) -- never
                      * `dangerouslySetInnerHTML`, and never a link this page would resolve. */}
                    <span className="text-xs text-text-1">{hint.text}</span>
                  </li>
                ))}
              </ul>
              <SectionLabel testId="organization-advice">
                advice from this worker&apos;s profile — it never decides who does the work
              </SectionLabel>
            </DetailsGroup>
          </Panel>
        )}
      </div>
    </PageShell>
  )
}


/**
 * One capability's staffing decision, where the staffing decision is read (M53 R9).
 *
 * TWO controls and no third: a picker that names a profile or a model, and a `Clear`. A set `PUT`s
 * and a clear `DELETE`s, both against `/api/w/<id>/staffing/<capability>`, and the refusal renders
 * through the same `organization-error` row the proposals already use.
 *
 * Nothing here repeats a rule the verb owns. Asking for neither a profile nor a model is not
 * refused in the browser: it is sent, and `setStaffingPreference` answers `a staffing preference for
 * <key> must name a profile, a model, or both` in its own words -- one owner for that sentence
 * rather than a second copy here to go stale. `Clear` is how a person means "nobody in particular",
 * which is a different act and has its own verb.
 *
 * The preference is ADVISORY and the caption says so: `rankCandidates` reads it at step 3 of seven,
 * so it is obeyed ahead of any record and behind any refusal, and a preference for a busy worker
 * loses to availability.
 */
function StaffingPreferenceControl({
  workspaceId,
  capability,
  capabilityLabel,
  templates,
  preference,
  onChanged,
}: {
  readonly workspaceId: string
  readonly capability: string
  readonly capabilityLabel: string
  readonly templates: readonly { readonly id: string; readonly name: string }[]
  readonly preference: OrganizationPreference | null
  readonly onChanged: () => void
}): React.JSX.Element {
  const [model, setModel] = useState(preference?.model ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async (options: { method: 'PUT' | 'DELETE'; body?: Record<string, unknown> }): Promise<void> => {
    setBusy(true)
    setError(null)
    const failure = await sendControl(`/api/w/${workspaceId}/staffing/${encodeURIComponent(capability)}`, options)
    setBusy(false)
    if (failure !== null) {
      setError(failure)
      return
    }
    onChanged()
  }

  const set = (templateId: string | null, nextModel: string): void => {
    void send({ method: 'PUT', body: { templateId, model: nextModel.trim() === '' ? null : nextModel.trim() } })
  }

  return (
    <span data-testid={`staffing-control-${capability}`} className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-1.5">
        {/* The capability's LABEL beside the control, so a person reading one row of several knows
          * which decision this picker is about (`docs/ia.md` rule 3 -- the key is in `title`). */}
        <span title={capability} className="font-mono text-[10px] text-text-3">
          {`Ask for · ${capabilityLabel}`}
        </span>
        <select
          data-testid={`staffing-preference-${capability}`}
          aria-label={`who should take ${capabilityLabel}`}
          disabled={busy}
          value={preference?.templateId ?? ''}
          onChange={(event) => set(event.target.value === '' ? null : event.target.value, model)}
          className={`${INPUT_SHELL} py-0.5 text-xs`}
        >
          <option value="">Nobody in particular</option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
        <input
          data-testid={`staffing-model-${capability}`}
          aria-label={`what model should take ${capabilityLabel}`}
          disabled={busy}
          value={model}
          placeholder="any model"
          onChange={(event) => setModel(event.target.value)}
          onBlur={() => {
            if ((preference?.model ?? '') !== model.trim()) set(preference?.templateId ?? null, model)
          }}
          className={`${INPUT_SHELL} w-[130px] py-0.5 text-xs`}
        />
        {preference !== null && (
          <Button
            variant="ghost"
            size="sm"
            data-testid={`staffing-clear-${capability}`}
            disabled={busy}
            onClick={() => {
              setModel('')
              void send({ method: 'DELETE' })
            }}
          >
            Clear
          </Button>
        )}
      </span>
      {preference !== null && (
        <span data-testid={`staffing-asked-${capability}`} className="text-[11px] text-text-2">
          {askedFor(preference)}
        </span>
      )}
      {error !== null && (
        <span role="alert" data-testid="organization-error" className="text-[11px] text-tone-blocked">
          {error}
        </span>
      )}
    </span>
  )
}

/**
 * The sentence under the control: what was asked for, and who asked.
 *
 * The template's NAME and never its id, and a USERNAME and never a `User.id` -- `buildOrganization`
 * resolved the setter at the web boundary in one batched lookup (M52 erratum E18). The two ways a
 * name can be missing are said apart, because they are different facts: an account deleted since is
 * `a person no longer on record`, and a decision taken with no principal at all (the CLI carries
 * none) named nobody to begin with.
 */
function askedFor(preference: OrganizationPreference): string {
  const who =
    preference.templateName !== null && preference.model !== null
      ? `${preference.templateName} on ${preference.model}`
      : (preference.templateName ?? preference.model ?? 'nobody in particular')
  const by =
    preference.setById === null ? 'somebody unrecorded' : (preference.setBy ?? 'a person no longer on record')
  return `Asked for: ${who} — by ${by}. A preference is obeyed ahead of any record and behind any refusal.`
}

/** A worker's name for an id this view already holds, and the id itself when it does not -- which
 *  is findable, rather than a name this component would have to invent. */
function nameOf(slaveId: string, view: OrganizationView): string {
  return view.workers.find((worker) => worker.slaveId === slaveId)?.name ?? slaveId
}
