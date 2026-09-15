/**
 * WHY a PERSON exists (M50 R1, moved to `Person.lifecycle` by M58 R1), as data.
 *
 * `permanent` is somebody who belongs to a department of a company; `project` is somebody hired for
 * one project; `ephemeral` is a specialist brought in for exactly ONE assignment, who is released
 * when that assignment is over.
 *
 * A COLUMN, never a derivation, and a fact about the PERSON rather than about any one seat: the
 * same person may sit on three projects and is not three different kinds of hire.
 *
 * M58 keeps all THREE members (spec erratum E2). `permanent` outlived the roster COPY it was named
 * for -- a person in a department is exactly what it now means -- and `enum-parity.test.ts` pins
 * this list member-for-member against the `SlaveLifecycle` enum in the schema.
 *
 * The order is the one a person reads them in: most permanent first.
 */
export const SLAVE_LIFECYCLES = ['permanent', 'project', 'ephemeral'] as const

export type SlaveLifecycle = (typeof SLAVE_LIFECYCLES)[number]

/**
 * What each lifecycle is called when a person reads it (`docs/ia.md` rule 3). `Record<SlaveLifecycle,
 * string>` is load-bearing: a fourth member fails the build here rather than turning up on the
 * Organization tab as an identifier.
 */
export const SLAVE_LIFECYCLE_LABEL: Record<SlaveLifecycle, string> = {
  permanent: 'Permanent',
  project: 'Project',
  ephemeral: 'Ephemeral',
}
