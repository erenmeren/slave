import type { HappeningNowItem } from '../../server/home'
import { formatAge } from '../../lib/format'
import { AvatarTile } from '../ui/AvatarTile'
import { EmptyState } from '../ui/EmptyState'
import { ScrollArea } from '../ui/ScrollArea'

/**
 * Home's live feed (M61 R11, Task 8): every `HAPPENING_TYPES` event across every visible project,
 * newest first -- the SAME sentence/avatar recipe `project/ActivityDigest.tsx` draws for one
 * project's Activity tab, widened here with a `workspaceName · <age>` byline since Home spans
 * every project at once and a bare timestamp would not say whose event this is.
 *
 * `title={item.type}` carries the raw domain type (`docs/ia.md` rule 3: a label, never a key, as
 * VISIBLE text) -- the sentence is what a person reads; the raw type is still reachable for
 * anyone who needs it.
 */
export function HappeningFeed({ items }: { readonly items: readonly HappeningNowItem[] }): React.JSX.Element {
  return (
    <aside data-testid="home-feed" className="flex min-h-0 flex-col rounded-surface border border-line bg-panel p-3">
      <h2 className="type-label">Happening now</h2>
      <ScrollArea className="mt-2">
        {items.length === 0 ? (
          <EmptyState testId="home-feed-empty" message="nothing has happened yet" />
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((item) => (
              <li key={item.id} data-testid="feed-item" title={item.type} className="flex items-start gap-2">
                <AvatarTile name={item.actorName ?? item.workspaceName} tone="idle" />
                <div className="min-w-0 flex-1">
                  <p className="type-meta text-t1">{item.sentence}</p>
                  <p className="type-meta text-t3">
                    {item.workspaceName} · {formatAge(item.at)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </aside>
  )
}
