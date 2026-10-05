'use client'

import { useEffect, useRef, useState } from 'react'
import type { ProjectDiagram, ProjectView } from '@slave-of-ai/control'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { usePoll } from '@/hooks/usePoll'
import { plural } from '@/lib/format'
import { NodeSheet } from './NodeSheet'
import { TeamDiagram, type DiagramSubject } from './TeamDiagram'
import { Timeline } from './Timeline'

function Plain({ id, title, children }: { readonly id: string; readonly title: string; readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <Card data-testid={id}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{children}</CardDescription>
      </CardHeader>
    </Card>
  )
}

/**
 * The Project screen's Diagram and Timeline views: one read of the newest build, re-read on the
 * screen's own cadence (`pollMs`: 3 seconds while something runs), drawn as the team diagram or
 * as the timeline. An older project has no lead build and says so instead.
 */
export function DiagramView({ project, view, pollMs }: { readonly project: ProjectView; readonly view: 'diagram' | 'timeline'; readonly pollMs: number }): React.JSX.Element {
  // `usePoll` keeps the first interval function it is given; the cadence is read through a ref.
  const cadence = useRef(pollMs)
  cadence.current = pollMs
  const { data, error, refresh } = usePoll<{ readonly diagram: ProjectDiagram | null }>(`/api/w/${project.id}/diagram`, { diagram: null }, () => cadence.current)
  const [subject, setSubject] = useState<DiagramSubject | null>(null)
  // The poll's first read is one interval away: read once on opening.
  useEffect(() => {
    void refresh()
  }, [refresh])

  if (project.flow !== 'lead') {
    return (
      <Plain id="diagram-older" title="No diagram for this project">
        This project was built the older way, as a set of tasks handed to seats, and has no lead build to draw. Its tasks are listed in Overview.
      </Plain>
    )
  }
  const build = data.diagram?.build ?? null
  if (data.diagram === null) {
    return error === null ? (
      <Skeleton data-testid="diagram-loading" className="h-[460px] w-full rounded-lg" />
    ) : (
      <Alert>
        <AlertDescription>Could not read the diagram ({error}). Retrying…</AlertDescription>
      </Alert>
    )
  }
  if (build === null) {
    return (
      <Plain id="diagram-empty" title="Nothing to draw yet">
        No build has started. Ask for something in Overview and the people working on it appear here.
      </Plain>
    )
  }
  const people = build.nodes.filter((node) => node.kind === 'lead' || node.kind === 'helper' || node.kind === 'checker')
  if (people.length === 0) {
    return (
      <Plain id="diagram-empty" title="Nobody has started yet">
        Build {build.version} is getting ready. The lead appears here as soon as its first turn starts.
      </Plain>
    )
  }
  const working = people.filter((node) => node.state === 'working').length
  return (
    <div className="flex flex-col gap-4" data-testid="diagram-view" data-view={view}>
      {error !== null && (
        <Alert>
          <AlertDescription>Could not refresh the diagram ({error}). Retrying…</AlertDescription>
        </Alert>
      )}
      {view === 'diagram' ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Team</CardTitle>
            <CardDescription>
              Build {build.version}: {working} working now, {plural(people.length, 'person', 'people')} in all. Press a card for its sessions and steps.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TeamDiagram build={build} onSelect={setSubject} />
          </CardContent>
        </Card>
      ) : (
        <Timeline build={build} onSelect={setSubject} />
      )}
      <NodeSheet build={build} workspaceId={project.id} subject={subject} onClose={() => setSubject(null)} />
    </div>
  )
}
