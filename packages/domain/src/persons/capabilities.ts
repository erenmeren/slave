/**
 * Final review, Important 2: the two sources a MANAGED person's capability set has, and the pure
 * arithmetic that combines them.
 *
 * A managed person (`Person.poolSlot` non-null) provides two things that used to be stored as one:
 * whatever their TEMPLATE says today (`SlaveTemplate.capabilityKeys`, the baseline) and whatever
 * somebody granted them ON TOP of it (`Person.capabilityGrants`). `syncPersonPool` rewrites the
 * baseline half on every pass, so storing only the union in `Person.capabilities` left two
 * mutually exclusive failures and no third option: write the baseline and an explicit grant is
 * erased on the next sync, or write the union and a key the template has since DROPPED can never
 * disappear -- because nothing in one column can tell "the template used to say this" from "a
 * person said this".
 *
 * Both functions are PURE and total, and both return a sorted, deduplicated array: these values
 * are compared as sets everywhere they are read, and a canonical order means a re-derivation that
 * happens to walk its input differently does not look like a change and provoke a write.
 */

/** Sorted, deduplicated -- the one shape both functions below return. */
function canonical(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted()
}

/**
 * What a managed person actually provides: the union of their template's CURRENT baseline and
 * their own explicit grants.
 *
 * This is what gets stored in `Person.capabilities`, so every existing reader -- the scheduler,
 * `formTeam`'s roster, the Organization view -- keeps reading one column and needs to know nothing
 * about the split.
 */
export function effectiveCapabilities(baseline: readonly string[], grants: readonly string[]): string[] {
  return canonical([...baseline, ...grants])
}

/**
 * What a request for an EFFECTIVE set implies about the grants: exactly the keys asked for that the
 * baseline does not already carry.
 *
 * The subtraction is what keeps `capabilityGrants` honest. Recording the whole request would
 * freeze today's baseline into the grant column, and the very next template edit would no longer
 * reach this person -- the drift the split exists to prevent, reintroduced from the other side.
 *
 * Nothing here can REMOVE a baseline key: a request narrower than the baseline yields no grants,
 * and {@link effectiveCapabilities} then restores the baseline in full. That is deliberate -- the
 * template is the persona, and taking a capability off one person while leaving it on the persona
 * is a template edit, not a person edit.
 */
export function capabilityGrantDelta(requested: readonly string[], baseline: readonly string[]): string[] {
  const base = new Set(baseline)
  return canonical(requested.filter((key) => !base.has(key)))
}
