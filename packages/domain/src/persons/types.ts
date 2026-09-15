/**
 * The shapes M58 introduces, in the one place a pure function and a Prisma read can both agree on.
 *
 * `Person` is the human; `Slave` (in the database, and everywhere the scheduler looks) is the SEAT
 * that person holds on one project. This file names neither table — it names what a caller has to
 * hand a pure function, so `packages/control`, `apps/orchestrator` and `apps/web` can all build the
 * same argument out of whatever query they happened to run.
 */

/** What a `PersonSkill` row SAYS: this person has this skill on top of their persona's set, or
 *  this person does not have it even though their persona does (R11). The database enum
 *  `SkillGrantMode` mirrors this union member for member -- `enum-parity.test.ts` is what holds the
 *  two together, because nothing in TypeScript does. */
export const SKILL_GRANT_MODES = ['granted', 'revoked'] as const
export type SkillGrantMode = (typeof SKILL_GRANT_MODES)[number]

/** Where an effective skill came from: the persona the person was hired from, or the person's own
 *  grant. A revoked skill is not in the effective set at all, so `revoked` is not an origin. */
export type SkillOrigin = 'persona' | 'person'

/** Which level of the seat -> person -> template chain answered (R7). `seat` is `Slave`'s own
 *  column, `person` is `Person`'s, `template` is `SlaveTemplate`'s. */
export type OverrideOrigin = 'seat' | 'person' | 'template'

/** The three levels of one override, already read. `null` at a level means "this level says
 *  nothing"; an empty STRING is a level saying "cleared", which is a different thing and only
 *  {@link effectiveProfileFor} distinguishes it. */
export interface OverrideLevels<T> {
  readonly seat: T | null
  readonly person: T | null
  readonly template: T | null
}

export interface Resolved<T> {
  readonly value: T
  readonly origin: OverrideOrigin
}

/** One seat, as every read model and every pure function sees it. `closedAt` non-null is a seat
 *  the person was removed from: it keeps its runs, its messages and its permissions as history and
 *  the scheduler never looks at it again (R2, R17). */
export interface PersonSeat {
  readonly slaveId: string
  readonly teamId: string
  readonly teamName: string
  readonly workspaceId: string
  readonly projectName: string
  readonly role: string
  readonly runtimeRoles: readonly string[]
  readonly closedAt: string | null
}
