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

/**
 * The verifier's verdict (spec R8), from the LAST `<slave-verification>` block of its final
 * message -- the same "last block wins" rule {@link parseSlaveReport} follows, for the same reason:
 * a verifier that quotes its instructions or revises its answer mid-message means the last one.
 * Every requirement key of the goal must appear exactly once; `pass`/`fail` need a non-empty
 * `check` (what was run), `fail`/`unverifiable` need a non-empty `reason` (why); `unverifiable`
 * alone may have no check -- there is none to show. The error names each gap, because it is what
 * the run is failed with (plan D7) and, for a `fail`, what a package reads back on rework (D5).
 */
export function parseSlaveVerification(text: string, requirementKeys: readonly string[]): Result<readonly VerificationItem[], string> {
  const open = `<${SLAVE_VERIFICATION_TAG}>`
  const close = `</${SLAVE_VERIFICATION_TAG}>`
  const start = text.lastIndexOf(open)
  if (start === -1) return err(`the final message has no ${open} block`)
  const end = text.indexOf(close, start)
  if (end === -1) return err(`the ${open} block is not closed`)
  let value: unknown
  try {
    value = JSON.parse(text.slice(start + open.length, end))
  } catch {
    return err(`the ${open} block is not valid JSON`)
  }
  const parsed = verificationSchema.safeParse(value)
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`)
    return err(`the ${open} block's shape is wrong: ${issues.join('; ')}`)
  }

  const items = parsed.data.items.map((item) => ({
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
 * the integrated diff summary it is checking against.
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
    input.diffStat.trim() === '' ? '(no changes)' : input.diffStat,
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
 */
export function renderVerificationRework(round: number, failed: readonly (VerificationItem & { readonly text: string })[]): string {
  const header = `Verification round ${String(round)} found requirement(s) your package owns not met. Fix them, then finish as your instructions describe.`
  const body = failed
    .map((item) => `\n\n${item.key}: ${item.text}\ncheck: ${item.check}\noutput: ${trimEvidence(item.output, 1500)}\nreason: ${item.reason}`)
    .join('')
  return trimEvidence(header + body, VERIFICATION_REWORK_MAX_CHARS)
}
