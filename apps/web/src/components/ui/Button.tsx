import { forwardRef } from 'react'
import { TONE_BORDER, TONE_FILL, TONE_TEXT } from './StatusPill'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant: 'primary' | 'ghost' | 'danger'
  /** `md` is the handoff's standalone action (`px-3 py-1.5`); `sm` is the denser control that sits
   *  inside a form row or a table cell (`px-2.5 py-1`). `sm` is EXACTLY the geometry
   *  `FormControls`' `GhostButton`/`PrimaryButton` carried before M44 folded them into this
   *  component, so the thirty-five call sites that used them did not move a pixel. */
  readonly size?: 'md' | 'sm'
}

const SURFACE: Record<ButtonProps['variant'], string> = {
  ghost: 'border-line bg-transparent text-text-2 hover:border-line-hover hover:text-text-1',
  // Primary rides the `working` tone (the handoff's default "go" colour) and danger the `blocked`
  // one -- both through `StatusPill`'s own `1a`-alpha fill / `3d`-alpha border tables, not a
  // bespoke button colour. `FormControls` had drifted to `/15` and `/40`; M44 converges on the
  // handoff's stated alphas, which is the only visual change this consolidation makes.
  primary: `${TONE_FILL.working} ${TONE_BORDER.working} ${TONE_TEXT.working} hover:brightness-125`,
  danger: `${TONE_FILL.blocked} ${TONE_BORDER.blocked} ${TONE_TEXT.blocked} hover:brightness-125`,
}

const GEOMETRY: Record<NonNullable<ButtonProps['size']>, string> = {
  md: 'px-3 py-1.5',
  sm: 'px-2.5 py-1',
}

/**
 * The ONE button (M44 R3). `ghost` for a secondary action, `primary` for the default "go",
 * `danger` for anything destructive -- and `DangerConfirm` is still the only thing that may FIRE a
 * destructive action, because a destructive action asks twice.
 *
 * Forwards native `<button>` props (`type` defaults to `"button"` so a caller does not accidentally
 * submit an enclosing form); `className` is appended after the variant's own classes so a caller
 * can extend layout (`w-full`) without fighting it; a caller's own `data-testid` overrides the
 * default because `{...rest}` is spread last.
 *
 * A `forwardRef` because `DangerConfirm` has to focus its confirm on open and hand focus back to
 * its trigger on Escape (M44 erratum E12) -- the two-step timing `EmergencyStopButton` documented
 * before M44 moved it into shared code.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size = 'md', type = 'button', className, ...rest },
  ref,
): React.JSX.Element {
  return (
    <button
      ref={ref}
      type={type}
      data-testid="button"
      data-variant={variant}
      data-size={size}
      className={`inline-flex items-center justify-center gap-1.5 rounded-chip border ${GEOMETRY[size]} text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${SURFACE[variant]} ${className ?? ''}`}
      {...rest}
    />
  )
})

// `forwardRef` erases the render function's own name from React's devtools label; this puts it
// back, so a `Button` in the component tree reads as one.
Button.displayName = 'Button'
