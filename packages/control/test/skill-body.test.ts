import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readSkillBody } from '../src/skills.js'

/** A skill directory with whatever `SKILL.md` content the case needs -- `readSkillBody` is pure
 *  filesystem, so no catalog row or provider root is needed to exercise it. */
function skillDir(content: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-skill-body-'))
  if (content !== null) writeFileSync(join(dir, 'SKILL.md'), content)
  return dir
}

describe('readSkillBody (conductor R6)', () => {
  it('returns null when SKILL.md is missing', () => {
    expect(readSkillBody(skillDir(null))).toBeNull()
  })

  it('returns null when the directory itself does not exist', () => {
    expect(readSkillBody(join(tmpdir(), 'slaveofai-skill-body-does-not-exist'))).toBeNull()
  })

  it('returns the empty string for a file that is front matter and nothing else', () => {
    const dir = skillDir('---\nname: x\ndescription: y\n---\n')
    expect(readSkillBody(dir)).toBe('')
  })

  it('returns the whole file, trimmed, when there is no front matter at all', () => {
    const dir = skillDir('\n  Just a plain skill file, no front matter.  \n')
    expect(readSkillBody(dir)).toBe('Just a plain skill file, no front matter.')
  })

  it('returns the body after the front matter, trimmed, for a normal skill file', () => {
    const dir = skillDir('---\nname: x\ndescription: y\n---\n\nDo the thing carefully.\n\nAnd check it twice.\n')
    expect(readSkillBody(dir)).toBe('Do the thing carefully.\n\nAnd check it twice.')
  })
})
