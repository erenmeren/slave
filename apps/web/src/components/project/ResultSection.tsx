import Link from 'next/link'
import { FileTextIcon } from 'lucide-react'
import type { ProjectView } from '@slave-of-ai/control'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

/** The Result section's sentence (design section 6.3), or null when there is no result to tell. */
export function resultSentence(project: ProjectView): string | null {
  const build = project.build
  if (build === null) return null
  if (project.phase === 'delivered' || build.mergedAt !== null) {
    const when = build.mergedAt === null ? '' : ` on ${new Date(build.mergedAt).toLocaleDateString()}`
    const at = build.mergeCommit === null ? '' : ` at ${build.mergeCommit.slice(0, 7)}`
    return `Merged into ${project.baseBranch}${at}${when}.`
  }
  if (project.phase === 'ready_to_merge') return 'Waiting for your merge.'
  if (project.phase === 'closed') return `Left unmerged. The branch ${build.branch} is kept.`
  return null
}

/** Lead UX design section 6.3, "Result": what came of the newest build, and its full report. */
export function ResultSection({ project }: { readonly project: ProjectView }): React.JSX.Element | null {
  const sentence = resultSentence(project)
  if (sentence === null || project.build === null) return null
  return (
    <Card data-testid="result">
      <CardHeader>
        <CardTitle className="text-base">Result</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm">{sentence}</p>
        <Button asChild variant="outline" size="sm">
          <Link href={`/w/${project.id}/goals/${String(project.build.version)}`}>
            <FileTextIcon />
            Open the full report
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}
