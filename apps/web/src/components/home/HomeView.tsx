'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { ArchiveRestoreIcon, ChevronRightIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'
import { STOP_REASON_WORDS, projectPhaseSentence } from '@slave-of-ai/domain'
import type { ProjectListItem, ProjectView } from '@slave-of-ai/control'
import { DeleteProjectDialog } from '@/components/app/DeleteProjectDialog'
import { LimitBar } from '@/components/app/LimitBar'
import { PhaseBadge } from '@/components/app/phase'
import { DecisionCard } from '@/components/project/DecisionCard'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { usePoll } from '@/hooks/usePoll'
import { api, notifyProjectsChanged } from '@/lib/api'
import { formatAgo, formatUsd, percentOf, plural, spendLine } from '@/lib/format'

/** How often Home re-reads (lead UX design U-9). */
export const HOME_POLL_MS = 10_000

/** The one line "Waiting for you" says about a waiting project (design section 6.1). */
export function waitingReason(project: ProjectListItem): string {
  if (project.flow === 'packages') return 'A decision is waiting. Answer it from the command line: supervisor-decisions.'
  if (project.phase === 'ready_to_merge') return 'Ready to merge.'
  return project.stopReason === null ? 'The build stopped before everything was proven.' : STOP_REASON_WORDS[project.stopReason]
}

/**
 * A waiting lead build, answerable where it is listed: the project's own decision card, read once
 * and again after an answer. Until it is read, or for anything the card does not answer, the row
 * with its Open link stands.
 */
function WaitingDecision({ project, onAnswered, children }: { readonly project: ProjectListItem; readonly onAnswered: () => Promise<void>; readonly children: React.ReactNode }): React.JSX.Element {
  const [view, setView] = useState<ProjectView | null>(null)
  const read = useCallback(async (): Promise<void> => {
    const result = await api<{ readonly project: ProjectView }>(`/api/w/${project.id}/project`)
    if (result.ok) setView(result.data.project)
  }, [project.id])
  useEffect(() => {
    void read()
  }, [read, project.phase])
  const answerable = view !== null && view.build !== null && (view.phase === 'needs_decision' || view.phase === 'ready_to_merge')
  if (!answerable) return <>{children}</>
  return (
    <div data-testid="waiting-decision" className="flex flex-col gap-2 py-3">
      <Link href={`/w/${project.id}`} className="text-sm font-semibold hover:underline">
        {project.name}
      </Link>
      <DecisionCard
        project={view}
        onDone={async () => {
          await read()
          await onAnswered()
        }}
      />
    </div>
  )
}

function Figure({ id, label, value, detail }: { readonly id: string; readonly label: string; readonly value: string; readonly detail: string }): React.JSX.Element {
  return (
    <div data-testid={`home-${id}`} className="flex min-w-0 flex-col gap-1 rounded-lg border bg-card p-3">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
      <span className="text-xl font-semibold tabular-nums">{value}</span>
      <span className="truncate text-xs text-muted-foreground" title={detail}>{detail}</span>
    </div>
  )
}

/**
 * Lead UX design section 6.1: is anything waiting for me, and how are my projects doing? Waiting
 * builds first, under an amber border; then one card per project; then the archived ones, folded.
 */
export function HomeView({ initial }: { readonly initial: readonly ProjectListItem[] }): React.JSX.Element {
  const { data, error, refresh } = usePoll<{ readonly projects: readonly ProjectListItem[] }>('/api/projects', { projects: initial }, () => HOME_POLL_MS)
  const [deleting, setDeleting] = useState<ProjectListItem | null>(null)
  const live = data.projects.filter((project) => !project.archived)
  const archived = data.projects.filter((project) => project.archived)
  const waiting = live.filter((project) => project.waiting > 0)
  const busy = live.filter((project) => project.workingNow > 0)
  const workingNow = live.reduce((total, project) => total + project.workingNow, 0)
  const totalSpent = live.reduce((total, project) => total + project.totalSpentUsd, 0)

  const restore = async (project: ProjectListItem): Promise<void> => {
    const result = await api(`/api/w/${project.id}/restore`, { method: 'POST' })
    if (result.ok) toast.success(`${project.name} is back in the list`)
    else toast.error(result.error)
    notifyProjectsChanged()
    await refresh()
  }

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-4 py-8 md:px-8" data-testid="home">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <Button asChild>
          <Link href="/new">
            <PlusIcon />
            New project
          </Link>
        </Button>
      </div>

      {error !== null && (
        <Alert data-testid="home-error">
          <AlertDescription>Could not load your projects. Retrying…</AlertDescription>
        </Alert>
      )}

      {live.length === 0 && archived.length === 0 ? (
        <Card className="items-center py-14 text-center" data-testid="home-empty">
          <CardHeader className="w-full max-w-md justify-items-center">
            <CardTitle className="text-lg">No projects yet.</CardTitle>
            <CardDescription>Describe what you want built, and a lead builds it while Slave checks the result.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/new">
                <PlusIcon />
                New project
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {live.length > 0 && (
        <section data-testid="home-figures" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Figure id="working" label="Working now" value={plural(workingNow, 'person', 'people')} detail={busy.length === 0 ? 'Nothing is running' : `on ${busy.map((project) => project.name).join(', ')}`} />
          <Figure id="waiting" label="Waiting for you" value={String(waiting.length)} detail={waiting.length === 0 ? 'Nothing needs you' : waiting.map((project) => project.name).join(', ')} />
          <Figure id="spent" label="Spent in all" value={`${live.some((project) => project.spendUnmeasured) ? 'at least ' : ''}${formatUsd(totalSpent)}`} detail={`across ${plural(live.length, 'project')}`} />
          <Figure id="projects" label="Projects" value={String(live.length)} detail={`${String(busy.length)} running · ${String(archived.length)} archived`} />
        </section>
      )}

      {waiting.length > 0 && (
        <section aria-labelledby="waiting-heading" data-testid="waiting" className="rounded-xl border-2 border-warning/60 bg-warning-muted/60 p-4">
          <h2 id="waiting-heading" className="mb-3 text-sm font-semibold text-warning-foreground">
            Waiting for you
          </h2>
          <ul className="flex flex-col divide-y divide-warning/30">
            {waiting.map((project) => (
              <li key={project.id}>
              <WaitingDecision project={project} onAnswered={refresh}>
              <div data-testid="waiting-item" className="flex flex-wrap items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="font-medium">{project.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {waitingReason(project)}
                    {project.waitingSince !== null && <span suppressHydrationWarning> · waiting {formatAgo(project.waitingSince).replace(' ago', '')}</span>}
                  </p>
                </div>
                <Button asChild size="sm">
                  <Link href={`/w/${project.id}`}>
                    Open
                    <ChevronRightIcon />
                  </Link>
                </Button>
              </div>
              </WaitingDecision>
              </li>
            ))}
          </ul>
        </section>
      )}

      {live.length > 0 && (
        <section aria-label="Your projects" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {live.map((project) => (
            <Link key={project.id} href={`/w/${project.id}`} data-testid="project-card" data-phase={project.phase} className="group min-w-0 rounded-xl focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
              <Card className="h-full min-w-0 gap-3 transition-colors group-hover:border-primary/40">
                <CardHeader className="min-w-0 gap-2">
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <CardTitle className="min-w-0 truncate text-base" title={project.name}>{project.name}</CardTitle>
                    <PhaseBadge phase={project.phase} />
                  </div>
                  <CardDescription className="line-clamp-2">{projectPhaseSentence(project.phase, { baseBranch: project.baseBranch, haltedReason: project.haltedReason })}</CardDescription>
                </CardHeader>
                <CardContent className="mt-auto flex flex-col gap-2 text-sm">
                  {project.workingNow > 0 && (
                    <p data-testid="card-working" className="truncate text-info-foreground" title={project.doing ?? undefined}>
                      {plural(project.workingNow, 'person', 'people')} working{project.doing === null ? '' : ` · ${project.doing}`}
                    </p>
                  )}
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Spent {spendLine(project.spentUsd, project.spendUnmeasured, project.budgetUsd)}</span>
                    <span suppressHydrationWarning>updated {formatAgo(project.updatedAt)}</span>
                  </div>
                  <LimitBar percent={percentOf(project.spentUsd, project.budgetUsd)} label="Spent of the budget" />
                </CardContent>
              </Card>
            </Link>
          ))}
        </section>
      )}

      {archived.length > 0 && (
        <Collapsible data-testid="archived">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="text-muted-foreground">
              Archived ({archived.length})
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 flex flex-col divide-y rounded-lg border">
              {archived.map((project) => (
                <li key={project.id} data-testid="archived-item" className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                  <span className="truncate">{project.name}</span>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => void restore(project)}>
                      <ArchiveRestoreIcon />
                      Restore
                    </Button>
                    <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setDeleting(project)}>
                      <Trash2Icon />
                      Delete…
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}

      {deleting !== null && (
        <DeleteProjectDialog
          project={deleting}
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(null)
          }}
          onDeleted={() => void refresh()}
        />
      )}
    </div>
  )
}
