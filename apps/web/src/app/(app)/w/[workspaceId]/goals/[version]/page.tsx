import Link from 'next/link'
import { loadGoalReport } from '@slave-of-ai/control'
import { ReportView } from '@/components/report/ReportView'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

/** Lead UX design section 6.4: one build's report. A build number that is not a whole number, an
 *  unknown project and an unknown build each get a sentence, never a thrown page. */
export default async function ReportPage({ params }: { params: Promise<{ workspaceId: string; version: string }> }): Promise<React.JSX.Element> {
  const { workspaceId, version } = await params
  const report = /^[1-9]\d{0,8}$/u.test(version) ? await loadGoalReport(workspaceId, Number(version)) : null
  if (report === null || !report.ok) {
    return (
      <div className="mx-auto flex max-w-xl flex-col items-start gap-3 px-4 py-16 md:px-8" data-testid="report-missing">
        <h1 className="text-xl font-semibold">There is no report here</h1>
        <p className="text-sm text-muted-foreground">This build does not exist, or its project was deleted.</p>
        <Button asChild variant="outline">
          <Link href={`/w/${workspaceId}`}>Back to the project</Link>
        </Button>
      </div>
    )
  }
  return <ReportView key={`${workspaceId}:${version}`} report={report.value} />
}

export const metadata = { title: 'Report · Slave of AI' }
