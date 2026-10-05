import { SUBORDINATE_TOOLS } from './constants.js'

/**
 * Lead UX design section 6.3 ("Who is working"): one line of what a session is doing now, from the
 * newest tool call on its stream. `summary` is the stream's own action line -- the tool's name, a
 * space, and its one readable argument (`summaryFor` in the providers package) -- so the argument
 * is everything after the first space. A file path is cut to its last two parts: the worktree's
 * absolute prefix says nothing to a person.
 */
export function doingSentence(name: string, summary: string): string {
  const space = summary.indexOf(' ')
  const arg = space === -1 ? '' : summary.slice(space + 1).trim()
  const file = shortPath(arg)
  if (SUBORDINATE_TOOLS.includes(name)) return 'Handing work to a helper'
  switch (name) {
    case 'Bash':
      return arg === '' ? 'Running a command' : `Running ${arg}`
    case 'Read':
      return file === '' ? 'Reading the code' : `Reading ${file}`
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return file === '' ? 'Editing the code' : `Editing ${file}`
    case 'Write':
      return file === '' ? 'Writing a file' : `Writing ${file}`
    case 'Grep':
    case 'Glob':
    case 'LS':
      return 'Searching the code'
    case 'WebFetch':
    case 'WebSearch':
      return 'Looking something up'
    case 'TodoWrite':
      return 'Planning its next steps'
    case 'Skill':
      return arg === '' ? 'Using a skill' : `Using the skill ${arg}`
    default:
      return 'Working'
  }
}

/** The last two parts of a path; anything that does not look like a path is returned as it is. */
export function shortPath(value: string): string {
  if (!value.includes('/')) return value
  const parts = value.split('/').filter((part) => part !== '')
  return parts.slice(-2).join('/')
}
