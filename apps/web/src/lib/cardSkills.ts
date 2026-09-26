import { effectiveSkills, isProcessSkill, type SkillOrigin } from '@slave-of-ai/domain'

/**
 * One skill chip on a workforce card (spec §2), as both card reads hand it to the client.
 *
 * `state` is the person panel's own three-state word (`PersonSkillRow.state`, M58 R23): `persona`
 * for a skill inherited from the persona, `person` for this person's own grant, `revoked` for an
 * inherited skill this person said no to. A persona card only ever holds `persona`.
 */
export interface CardSkillRow {
  readonly skillId: string
  readonly name: string
  readonly providerName: string
  /** `Skill.missingSince` is set: a scan could not find it on disk (an uninstalled plugin, say).
   *  The link stays -- the catalog never deletes -- and the chip is drawn greyed. */
  readonly missing: boolean
  /** {@link isProcessSkill}, computed once here so no client has to. */
  readonly process: boolean
  readonly state: SkillOrigin | 'revoked'
}

/** The columns a chip needs, as ONE Prisma `select` both reads share. */
export const CARD_SKILL_SELECT = {
  id: true,
  name: true,
  missingSince: true,
  provider: { select: { name: true } },
} as const

/** What {@link CARD_SKILL_SELECT} reads back. */
export interface CardSkillSource {
  readonly id: string
  readonly name: string
  readonly missingSince: Date | null
  readonly provider: { readonly name: string }
}

/** One `CardSkillSource` row, plus the state its own caller already knows, turned into the chip. */
export function cardSkillOf(skill: CardSkillSource, state: CardSkillRow['state']): CardSkillRow {
  return {
    skillId: skill.id,
    name: skill.name,
    providerName: skill.provider.name,
    missing: skill.missingSince !== null,
    process: isProcessSkill({ name: skill.name, providerName: skill.provider.name }),
    state,
  }
}

/** Held skills by name, then the revoked ones -- the order every card draws its chips in. */
export function byCardOrder(a: CardSkillRow, b: CardSkillRow): number {
  const revoked = Number(a.state === 'revoked') - Number(b.state === 'revoked')
  return revoked !== 0 ? revoked : a.name.localeCompare(b.name)
}

/**
 * A person's chips (workforce cards §2): the EFFECTIVE set -- `effectiveSkills`, the same function
 * dispatch uses, so the card cannot promise a skill a run will not get -- each with its origin,
 * then every inherited skill this person REVOKED, struck through, because a person cannot restore
 * what they cannot see (the person panel's rule, M58 R23).
 */
export function personCardSkills(input: {
  readonly templateSkills: readonly CardSkillSource[]
  readonly personSkills: readonly (CardSkillSource & { readonly mode: 'granted' | 'revoked' })[]
}): readonly CardSkillRow[] {
  const byId = new Map([...input.templateSkills, ...input.personSkills].map((skill) => [skill.id, skill] as const))
  const revoked = input.personSkills.filter((skill) => skill.mode === 'revoked').map((skill) => skill.id)
  const effective = effectiveSkills({
    templateSkillIds: input.templateSkills.map((skill) => skill.id),
    granted: input.personSkills.filter((skill) => skill.mode === 'granted').map((skill) => skill.id),
    revoked,
  })
  const held = effective.flatMap((row) => {
    const skill = byId.get(row.skillId)
    return skill === undefined ? [] : [cardSkillOf(skill, row.origin)]
  })
  const struck = input.templateSkills.filter((skill) => revoked.includes(skill.id)).map((skill) => cardSkillOf(skill, 'revoked'))
  return [...held, ...struck].toSorted(byCardOrder)
}
