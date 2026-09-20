'use client'

import { useEffect, useMemo, useState } from 'react'
import { SLAVE_LIFECYCLE_LABEL } from '@slave-of-ai/domain'
// Type-only, so nothing from `server/organization.ts` -- and nothing under it, control and the
// Prisma client -- reaches the client bundle. The rule `supervisor/ProposalRow.tsx` states for
// `SupervisorView`.
import type { OrganizationPreference, OrganizationView } from '../../server/organization'
import type { CatalogRowView, ProjectTeamRow, RosterCompany } from '../../server/org'
import type { PersonDetail } from '../../server/persons'
import type { SlaveCardData } from '../../server/overview'
import { useShellFacts } from '../../hooks/useShellFacts'
import { plural } from '../../lib/plural'
import { postControl, sendControl } from '../../lib/postControl'
import { ProposalRow } from '../supervisor/ProposalRow'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { DetailsGroup } from '../ui/DetailsGroup'
import { EmptyState } from '../ui/EmptyState'
import { INPUT_SHELL, SelectField } from '../ui/FormControls'
import { LoadingState } from '../ui/LoadingState'
import { PageShell } from '../ui/PageShell'
import { Panel } from '../ui/Panel'
import { SectionLabel } from '../ui/SectionLabel'
import { CapabilityChips } from './CapabilityChips'
import { SlavePanel } from '../SlavePanel'
import { NewSlaveDrawer } from '../slaves/NewSlaveDrawer'
import { assignableProjectsOf } from '../persons/PersonProjectsGroup'
import { cardsOf, haltedReasonOf, liveSeatOf, personOf } from '../persons/liveSeat'

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
  roster = [],
  templates = [],
  teams = [],
  skillCatalogue = [],
}: {
  readonly workspaceId: string
  readonly initial: OrganizationView
  readonly roster?: readonly RosterCompany[]
  readonly templates?: readonly CatalogRowView[]
  readonly teams?: readonly ProjectTeamRow[]
  readonly skillCatalogue?: readonly { readonly skillId: string; readonly name: string; readonly providerName: string }[]
}): React.JSX.Element {
  const [view, setView] = useState<OrganizationView>(initial)
  // `/organization` publishes no `shellFacts` of its own (`ShellFactsSeed`'s own note names exactly
  // this route), so the project's NAME for the sub-line comes from the layout's seed rather than a
  // second read here -- null for the one paint before that effect lands, same as the header's own
  // budget figure on this route.
  const projectName = useShellFacts(workspaceId)?.workspace.name ?? null
  // Pool-seating's own busy/error state moved into `OrganizationAdd`, decision writes' into
  // `OrganizationNeeds` (both M61 R7 extractions) -- this page owns neither any more.
  const [stale, setStale] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const [selected, setSelected] = useState<{ readonly personId: string; readonly slaveId: string } | null>(null)
  const [personTick, setPersonTick] = useState(0)
  const [panel, setPanel] = useState<
    | { readonly kind: 'idle' }
    | { readonly kind: 'loading' }
    | { readonly kind: 'error' }
    | { readonly kind: 'ready'; readonly person: PersonDetail; readonly slave: SlaveCardData | null; readonly haltedReason: string | null }
  >({ kind: 'idle' })
  const assignableProjects = useMemo(() => assignableProjectsOf(teams), [teams])
  const teamId = view.teamId
  const pool = view.pool
  /** `slaveId -> name`, for `OrganizationPreferences`'s "who covers this" chip -- a lookup rather
   *  than the whole `OrganizationRow[]`, so the extracted component takes only what it reads. */
  const workerNames = useMemo(
    (): Readonly<Record<string, string>> => Object.fromEntries(view.workers.map((worker) => [worker.slaveId, worker.name])),
    [view.workers],
  )

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

  useEffect((): void => {
    if (selected === null) {
      setPanel({ kind: 'idle' })
      return
    }
    const personId = selected.personId
    const slaveId = selected.slaveId
    setPanel({ kind: 'loading' })
    void Promise.all([
      fetch(`/api/persons/${personId}`).then(async (response) => (response.ok ? ((await response.json()) as unknown) : null)),
      fetch(`/api/w/${workspaceId}/overview`)
        .then(async (response) => (response.ok ? ((await response.json()) as unknown) : null))
        .catch(() => null),
    ])
      .then(([detail, snapshot]) => {
        const person = personOf(detail)
        if (person === null) {
          setPanel({ kind: 'error' })
          return
        }
        setPanel({
          kind: 'ready',
          person,
          slave: liveSeatOf(cardsOf(snapshot), slaveId, personId),
          haltedReason: haltedReasonOf(snapshot),
        })
      })
      .catch(() => setPanel({ kind: 'error' }))
  }, [selected, personTick, workspaceId])

  return (
    <>
      <PageShell flush>
      <div className="flex flex-col gap-[11px] px-[20px] pt-[16px]">
        <div>
          <h1 className="m-0 text-[22px] font-semibold tracking-[-.3px] text-t1">Team</h1>
          <p className="mt-[6px] text-[13.5px] text-t2">
            {plural(view.workers.length, 'worker')} on {projectName ?? 'this project'} · why they are here and what
            they are doing
          </p>
        </div>
        {stale && (
          <Alert variant="error" testId="organization-stale">
            could not refresh this page — showing the last answer.
          </Alert>
        )}

        <OrganizationAdd
          workspaceId={workspaceId}
          pool={pool}
          teamId={teamId}
          onSeated={() => void reload()}
          onNewSlave={() => setNewOpen(true)}
        />

        <OrganizationRoster workers={view.workers} onOpen={(personId, slaveId) => setSelected({ personId, slaveId })} />

        <OrganizationNeeds
          workspaceId={workspaceId}
          needs={view.needs}
          pendingElsewhere={view.pendingElsewhere}
          templates={view.templates}
          taskTitles={view.taskTitles}
          hints={view.hints}
          names={workerNames}
          onChanged={() => void reload()}
        />

        <OrganizationPreferences
          workspaceId={workspaceId}
          covered={view.covered}
          templates={view.templates}
          names={workerNames}
          onChanged={() => void reload()}
        />

        {view.unfillable.length > 0 && (
          <Alert variant="notice" testId="organization-unfillable">
            nobody on this project, on the company roster or in the catalog provides{' '}
            {view.unfillable.map((one) => one.label).join(', ')}. A capability nobody anywhere has is
            not a staffing decision anybody can take from here.
          </Alert>
        )}
      </div>
    </PageShell>
      <NewSlaveDrawer
        open={newOpen}
        onClose={() => setNewOpen(false)}
        roster={roster}
        templates={templates}
        teams={teams}
        {...(teamId === '' ? {} : { defaultTeamId: teamId })}
      />
      {panel.kind === 'loading' && <LoadingState testId="organization-panel-loading" message="opening this slave…" />}
      {panel.kind === 'error' && (
        <Alert variant="error" testId="organization-panel-error">
          could not open this slave — they may have been deleted. Try clicking the name again.
        </Alert>
      )}
      {panel.kind === 'ready' && (
        <div className="fixed inset-y-0 right-0 z-10 w-96 border-l border-line bg-panel shadow-resting motion-safe:animate-[panel-in_160ms_ease-out]">
          <SlavePanel
            key={panel.slave?.id ?? panel.person.personId}
            slave={panel.slave}
            person={panel.person}
            projects={assignableProjects}
            skillCatalogue={skillCatalogue}
            liveEvents={[]}
            workspaceId={workspaceId}
            haltedReason={panel.haltedReason}
            onClose={() => setSelected(null)}
            onPersonChanged={() => setPersonTick((tick) => tick + 1)}
          />
        </div>
      )}
    </>
  )
}


/**
 * "Add somebody" (M61 R7, controller Ruling 4 -- the scope fix that follows `docs/ia.md` rule 2
 * onto the organization page's remaining UI): seat somebody already on the company roster, or open
 * the drawer that makes a brand new one. Extracted the same way `OrganizationNeeds`/
 * `OrganizationPreferences` were, with its own `poolPersonId`/`pending`/`error` state -- this is
 * how an end user staffs a project, and it is reachable from two pages now.
 *
 * `onNewSlave` is a bare callback rather than this component owning `NewSlaveDrawer` itself:
 * `NewSlaveDrawer` needs `roster`/`templates`/`teams` in the DRAWER's own richer shapes
 * (`RosterCompany[]`/`TemplateRow[]`/`ProjectTeamRow[]`), none of which belong on
 * `TeamLiveSnapshot` -- `listRoster()` alone is an unscoped, installation-wide read
 * (`server/org.ts`'s own docstring) that must not run on every `/api/w/:id/team` poll. Each caller
 * decides what "make a new slave" means for its own page: `OrganizationClient` still opens its own
 * local drawer (it already has the richer props); the Team tab sends the person to `/workforce`,
 * where that drawer already lives fully wired.
 */
export function OrganizationAdd({
  workspaceId,
  pool,
  teamId,
  onSeated,
  onNewSlave,
}: {
  readonly workspaceId: string
  readonly pool: OrganizationView['pool']
  readonly teamId: string
  readonly onSeated: () => void
  readonly onNewSlave: () => void
}): React.JSX.Element {
  const [poolPersonId, setPoolPersonId] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const seat = async (): Promise<void> => {
    if (poolPersonId === '' || teamId === '') return
    setPending(true)
    setError(null)
    const failure = await sendControl(`/api/persons/${poolPersonId}/assign`, { method: 'POST', body: { teamId } })
    setPending(false)
    if (failure !== null) {
      setError(failure)
      return
    }
    setPoolPersonId('')
    onSeated()
  }

  return (
    <Panel title="add somebody">
      <div className="flex flex-wrap items-end gap-2">
        <SelectField
          label="Add somebody"
          selectProps={{
            'aria-label': 'add somebody from the pool',
            'data-testid': 'organization-pool-person',
            value: poolPersonId,
            disabled: pending,
            onChange: (event) => setPoolPersonId(event.target.value),
          } as React.SelectHTMLAttributes<HTMLSelectElement>}
        >
          <option value="">somebody who already works here…</option>
          {pool.map((person) => (
            <option key={person.personId} value={person.personId}>{person.name}</option>
          ))}
        </SelectField>
        <Button
          variant="primary"
          size="sm"
          data-testid="organization-pool-submit"
          disabled={pending || poolPersonId === '' || teamId === ''}
          onClick={() => void seat()}
        >
          Seat them
        </Button>
        <Button variant="ghost" size="sm" data-testid="organization-add-from-pool" onClick={onNewSlave}>
          or make a new slave
        </Button>
      </div>
      {error !== null && (
        <span role="alert" data-testid="organization-error" className="text-[11px] text-tone-blocked">
          {error}
        </span>
      )}
    </Panel>
  )
}

/**
 * The roster table (M61 R7, controller Ruling 4): every worker on this project, with why they are
 * here, what they can be asked for, and what they are doing right now -- extracted out of
 * `OrganizationClient` for the Team tab's DEVELOPER-mode view (`docs/ia.md` rule 2: this table is
 * moved, not removed). `workers` is `TeamLiveSnapshot.workers`/`OrganizationView.workers` passed
 * straight through -- no reshaping, so `organization-row-*`/`organization-why-*`/`capability-chip`
 * read exactly as they always have.
 *
 * `onOpen` takes both ids (mirroring the original `setSelected({personId, slaveId})` call) so each
 * caller can open whatever detail surface it owns: `OrganizationClient`'s own fixed panel needs
 * both; the Team tab's `?slave=` mirror only reads `personId` and ignores the second argument.
 */
export function OrganizationRoster({
  workers,
  onOpen,
}: {
  readonly workers: OrganizationView['workers']
  readonly onOpen: (personId: string, slaveId: string) => void
}): React.JSX.Element {
  if (workers.length === 0) {
    return (
      <EmptyState
        testId="organization-empty"
        message="nobody is on this project yet. A plan that asks for a capability is what puts somebody here."
      />
    )
  }
  return (
    <div data-testid="organization-rows" className="flex flex-col gap-[11px]">
      {workers.map((worker) => (
        // Fix round 1, Important 1 (ruling T7-2): a self-contained card, not a `DataTable`
        // row -- the shared header/row grid template lined up only while the two shared one
        // width, and the card recipe's own border+padding broke that the moment it landed
        // on the row wrapper (`DataTable`/`Row` are UNCHANGED; other pages still use them).
        // A released worker's card is greyed and carries the state a stylesheet and a gate
        // can both read -- it is still here, and still findable (D7).
        <div
          key={worker.slaveId}
          data-testid={`organization-row-${worker.slaveId}`}
          data-released={worker.released === null ? undefined : 'true'}
          className={`flex flex-col gap-[10px] rounded-panel-card border border-line bg-card p-[14px_16px] shadow-card ${
            worker.released === null ? '' : 'opacity-60'
          }`}
        >
          <div className="flex items-start justify-between gap-2">
            <span className="flex min-w-0 flex-col">
              <button
                type="button"
                data-testid={`organization-open-${worker.personId}`}
                onClick={() => onOpen(worker.personId, worker.slaveId)}
                className="truncate text-left font-semibold text-t1 hover:text-t2"
              >
                {worker.name}
              </button>
              {/* The role a person reads, with the runtime roles that actually decide
                * dispatch one hover away (M44 R5). */}
              <span title={worker.runtimeRoles.join(', ')} className="truncate text-[12px] text-t3">
                {worker.roleLabel}
              </span>
            </span>
            <span data-testid={`organization-lifecycle-${worker.slaveId}`}>
              {/* The WORD, with the raw value in `title` (`docs/ia.md` rule 3). An
                * ephemeral worker gets the `waiting` tone -- the one tone in the palette
                * that already means "this is temporary and somebody will have to act" --
                * so a temporary specialist is visible in a glance down the card. */}
              <Chip {...(worker.lifecycle === 'ephemeral' ? { tone: 'waiting' as const } : {})} title={worker.lifecycle}>
                {SLAVE_LIFECYCLE_LABEL[worker.lifecycle]}
              </Chip>
            </span>
          </div>
          <CapabilityChips capabilities={worker.capabilities} />
          {/* The card's own label where the column header used to say it (spec :349 --
            * "worker cards with lifecycle, 'Now:', 'Why here:', capability chips"). The
            * label sits OUTSIDE the testid'd span so `organization-why-*`'s text stays
            * exactly the sentence itself -- another party's words, as JSX children, never
            * elements (spec §1) -- and nothing reading it has to strip a prefix. */}
          <span className="text-xs text-text-2">
            <span className="text-text-3">Why here: </span>
            <span data-testid={`organization-why-${worker.slaveId}`}>{worker.why}</span>
          </span>
          {worker.released === null ? (
            <span className={`text-xs ${worker.doing === null ? 'text-text-3' : 'text-tone-working'}`}>
              <span className="text-text-3">Now: </span>
              <span data-testid={`organization-doing-${worker.slaveId}`}>{worker.doing ?? 'Idle'}</span>
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
        </div>
      ))}
    </div>
  )
}

/**
 * "What this project still needs" (M53 R9), extracted out of `OrganizationClient` (M61 R7/Task 6)
 * so the Team tab can render the same block: every capability with a ready task and nobody to give
 * it to, each with the staffing-preference control and any pending Supervisor proposal answerable
 * in place, plus the count of proposals answered elsewhere. Its own `busyId`/`errors` state --
 * `OrganizationClient` used to own both for exactly this block and now owns neither, because this
 * component is reachable from two pages (`/organization`'s redirect target and the Team tab) that
 * do not share React state.
 *
 * `onChanged` is what a caller with no live stream (`OrganizationClient`, which `/organization`'s
 * own docstring says publishes no `shellFacts`) uses to refetch; the Team tab's `useTeamLive` has
 * an `EventSource` that wakes on the very event a decision write appends, so its `onChanged` is a
 * no-op (the same "no `onRefresh`" rule `NeedsYouCard`'s own docstring states).
 *
 * `null` (renders nothing) when there is nothing to say -- no need and no proposal waiting
 * elsewhere -- the same "silence beats noise" rule `RunbookPanel` follows.
 */
export function OrganizationNeeds({
  workspaceId,
  needs,
  pendingElsewhere,
  templates,
  taskTitles,
  hints,
  names,
  onChanged,
}: {
  readonly workspaceId: string
  readonly needs: OrganizationView['needs']
  readonly pendingElsewhere: number
  readonly templates: OrganizationView['templates']
  readonly taskTitles: OrganizationView['taskTitles']
  /** The collaboration hints (M61 R7, controller Ruling 4): folded into this component rather than
   *  kept as their own top-level section, so "what this project still needs" and "who to consult
   *  about it" stay adjacent wherever this renders. `names` is the `slaveId -> name` lookup the
   *  hint's byline resolves off (the same one `OrganizationPreferences` takes). */
  readonly hints: OrganizationView['hints']
  readonly names: Readonly<Record<string, string>>
  readonly onChanged: () => void
}): React.JSX.Element | null {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})

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
    onChanged()
  }

  if (needs.length === 0 && pendingElsewhere === 0 && hints.length === 0) return null

  return (
    <>
    <Panel title="what this project still needs">
      {needs.length > 0 && (
        <div data-testid="organization-needs" className="flex flex-col gap-3">
          {needs.map((need) => (
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
                templates={templates}
                preference={need.preference}
                onChanged={onChanged}
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
                    taskTitles={taskTitles}
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
      {pendingElsewhere > 0 && (
        <span data-testid="organization-pending-elsewhere" className="text-xs text-text-3">
          {plural(pendingElsewhere, 'staffing proposal')}{' '}
          {pendingElsewhere === 1 ? 'is' : 'are'} waiting on the Overview: the gap each was
          made about is no longer one.
        </span>
      )}
    </Panel>
    {hints.length > 0 && (
      <Panel>
        {/* Folded once there is more than a handful (fix round 1, minor 6): a persona may carry
          * thirty handoff sentences, and thirty of them under a roster of three is a page about
          * advice. `DetailsGroup` renders its children only while open, which is exactly the
          * behaviour wanted here -- nothing below is fetched or measured. */}
        <DetailsGroup group="collaboration" title="Who to consult" defaultOpen={hints.length <= ADVICE_OPEN_MAX}>
          <ul className="flex flex-col gap-1">
            {hints.map((hint, index) => (
              <li
                key={`${hint.slaveId}-${String(index)}`}
                data-testid="organization-hint"
                data-capability={hint.capability ?? ''}
                className="flex flex-col gap-0.5"
              >
                <span className="font-mono text-[10px] text-text-3">
                  {nameOf(hint.slaveId, names)}
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
    </>
  )
}

/**
 * "What this project is covered for" (M53 plan decision D36), extracted alongside
 * `OrganizationNeeds` (M61 R7/Task 6) for the same reason: a person's most likely reason to ask for
 * somebody is that the current holder is not working out, and a capability WITH a holder carries no
 * need row at all, so the staffing-preference control has to sit here too, not only on the need
 * rows above.
 *
 * `names` is a `slaveId -> name` lookup rather than the full `OrganizationRow[]` `nameOf` used to
 * close over: the Team tab has no `OrganizationRow[]` of its own (`TeamLiveRow[]` is a different
 * shape), and a lookup is the one thing both callers can build off what they already have.
 *
 * `null` when nothing is covered -- an empty list here would be a panel affirming a fact by drawing
 * an empty box around it (`docs/ia.md` rule 2).
 */
export function OrganizationPreferences({
  workspaceId,
  covered,
  templates,
  names,
  onChanged,
}: {
  readonly workspaceId: string
  readonly covered: OrganizationView['covered']
  readonly templates: OrganizationView['templates']
  readonly names: Readonly<Record<string, string>>
  readonly onChanged: () => void
}): React.JSX.Element | null {
  if (covered.length === 0) return null
  return (
    <Panel title="what this project is covered for">
      {/* D36: the control sits here TOO, and not only on the need rows -- a person's most
        * likely reason to ask for somebody is that the current holder is not working out, and
        * a capability with a holder has no need row at all. */}
      <ul data-testid="organization-covered" className="flex flex-col gap-1.5">
        {covered.map((one) => (
          <li key={one.capability} className="flex flex-wrap items-center gap-2">
            <Chip title={one.capability} tone="done">
              {one.label} · {nameOf(one.by, names)}
            </Chip>
            <StaffingPreferenceControl
              workspaceId={workspaceId}
              capability={one.capability}
              capabilityLabel={one.label}
              templates={templates}
              preference={one.preference}
              onChanged={onChanged}
            />
          </li>
        ))}
      </ul>
    </Panel>
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

/** A worker's name off the `names` lookup `OrganizationPreferences` was handed, and the id itself
 *  when it is not in it -- which is findable, rather than a name this component would have to
 *  invent. */
function nameOf(slaveId: string, names: Readonly<Record<string, string>>): string {
  return names[slaveId] ?? slaveId
}
