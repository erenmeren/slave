'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ArchiveIcon, CircleStopIcon, EllipsisIcon, FileTextIcon, PlayIcon, SettingsIcon, Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'
import { phaseIsActive, projectPhaseSentence } from '@slave-of-ai/domain'
import type { ProjectView } from '@slave-of-ai/control'
import { DeleteProjectDialog } from '@/components/app/DeleteProjectDialog'
import { PhaseBadge } from '@/components/app/phase'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { usePoll } from '@/hooks/usePoll'
import { api } from '@/lib/api'
import { DecisionCard } from './DecisionCard'
import { GoalSection } from './GoalSection'
import { OlderTasks } from './OlderTasks'
import { ProofSection } from './ProofSection'
import { ResultSection } from './ResultSection'
import { SettingsSheet } from './SettingsSheet'
import { SideColumn } from './SideColumn'
import { WhoIsWorking } from './WhoIsWorking'

/** Lead UX design U-9: 3 seconds while something runs, 15 otherwise. */
export function projectPollMs(project: ProjectView): number {
  return phaseIsActive(project.phase) ? 3_000 : 15_000
}

/** Stop is offered while something runs or waits to run; Continue while the project is stopped. */
export function headerAction(project: ProjectView): 'stop' | 'continue' | null {
  if (project.flow === 'packages' || project.archived) return null
  if (project.phase === 'paused' || project.phase === 'failed') return 'continue'
  if (phaseIsActive(project.phase)) return 'stop'
  return null
}

/**
 * Lead UX design section 6.3: what is happening to this project, and does it need me? One screen,
 * no tabs: the header with Stop or Continue, the decision card when the person is needed, what
 * was asked for, who is working, the proof and the result, beside Limits, Builds and Notes.
 */
export function ProjectScreen({ initial }: { readonly initial: ProjectView }): React.JSX.Element {
  const router = useRouter()
  const { data: polled, error, refresh } = usePoll<{ readonly project: ProjectView }>(`/api/w/${initial.id}/project`, { project: initial }, (data) => projectPollMs(data.project))
  const project = polled.project
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [busy, setBusy] = useState(false)
  const action = headerAction(project)
  const build = project.build
  const lead = project.flow === 'lead'

  const stop = async (): Promise<void> => {
    setBusy(true)
    const result = await api(`/api/w/${project.id}/emergency-stop`, { method: 'POST' })
    setBusy(false)
    if (result.ok) toast.success('Stopped. Everything running is being paused.')
    else toast.error(result.error)
    await refresh()
  }

  const resume = async (): Promise<void> => {
    setBusy(true)
    const result = await api<{ requested: readonly string[] }>(`/api/w/${project.id}/continue`, { method: 'POST' })
    setBusy(false)
    if (result.ok) toast.success(result.data.requested.length === 0 ? 'Continuing.' : `Continuing: ${String(result.data.requested.length)} paused session(s) resume.`)
    else toast.error(result.error)
    await refresh()
  }

  const archive = async (): Promise<void> => {
    const result = await api(`/api/w/${project.id}/archive`, { method: 'POST' })
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(`${project.name} is archived. Restore it from Projects.`)
    router.push('/')
  }

  const working = project.phase === 'starting' || project.phase === 'building' || project.phase === 'checking' || project.phase === 'paused'

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-4 py-6 md:px-8" data-testid="project-screen" data-phase={project.phase}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{project.name}</h1>
            <PhaseBadge phase={project.phase} />
            {project.archived && <span className="text-sm text-muted-foreground">Archived</span>}
          </div>
          <p data-testid="phase-sentence" className="mt-1 text-sm text-muted-foreground">
            {projectPhaseSentence(project.phase, { baseBranch: project.baseBranch, haltedReason: project.haltedReason })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {action === 'stop' && (
            <Button variant="outline" className="border-destructive/50 text-destructive hover:bg-destructive/10" disabled={busy} onClick={() => void stop()} data-testid="stop">
              <CircleStopIcon />
              Stop
            </Button>
          )}
          {action === 'continue' && (
            <Button disabled={busy} onClick={() => void resume()} data-testid="continue">
              <PlayIcon />
              Continue
            </Button>
          )}
          <Button variant="outline" onClick={() => setSettingsOpen(true)} data-testid="open-settings">
            <SettingsIcon />
            Settings
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More" data-testid="more">
                <EllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {build !== null && (
                <DropdownMenuItem asChild>
                  <Link href={`/w/${project.id}/goals/${String(build.version)}`}>
                    <FileTextIcon />
                    Open the full report
                  </Link>
                </DropdownMenuItem>
              )}
              {!project.archived && (
                <DropdownMenuItem onSelect={() => void archive()}>
                  <ArchiveIcon />
                  Archive
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)} data-testid="more-delete">
                <Trash2Icon />
                Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {error !== null && (
        <Alert>
          <AlertDescription>Could not refresh this project ({error}). Retrying…</AlertDescription>
        </Alert>
      )}

      {project.phase === 'failed' && (
        <Alert variant="destructive" data-testid="failed-alert">
          <AlertTitle>Slave stopped this project</AlertTitle>
          <AlertDescription>{project.haltedReason ?? 'No reason was recorded.'} Fix what it says, then press Continue.</AlertDescription>
        </Alert>
      )}

      <DecisionCard project={project} onDone={refresh} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-6">
          <GoalSection project={project} onDone={refresh} />
          {lead && working && <WhoIsWorking build={build} paused={project.phase === 'paused'} />}
          {lead && build !== null && <ProofSection build={build} />}
          {lead && <ResultSection project={project} />}
          <OlderTasks project={project} />
        </div>
        <SideColumn project={project} onOpenSettings={() => setSettingsOpen(true)} />
      </div>

      <SettingsSheet project={project} open={settingsOpen} onOpenChange={setSettingsOpen} onDone={refresh} />
      <DeleteProjectDialog project={project} open={deleting} onOpenChange={setDeleting} onDeleted={() => router.push('/')} />
    </div>
  )
}
