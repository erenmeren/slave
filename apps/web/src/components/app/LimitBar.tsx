import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'

/** A spend or time bar (lead UX design section 6.3): red once past the whole, none without a whole. */
export function LimitBar({ percent, label, className }: { readonly percent: number | null; readonly label: string; readonly className?: string }): React.JSX.Element | null {
  if (percent === null) return null
  return <Progress aria-label={label} value={percent} className={cn('h-1.5', percent >= 100 && '[&>[data-slot=progress-indicator]]:bg-destructive', className)} />
}
