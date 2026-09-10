'use client'

import { useState } from 'react'
// Type-only, so nothing from `server/organization.ts` -- and nothing under it, control and the
// Prisma client -- reaches the client bundle. The rule `SupervisorPanel.tsx` states for
// `SupervisorView`.
import type { OrganizationView } from '../../server/organization'
import { plural } from '../../lib/plural'
import { postControl } from '../../lib/postControl'
import { ProposalRow } from '../SupervisorPanel'
import { Alert } from '../ui/Alert'
import { Chip } from '../ui/Chip'
import { DataTable, Row } from '../ui/DataTable'
import { EmptyState } from '../ui/EmptyState'
import { PageShell } from '../ui/PageShell'
import { Panel } from '../ui/Panel'
import { SectionLabel } from '../ui/SectionLabel'
import { CapabilityChips } from './CapabilityChips'

/** `gate:m11-shell` and four M46 tests read `data-table-row` on tables built this way; the columns
 *  are free to move, the primitive is not (`WorkforceCatalog`'s own note). */
const COLUMNS = '1fr 90px 1.6fr 1.8fr 90px'
const HEADER = ['Worker', 'Kind', 'Provides', 'Why they are here', 'Doing'] as const

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
                  <div key={worker.slaveId} data-testid={`organization-row-${worker.slaveId}`}>
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
                      <span data-testid={`organization-kind-${worker.slaveId}`}>
                        <Chip>{worker.kind}</Chip>
                      </span>
                      <CapabilityChips capabilities={worker.capabilities} />
                      {/* Another party's sentence -- a MODEL may have written this one -- as JSX
                        * children, so it is characters on the page and never elements (spec §1). */}
                      <span data-testid={`organization-why-${worker.slaveId}`} className="text-xs text-text-2">
                        {worker.why}
                      </span>
                      <span
                        data-testid={`organization-doing-${worker.slaveId}`}
                        className={`text-xs ${worker.doing === null ? 'text-text-3' : 'text-tone-working'}`}
                      >
                        {worker.doing ?? 'Idle'}
                      </span>
                    </Row>
                  </div>
                ))}
              </DataTable>
            </div>
          )}
        </Panel>

        {view.needs.length > 0 && (
          <Panel title="what this project still needs">
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
          </Panel>
        )}

        {view.covered.length > 0 && (
          <Panel title="what this project is covered for">
            <ul data-testid="organization-covered" className="flex flex-wrap gap-1">
              {view.covered.map((one) => (
                <li key={one.capability}>
                  <Chip title={one.capability} tone="done">
                    {one.label} · {nameOf(one.by, view)}
                  </Chip>
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
          <Panel title="who to consult">
            <ul className="flex flex-col gap-1">
              {view.hints.map((hint, index) => (
                <li
                  key={`${hint.slaveId}-${String(index)}`}
                  data-testid="organization-hint"
                  className="flex flex-col gap-0.5"
                >
                  <span className="font-mono text-[10px] text-text-3">
                    {nameOf(hint.slaveId, view)}
                    {hint.targetTemplateName === null ? '' : ` → ${hint.targetTemplateName}`}
                    {hint.capability === null ? '' : ` · ${hint.capability}`}
                  </span>
                  {/* A persona's own sentence, as characters (spec §1) -- never
                    * `dangerouslySetInnerHTML`, and never a link this page would resolve. */}
                  <span className="text-xs text-text-1">{hint.text}</span>
                </li>
              ))}
            </ul>
            <span data-testid="organization-advice">
              <SectionLabel>advice from this worker&apos;s profile — it never decides who does the work</SectionLabel>
            </span>
          </Panel>
        )}
      </div>
    </PageShell>
  )
}

/** A worker's name for an id this view already holds, and the id itself when it does not -- which
 *  is findable, rather than a name this component would have to invent. */
function nameOf(slaveId: string, view: OrganizationView): string {
  return view.workers.find((worker) => worker.slaveId === slaveId)?.name ?? slaveId
}
