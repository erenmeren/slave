import { describe, expect, it } from 'vitest'
import { SKILL_SOURCE_GLYPH, skillGlyphOf, skillGroupOf, skillSourceTitle } from '../src/lib/skillSource.js'

describe('skillSource', () => {
  it('marks a plugin skill 🔌 and a personal or project skill 🧩', () => {
    expect(skillGlyphOf('plugin:superpowers')).toBe(SKILL_SOURCE_GLYPH.plugin)
    expect(skillGlyphOf('personal')).toBe('🧩')
    expect(skillGlyphOf('project')).toBe('🧩')
    expect(SKILL_SOURCE_GLYPH.plugin).toBe('🔌')
  })

  it('marks a library skill 📚 and names its source', () => {
    expect(skillGlyphOf('library:trailofbits')).toBe('📚')
    expect(skillSourceTitle('library:trailofbits')).toBe('from the trailofbits library')
    expect(skillGroupOf('library:trailofbits')).toEqual({ key: 'library:trailofbits', label: '📚 trailofbits', order: 3 })
  })

  it('names the plugin in the tooltip', () => {
    expect(skillSourceTitle('plugin:superpowers')).toBe('from the superpowers plugin')
    expect(skillSourceTitle('personal')).toBe('from your skills')
    expect(skillSourceTitle('project')).toBe('from this project')
  })

  it('groups Your skills, then Project, then one group per plugin', () => {
    expect(skillGroupOf('personal')).toEqual({ key: 'personal', label: 'Your skills', order: 0 })
    expect(skillGroupOf('project')).toEqual({ key: 'project', label: 'Project', order: 1 })
    expect(skillGroupOf('plugin:superpowers')).toEqual({ key: 'plugin:superpowers', label: '🔌 superpowers', order: 2 })
    expect(skillGroupOf('somewhere-else')).toEqual({ key: 'somewhere-else', label: 'somewhere-else', order: 4 })
  })
})
