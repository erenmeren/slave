import type { ProviderCapabilities } from '@ai-team-os/control'
import { Chip } from './ui/Chip'

/**
 * The shell-only gate mark (M12 Task 13 fix round 1, spec §8: "wherever a worker's runtime is
 * shown, a provider whose gate is shell-only is marked as such -- Decision 8 is a user-visible
 * fact, not an internal flag"). Shared by `AgentCard` and `AgentPanel`, the two Overview surfaces
 * that show a worker's runtime and had no mark at all.
 *
 * Deliberately narrower than `RosterTable.tsx`'s own gate chip, which renders a label for every
 * gate (`all-tools`/`shell-only`/`none`) -- that chip predates this fix and review Minor 5 defers
 * changing it. Spec §8's own words are about `shell-only` specifically, and this component's two
 * new callers have no other gate context on screen (no model override row, no roster grouping) to
 * make an unconditional label legible the way the Roster's row does -- so this renders NOTHING
 * for `all-tools`/`none`/`null`, only the one fact spec §8 actually asks to be marked.
 */
export function ShellOnlyMark({ gate }: { readonly gate: ProviderCapabilities['gate'] | null }): React.JSX.Element | null {
  if (gate !== 'shell-only') return null
  return (
    <Chip>
      <span data-testid="shell-only-mark">shell only</span>
    </Chip>
  )
}
