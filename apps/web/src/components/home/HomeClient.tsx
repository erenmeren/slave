'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { useHome } from '../../hooks/useHome'
import { formatUsd } from '../../lib/realMoney'
import { postControl } from '../../lib/postControl'
import type { HomeSnapshot } from '../../server/home'
import { KpiStrip } from '../analytics/KpiStrip'
import type { CompanyRow } from '../CompanyManager'
import { useMode } from '../mode/ModeProvider'
import { NeedsYouRow } from '../project/NeedsYouBar'
import { NewProjectDrawer } from '../projects/NewProjectDrawer'
import { useHeaderAction } from '../shell/HeaderActionProvider'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Panel } from '../ui/Panel'
import { ScrollArea } from '../ui/ScrollArea'
import { Stat } from '../ui/Stat'
import { HappeningFeed } from './HappeningFeed'
import { ProjectRowItem } from './ProjectRowItem'

/** `Hello` on the server and on the first client render (both produce the same markup, so no
 *  hydration mismatch); the local time-of-day word arrives one effect later, client-only -- the
 *  server has no timezone to say "morning" with. */
function timeGreeting(hour: number): string {
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function useGreeting(): string {
  const [greeting, setGreeting] = useState('Hello')
  useEffect((): void => {
    setGreeting(timeGreeting(new Date().getHours()))
  }, [])
  return greeting
}

/**
 * Home (M61 R11, Task 8): a project list beside a live feed, replacing the deleted
 * `ProjectsClient` card grid. `initial` is `app/page.tsx`'s own `buildHomeSnapshot()` read;
 * `useHome` keeps it current with a poll while the tab is visible (`hooks/useHome.ts`).
 *
 * `?new=1` and `?archived=1` are the SAME two query params `ProjectsClient` round-tripped
 * (nothing removed, only moved): `newOpen` is local state so a click opens the Sheet
 * synchronously even under a router that has not echoed the URL back yet, seeded from and kept in
 * sync with the param; `archived` is read straight off `searchParams`, same as `show-archived`
 * always was.
 */
export function HomeClient({
  initial,
  companies,
}: {
  readonly initial: HomeSnapshot
  readonly companies: readonly CompanyRow[]
}): React.JSX.Element {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { isDeveloper } = useMode()
  const greeting = useGreeting()

  const archived = searchParams.get('archived') === '1'
  const snapshot = useHome(initial, archived)
  const { projects, needsYou, feed, numbers, kpis } = snapshot

  const [newOpen, setNewOpen] = useState(searchParams.get('new') === '1')
  const [busyDecisionId, setBusyDecisionId] = useState<string | null>(null)
  const [needsYouError, setNeedsYouError] = useState<string | null>(null)

  // The header's primary action (M57 R7's idiom): a `Button`, not a bare `<button>`, PUSHED
  // through the URL rather than local-state-only -- the SAME `?new=1` mechanism
  // `ProjectSwitcher.tsx`'s own `new-project` row already drives, so the Sheet has exactly one way
  // to be asked open rather than two that can drift apart.
  //
  // Deliberately NOT dependent on `searchParams` (`window.location.search` is read instead, at
  // click time): `useHeaderAction`'s effect re-fires whenever THIS callback's identity changes,
  // and a fresh `URLSearchParams` in the dependency array -- unavoidable, since a hook result is a
  // new value each call by definition -- would re-run that effect, and therefore re-publish the
  // header's node, on every single render.
  const openNew = useCallback((): void => {
    setNewOpen(true)
    const query = new URLSearchParams(window.location.search)
    query.set('new', '1')
    router.push(`/?${query.toString()}`)
  }, [router])
  useHeaderAction(
    <Button variant="primary" data-testid="new-project" onClick={openNew}>
      + New project
    </Button>,
    [openNew],
  )

  const closeNew = useCallback((): void => {
    setNewOpen(false)
    // Ruled minor (M24 final review, carried over): `?new=1` opened the Sheet on load -- closing
    // it without dropping the param would reopen it on the next reload. MERGED into the current
    // query (ruling R13), so `?archived=1` beside it survives the close.
    if (searchParams.get('new') === '1') {
      const query = new URLSearchParams(searchParams)
      query.delete('new')
      const search = query.toString()
      router.replace(search === '' ? '/' : `/?${search}`)
    }
  }, [searchParams, router])

  const toggleArchived = useCallback(
    (checked: boolean): void => {
      const query = new URLSearchParams(searchParams)
      if (checked) query.set('archived', '1')
      else query.delete('archived')
      const search = query.toString()
      router.replace(search === '' ? '/' : `/?${search}`)
    },
    [searchParams, router],
  )

  const answerNeedsYou = async (decisionId: string, verdict: 'approve' | 'reject'): Promise<void> => {
    const item = needsYou.find((row) => row.decisionId === decisionId)
    if (item === undefined) return
    setBusyDecisionId(decisionId)
    setNeedsYouError(null)
    const result = await postControl(`/api/w/${item.workspaceId}/supervisor/decisions/${decisionId}/${verdict}`)
    setBusyDecisionId(null)
    if (!result.ok) {
      setNeedsYouError(result.error)
      return
    }
    router.refresh()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[var(--gap-2)] p-[var(--gap-3)]">
      <header data-testid="home-greeting">
        <h1 className="type-display">{greeting}</h1>
        <p className="type-meta text-t2">
          {projects.length} projects · {numbers.peopleWorking} people working · {formatUsd(numbers.spendUsd)} spent
        </p>
      </header>

      {needsYou.length > 0 && (
        <section
          data-testid="home-needs-you"
          className="rounded-surface border border-accent/35 bg-accent/10 px-3.5 py-2.5"
        >
          {needsYouError !== null && (
            <p role="alert" data-testid="needs-you-error" className="type-meta mb-[var(--gap-1)] text-s-blocked">
              {needsYouError}
            </p>
          )}
          {/* I2 (final-review wave): unbounded, this list grows past Home's own `overflow-hidden`
            * frame -- `30dvh` caps it and the list scrolls inside itself instead. */}
          <ScrollArea className="flex flex-col gap-[var(--gap-1)] max-h-[30dvh]">
            {needsYou.map((item) => (
              <NeedsYouRow
                key={`${item.workspaceId}-${item.kind}-${item.id}`}
                item={item}
                workspaceName={item.workspaceName}
                busy={busyDecisionId}
                onAnswer={(decisionId, verdict) => void answerNeedsYou(decisionId, verdict)}
              />
            ))}
          </ScrollArea>
        </section>
      )}

      <div className="flex items-center justify-between">
        <h2 className="type-label">Projects</h2>
        <label className="flex items-center gap-[6px] text-[13px] text-t2">
          <input
            type="checkbox"
            data-testid="show-archived"
            checked={archived}
            onChange={(event) => toggleArchived(event.target.checked)}
          />
          show archived
        </label>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_300px] gap-[var(--gap-2)]">
        <ScrollArea testId="home-projects">
          {projects.length === 0 ? (
            <EmptyState testId="home-projects-empty" message="no projects yet" />
          ) : (
            <div className="flex flex-col gap-1">
              {projects.map((project) => (
                <ProjectRowItem key={project.id} project={project} companies={companies} />
              ))}
            </div>
          )}
        </ScrollArea>
        <HappeningFeed items={feed} />
      </div>

      <div data-testid="home-numbers" className="flex gap-[var(--gap-2)]">
        <Stat
          testId="stat-people"
          label="People"
          value={`${numbers.peopleWorking} working`}
          note={`${numbers.peopleIdle} idle`}
          {...(numbers.peopleWorking > 0 ? { tone: 'working' as const } : {})}
        />
        <Stat
          testId="stat-spend"
          label="Spend"
          value={formatUsd(numbers.spendUsd)}
          note={numbers.unmeasured ? 'some runs unmeasured' : undefined}
          unmeasured={numbers.unmeasured}
        />
        <Stat testId="stat-finished" label="Finished this week" value={String(numbers.finishedThisWeek)} note="tasks" />
      </div>

      {isDeveloper && (
        <section data-testid="all-projects-analytics" className="flex flex-col gap-4">
          <Panel
            title="across every project"
            action={
              <Link href="/analytics" className="text-[10px] text-text-3 hover:text-text-1">
                all →
              </Link>
            }
          >
            <KpiStrip kpis={kpis} />
          </Panel>
        </section>
      )}

      <NewProjectDrawer open={newOpen} onClose={closeNew} />
    </div>
  )
}
