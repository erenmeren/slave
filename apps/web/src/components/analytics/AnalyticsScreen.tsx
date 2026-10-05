'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { AnalyticsView } from '@slave-of-ai/control'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { usePoll } from '@/hooks/usePoll'
import { cn } from '@/lib/utils'
import { EvidenceSection } from './EvidenceSection'
import { HelpersSection } from './HelpersSection'
import { MoneySection } from './MoneySection'
import { WorkSection } from './WorkSection'
import { PERIODS, analyticsApi, analyticsHref } from './words'

/** How often the page re-reads: it adds up every project, so it is read rarely. */
export const ANALYTICS_POLL_MS = 60_000
const ALL = 'all'

/**
 * Analytics: how much was spent, where and by whom, and how much work it bought. One project or
 * all of them, over a week, a month or everything; both choices live in the address, so a view can
 * be bookmarked. Four sections: Money, Work, People, Evidence.
 */
export function AnalyticsScreen({ initial }: { readonly initial: AnalyticsView }): React.JSX.Element {
  const router = useRouter()
  const { data, error } = usePoll<{ readonly analytics?: AnalyticsView }>(analyticsApi(initial.projectId, initial.days), { analytics: initial }, () => ANALYTICS_POLL_MS)
  const view = data.analytics ?? initial
  return (
    <div className="mx-auto flex w-full max-w-[1200px] min-w-0 flex-col gap-10 px-4 py-8 md:px-8" data-testid="analytics">
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground">What was spent, on what, and how much work it bought.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Select value={view.projectId ?? ALL} onValueChange={(value) => router.push(analyticsHref(value === ALL ? null : value, view.days))}>
            <SelectTrigger data-testid="analytics-project" aria-label="Project" className="w-full min-w-0 sm:w-[280px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All projects</SelectItem>
              {view.projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                  {project.archived ? ' (archived)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <nav aria-label="Period" data-testid="analytics-period" className="inline-flex w-fit gap-1 rounded-lg border bg-muted/50 p-1">
            {PERIODS.map((period) => (
              <Link
                key={period.id}
                href={analyticsHref(view.projectId, period.days)}
                aria-current={view.days === period.days ? 'page' : undefined}
                data-testid={`period-${period.id}`}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  view.days === period.days ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {period.word}
              </Link>
            ))}
          </nav>
        </div>
      </div>

      {error !== null && (
        <Alert data-testid="analytics-error">
          <AlertDescription>Could not refresh the figures. Retrying…</AlertDescription>
        </Alert>
      )}
      {view.truncated && (
        <Alert data-testid="analytics-truncated">
          <AlertDescription>There are more sessions than this page adds up: the oldest are left out of the figures.</AlertDescription>
        </Alert>
      )}

      <MoneySection view={view} />
      <WorkSection view={view} />
      <HelpersSection view={view} />
      <EvidenceSection view={view} />
    </div>
  )
}
