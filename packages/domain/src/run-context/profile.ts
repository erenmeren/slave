/**
 * How long a profile may be (M37 §2).
 *
 * Lives in the domain rather than beside either of its two enforcement points, because there are
 * exactly two and they are in different packages: `packages/control`'s `setProfile` (M37 Task 3)
 * refuses a write past this length, and `apps/orchestrator`'s `buildRunContext` (Task 2) re-checks
 * it at dispatch -- the case the spec §7 names, a text written while the cap was higher. Two
 * copies of the number would let a profile be writable and undispatchable at the same time.
 *
 * 16k characters is roughly four thousand tokens: a persona long enough to be a working brief and
 * short enough that it cannot crowd the task out of the prompt it is prepended to.
 */
export const PROFILE_MAX_CHARS = 16_000

/**
 * The profile that actually applies to a slave, and which level it came from (M37 §2).
 *
 * The same override chain `model` and `provider` already walk: the worker's own column, then its
 * roster link's, then the template's. An empty string is treated as no profile at that level's
 * OWN position (it wins the `??` chain and then renders nothing), which is what "cleared" means on
 * a column whose absent value is `null` -- see `setProfile`'s `--clear` (M37 t3).
 *
 * Lives here rather than beside its first caller (`apps/orchestrator/src/runContext.ts`, where
 * M37 t2 wrote it) because it has two callers in two packages now: the run-context builder and
 * the web's profile panel (t4), and the web may not import from an application. Pure, so it needs
 * neither.
 */
export function effectiveProfile(slave: {
  readonly profile: string | null
  readonly companySlave: {
    readonly profile: string | null
    readonly template: { readonly profile: string | null }
  } | null
}): { readonly text: string; readonly origin: 'slave' | 'company' | 'template' } | null {
  if (slave.profile !== null) return slave.profile === '' ? null : { text: slave.profile, origin: 'slave' }
  if (slave.companySlave === null) return null
  const company = slave.companySlave
  if (company.profile !== null) return company.profile === '' ? null : { text: company.profile, origin: 'company' }
  const template = company.template.profile
  if (template !== null) return template === '' ? null : { text: template, origin: 'template' }
  return null
}
