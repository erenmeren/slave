import type { ActivityLine, BuildView } from '@slave-of-ai/control'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatAgo } from '@/lib/format'
import { cn } from '@/lib/utils'

const KIND_TONE: Readonly<Record<ActivityLine['kind'], string>> = {
  lead: 'text-info-foreground',
  helper: 'text-success-foreground',
  checker: 'text-checking-foreground',
}

const OUTCOME_DOT: Readonly<Record<'ok' | 'error' | 'open', string>> = {
  ok: 'bg-success',
  error: 'bg-destructive',
  open: 'bg-info working-pulse',
}

const OUTCOME_WORD: Readonly<Record<'ok' | 'error' | 'open', string>> = { ok: 'Done', error: 'Failed', open: 'Running' }

/**
 * What the build is doing, step by step, newest first: who did it, what it was in words, whether
 * it worked, and when. The newest sixty steps; it refreshes with the screen.
 */
export function ActivityFeed({ build }: { readonly build: BuildView }): React.JSX.Element | null {
  if (build.activity.length === 0) return null
  return (
    <Card data-testid="activity">
      <CardHeader>
        <CardTitle className="text-base">Activity</CardTitle>
        <CardDescription>
          The newest {build.activity.length} of {build.toolCalls} steps, newest first.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="max-h-[360px] overflow-y-auto pr-2">
          <ol className="flex flex-col">
            {build.activity.map((line) => {
              const outcome = line.outcome ?? 'open'
              return (
                <li key={line.id} data-testid="activity-line" data-outcome={outcome} className="flex min-w-0 items-baseline gap-3 border-b py-1.5 text-sm last:border-b-0">
                  <span className={cn('mt-1.5 size-2 shrink-0 self-start rounded-full', OUTCOME_DOT[outcome])} title={OUTCOME_WORD[outcome]} />
                  <span className={cn('w-28 shrink-0 truncate font-medium', KIND_TONE[line.kind])} title={line.who}>
                    {line.who}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={line.text}>
                    {line.text}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums" suppressHydrationWarning>
                    {formatAgo(line.at)}
                  </span>
                </li>
              )
            })}
          </ol>
        </div>
      </CardContent>
    </Card>
  )
}
