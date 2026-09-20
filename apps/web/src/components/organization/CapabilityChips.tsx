/**
 * A worker's capabilities, as LABELS with their keys in `title` (`docs/ia.md` rule 3: a surface
 * prints words, and the raw value stays reachable). Shared by the Organization rows and by M46's
 * profile drawer, so one capability reads the same in both places.
 *
 * NOT `ui/Chip` (whose own `testId` prop would do): a chip here is 11px inside a table row that
 * already carries a role chip, and the `capability-chip` handle is a contract Task 5's gate reads
 * on both surfaces. Deliberately a plain function with no client hooks, so the drawer -- a
 * `'use client'` file -- and the Organization table can both render it.
 */
export function CapabilityChips({
  capabilities,
  max = 4,
}: {
  readonly capabilities: readonly {
    readonly key: string
    readonly label: string
    /** 2026-09-20 catalogue capability mapping, R8: which of the two sources chose this key --
     *  absent for a caller that has no provenance to say, so `data-provenance` renders on neither
     *  attribute nor value and every other caller is unchanged. */
    readonly provenance?: 'matched' | 'mapped'
  }[]
  readonly max?: number
}): React.JSX.Element {
  if (capabilities.length === 0) {
    return <span className="text-[11px] text-text-3">no capabilities recorded</span>
  }
  const shown = capabilities.slice(0, max)
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((capability) => (
        <span
          key={capability.key}
          data-testid="capability-chip"
          data-provenance={capability.provenance}
          title={capability.key}
          className="rounded-pill border border-line2 px-2 py-[2px] text-[12px] text-t2"
        >
          {capability.label}
        </span>
      ))}
      {capabilities.length > shown.length && (
        <span className="text-[11px] text-text-3">+{capabilities.length - shown.length}</span>
      )}
    </span>
  )
}
