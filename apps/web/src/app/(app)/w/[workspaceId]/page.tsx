import Link from 'next/link'
import { projectView } from '@slave-of-ai/control'
import { ProjectScreen } from '@/components/project/ProjectScreen'
import { viewOf } from '@/components/project/views'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

/** Lead UX design section 6.3: one project, one screen. `?view=diagram` or `?view=timeline` opens
 *  it on that view. */
export default async function ProjectPage({ params, searchParams }: { params: Promise<{ workspaceId: string }>; searchParams: Promise<{ view?: string | string[] }> }): Promise<React.JSX.Element> {
  const { workspaceId } = await params
  const { view } = await searchParams
  const project = await projectView(workspaceId)
  if (!project.ok) {
    return (
      <div className="mx-auto flex max-w-xl flex-col items-start gap-3 px-4 py-16 md:px-8" data-testid="project-not-found">
        <h1 className="text-xl font-semibold">There is no project here</h1>
        <p className="text-sm text-muted-foreground">It may have been deleted.</p>
        <Button asChild variant="outline">
          <Link href="/">Back to Projects</Link>
        </Button>
      </div>
    )
  }
  // Keyed so moving from one project to another remounts the screen instead of showing the old
  // project's state under the new URL until the next read.
  return <ProjectScreen key={workspaceId} initial={project.value} view={viewOf(view)} />
}

export async function generateMetadata({ params }: { params: Promise<{ workspaceId: string }> }): Promise<{ title: string }> {
  const { workspaceId } = await params
  const view = await projectView(workspaceId)
  return { title: view.ok ? `${view.value.name} · Slave of AI` : 'Slave of AI' }
}
