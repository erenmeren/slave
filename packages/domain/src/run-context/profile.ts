/**
 * How long a profile may be (M37 §2).
 *
 * Lives in the domain rather than beside either of its two enforcement points, because there are
 * exactly two and they are in different packages: `packages/control`'s `setProfile` (M37 Task 3)
 * refuses a write past this length, and `apps/orchestrator`'s `buildRunContext` (Task 2) re-checks
 * it at dispatch -- the case the spec §7 names, a text written while the cap was higher. Two
 * copies of the number would let a profile be writable and undispatchable at the same time.
 *
 * 48k characters is roughly twelve thousand tokens. M37 set 16k ("a working brief that cannot
 * crowd the task out"); raised in 2026-09 when the Agency persona catalogue was made the default
 * roster and 87 of its 279 personas -- the longest 34,597 characters -- fell over the old cap.
 * 48k takes every one of them with room to spare while keeping the ceiling well under what a
 * single persona should ever cost per run; a persona near the cap is prepended to EVERY run of a
 * worker hired from it, so the number is a ceiling, not a target.
 */
export const PROFILE_MAX_CHARS = 48_000

/**
 * M58 R7: the chain itself moved to `packages/domain/src/persons/overrides.ts`
 * (`effectiveProfileFor`), because it is now three levels of seat -> person -> template and model
 * and provider walk the SAME ladder. This file keeps the cap alone, which is what its two
 * enforcement points -- `setProfile` and `buildRunContext` -- actually share.
 */
