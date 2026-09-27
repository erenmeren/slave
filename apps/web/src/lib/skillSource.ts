import { skillSourceOf } from '@slave-of-ai/domain'

/**
 * How a skill's SOURCE is drawn (workforce cards spec §2/§3). A plugin is a skill source, not a new
 * concept (decision 5), so a card only says "came with a plugin", "comes from the skill library"
 * (installed for the workers, outside the operator's own `~/.claude`) or "is on your own disk" --
 * the plugin's or library source's name goes in the tooltip.
 */
export const SKILL_SOURCE_GLYPH = { local: '🧩', plugin: '🔌', library: '📚' } as const

/** The one glyph a card prints for this provider -- 🔌 plugin, 📚 library, 🧩 anything else local. */
export function skillGlyphOf(providerName: string): string {
  return SKILL_SOURCE_GLYPH[skillSourceOf(providerName).kind]
}

/** The tooltip on the glyph: WHICH plugin, or which of the two local roots. */
export function skillSourceTitle(providerName: string): string {
  const source = skillSourceOf(providerName)
  if (source.kind === 'plugin') return `from the ${source.plugin} plugin`
  if (source.kind === 'library') return `from the ${source.library} library`
  if (providerName === 'project') return 'from this project'
  if (providerName === 'personal') return 'from your skills'
  return `from ${providerName}`
}

/** One heading in the skill picker. `order` sorts the groups; a label sorts inside an order. */
export interface SkillGroup {
  readonly key: string
  readonly label: string
  readonly order: number
}

/** "Your skills", then "Project", then one group per plugin, then one per library source, then
 *  anything this build does not know -- shown under its own provider name rather than hidden. */
export function skillGroupOf(providerName: string): SkillGroup {
  if (providerName === 'personal') return { key: providerName, label: 'Your skills', order: 0 }
  if (providerName === 'project') return { key: providerName, label: 'Project', order: 1 }
  const source = skillSourceOf(providerName)
  if (source.kind === 'plugin') return { key: providerName, label: `${SKILL_SOURCE_GLYPH.plugin} ${source.plugin}`, order: 2 }
  if (source.kind === 'library') return { key: providerName, label: `${SKILL_SOURCE_GLYPH.library} ${source.library}`, order: 3 }
  return { key: providerName, label: providerName, order: 4 }
}
