import { loadGoalReport, refusalText } from '@slave-of-ai/control'
import { renderGoalReportMarkdown } from '@slave-of-ai/domain'
import { requirePrincipal } from '../../../../../../../server/principal'
import { refusalStatus } from '../../../../../../../server/refusalStatus'

export const dynamic = 'force-dynamic'

/**
 * One goal version's report (Conductor Plan 5, spec R10, plan D9): the `GoalReport` as JSON, or
 * with `?format=markdown` the deterministic Markdown export as a download. A read, so no control
 * envelope. A refusal maps through `refusalStatus` (404 for `_not_found`), and a version that is
 * not a whole number is the caller's mistake (400), not a missing version. NOT gated on
 * archiving: an archived project's reports are still its record.
 */
export async function GET(request: Request, context: { params: Promise<{ workspaceId: string; version: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, version } = await context.params
  if (!/^[1-9]\d{0,8}$/u.test(version)) {
    return Response.json({ error: `goal version "${version}" is not a positive whole number` }, { status: 400 })
  }
  const report = await loadGoalReport(workspaceId, Number(version))
  if (!report.ok) return Response.json({ error: refusalText(report.error) }, { status: refusalStatus(report.error.kind) })
  if (new URL(request.url).searchParams.get('format') === 'markdown') {
    return new Response(renderGoalReportMarkdown(report.value), {
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="goal-v${version}-report.md"`,
        'cache-control': 'no-store',
      },
    })
  }
  return Response.json(report.value)
}
