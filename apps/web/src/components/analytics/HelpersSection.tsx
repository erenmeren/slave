import Link from 'next/link'
import type { AnalyticsView } from '@slave-of-ai/control'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatAgo } from '@/lib/format'
import { periodWord } from './words'

/**
 * People: which of the roster's people, and which general helpers, the leads called on -- how
 * often, how many steps each made and how many of those failed. A helper has no cost of its own:
 * it works inside the lead's turn, and the runtime reports one figure for the turn.
 */
export function HelpersSection({ view }: { readonly view: AnalyticsView }): React.JSX.Element {
  const most = Math.max(1, ...view.helpers.map((row) => row.sessions))
  return (
    <section aria-labelledby="helpers-heading" data-testid="analytics-helpers" className="flex min-w-0 flex-col gap-4">
      <h2 id="helpers-heading" className="text-lg font-semibold tracking-tight">People</h2>
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="text-base">Who the leads called on</CardTitle>
          <CardDescription>The most called first, {periodWord(view.days)}. A helper&apos;s cost is inside the lead&apos;s turn, so there is no figure of its own to show.</CardDescription>
        </CardHeader>
        <CardContent>
          {view.helpers.length === 0 ? (
            <p data-testid="helpers-empty" className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              No lead handed work to a helper {periodWord(view.days)}. A lead calls on the people of its project&apos;s roster, or on a general helper, when it splits the work.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Who</TableHead>
                  <TableHead className="w-[26%]">Called</TableHead>
                  <TableHead className="text-right">Steps</TableHead>
                  <TableHead className="text-right">Failed steps</TableHead>
                  <TableHead className="text-right">Projects</TableHead>
                  <TableHead className="text-right">Last called</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.helpers.map((row) => (
                  <TableRow key={row.key} data-testid="helper-row">
                    <TableCell className="max-w-[260px]">
                      {row.personId === null ? (
                        <span className="block truncate font-medium" title={row.name}>{row.name}</span>
                      ) : (
                        <Link href={`/people?person=${row.personId}`} className="block truncate font-medium hover:underline" title={row.name}>
                          {row.name}
                        </Link>
                      )}
                      {row.personId === null && <span className="text-xs text-muted-foreground">{row.name === 'General helper' ? 'no roster person' : 'no longer on a roster'}</span>}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="w-8 shrink-0 text-right tabular-nums">{row.sessions}</span>
                        <div aria-hidden className="h-2 min-w-10 flex-1 rounded-full bg-muted">
                          <div className="h-full rounded-full bg-success" style={{ width: `${String((row.sessions / most) * 100)}%` }} />
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.steps}</TableCell>
                    <TableCell className={row.failedSteps > 0 ? 'text-right text-destructive tabular-nums' : 'text-right text-muted-foreground tabular-nums'}>{row.failedSteps}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.projects}</TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap text-muted-foreground" suppressHydrationWarning>
                      {row.lastAt === null ? '—' : formatAgo(row.lastAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </section>
  )
}
