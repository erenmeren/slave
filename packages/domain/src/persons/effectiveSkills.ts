import type { SkillOrigin } from './types.js'

/** What the three sources of a person's skills are, already read (R3). Ids, never rows: this
 *  function is asked the same question by a run-context builder holding `Skill` rows and by a web
 *  read model holding nothing but the join tables. */
export interface EffectiveSkillInput {
  /** `TemplateSkill.skillId` for the persona this person was hired from. Empty for a person made
   *  from nothing, and empty for a person whose persona has no default skills. */
  readonly templateSkillIds: readonly string[]
  /** `PersonSkill.skillId` where `mode = granted`. */
  readonly granted: readonly string[]
  /** `PersonSkill.skillId` where `mode = revoked`. */
  readonly revoked: readonly string[]
}

export interface EffectiveSkill {
  readonly skillId: string
  readonly origin: SkillOrigin
}

/**
 * The skills a person actually has: template ∪ granted − revoked (R3).
 *
 * COMPUTED, never copied. Changing a persona's default skills changes every person hired from it at
 * once, which is the whole of D4 — and is only true because nothing anywhere writes the union into
 * a row.
 *
 * A revoke beats a grant of the same skill. The two are not a race: `setPersonSkills` writes ONE
 * `PersonSkill` row per skill with one `mode`, so the pair can only both appear if a caller built
 * this argument from two unrelated queries — and then the safe reading of "somebody said no" is
 * that they meant it.
 *
 * `origin` says `persona` for anything the template supplies, EVEN when the person also granted it:
 * the row is inherited and would survive the grant being taken away, and a panel that called it a
 * personal grant would offer to remove something removing does not remove.
 *
 * Sorted by `skillId` so two calls with the same set in a different order are the same answer --
 * every surface that renders this list renders it in this order, and a test can assert it.
 */
export function effectiveSkills(input: EffectiveSkillInput): readonly EffectiveSkill[] {
  const revoked = new Set(input.revoked)
  const persona = new Set(input.templateSkillIds)
  const rows = new Map<string, EffectiveSkill>()
  for (const skillId of persona) {
    if (revoked.has(skillId)) continue
    rows.set(skillId, { skillId, origin: 'persona' })
  }
  for (const skillId of input.granted) {
    if (revoked.has(skillId) || rows.has(skillId)) continue
    rows.set(skillId, { skillId, origin: 'person' })
  }
  return [...rows.values()].toSorted((a, b) => a.skillId.localeCompare(b.skillId))
}

/** {@link effectiveSkills} without the origins -- what a dispatch needs, which is the set and
 *  nothing about where it came from. */
export function effectiveSkillIds(input: EffectiveSkillInput): readonly string[] {
  return effectiveSkills(input).map((row) => row.skillId)
}
