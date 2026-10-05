import { analyticsDaysOf, analyticsView } from '@slave-of-ai/control'
import { AnalyticsScreen } from '@/components/analytics/AnalyticsScreen'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Analytics · Slave of AI' }

const one = (value: string | string[] | undefined): string | null => {
  const text = (Array.isArray(value) ? value[0] : value)?.trim() ?? ''
  return text === '' ? null : text
}

/**
 * Analytics: how much was spent, where and by whom, and how much work it bought. The address says
 * which project (`?project=`, every project without it) and which period (`?days=7`, `30` or
 * `all`). The first read is made here so the first paint carries it; the screen keeps it current.
 */
export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<React.JSX.Element> {
  const params = await searchParams
  const initial = await analyticsView({ projectId: one(params['project']), days: analyticsDaysOf(one(params['days'])) })
  // Keyed by the choice: another project or period is another screen, with its own first read.
  return <AnalyticsScreen key={`${initial.projectId ?? 'all'}:${String(initial.days)}`} initial={initial} />
}
