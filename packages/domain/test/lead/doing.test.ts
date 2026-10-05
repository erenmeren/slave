import { describe, expect, it } from 'vitest'
import { doingSentence, shortPath } from '../../src/lead/index.js'

describe('doingSentence (lead UX design section 6.3)', () => {
  it('says what a command, a read and an edit are doing, with the path cut to its last two parts', () => {
    expect(doingSentence('Bash', 'Bash npm test')).toBe('Running npm test')
    expect(doingSentence('Read', 'Read /home/x/worktrees/t1/src/app.ts')).toBe('Reading src/app.ts')
    expect(doingSentence('Edit', 'Edit /home/x/worktrees/t1/src/app.ts')).toBe('Editing src/app.ts')
    expect(doingSentence('Write', 'Write README.md')).toBe('Writing README.md')
  })

  it('reads a subordinate call as handing work to a helper, under either tool name', () => {
    const tool = 'Agent'
    expect(doingSentence(tool, `${tool} build the login page`)).toBe('Handing work to a helper')
    expect(doingSentence('Task', 'Task build the login page')).toBe('Handing work to a helper')
  })

  it('falls back to plain words for a bare name and for a tool it does not know', () => {
    expect(doingSentence('Bash', 'Bash')).toBe('Running a command')
    expect(doingSentence('Grep', 'Grep useState')).toBe('Searching the code')
    expect(doingSentence('mcp__thing__call', 'mcp__thing__call x')).toBe('Working')
  })
})

describe('shortPath', () => {
  it('keeps a word that is not a path, and cuts a path to its last two parts', () => {
    expect(shortPath('npm')).toBe('npm')
    expect(shortPath('/a/b/c/d.ts')).toBe('c/d.ts')
    expect(shortPath('d.ts')).toBe('d.ts')
  })
})
