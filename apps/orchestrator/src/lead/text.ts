/**
 * Lead flow (final review): the two ways the lead's code shortens another party's text for a note
 * or a card, in one place -- they had been copied into each file that needed them.
 */

/** The first line of what a failed git call said: its stderr, else the error's own message. */
export function gitError(error: unknown): string {
  const stderr = typeof error === 'object' && error !== null ? (error as { readonly stderr?: unknown }).stderr : undefined
  const text = typeof stderr === 'string' && stderr.trim() !== '' ? stderr : error instanceof Error ? error.message : String(error)
  return text.trim().split('\n')[0] ?? ''
}

/** The first line of `text`, cut at `max` characters. */
export function firstLine(text: string, max: number): string {
  return (text.split('\n')[0] ?? '').slice(0, max)
}
