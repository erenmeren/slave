/**
 * The one formatting of a slave's persona-facing identity (M37 §3) -- used wherever a title,
 * not a runtime role set, is what a reader wants: a message envelope, a CLI listing.
 */
export function displayName(slave: { readonly name: string; readonly role: string }): string {
  return `${slave.name} (${slave.role})`
}

/**
 * The one formatting of a slave's roster-facing identity (M37 §3): name, its persona title, the
 * roles it may actually be dispatched as, and its id -- used by the ask roster, delivery, and the
 * CLI wherever a reader needs to pick a slave by id rather than by name alone (names are not
 * unique; ids are).
 */
export function rosterLine(slave: {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly runtimeRoles: readonly string[]
}): string {
  const roles = slave.runtimeRoles.length > 0 ? slave.runtimeRoles.join(', ') : 'none'
  return `${slave.name} (${slave.role}; roles: ${roles}) — id ${slave.id}`
}
