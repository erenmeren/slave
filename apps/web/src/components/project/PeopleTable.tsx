import type { BuildView, PersonRow } from '@slave-of-ai/control'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ESTIMATE_TITLE, aboutUsd, unpricedWord } from '@/lib/estimate'
import { formatAgo, formatUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { initialsOf, toneOf } from './WhoIsWorking'

const KIND_WORD: Readonly<Record<PersonRow['kind'], string>> = { lead: 'Lead', helper: 'Helper', checker: 'Checker' }
const STATE_WORD: Readonly<Record<PersonRow['state'], string>> = { working: 'Working', paused: 'Paused', done: 'Finished' }
const STATE_TONE: Readonly<Record<PersonRow['state'], string>> = {
  working: 'bg-info-muted text-info-foreground',
  paused: 'bg-warning-muted text-warning-foreground',
  done: 'bg-muted text-muted-foreground',
}

/**
 * What a person cost, or why there is no figure of their own. A reported figure is said plainly; an
 * estimate always says "about": a helper's (its cost is inside the lead's, so an estimate is all
 * there is), and the lead's or a checker's for a session that has not reported yet.
 */
export function costWord(person: PersonRow): string {
  if (person.kind === 'helper') return person.estimatedUsd !== null ? aboutUsd(person.estimatedUsd) : "in the lead's"
  const running = person.estimatedRunningUsd
  if (person.costUsd !== null) return running !== null ? `${formatUsd(person.costUsd)} + ${aboutUsd(running)} so far` : formatUsd(person.costUsd)
  if (running !== null) return `${aboutUsd(running)} so far`
  if (person.running > 0 && person.unpricedModels.length > 0) return unpricedWord(person.unpricedModels)
  return 'when it ends'
}

/** The small print under an estimate; null when the cell holds none. */
export function costNote(person: PersonRow): string | null {
  if (person.kind === 'helper') return person.estimatedUsd !== null ? "estimate · in the lead's cost" : null
  return person.estimatedRunningUsd !== null ? 'estimate' : null
}

/**
 * Everybody who worked on the build, finished or not: the lead, each helper it called and the
 * checkers -- what each is doing now, how many sessions and steps it took, and what it cost. A
 * helper has no reported figure of its own: the runtime reports one cost per lead turn, helpers
 * included, so a helper's is an estimate from the tokens its sessions used, and says so.
 */
export function PeopleTable({ build }: { readonly build: BuildView }): React.JSX.Element | null {
  if (build.people.length === 0) return null
  return (
    <Card data-testid="people">
      <CardHeader>
        <CardTitle className="text-base">People on this build</CardTitle>
        <CardDescription>
          {build.workingNow} working now, {build.people.length} in all.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Who</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Sessions</TableHead>
              <TableHead className="text-right">Steps</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Last active</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {build.people.map((person) => (
              <TableRow key={person.id} data-testid="person-row" data-kind={person.kind} data-state={person.state}>
                <TableCell className="max-w-[320px]">
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar className={cn('size-8', person.state === 'working' && 'working-pulse')}>
                      <AvatarFallback className={cn('text-xs font-semibold', toneOf(person.name))}>{initialsOf(person.name)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {person.name}
                        {person.name !== KIND_WORD[person.kind] && <span className="font-normal text-muted-foreground"> · {KIND_WORD[person.kind].toLowerCase()}</span>}
                      </p>
                      <p className="truncate text-xs text-muted-foreground" title={person.doing ?? undefined}>
                        {person.state === 'working' ? (person.doing ?? 'Starting…') : person.state === 'paused' ? 'Paused until you press Continue' : 'Not working now'}
                      </p>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge className={STATE_TONE[person.state]}>{STATE_WORD[person.state]}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {person.sessions}
                  {person.running > 0 && <span className="text-muted-foreground"> ({person.running} open)</span>}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {person.toolCalls}
                  {person.failedCalls > 0 && <span className="text-destructive" title="Steps that failed"> · {person.failedCalls} failed</span>}
                </TableCell>
                <TableCell data-testid="person-cost" className={cn('text-right tabular-nums', person.costUsd === null && person.estimatedUsd === null && 'text-xs text-muted-foreground')} title={costNote(person) === null ? undefined : ESTIMATE_TITLE}>
                  {costWord(person)}
                  {costNote(person) !== null && <span className="block text-xs font-normal text-muted-foreground">{costNote(person)}</span>}
                </TableCell>
                <TableCell className="text-right text-xs text-muted-foreground" suppressHydrationWarning>
                  {person.lastAt === null ? '—' : formatAgo(person.lastAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
