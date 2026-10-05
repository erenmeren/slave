'use client'

import { ChartGanttIcon, LayoutListIcon, WorkflowIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ProjectViewName } from './views'

const VIEWS: readonly { readonly id: ProjectViewName; readonly word: string; readonly Icon: typeof LayoutListIcon }[] = [
  { id: 'overview', word: 'Overview', Icon: LayoutListIcon },
  { id: 'diagram', word: 'Diagram', Icon: WorkflowIcon },
  { id: 'timeline', word: 'Timeline', Icon: ChartGanttIcon },
]

/** The switch under the Project screen's header. The chosen view is kept in the URL by the screen. */
export function ViewSwitch({ view, onChange }: { readonly view: ProjectViewName; readonly onChange: (view: ProjectViewName) => void }): React.JSX.Element {
  return (
    <div role="tablist" aria-label="View" data-testid="view-switch" className="inline-flex w-fit gap-1 rounded-lg border bg-muted/50 p-1">
      {VIEWS.map(({ id, word, Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={view === id}
          data-testid={`view-${id}`}
          onClick={() => onChange(id)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>svg]:size-4',
            view === id ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon />
          {word}
        </button>
      ))}
    </div>
  )
}
