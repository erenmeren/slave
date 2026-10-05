import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'

/**
 * A spend or time bar (lead UX design section 6.3): red once past the whole, none without a whole.
 *
 * `estimatePercent` draws an ESTIMATE as a lighter, hatched piece after the measured part -- told
 * apart from it by look and by its own `title`, and never part of the bar's own value.
 */
export function LimitBar({ percent, label, className, estimatePercent, estimateTitle }: { readonly percent: number | null; readonly label: string; readonly className?: string; readonly estimatePercent?: number | null; readonly estimateTitle?: string | undefined }): React.JSX.Element | null {
  if (percent === null) return null
  const bar = <Progress aria-label={label} value={percent} className={cn('h-1.5', percent >= 100 && '[&>[data-slot=progress-indicator]]:bg-destructive', className)} />
  const extra = Math.min(estimatePercent ?? 0, 100 - percent)
  if (extra <= 0) return bar
  return (
    <div className="relative">
      {bar}
      <div
        data-testid="limit-bar-estimate"
        title={estimateTitle}
        className="absolute inset-y-0 rounded-r-full bg-primary/40 bg-[repeating-linear-gradient(135deg,transparent_0_3px,var(--background)_3px_5px)]"
        style={{ left: `${String(percent)}%`, width: `${String(extra)}%` }}
      />
    </div>
  )
}
