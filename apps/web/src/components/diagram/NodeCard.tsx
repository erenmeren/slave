import { ChevronDownIcon, ChevronRightIcon, FlagIcon, UserIcon } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { initialsOf, toneOf } from '@/components/project/WhoIsWorking'
import { cn } from '@/lib/utils'
import type { CardData } from './shape'
import { TONE_BADGE, TONE_EDGE } from './words'

/**
 * One card of the team diagram: who it is, how it stands, what it is doing now in words, and its
 * steps, failed steps and cost. The box is the size the layout was told, so nothing a card says
 * can move its neighbours: long words are cut, and said whole in the side panel.
 */
export function NodeCard({ data, width, height, onToggle }: { readonly data: CardData; readonly width: number; readonly height: number; readonly onToggle?: () => void }): React.JSX.Element {
  const end = data.kind === 'request' || data.kind === 'result'
  return (
    <div
      data-testid="diagram-card"
      data-kind={data.kind}
      data-tone={data.tone}
      style={{ width, height }}
      className={cn('flex cursor-pointer flex-col gap-1.5 overflow-hidden rounded-lg border border-l-4 bg-card px-3 py-2.5 text-left text-card-foreground shadow-xs transition-shadow hover:shadow-md', TONE_EDGE[data.tone])}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Avatar className={cn('size-7 shrink-0', data.working && 'working-pulse')}>
          <AvatarFallback className={cn('text-[11px] font-semibold', end ? 'bg-muted text-muted-foreground' : toneOf(data.name))}>
            {data.kind === 'request' ? <UserIcon className="size-3.5" /> : data.kind === 'result' ? <FlagIcon className="size-3.5" /> : initialsOf(data.name)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm leading-tight font-medium">{data.name}</p>
          <p className="truncate text-[11px] leading-tight text-muted-foreground">{data.role}</p>
        </div>
        {data.badge !== '' && <Badge className={cn('shrink-0', TONE_BADGE[data.tone])}>{data.badge}</Badge>}
      </div>
      {data.asked !== null && (
        <p className="truncate text-xs font-medium" title={data.asked}>
          {data.asked}
        </p>
      )}
      <p className={cn('text-xs text-muted-foreground', end ? 'line-clamp-3' : 'truncate')} title={data.sentence}>
        {data.sentence}
      </p>
      {data.steps !== null && (
        <p className="mt-auto flex min-w-0 items-center gap-1 text-[11px] whitespace-nowrap text-muted-foreground tabular-nums">
          <span className="text-foreground">{data.steps}</span>
          {data.failed !== null && <span className="text-destructive">· {data.failed}</span>}
          {data.cost !== null && <span className="truncate">· {data.cost}</span>}
          {data.group !== null && onToggle !== undefined && (
            <button
              type="button"
              data-testid="diagram-toggle"
              aria-expanded={data.expanded}
              // `nodrag nopan`: the canvas must not read this press as the start of a drag.
              className="nodrag nopan ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-sm px-1 py-0.5 font-medium text-foreground hover:bg-muted"
              onClick={(event) => {
                event.stopPropagation()
                onToggle()
              }}
            >
              {data.expanded ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
              {data.expanded ? 'Hide sessions' : 'Show sessions'}
            </button>
          )}
        </p>
      )}
    </div>
  )
}
