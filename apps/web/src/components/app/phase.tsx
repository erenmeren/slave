import { PROJECT_PHASE_LABEL, phaseIsActive, type ProjectPhase } from '@slave-of-ai/domain'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/**
 * Lead UX design section 5: a phase's colour -- blue while it builds, violet while it is checked,
 * amber when a person is needed, green when delivered, red when Slave stopped it, grey otherwise.
 * The badge's text is the word; the raw phase is on `data-phase` for the tests and the operator.
 */
const BADGE_TONE: Readonly<Record<ProjectPhase, string>> = {
  empty: 'border-border bg-muted text-muted-foreground',
  starting: 'border-transparent bg-info-muted text-info-foreground',
  building: 'border-transparent bg-info-muted text-info-foreground',
  checking: 'border-transparent bg-checking-muted text-checking-foreground',
  needs_decision: 'border-transparent bg-warning-muted text-warning-foreground',
  ready_to_merge: 'border-transparent bg-warning-muted text-warning-foreground',
  delivered: 'border-transparent bg-success-muted text-success-foreground',
  closed: 'border-border bg-muted text-muted-foreground',
  paused: 'border-border bg-transparent text-muted-foreground',
  failed: 'border-transparent bg-destructive/15 text-destructive',
  older: 'border-border bg-muted text-muted-foreground',
}

const DOT_TONE: Readonly<Record<ProjectPhase, string>> = {
  empty: 'bg-muted-foreground/40',
  starting: 'bg-info',
  building: 'bg-info',
  checking: 'bg-checking',
  needs_decision: 'bg-warning',
  ready_to_merge: 'bg-warning',
  delivered: 'bg-success',
  closed: 'bg-muted-foreground/40',
  paused: 'border border-muted-foreground bg-transparent',
  failed: 'bg-destructive',
  older: 'bg-muted-foreground/40',
}

export function PhaseBadge({ phase, className }: { readonly phase: ProjectPhase; readonly className?: string }): React.JSX.Element {
  return (
    <Badge variant="outline" data-testid="phase-badge" data-phase={phase} className={cn('font-medium', BADGE_TONE[phase], className)}>
      {PROJECT_PHASE_LABEL[phase]}
    </Badge>
  )
}

/** The sidebar's state dot; it pulses while something runs. */
export function PhaseDot({ phase }: { readonly phase: ProjectPhase }): React.JSX.Element {
  return (
    <span
      aria-hidden
      data-phase={phase}
      className={cn('inline-block size-2 shrink-0 rounded-full', DOT_TONE[phase], phaseIsActive(phase) && 'animate-pulse')}
    />
  )
}
