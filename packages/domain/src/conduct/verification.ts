import { z } from 'zod'
import { sanitisePersonText } from '../handoff/contract.js'
import { err, ok, type Result } from '../result.js'
import {
  REQUIREMENTS_MAX_ITEMS,
  SLAVE_VERIFICATION_TAG,
  VERIFICATION_CHECK_MAX_CHARS,
  VERIFICATION_OUTPUT_MAX_CHARS,
  VERIFICATION_REASON_MAX_CHARS,
  VERIFICATION_REWORK_MAX_CHARS,
} from './constants.js'
import type { RequirementItem } from './requirements.js'

/** One requirement's verdict from a verification run (spec R8), as {@link parseSlaveVerification}
 *  reads it -- the `check`/`output`/`reason` fields are what a person reads back as evidence, and
 *  what a `fail` rides on the package's rework prompt ({@link renderVerificationRework}). */
export interface VerificationItem {
  readonly key: string
  readonly status: 'pass' | 'fail' | 'unverifiable'
  readonly check: string
  readonly output: string
  readonly reason: string
}

const itemSchema = z.object({
  key: z.string().min(1).max(20),
  status: z.enum(['pass', 'fail', 'unverifiable']),
  check: z.string().max(200_000).default(''),
  output: z.string().max(2_000_000).default(''),
  reason: z.string().max(200_000).default(''),
})
const verificationSchema = z.object({ items: z.array(itemSchema).max(REQUIREMENTS_MAX_ITEMS * 2) })

/**
 * Cuts `text` to `max` characters, keeping the head and the tail rather than the head alone --
 * evidence a person or a rework prompt reads often shows what went wrong at the END of a run
 * (a traceback, a final assertion), not just how it started. Unchanged when it already fits.
 */
export function trimEvidence(text: string, max: number): string {
  if (text.length <= max) return text
  const headLen = Math.floor(max / 2)
  const tailLen = max - headLen
  const cut = text.length - headLen - tailLen
  return `${text.slice(0, headLen)}\n… [${String(cut)} characters cut] …\n${text.slice(text.length - tailLen)}`
}

/** Skips ASCII/Unicode whitespace forward from `pos`, for {@link scanJsonObjectEnd}'s caller: the
 *  closing tag need not sit flush against the JSON's final brace. */
function skipWhitespace(text: string, pos: number): number {
  let i = pos
  while (i < text.length && /\s/u.test(text[i]!)) i += 1
  return i
}

/**
 * Walks `text` from `start` (which must be the object's opening `{`) tracking combined
 * brace/bracket depth and JSON string state, and returns the index right after the character where
 * that depth first returns to zero -- the top-level object's own closing brace -- or `null` if it
 * never does before the text ends (an unclosed or truncated object). Inside a string, `\` escapes
 * the next character and an unescaped `"` ends the string; a brace or bracket inside a string is
 * plain text and does not change the depth. This is a STRUCTURAL scanner, not a JSON validator: a
 * candidate this finds balanced may still fail `JSON.parse` (e.g. an unquoted key) -- that is
 * `parseSlaveVerification`'s job, not this one's.
 */
function scanJsonObjectEnd(text: string, start: number): number | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return null
}

/**
 * The verifier's verdict (spec R8), from the LAST `<slave-verification>` block of its final
 * message -- the same "last block wins" rule {@link parseSlaveReport} follows, for the same reason:
 * a verifier that quotes its instructions or revises its answer mid-message means the last one.
 * Every requirement key of the goal must appear exactly once; `pass`/`fail` need a non-empty
 * `check` (what was run), `fail`/`unverifiable` need a non-empty `reason` (why); `unverifiable`
 * alone may have no check -- there is none to show. The error names each gap, because it is what
 * the run is failed with (plan D7) and, for a `fail`, what a package reads back on rework (D5).
 *
 * NOT a substring search for `open`/`close` at all (ruling V2c, fix round 3, replaces round 2's
 * V2b): pairing tag SUBSTRINGS, in either search order, has no fixed rule that is always the real
 * tag -- V2b's "try every (open, close) pair" let a later block that structurally closes but is
 * NOT valid JSON (an earlier now-stale block happened to parse) silently fall back to that earlier,
 * stale block instead of failing, and a flood of 50+ tag-like mentions (inside the block's own
 * evidence, or after it) could push the genuine pair outside a fixed candidate cap.
 *
 * Instead this is a forward, JSON-AWARE scan with no pairing and no cap. It walks `text` left to
 * right; at each `open` occurrence not already inside a block recorded below, it skips whitespace
 * and requires the next character to be `{` (otherwise this occurrence is prose or a bare mention --
 * skip past just this `open` and keep scanning); from that `{` it runs {@link scanJsonObjectEnd},
 * a structural brace/bracket/string scanner (NOT a substring search) that finds where the top-level
 * object closes, immune to a `close`-tag-shaped substring quoted inside one of the object's own
 * strings, because such a substring is never seen as a candidate open OR checked against as a close
 * at all -- the object's end is found by depth, not by text search. If that end is found and,
 * after optional whitespace, the literal `close` tag follows, the (start, end) pair is RECORDED and
 * scanning resumes right after that closing tag -- so a `close`-tag-shaped substring elsewhere
 * inside the block's own strings is never independently visited as a candidate boundary either.
 * Otherwise scanning resumes right after this `open` occurrence, so a later, unrelated mention (a
 * recap after the block, prose before it) is free to be tried as its own candidate.
 *
 * The LAST recorded block wins -- no fallback to an earlier one. If its slice fails `JSON.parse`,
 * this reports "not valid JSON", full stop; a structurally-closed-but-invalid LATER block must
 * never resurrect an earlier, valid-looking one (that would silently accept stale content). If NO
 * block was ever recorded: an `open` occurrence existed somewhere (prose, or JSON that never
 * closed) but never actually completed a whole tagged block -- reported "not closed"; if `open`
 * never occurred at all -- reported "has no ... block".
 *
 * An object whose structural scan reaches the end of `text` without balancing (truncated mid-JSON)
 * stops the ENTIRE search rather than moving on to the next `open` occurrence: everything after
 * this point was already walked once looking for a closing brace that was never found, so there is
 * nothing left un-scanned for a later candidate to find that this pass would have missed. (`in
 * practice this only ever guards against a genuinely truncated final message -- the ordinary case
 * this protects is a huge run output with many tag-like substrings near the end, none of which ever
 * close, which would otherwise re-walk the same unclosed tail once per occurrence.)
 */
export function parseSlaveVerification(text: string, requirementKeys: readonly string[]): Result<readonly VerificationItem[], string> {
  const open = `<${SLAVE_VERIFICATION_TAG}>`
  const close = `</${SLAVE_VERIFICATION_TAG}>`

  let hadOpen = false
  const blocks: { readonly start: number; readonly end: number }[] = []
  let cursor = text.indexOf(open)
  while (cursor !== -1) {
    hadOpen = true
    const objectStart = skipWhitespace(text, cursor + open.length)
    if (text[objectStart] !== '{') {
      cursor = text.indexOf(open, cursor + open.length)
      continue
    }
    const objectEnd = scanJsonObjectEnd(text, objectStart)
    if (objectEnd === null) break // see the doc comment: nothing later in the text can close either.
    const afterObject = skipWhitespace(text, objectEnd)
    if (text.startsWith(close, afterObject)) {
      blocks.push({ start: objectStart, end: objectEnd })
      cursor = text.indexOf(open, afterObject + close.length)
    } else {
      cursor = text.indexOf(open, cursor + open.length)
    }
  }

  const lastBlock = blocks.at(-1)
  if (lastBlock === undefined) {
    return hadOpen ? err(`the ${open} block is not closed`) : err(`the final message has no ${open} block`)
  }

  let value: unknown
  try {
    value = JSON.parse(text.slice(lastBlock.start, lastBlock.end))
  } catch {
    return err(`the ${open} block is not valid JSON`)
  }

  const schemaParsed = verificationSchema.safeParse(value)
  if (!schemaParsed.success) {
    const issues = schemaParsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`)
    return err(`the ${open} block's shape is wrong: ${issues.join('; ')}`)
  }

  const items = schemaParsed.data.items.map((item) => ({
    key: item.key,
    status: item.status,
    check: item.check.trim(),
    output: item.output.trim(),
    reason: item.reason.trim(),
  }))

  const problems: string[] = []
  for (const key of requirementKeys) {
    const count = items.filter((item) => item.key === key).length
    if (count === 0) problems.push(`${key} is not reported`)
    if (count > 1) problems.push(`${key} is reported ${String(count)} times`)
  }
  for (const item of items) {
    if (!requirementKeys.includes(item.key)) problems.push(`${item.key} is not a requirement of this goal`)
    if ((item.status === 'pass' || item.status === 'fail') && item.check === '') {
      problems.push(`${item.key} is ${item.status} with no check`)
    }
    if ((item.status === 'fail' || item.status === 'unverifiable') && item.reason === '') {
      problems.push(`${item.key} is ${item.status} with no reason`)
    }
  }
  if (problems.length > 0) return err(`the verification is incomplete: ${[...new Set(problems)].join('; ')}`)

  return ok(
    items.map((item) => ({
      key: item.key,
      status: item.status,
      check: trimEvidence(item.check, VERIFICATION_CHECK_MAX_CHARS),
      output: trimEvidence(item.output, VERIFICATION_OUTPUT_MAX_CHARS),
      reason: trimEvidence(item.reason, VERIFICATION_REASON_MAX_CHARS),
    })),
  )
}

/** What {@link renderVerificationGoal} reads to build a verification round's goal section. */
export interface VerificationGoalInput {
  readonly goalVersion: number
  readonly round: number
  readonly requirements: readonly RequirementItem[]
  /** `git diff --stat` from where the goal version started -- what was actually built. */
  readonly diffStat: string
  readonly diffCapped: boolean
}

/**
 * The `verification_goal` run-context section's text: which round this is, every requirement the
 * verifier must check (through {@link sanitisePersonText} -- another party's text is data), and
 * the integrated diff summary it is checking against. The diff stat goes through the same defuse
 * (fix round 1, C1): its file names and hunk headers are chosen by package workers, so a path a
 * worker named `<slave-report>...` (or containing a routing literal) must not reopen or steer this
 * run's own prompt.
 */
export function renderVerificationGoal(input: VerificationGoalInput): string {
  return [
    `Verification round ${String(input.round)} of goal v${String(input.goalVersion)}.`,
    `Requirement keys: ${input.requirements.map((r) => r.key).join(', ')}`,
    '',
    'The requirements (check every one):',
    ...input.requirements.map((r) => `${r.key}: ${sanitisePersonText(r.text)}`),
    '',
    'What was built for this goal (git diff --stat from where the goal started):',
    input.diffStat.trim() === '' ? '(no changes)' : sanitisePersonText(input.diffStat),
    ...(input.diffCapped ? ['(the summary was cut; read the repository for the rest)'] : []),
  ].join('\n')
}

/**
 * The `verification_protocol` run-context section's text: the rule to write and run a check per
 * requirement in the scratch directory rather than the repository, and the exact
 * `<slave-verification>` shape to end with, one item per requirement key already filled in.
 */
export function renderVerificationProtocol(requirementKeys: readonly string[], verifyDir: string): string {
  const example = {
    items: requirementKeys.map((key) => ({
      key,
      status: 'pass|fail|unverifiable',
      check: 'the command or script you ran',
      output: 'what it printed',
      reason: 'why it failed or could not be checked',
    })),
  }
  return [
    'You verify; you do not fix. For EACH requirement above:',
    `1. Write a check -- a command, a script or a test -- in the scratch directory $SLAVEOFAI_VERIFY_DIR (${verifyDir}). Never in the repository: writes there are denied, and a verification that changed the repository is thrown away.`,
    '2. Run it against this checkout.',
    '3. Decide: pass (the check shows the requirement holds), fail (it shows it does not), or unverifiable (no check you can run here can show it either way -- say why).',
    'End your final message with this block, exactly once, one item per requirement key:',
    `<${SLAVE_VERIFICATION_TAG}>${JSON.stringify(example)}</${SLAVE_VERIFICATION_TAG}>`,
    '"check" is the check itself (the script text or the command line); "output" is what running it printed.',
  ].join('\n')
}

/**
 * The reason a package's task is sent back to `rework` after a verification `fail` (plan D5) --
 * the same rejection channel a review's own reason rides. Bounded by
 * {@link VERIFICATION_REWORK_MAX_CHARS}: a worker reads this once per item, and each item's own
 * `output` is cut first (1500 characters) so one long log cannot crowd out the others.
 *
 * Every field goes through {@link sanitisePersonText} (fix round 1, C1): `check`/`output`/`reason`
 * are VERIFIER-authored, but this text lands in a DIFFERENT run's prompt -- the package worker's --
 * so a check's output that happens to contain a literal `<slave-report>`/`<slave-ask>` marker or a
 * routing literal must not be able to forge or steer that other run, the same "another party's text
 * is data" rule {@link renderVerificationGoal} already applies to the requirement text.
 */
export function renderVerificationRework(round: number, failed: readonly (VerificationItem & { readonly text: string })[]): string {
  const header = `Verification round ${String(round)} found requirement(s) your package owns not met. Fix them, then finish as your instructions describe.`
  const body = failed
    .map((item) => {
      const output = trimEvidence(sanitisePersonText(item.output), 1500)
      return `\n\n${item.key}: ${sanitisePersonText(item.text)}\ncheck: ${sanitisePersonText(item.check)}\noutput: ${output}\nreason: ${sanitisePersonText(item.reason)}`
    })
    .join('')
  return trimEvidence(header + body, VERIFICATION_REWORK_MAX_CHARS)
}
