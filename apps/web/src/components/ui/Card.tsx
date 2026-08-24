/**
 * The handoff card surface (spec §3): `bg-bg-2`, radius 8, hover border. Renders as a `<button>`
 * when `onClick` is given (selectable/clickable card) and a plain `<div>` otherwise — matches the
 * `TaskCard.tsx` house pattern of an interactive card being its own `<button type="button">`
 * rather than a `<div onClick>` (native focus/keyboard support for free).
 */
export function Card({
  selected = false,
  onClick,
  children,
}: {
  readonly selected?: boolean
  readonly onClick?: () => void
  readonly children: React.ReactNode
}): React.JSX.Element {
  const surface = selected
    ? 'border-white/20 bg-[#151a21]'
    : 'border-line bg-bg-2 hover:border-white/20'
  const className = `flex w-full flex-col gap-2 rounded-card border p-3 text-left transition-colors ${surface}`

  if (onClick !== undefined) {
    return (
      <button type="button" data-testid="card" data-selected={selected} onClick={onClick} className={className}>
        {children}
      </button>
    )
  }

  return (
    <div data-testid="card" data-selected={selected} className={className}>
      {children}
    </div>
  )
}
