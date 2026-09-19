'use client'

import type { DigestDay } from '../../server/activityDigest'
import { AvatarTile } from '../ui/AvatarTile'
import { EmptyState } from '../ui/EmptyState'
import { ScrollArea } from '../ui/ScrollArea'

/** `HH:MM` off the ISO stamp -- the digest's own row is a sentence, not a log line, so it carries
 *  no seconds (`SupervisorTimeline`'s `clock` keeps them; this is a coarser read). */
function hhmm(iso: string): string {
  return iso.slice(11, 16)
}

/**
 * Simple mode's Activity tab (M61 R10): the workspace's happenings, read as sentences, grouped by
 * day -- `buildActivityDigest`'s own day grouping, drawn here with no further logic. `days` is
 * `null` for a workspace this build could not find, and `[]` for one with no happenings yet.
 */
export function ActivityDigest({
  workspaceId,
  days,
}: {
  readonly workspaceId: string
  readonly days: readonly DigestDay[] | null
}): React.JSX.Element {
  return (
    <ScrollArea className="p-[var(--gap-3)]">
      {days === null ? (
        <EmptyState testId="digest-unavailable" message={`no project with id ${workspaceId}`} />
      ) : days.length === 0 ? (
        <EmptyState testId="digest-empty" message="nothing has happened here yet" />
      ) : (
        days.map((day) => (
          <section key={day.id} data-testid="digest-day">
            {/* `glass` + `sticky top-0`: the day heading stays readable as its own items scroll
              * underneath it, inside the ONE scroll region this view owns. */}
            <h3 className="type-label sticky top-0 glass py-1">{day.when}</h3>
            <ul>
              {day.items.map((item) => (
                <li key={item.id} data-testid="digest-item" title={item.type} className="flex gap-3 py-2">
                  <AvatarTile size="sm" name={item.actorName ?? 'S'} tone="idle" />
                  <div>
                    <p className="type-body">{item.sentence}</p>
                    <time className="type-meta text-t3">{hhmm(item.at)}</time>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </ScrollArea>
  )
}
