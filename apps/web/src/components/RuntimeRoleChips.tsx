import { Chip } from './ui/Chip'

/**
 * What an empty `runtimeRoles` set means, in one sentence (M37 §7).
 *
 * Exported because three surfaces say it -- the card, the panel and the Slaves table through
 * {@link RuntimeRoleChips}, and the org graph's node as the title on its own compact mark -- and a
 * worker being undispatchable must not be described three different ways depending on which page
 * an operator happened to open.
 */
export const NOT_DISPATCHABLE_TEXT = 'cannot be dispatched — no runtime roles'

/**
 * The roles a worker may be DISPATCHED as, as chips -- or the warning that it holds none (M37 §5).
 *
 * `Slave.role` is the profile's TITLE since M37 and is matched by nothing; this set is what the
 * scheduler, reviewer/manager staffing and role-addressed messaging read. So wherever a worker is
 * listed, this is the field that answers "can this one pick up work at all", and an empty chip row
 * would have read as "none assigned yet" rather than "parked".
 *
 * Renders the chips (or the warning) and nothing around them: each caller owns its own wrapper,
 * because the card, the panel and a table cell lay them out differently while agreeing exactly on
 * what is shown and what it is called.
 */
export function RuntimeRoleChips({ roles }: { readonly roles: readonly string[] }): React.JSX.Element {
  if (roles.length === 0) {
    return (
      <span data-testid="not-dispatchable" className="text-[10.5px] text-tone-blocked">
        {NOT_DISPATCHABLE_TEXT}
      </span>
    )
  }
  return (
    <>
      {roles.map((role) => (
        <Chip key={role}>
          <span data-testid="runtime-role-chip">{role}</span>
        </Chip>
      ))}
    </>
  )
}
