/** The handoff dashed "add" tile (spec §3): e.g. Skills' "add skill source". */
export function EmptyTile({
  label,
  onClick,
}: {
  readonly label: string
  readonly onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="empty-tile"
      onClick={onClick}
      className="flex flex-col items-center justify-center gap-1 rounded-tile border border-dashed border-line p-4 text-xs text-text-3 transition-colors hover:border-white/20 hover:text-text-2"
    >
      <span aria-hidden className="text-base leading-none">
        +
      </span>
      <span>{label}</span>
    </button>
  )
}
