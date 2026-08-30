export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The argument keys Claude's tool calls carry, in priority order -- the keys `summaryFor` looks
 * under for the one readable argument that turns a bare tool name into an action line a human can
 * read at a glance (M4 spec §1): `Write /abs/note3.txt` rather than
 * `Write toolu_01UCoRZm85rNxfupNQPToZXL`.
 */
export const CLAUDE_SUMMARY_ARG_KEYS = [
  // First, deliberately: a `Skill` tool_use carries `{"skill": "<plugin>:<name>"}` and nothing
  // else worth showing (M14 §4.1, measured from `test/fixtures/claude/skill-tool-use.ndjson`,
  // whose README carries the binary version and the command). Ahead of `description` because a
  // future CLI adding a `description` beside it must not shadow the one argument that names the
  // skill -- without this key every skill call in the product reads as the bare word `Skill`.
  'skill',
  'file_path',
  'path',
  'notebook_path',
  'command',
  'pattern',
  'url',
  'query',
  'description',
  'prompt',
] as const

/**
 * Cursor's own vocabulary, deliberately NOT merged with Claude's (M13 Task 5).
 *
 * ONLY `path` is measured: the recorded run's single tool call is a read. `command` is here
 * because the shell tool is the entire subject of Cursor's write gate and a shell action line
 * without its command is useless; the rest are absent deliberately rather than guessed at. Merging
 * the two lists would change which argument each runtime's action line shows -- a behavior change,
 * in the one series that must not have one.
 */
export const CURSOR_SUMMARY_ARG_KEYS = ['path', 'command'] as const

const SUMMARY_ARG_MAX_LENGTH = 80

function firstStringArg(args: unknown, keys: readonly string[]): string | null {
  if (!isRecord(args)) return null
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string') return value
  }
  return null
}

/**
 * `<tool name> <its one readable argument>`, or the bare tool name.
 *
 * First string match among `keys` wins; a value present but not a string (or no known key present
 * at all) falls through to the bare tool name, same as `args` being absent entirely.
 */
export function summaryFor(toolName: string, args: unknown, keys: readonly string[]): string {
  const raw = firstStringArg(args, keys)
  if (raw === null) return toolName

  // Collapse newlines/tabs/runs of spaces to one space, so a multiline command reads as one line
  // rather than blowing up the action line's height.
  const normalized = raw.replace(/\s+/g, ' ').trim()
  if (normalized.length === 0) return toolName

  const trimmedArg =
    normalized.length > SUMMARY_ARG_MAX_LENGTH ? `${normalized.slice(0, SUMMARY_ARG_MAX_LENGTH)}…` : normalized
  return `${toolName} ${trimmedArg}`
}
