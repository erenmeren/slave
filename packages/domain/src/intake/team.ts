import { MANAGER_ROLE, REVIEWER_ROLE } from '../supervisor/constants.js'
import type { IntakeSeat } from './draft.js'
import type { IntakeCatalogueEntry } from './facts.js'

/**
 * Which division a manager and a reviewer are added to when nobody holds them.
 *
 * The Agency persona catalogue has no `manager` and no `reviewer` division -- the roles this
 * system dispatches on are a ROLE MAP over personas, not names in the catalogue -- so the rule
 * picks the first seat whose division looks like the work being reviewed, and falls back to the
 * first seat of all. A regex over free text because `sourceDivision` IS free text: it is the
 * directory a persona file was imported from.
 */
const ENGINEERING_DIVISION = /engineer|develop|software|backend|frontend|platform|infra/iu

/**
 * A team that can actually be planned and reviewed (M59 R13).
 *
 * `dispatchPlanning` refuses a project with nobody holding `manager`
 * (`apps/orchestrator/src/planning.ts`, `guardrail.tripped { no_planner }`) and a review needs
 * somebody holding `reviewer`, so a suggested team without both is a project that looks staffed
 * and does nothing. This adds the missing role (or roles) to ONE seat rather than inventing a
 * seat: a person reading the card sees who carries it.
 *
 * An EMPTY team is left empty, deliberately. "I will staff it myself" is a real answer, and the
 * project then shows M38's `no_planner` situation exactly as an unstaffed project does today.
 */
export function ensureStaffRoles(
  team: readonly IntakeSeat[],
  catalogue: readonly IntakeCatalogueEntry[],
): readonly IntakeSeat[] {
  if (team.length === 0) return []
  const seats = team.map((seat) => ({ templateId: seat.templateId, runtimeRoles: [...seat.runtimeRoles] }))
  const divisionOf = new Map(catalogue.map((entry) => [entry.templateId, entry.division ?? '']))
  const engineering = seats.findIndex((seat) => ENGINEERING_DIVISION.test(divisionOf.get(seat.templateId) ?? ''))
  const chosen = seats[engineering === -1 ? 0 : engineering]
  // Unreachable -- `seats.length > 0` and the index is either a `findIndex` hit or 0 -- and spelled
  // because `noUncheckedIndexedAccess` is on and a silent `!` is how that setting stops helping.
  if (chosen === undefined) return seats
  for (const role of [MANAGER_ROLE, REVIEWER_ROLE]) {
    if (!seats.some((seat) => seat.runtimeRoles.includes(role))) chosen.runtimeRoles.push(role)
  }
  return seats
}
