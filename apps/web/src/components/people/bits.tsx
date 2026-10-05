import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { initialsOf, toneOf } from '@/components/project/WhoIsWorking'
import { cn } from '@/lib/utils'
import { divisionMark, divisionWord } from './words'

/** Somebody's face: their initials on a steady tone, with a green ring while they work. */
export function PersonAvatar({ name, working = false, className }: { readonly name: string; readonly working?: boolean; readonly className?: string }): React.JSX.Element {
  return (
    <Avatar className={cn('size-10', working && 'working-pulse', className)}>
      <AvatarFallback className={cn('text-xs font-semibold', toneOf(name))}>{initialsOf(name)}</AvatarFallback>
    </Avatar>
  )
}

/** A persona's face: the mark of its division on a steady tone. */
export function PersonaAvatar({ name, division, className }: { readonly name: string; readonly division: string | null; readonly className?: string }): React.JSX.Element {
  return (
    <Avatar className={cn('size-10 rounded-lg', className)}>
      <AvatarFallback className={cn('rounded-lg text-base', toneOf(name))} aria-hidden>
        {divisionMark(division)}
      </AvatarFallback>
    </Avatar>
  )
}

export function DivisionChip({ division }: { readonly division: string | null }): React.JSX.Element | null {
  if (division === null) return null
  return (
    <Badge variant="outline" className="font-normal">
      <span aria-hidden>{divisionMark(division)}</span>
      {divisionWord(division)}
    </Badge>
  )
}

/** The small coloured badge that says somebody is working right now. */
export function WorkingBadge(): React.JSX.Element {
  return (
    <Badge className="bg-success-muted text-success-foreground" data-testid="working-badge">
      <span className="size-1.5 rounded-full bg-success" aria-hidden />
      Working
    </Badge>
  )
}

/** A section of a detail sheet: a heading, an optional line under it, an optional action beside it. */
export function SheetSection({ title, hint, action, children, testId }: { readonly title: string; readonly hint?: React.ReactNode; readonly action?: React.ReactNode; readonly children: React.ReactNode; readonly testId: string }): React.JSX.Element {
  return (
    <section id={testId} data-testid={testId} className="flex scroll-mt-14 flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          {hint !== undefined && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

/** The sections of a long sheet as a row of jumps that stays in view while the sheet scrolls. */
export function SectionNav({ items }: { readonly items: readonly { readonly id: string; readonly label: string }[] }): React.JSX.Element {
  return (
    <nav aria-label="Sections" className="sticky top-0 z-10 flex shrink-0 gap-1 overflow-x-auto border-b bg-background/95 px-3 py-1.5 backdrop-blur" data-testid="section-nav">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          onClick={() => document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        >
          {item.label}
        </button>
      ))}
    </nav>
  )
}
