/**
 * WHY a worker exists (M50 R1), as data.
 *
 * `permanent` is somebody who exists in the COMPANY ROSTER and was materialised onto this project;
 * `project` is somebody hired for this project; `ephemeral` is a specialist brought in for exactly
 * ONE assignment, who is released when that assignment is over.
 *
 * A COLUMN, never a derivation. Until this milestone three surfaces derived `company | project`
 * from `Slave.companySlaveId` being null (`packages/control/src/capability.ts`,
 * `apps/web/src/server/organization.ts`, `apps/web/src/server/brief.ts`) -- three readings of one
 * question, none of which could say "this one is temporary" because the schema held no such fact.
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
