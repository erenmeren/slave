import { loadGoalReport, refusalText } from '@slave-of-ai/control'
import { GoalReportView } from '../../../../../components/project/GoalReportView'

export const dynamic = 'force-dynamic'

/** One goal version's report (Conductor Plan 5, spec R10, plan D9). Not a tab: reached from the
 *  Team page's Goal stat, from the Supervisor's note when the version came to rest, and from the
 *  version links on the page itself. The route stays put in both modes (`docs/ia.md` rule 2). A
 *  version that is not a positive whole number, an unknown project and an unknown version each get
 *  a sentence, never a thrown page. */
export default async function GoalReportPage({
  params,
}: {
  params: Promise<{ workspaceId: string; version: string }>
}): Promise<React.JSX.Element> {
  const { workspaceId, version } = await params
  if (!/^[1-9]\d{0,8}$/u.test(version)) {
    return (
      <div data-testid="goal-report-missing" className="p-6 text-tone-blocked">
        goal version “{version}” is not a positive whole number
      </div>
    )
  }
  const report = await loadGoalReport(workspaceId, Number(version))
  if (!report.ok) {
    return (
      <div data-testid="goal-report-missing" className="p-6 text-tone-blocked">
        {refusalText(report.error)}
      </div>
    )
  }
  // Keyed so a client-side navigation between versions or projects remounts rather than reusing
  // the old report's scroll position under the new URL.
  return <GoalReportView key={`${workspaceId}:${version}`} report={report.value} />
}
