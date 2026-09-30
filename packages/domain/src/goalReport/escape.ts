import { sanitisePersonText } from '../handoff/contract.js'

const HTML_ENTITY: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

/**
 * One line of Markdown prose or one table cell, from text a person or a model wrote (plan D7).
 * Markers and routing literals are defused (`sanitisePersonText`: the export is text people paste
 * into prompts). Whitespace collapses, so a newline cannot end a table row. HTML is escaped, so
 * no renderer runs a tag. Markdown punctuation is backslash-escaped, so no link, emphasis, code
 * span or cell border can be forged. CommonMark allows a backslash before any ASCII punctuation.
 *
 * A bare URL is a separate hazard escaping brackets does not close: GFM autolinks `http://…`,
 * `https://…`, `ftp://…` and `www.…` even with no `[]()` around them at all -- the link TEXT is
 * always the URL itself (never attacker-chosen text), but a live `javascript:`-lookalike or
 * otherwise misleading link is still worth not rendering (fix round 1, m3). Rather than track
 * every scheme GFM recognises, this escapes the `:` of every `://` as `\://`: a valid CommonMark
 * escape (renders as a plain `:`), and one GFM's autolink scanner does not match, so the text
 * reads the same to a person and stays inert to every renderer.
 */
export function mdInline(text: string): string {
  return sanitisePersonText(text)
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[&<>]/gu, (char) => HTML_ENTITY[char] ?? char)
    .replace(/[\\`*_[\]|~#!()]/gu, (char) => `\\${char}`)
    .replace(/:\/\//gu, '\\://')
}

/**
 * A line that would open a NEW block once `mdQuote` puts it after "> " (fix round 1, I2): a
 * bullet/thematic/setext marker (`-`, `+`, `=`, `*`, `#`) or an ordered-list marker (digits then
 * `.` or `)`) at the very start. `mdInline` (run on the line before this) already backslash-
 * escapes `*`, `#` and `)` wherever they sit, so this only has to catch what it leaves alone: a
 * leading `-`/`+`/`=`, and the `.` an ordered marker's digits end in. Escaping the DELIMITER
 * rather than a leading digit keeps a numbered line readable -- CommonMark cannot backslash-
 * escape a digit (escapes are ASCII-punctuation only), so `\1` would print its backslash, while
 * `1\.` prints as plain `1.`. Both breaks work the same way: block-structure scanning reads raw
 * characters before any backslash escape is resolved, so a backslash anywhere before the marker's
 * last required character stops the line from being read as one.
 */
const BLOCK_MARKER = /^(?:([-+=*#])|(\d+)([.)]))/u

function escapeBlockMarker(line: string): string {
  return line.replace(BLOCK_MARKER, (_whole, symbol: string | undefined, digits: string | undefined, delim: string | undefined) =>
    symbol !== undefined ? `\\${symbol}` : `${digits ?? ''}\\${delim ?? ''}`,
  )
}

/**
 * A fenced block for text whose shape matters: a check, an output, a goal. The fence is one
 * backtick longer than the longest backtick run inside, so the text cannot close it. HTML inside
 * a fence is shown, not run. Markers are still defused.
 */
export function mdFence(text: string): string {
  const body = sanitisePersonText(text).replace(/\r\n?/gu, '\n').replace(/\n+$/u, '')
  let longest = 0
  for (const match of body.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}text\n${body}\n${fence}`
}

/** A quote, line by line: prose keeps its lines, and each line is {@link mdInline}d, then
 *  {@link escapeBlockMarker}d so a line that starts with a block marker cannot reopen one once it
 *  sits after "> " (fix round 1, I2). */
export function mdQuote(text: string): readonly string[] {
  return sanitisePersonText(text)
    .replace(/\r\n?/gu, '\n')
    .replace(/\n+$/u, '')
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${escapeBlockMarker(mdInline(line))}`))
}

const CUT = /\n… \[(\d+) characters cut\] …\n/u

/** How many characters `trimEvidence` cut from this text, or 0 (plan D8). */
export function evidenceCut(text: string): number {
  const match = CUT.exec(text)
  return match === null ? 0 : Number(match[1])
}

/** The heading anchor GitHub-style renderers give `### Evidence for <key>`. Keys are `R<n>` or
 *  `RUN` (`requirementItemsSchema`), so lowercasing is the only mapping needed. */
export function evidenceAnchor(key: string): string {
  return `evidence-for-${key.toLowerCase()}`
}

/**
 * Real money, the web `formatUsd`'s rules (`apps/web/src/lib/realMoney.ts`): null (or nonsense) is
 * `—`, never `$0.00`. WHY a second copy rather than one import: `packages/domain` has no dependency
 * on `apps/web` -- and must not gain one, since every other web package depends on domain, not the
 * other way round -- so the Markdown export (built here, with no web runtime around it) cannot call
 * the web's formatter. The rule itself must still match byte for byte: the page renders the same
 * `GoalReport` through the web copy, and a reader comparing the page to the downloaded Markdown
 * must see the same figure either way.
 */
export function formatReportUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return '—'
  if (value > 0 && value < 0.005) return '<$0.01'
  return `$${value.toFixed(2)}`
}

export function shortCommit(sha: string | null): string {
  return sha === null ? 'unknown' : sha.slice(0, 12)
}
