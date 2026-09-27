import { skillSourceOf } from '@slave-of-ai/domain'

/**
 * How a skill's SOURCE is drawn (workforce cards spec §2/§3). Two glyphs and no more: a plugin is a
 * skill source, not a new concept (decision 5), so the only distinction a card makes is "came with
 * a plugin" versus "is on your own disk" -- the plugin's name goes in the tooltip.
 */
export const SKILL_SOURCE_GLYPH = { local: '🧩', plugin: '🔌' } as const

/** The one glyph a card prints for this provider -- 🔌 for a plugin, 🧩 for anything on local disk. */
export function skillGlyphOf(providerName: string): string {
  return SKILL_SOURCE_GLYPH[skillSourceOf(providerName).kind]
}

/** The tooltip on the glyph: WHICH plugin, or which of the two local roots. */
export function skillSourceTitle(providerName: string): string {
  const source = skillSourceOf(providerName)
  if (source.kind === 'plugin') return `from the ${source.plugin} plugin`
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

/** "Your skills", then "Project", then one group per plugin, then anything this build does not
 *  know -- shown under its own provider name rather than hidden. */
export function skillGroupOf(providerName: string): SkillGroup {
  if (providerName === 'personal') return { key: providerName, label: 'Your skills', order: 0 }
  if (providerName === 'project') return { key: providerName, label: 'Project', order: 1 }
  const source = skillSourceOf(providerName)
  if (source.kind === 'plugin') return { key: providerName, label: `${SKILL_SOURCE_GLYPH.plugin} ${source.plugin}`, order: 2 }
  return { key: providerName, label: providerName, order: 3 }
}
