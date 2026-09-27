import type { CardSkillRow } from './cardSkills'

/**
 * Which table a card's skill write lands in (workforce cards §3) -- a pure function, so the scope
 * rule is one place a test can read rather than a branch inside a click handler.
 *
 *   - A PERSONA card always writes the persona, as a delta (`{ add }` / `{ remove }`).
 *   - A PERSON card writes the person (`grant`, `revoke`, `clear`) unless the operator chose
 *     "Everyone from <persona>", which writes the persona the person was hired from.
 *   - A person's OWN grant is cleared whatever the scope says: the persona never had it, so there
 *     is nothing of the persona's to remove.
 */
export type SkillScope = 'person' | 'persona'

/** Which card sent the write, and what it targets (workforce cards §3). */
export type SkillTarget =
  | { readonly kind: 'persona'; readonly templateId: string }
  | {
      readonly kind: 'person'
      readonly personId: string
      /** Null for a person made from nothing: "Everyone from <persona>" has nobody to write. */
      readonly personaId: string | null
      readonly personaName: string | null
    }

/** One PATCH a card sends: the route it goes to, and the body that route already understands. */
export interface SkillWrite {
  readonly url: string
  readonly body: Readonly<Record<string, readonly string[]>>
}

const personaWrite = (templateId: string, body: SkillWrite['body']): SkillWrite => ({
  url: `/api/org/templates/${templateId}/skills`,
  body,
})

const personWrite = (personId: string, body: SkillWrite['body']): SkillWrite => ({
  url: `/api/persons/${personId}/skills`,
  body,
})

/** The write for "+ skill" on a card: a persona delta, a person grant, or -- with the "everyone
 *  from <persona>" scope -- the persona delta on the person's own persona. */
export function addSkillWrite(target: SkillTarget, skillId: string, scope: SkillScope): SkillWrite {
  if (target.kind === 'persona') return personaWrite(target.templateId, { add: [skillId] })
  if (scope === 'persona' && target.personaId !== null) return personaWrite(target.personaId, { add: [skillId] })
  return personWrite(target.personId, { grant: [skillId] })
}

/** The write for removing a chip: a persona delta, a person revoke/clear (by the chip's own
 *  `state`), or -- with the "everyone from <persona>" scope -- the persona delta. */
export function removeSkillWrite(
  target: SkillTarget,
  skill: { readonly skillId: string; readonly state: CardSkillRow['state'] },
  scope: SkillScope,
): SkillWrite {
  if (target.kind === 'persona') return personaWrite(target.templateId, { remove: [skill.skillId] })
  if (skill.state !== 'persona') return personWrite(target.personId, { clear: [skill.skillId] })
  if (scope === 'persona' && target.personaId !== null) return personaWrite(target.personaId, { remove: [skill.skillId] })
  return personWrite(target.personId, { revoke: [skill.skillId] })
}

/** A struck-through (revoked) chip's "restore": take back what this person said, so the persona
 *  speaks again -- the person panel's own `clear`. */
export function restoreSkillWrite(target: SkillTarget & { readonly kind: 'person' }, skillId: string): SkillWrite {
  return personWrite(target.personId, { clear: [skillId] })
}
