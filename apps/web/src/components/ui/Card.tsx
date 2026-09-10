/**
 * The handoff card surface (spec §3): `bg-bg-2`, radius 8, hover border. Renders as a `<button>`
 * when `onClick` is given and a plain `<div>` otherwise.
 *
 * M44 R3 widens it with `className`, `testId` and a `data` bag so a caller can extend the surface
 * and label it -- the three things `SlaveCard.tsx` names in its own docblock as the reason it is
 * NOT a `Card`. The three card DOMs do not converge in M44: `SlaveCard`'s `padding: 12px 13px` and
 * `border-radius: 8px` are two of `gate:m14-fidelity`'s stage-2 assertions and two of the design
 * README's numbers, and M44 freezes those (plan erratum E1). This is the groundwork M45 finishes.
 */
export function Card({
  selected = false,
  onClick,
  className,
  testId = 'card',
  data,
  children,
}: {
  readonly selected?: boolean
  readonly onClick?: () => void
  readonly className?: string
  readonly testId?: string
  /** Spread BEFORE `data-testid`, so a caller cannot accidentally shadow the testid the rest of
   *  the suite (and `gate:m14-fidelity`) queries this surface by. */
  readonly data?: Readonly<Record<`data-${string}`, string>>
  readonly children: React.ReactNode
}): React.JSX.Element {
  const surface = selected ? 'border-line-hover bg-bg-selected' : 'border-line bg-bg-2 hover:border-line-hover'
  const classes = `flex w-full flex-col gap-2 rounded-card border p-3 text-left transition-colors ${surface} ${className ?? ''}`.trim()

  if (onClick !== undefined) {
    return (
      <button type="button" {...data} data-testid={testId} data-selected={selected} onClick={onClick} className={classes}>
        {children}
      </button>
    )
  }

  return (
    <div {...data} data-testid={testId} data-selected={selected} className={classes}>
      {children}
    </div>
  )
}
