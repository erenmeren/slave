import { prisma } from '@slave-of-ai/db/client'
import { rosterSlug } from '@slave-of-ai/domain'

/** The name the runtime gives a helper started with no definition of the roster. */
export const GENERAL_HELPER_DEFINITION = 'general-purpose'
export const GENERAL_HELPER_NAME = 'General helper'

/** Who stands behind a helper session's definition: the roster person, or nobody. */
export interface HelperIdentity {
  readonly name: string
  /** The catalogue person; null for a general helper and for a definition no roster person answers to. */
  readonly personId: string | null
}

/**
 * Turns a helper session's definition into the roster person behind it, for the read models that
 * look across projects (Analytics, Home's feed). A definition is a slug of the person's name, made
 * unique within the roster in the roster's own order -- `buildRosterDefinitions`' rule, repeated
 * here from the names alone: that function also gathers every person's instructions and skill
 * files, which a read polled every few seconds must not do. A definition nobody on the roster
 * answers to (a person since released or renamed) keeps its own word.
 */
export async function helperIdentities(rosters: ReadonlyMap<string, readonly string[]>): Promise<(workspaceId: string, definition: string) => HelperIdentity> {
  const personIds = [...new Set([...rosters.values()].flat())]
  const persons = personIds.length === 0 ? [] : await prisma.person.findMany({ where: { id: { in: personIds }, releasedAt: null }, select: { id: true, name: true } })
  const nameOf = new Map(persons.map((person) => [person.id, person.name]))
  const byWorkspace = new Map<string, Map<string, HelperIdentity>>()
  for (const [workspaceId, roster] of rosters) {
    const slugs = new Map<string, HelperIdentity>()
    for (const personId of roster) {
      const name = nameOf.get(personId)
      if (name === undefined) continue
      const base = rosterSlug(name)
      let key = base
      for (let n = 2; slugs.has(key); n += 1) key = `${base}-${String(n)}`
      slugs.set(key, { name, personId })
    }
    byWorkspace.set(workspaceId, slugs)
  }
  return (workspaceId, definition) => {
    if (definition === GENERAL_HELPER_DEFINITION) return { name: GENERAL_HELPER_NAME, personId: null }
    return byWorkspace.get(workspaceId)?.get(definition) ?? { name: definition, personId: null }
  }
}
