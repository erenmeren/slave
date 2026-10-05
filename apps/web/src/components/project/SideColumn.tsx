import Link from 'next/link'
import { LEAD_NOTE_WORDS, STOP_REASON_WORDS } from '@slave-of-ai/domain'
import type { ProjectView } from '@slave-of-ai/control'
import { LimitBar } from '@/components/app/LimitBar'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatAgo, percentOf, spendLine, timeLine } from '@/lib/format'

/** A build's state in a person's words, for the Builds list. */
export function buildWord(build: ProjectView['builds'][number]): string {
  switch (build.leadState) {
    case null:
      return 'Older way'
    case 'building':
      return 'Building'
    case 'proving':
      return 'Checking'
    case 'delivered':
      return build.stopReason === 'accepted_as_is' ? 'Delivered as it was' : 'Delivered'
    case 'stopped':
      return 'Left unmerged'
    case 'awaiting_decision':
      return 'Waiting for you'
  }
}

/**
 * Lead UX design section 6.3, the right column: Limits (spend and working time against their caps,
 * "Change limits" opening the Settings sheet), Builds (each linking to its report), and the lead's
 * Notes in words.
 */
export function SideColumn({ project, onOpenSettings }: { readonly project: ProjectView; readonly onOpenSettings: () => void }): React.JSX.Element {
  const build = project.build
  const spent = build?.spentUsd ?? project.projectSpentUsd
  const worked = build?.workedMs ?? 0
  return (
    <div className="flex flex-col gap-4">
      <Card data-testid="limits" className="gap-4">
        <CardHeader>
          <CardTitle className="text-base">Limits</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Spent</span>
              <span data-testid="limits-spent" className="font-medium tabular-nums">
                {spendLine(spent, build?.spendUnmeasured ?? false, project.budgetUsd)}
              </span>
            </div>
            <LimitBar percent={percentOf(spent, project.budgetUsd)} label="Spent of the budget" />
          </div>
          {project.flow === 'lead' && (
            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Working time</span>
                <span data-testid="limits-time" className="font-medium tabular-nums">
                  {timeLine(worked, project.timeLimitMs)}
                </span>
              </div>
              <LimitBar percent={percentOf(worked, project.timeLimitMs)} label="Working time of the limit" />
            </div>
          )}
          {project.flow === 'lead' && project.budgetUsd === null && project.timeLimitMs === null && (
            <p className="text-xs text-warning-foreground">No budget and no time limit: nothing caps what this project spends.</p>
          )}
          {project.flow === 'lead' && !project.archived && (
            <Button variant="outline" size="sm" onClick={onOpenSettings} data-testid="change-limits">
              Change limits
            </Button>
          )}
        </CardContent>
      </Card>

      {project.builds.length > 0 && (
        <Card data-testid="builds" className="gap-3">
          <CardHeader>
            <CardTitle className="text-base">Builds</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1 text-sm">
              {project.builds.map((row) => (
                <li key={row.version}>
                  <Link href={`/w/${project.id}/goals/${String(row.version)}`} className="flex justify-between gap-2 rounded-md px-2 py-1 hover:bg-muted" title={row.stopReason === null ? undefined : STOP_REASON_WORDS[row.stopReason]}>
                    <span>Build {row.version}</span>
                    <span className="text-muted-foreground">{buildWord(row)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {build !== null && build.notes.length > 0 && (
        <Card data-testid="notes" className="gap-3">
          <CardHeader>
            <CardTitle className="text-base">Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2 text-sm">
              {build.notes.map((note) => (
                <li key={`${note.at}-${note.kind}`} data-kind={note.kind} title={note.detail} className="flex flex-col">
                  <span>{LEAD_NOTE_WORDS[note.kind]}</span>
                  <span className="text-xs text-muted-foreground">{formatAgo(note.at)}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
