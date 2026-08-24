import { TONE_BORDER, TONE_FILL, TONE_TEXT } from './StatusPill'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant: 'ghost' | 'primary'
}

const GHOST_CLASS = 'border-line bg-transparent text-text-2 hover:border-white/20 hover:text-text-1'
// Primary rides the `working` tone (the handoff's default "go" colour) — the same `1a`-alpha
// fill / `3d`-alpha border pattern `StatusPill`/`Chip` use, not a bespoke primary-button colour.
const PRIMARY_CLASS = `${TONE_FILL.working} ${TONE_BORDER.working} ${TONE_TEXT.working} hover:brightness-125`

/** The handoff button (spec §3 / README "Hover"): `ghost` for secondary actions, `primary` for
 *  the default "go" action. Forwards native `<button>` props (`type` defaults to `"button"` so a
 *  caller doesn't accidentally submit an enclosing form); `className` is appended after the
 *  variant's own classes so a caller can extend layout (e.g. `w-full`) without fighting it. */
export function Button({ variant, type = 'button', className, ...rest }: ButtonProps): React.JSX.Element {
  const surface = variant === 'primary' ? PRIMARY_CLASS : GHOST_CLASS
  return (
    <button
      type={type}
      data-testid="button"
      data-variant={variant}
      className={`inline-flex items-center justify-center gap-1.5 rounded-chip border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${surface} ${className ?? ''}`}
      {...rest}
    />
  )
}
