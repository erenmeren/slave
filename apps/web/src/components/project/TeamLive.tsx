'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { SUPERVISOR_PER_CALL_CAP_USD } from '@slave-of-ai/domain'
import { useMode } from '../mode/ModeProvider'
import { useTeamLive } from '../../hooks/useTeamLive'
import { useSelectedId } from '../../hooks/useSelectedId'
import { useRightPanel } from '../shell/RightPanelProvider'
import type { TeamLiveSnapshot } from '../../server/teamLive'
import type { PersonDetail } from '../../server/persons'
import type { SlaveCardData } from '../../server/overview'
import type { AssignableProject } from '../persons/PersonProjectsGroup'
import { cardsOf, haltedReasonOf, liveSeatOf, personOf } from '../persons/liveSeat'
import { SlavePanel } from '../SlavePanel'
import { HaltBanner } from '../HaltBanner'
import { formatUsd } from '../../lib/realMoney'
import { Alert } from '../ui/Alert'
import { EmptyState } from '../ui/EmptyState'
import { LoadingState } from '../ui/LoadingState'
import { ScrollArea } from '../ui/ScrollArea'
import { Stat } from '../ui/Stat'
import { OrganizationAdd, OrganizationNeeds, OrganizationPreferences, OrganizationRoster } from '../organization/OrganizationClient'
import { TeamCard } from './TeamCard'

/**
 * The project's own page now (M61 R7/Task 6): the Team ROWS, live, plus the three facts the
 * deleted Overview's four-tile brief reduced to (goal, work, spend). Replaces
 * `components/OverviewClient.tsx`, which this milestone deletes.
 *
 * This is the ONLY page client that publishes `ShellFacts` on `/w/:id` now -- `useTeamLive` does
 * the publish/unpublish pair `OverviewClient.tsx:170-182` used to (Task 5's `TeamLiveSnapshot`
 * already carries a real `ShellFacts`, so there is nothing left to reshape client-side the way
 * `OverviewClient`'s own `useMemo` had to).
 */
export function TeamLive({
  workspaceId,
  initial,
  skillCatalogue = [],
  projects = [],
}: {
  readonly workspaceId: string
  readonly initial: TeamLiveSnapshot
  readonly skillCatalogue?: readonly { readonly skillId: string; readonly name: string; readonly providerName: string }[]
  readonly projects?: readonly AssignableProject[]
}): React.JSX.Element {
  const { snapshot, error } = useTeamLive(workspaceId, initial)
  const view = snapshot ?? initial
  const { mode, isDeveloper } = useMode()
  const router = useRouter()
  const [selectedSlaveId, selectSlave] = useSelectedId('slave')
  /** `slaveId -> name`, for `OrganizationPreferences`/`OrganizationNeeds`'s hints byline -- built
   *  off `TeamLiveSnapshot.workers` (scope-fix addition), the same source `OrganizationClient`'s
   *  own lookup reads. */
  const workerNames = useMemo(
    (): Readonly<Record<string, string>> => Object.fromEntries(view.workers.map((worker) => [worker.slaveId, worker.name])),
    [view.workers],
  )
  const selected =
    view.rows.find((row) => row.personId === selectedSlaveId) ??
    view.rows.find((row) => row.slaveId === selectedSlaveId) ??
    null

  const { open: openPanel, close: closePanel, mode: panelMode } = useRightPanel()

  // Ruling T3-4 / T5-1, copied off `OverviewClient.tsx:224-256` verbatim (the reasoning is
  // unchanged: the provider outlives this page, and only THIS page's own clearer may close a slot
  // it still owns).
  const selectedIdRef = useRef<string | null>(null)
  selectedIdRef.current = selected?.slaveId ?? null
  const mounted = useRef(true)
  const owned = useRef(false)
  useEffect((): (() => void) => {
    mounted.current = true
    return (): void => {
      mounted.current = false
      if (owned.current) closePanel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount and unmount only, see
    // `OverviewClient.tsx`'s own identical guard.
  }, [])

  // The `?slave=` → shell-panel mirror, copied off `OverviewClient.tsx:258-310`. THE DEPENDENCY
  // LIST IS `selected?.slaveId` AND NOTHING ELSE -- `view` changes identity on every SSE frame, and
  // an effect that re-`open()`s several times a second is an effect that fights the person who just
  // collapsed the panel.
  useEffect((): void => {
    if (selected === null) {
      if (panelMode === 'slave') closePanel()
      return
    }
    const openedFor = selected.slaveId
    openPanel(
      'slave',
      <TeamPersonSlot
        key={selected.slaveId}
        personId={selected.personId}
        slaveId={selected.slaveId}
        workspaceId={workspaceId}
        skillCatalogue={skillCatalogue}
        projects={projects}
        onClose={() => {
          selectSlave(null)
          closePanel()
        }}
      />,
      () => {
        owned.current = false
        if (mounted.current && selectedIdRef.current === openedFor) selectSlave(null)
      },
      openedFor,
    )
    owned.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed on the SELECTION
    // and not on the snapshot, see `OverviewClient.tsx`'s own identical note.
  }, [selected?.slaveId])

  return (
    <section data-testid="team-live" className="flex min-h-0 flex-1 flex-col gap-[var(--gap-2)] p-[var(--gap-3)]">
      {view.haltedReason !== null && <HaltBanner reason={view.haltedReason} />}
      {/* Review fix round 1, Important 6: carried off `OverviewClient.tsx`'s own band, same words,
        * same tone, no testid of its own -- the deleted page never gave it one, so this one does
        * not either; a test reads it by role/text the way that page's own test did. */}
      {error !== null && <Alert variant="notice">showing stale data: {error}</Alert>}
      {/* M33 §4, carried off `OverviewClient.tsx`'s own band: standing provenance, not a warning --
        * `role="status"`, the neutral surface, same as it always was. */}
      {view.adoptedFrom !== null && (
        <Alert variant="info" testId="ws-adopted-from">
          organisation adopted from simulation{' '}
          <Link href={`/sim/${view.adoptedFrom.simulationId}`} className="underline">
            {view.adoptedFrom.name}
          </Link>
        </Alert>
      )}
      <ScrollArea>
        {view.rows.length === 0 ? (
          <EmptyState testId="team-empty" message="nobody works here yet" />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-[var(--gap-2)]">
            {view.rows.map((row) => (
              <TeamCard key={row.slaveId} row={row} onOpen={selectSlave} />
            ))}
          </div>
        )}
        {/* Scope fix (M61 R7, controller Ruling 4): "Add somebody" is how an end user staffs a
          * project, in both modes. `onSeated` no-ops -- the live stream refetches this snapshot on
          * the `slave.assigned`-shaped event the seat write appends, the same rule every other
          * write on this page already follows. `onNewSlave` sends the person to `/workforce`
          * rather than opening a local drawer: that drawer needs `roster`/`templates`/`teams` in
          * shapes `TeamLiveSnapshot` cannot cheaply carry (`listRoster()` is an unscoped,
          * installation-wide read -- see `OrganizationAdd`'s own docstring). */}
        <OrganizationAdd
          workspaceId={workspaceId}
          pool={view.pool}
          teamId={view.teamId}
          onSeated={() => {
            /* the live stream refetches this snapshot on the event the write appends */
          }}
          onNewSlave={() => router.push('/workforce')}
        />
        {isDeveloper && <OrganizationRoster workers={view.workers} onOpen={(personId) => selectSlave(personId)} />}
        {mode === 'developer' && (
          <OrganizationPreferences
            workspaceId={workspaceId}
            covered={view.preferences}
            templates={view.templates}
            names={workerNames}
            onChanged={() => {
              /* the live stream refetches this snapshot on the event the write appends */
            }}
          />
        )}
        <OrganizationNeeds
          workspaceId={workspaceId}
          needs={view.needs}
          pendingElsewhere={view.pendingElsewhere}
          templates={view.templates}
          taskTitles={view.taskTitles}
          hints={view.hints}
          names={workerNames}
          onChanged={() => {
            /* the live stream refetches this snapshot on the event the write appends */
          }}
        />
      </ScrollArea>
      <div className="flex gap-[var(--gap-2)]">
        <Stat
          testId="stat-goal"
          label="Goal"
          value={
            // Review fix round 1, Important 8: clamped to two lines with the whole of it one
            // hover away, the same rule the deleted `OverviewClient.tsx`'s own goal line followed
            // -- `project-goal-line` is the testid `gate-m45-project-experience.mjs` reads it by
            // (Ruling 6), moved here rather than reinvented.
            <span
              data-testid="project-goal-line"
              {...(view.stats.goal === null ? {} : { title: view.stats.goal })}
              className="line-clamp-2"
            >
              {view.stats.goal ?? 'No goal yet'}
            </span>
          }
          note={
            // The VERSION, then the edit affordance (M61 Task 11, controller Ruling 9). The
            // deleted `ProjectBrief`'s objective tile printed `vN` beside the goal and
            // `gate-m45-project-experience.mjs` reads it; `data-goal-version` is where the gate
            // finds the raw number, the way `docs/ia.md` rule 3 asks (the word a person reads is
            // `v2`, the value a machine reads is on the attribute). Absent entirely when there is
            // no goal to version.
            <>
              {view.stats.goalVersion !== null && (
                <>
                  <span data-goal-version={String(view.stats.goalVersion)}>v{view.stats.goalVersion}</span>
                  {' · '}
                </>
              )}
              <Link data-testid="goal-edit" href={`/w/${workspaceId}/settings#goal`} className="text-accent">
                Edit goal
              </Link>
            </>
          }
        />
        <Stat
          testId="stat-work"
          label="Work"
          value={`${String(view.stats.inProgress)} in progress`}
          note={`${String(view.stats.done)} done`}
        />
        <Stat
          testId="stat-spend"
          label="Spend"
          value={formatUsd(view.shellFacts.status.spentUsd)}
          // M32's upper-bound policy, restored (M61 Task 11): a total that contains calls nobody
          // measured is an UPPER BOUND and has to say so -- never one bare figure. The deleted
          // `ProjectBrief`'s cost tile said it in these words and nothing said it after that tile
          // went; `gate-m45-project-experience.mjs`'s own needle for the sentence is what found
          // the hole. Unmeasured RUNS are a different hole and are named separately, because they
          // are in NO total at all (`server/brief.ts`'s own docstring makes the distinction).
          note={
            <>
              {view.shellFacts.guardrails.budgetUsd === null
                ? 'no budget'
                : `of ${formatUsd(view.shellFacts.guardrails.budgetUsd)}`}
              {view.stats.unmeasuredCalls > 0 && (
                <span data-testid="stat-spend-unmeasured-calls" className="block text-s-waiting">
                  {view.stats.unmeasuredCalls} unmeasured calls charged at {formatUsd(SUPERVISOR_PER_CALL_CAP_USD)} each
                </span>
              )}
              {view.stats.unmeasuredRuns > 0 && (
                <span data-testid="stat-spend-unmeasured-runs" className="block text-s-waiting">
                  {view.stats.unmeasuredRuns} unmeasured runs (not in the total)
                </span>
              )}
            </>
          }
          unmeasured={view.stats.unmeasuredCalls > 0 || view.stats.unmeasuredRuns > 0}
        />
      </div>
      {/* M49 R6, re-homed (M61 Task 11): "one line on the `latest verified` fact --
        * `Knowledge: N verified · M candidates`, linking to the tab". That fact's tile went with
        * the Overview; the project's page is the Team tab now, so the line is here. Developer
        * mode only, because Knowledge is a developer TAB (R18) and a link into a place simple
        * mode does not show is a link to nowhere a simple-mode person was heading. */}
      {isDeveloper && (
        <Link
          data-testid="brief-knowledge"
          href={`/w/${workspaceId}/knowledge`}
          className="type-meta text-t3 hover:text-t1"
        >
          Knowledge: {view.stats.knowledge.verified} verified · {view.stats.knowledge.candidates} candidates
        </Link>
      )}
    </section>
  )
}

/**
 * The right panel's content for a Team-card click (M61 R7/Task 6).
 *
 * `TeamLiveRow` is not `SlaveCardData` -- Task 5's row is deliberately a reduced, English-sentence
 * shape (`server/teamLive.ts`'s own docstring), not the panel's much wider read -- so this slot
 * fetches its own `SlaveCardData` off `/api/w/:id/overview`, the SAME two-request shape
 * `OrganizationClient.tsx`'s own person slot already uses for the identical problem (`liveSeatOf`
 * off `cardsOf`, both from `components/persons/liveSeat.ts`). `liveEvents={[]}` for the same reason
 * `OrganizationClient.tsx` passes it empty: this page's live feed is `useTeamLive`'s workspace
 * stream, not `useOverview`'s per-slave indexed one, and inventing a second index here to feed a
 * panel that already has its own polling is not this task's problem to solve.
 */
function TeamPersonSlot({
  personId,
  slaveId,
  workspaceId,
  skillCatalogue,
  projects,
  onClose,
}: {
  readonly personId: string
  readonly slaveId: string
  readonly workspaceId: string
  readonly skillCatalogue: readonly { readonly skillId: string; readonly name: string; readonly providerName: string }[]
  readonly projects: readonly AssignableProject[]
  readonly onClose: () => void
}): React.JSX.Element {
  const [person, setPerson] = useState<PersonDetail | null>(null)
  const [slave, setSlave] = useState<SlaveCardData | null>(null)
  const [haltedReason, setHaltedReason] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [personTick, setPersonTick] = useState(0)

  useEffect((): void => {
    setLoaded(false)
    // Review fix round 1, Important 7: BOTH fetches are caught now, and so is the `Promise.all`
    // itself -- the first fetch had no `.catch` at all, so a rejection (offline, a network error)
    // left the slot on `team-panel-loading` forever with an unhandled rejection behind it, instead
    // of the `team-panel-error` state that already existed for exactly this case.
    void Promise.all([
      fetch(`/api/persons/${personId}`)
        .then(async (response) => (response.ok ? ((await response.json()) as unknown) : null))
        .catch(() => null),
      fetch(`/api/w/${workspaceId}/overview`)
        .then(async (response) => (response.ok ? ((await response.json()) as unknown) : null))
        .catch(() => null),
    ])
      .then(([detail, snapshot]) => {
        setPerson(personOf(detail))
        setSlave(liveSeatOf(cardsOf(snapshot), slaveId, personId))
        setHaltedReason(haltedReasonOf(snapshot))
        setLoaded(true)
      })
      .catch(() => {
        setPerson(null)
        setLoaded(true)
      })
  }, [personId, slaveId, workspaceId, personTick])

  if (!loaded) return <LoadingState testId="team-panel-loading" message="opening this slave…" />
  if (person === null) return <EmptyState testId="team-panel-error" message="could not open this slave — they may have been deleted." />

  return (
    <SlavePanel
      slave={slave}
      person={person}
      skillCatalogue={skillCatalogue}
      projects={projects}
      liveEvents={[]}
      workspaceId={workspaceId}
      haltedReason={haltedReason}
      onClose={onClose}
      onPersonChanged={() => setPersonTick((tick) => tick + 1)}
    />
  )
}
