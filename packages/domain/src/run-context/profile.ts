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
