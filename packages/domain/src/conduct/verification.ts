import { z } from 'zod'
import { sanitisePersonText } from '../handoff/contract.js'
import { err, ok, type Result } from '../result.js'
import {
  REQUIREMENTS_MAX_ITEMS,
  SLAVE_VERIFICATION_TAG,
  VERIFICATION_CHECK_MAX_CHARS,
  VERIFICATION_LEADS_MAX_CHARS,
  VERIFICATION_LEADS_PER_PACKAGE_MAX_CHARS,
  VERIFICATION_OUTPUT_MAX_CHARS,
  VERIFICATION_REASON_MAX_CHARS,
  VERIFICATION_REWORK_MAX_CHARS,
} from './constants.js'
import type { WorkerLead } from './report.js'
import { RUN_REQUIREMENT_KEY, type RequirementItem } from './requirements.js'
import { SMOKE_SCRIPT_PATH } from './skeleton.js'

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

/** What {@link scanJsonObjectEnd} found: the index right after the object's closing brace, or
 *  `null` if it never balanced before the text (or the budget) ran out, plus how many characters it
 *  examined -- charged against {@link parseSlaveVerification}'s work budget. */
interface ObjectScan {
  readonly end: number | null
  readonly examined: number
}

/**
 * Walks `text` from `start` (which must be the object's opening `{`) tracking combined
 * brace/bracket depth and JSON string state, and returns the index right after the character where
 * that depth first returns to zero -- the top-level object's own closing brace -- or `null` if it
 * never does before the text ends or `budget` characters have been examined. Inside a string, `\`
 * escapes the next character and an unescaped `"` ends the string; a brace or bracket inside a
 * string is plain text and does not change the depth. This is a STRUCTURAL scanner, not a JSON
 * validator: a candidate this finds balanced may still fail `JSON.parse` (e.g. an unquoted key) --
 * that is `parseSlaveVerification`'s job, not this one's.
 */
function scanJsonObjectEnd(text: string, start: number, budget: number): ObjectScan {
  let depth = 0
  let inString = false
  let escaped = false
  const stop = Math.min(text.length, start + Math.max(0, budget))
  for (let i = start; i < stop; i += 1) {
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
      if (depth === 0) return { end: i + 1, examined: i + 1 - start }
    }
  }
  return { end: null, examined: stop - start }
}

/** Slack on top of `4 x text.length` for {@link parseSlaveVerification}'s work budget, so a short
 *  message with a prose candidate or two is never refused for its size. */
const SCAN_BUDGET_SLACK = 4096

/**
 * The verifier's verdict (spec R8), from the LAST `<slave-verification>` block of its final
 * message -- the same "last block wins" rule {@link parseSlaveReport} follows, for the same reason:
 * a verifier that quotes its instructions or revises its answer mid-message means the last one.
 * Every requirement key of the goal must appear exactly once; `pass`/`fail` need a non-empty
 * `check` (what was run), `fail`/`unverifiable` need a non-empty `reason` (why); `unverifiable`
 * alone may have no check -- there is none to show. The error names each gap, because it is what
 * the run is failed with (plan D7) and, for a `fail`, what a package reads back on rework (D5).
 *
 * Finding the block (ruling V2d, fix round 4; amends V2c). Pairing tag SUBSTRINGS cannot tell a
 * tag quoted inside a JSON string from a real delimiter, so this is a forward, structural scan:
 * - A CANDIDATE is an opening tag followed, after optional whitespace, by `{`. An opening tag not
 *   followed by `{` is a bare mention and is ignored.
 * - From a candidate's `{`, {@link scanJsonObjectEnd} finds where the top-level object closes by
 *   brace/bracket depth, string- and escape-aware, so a tag-shaped substring inside one of the
 *   object's own strings is never a boundary. The candidate is RECORDED when the object balances
 *   and, after optional whitespace, the closing tag follows; scanning then resumes after that
 *   closing tag. Otherwise the candidate FAILS and scanning resumes right after its opening tag.
 * - Once a block has been recorded, any candidate after it that fails is an error -- "not closed"
 *   when its object ran to the end of the text, else "not valid JSON" -- and no earlier block is
 *   ever returned: a broken revision (a missing or extra `]`, a message cut off mid-string, a prose
 *   `<slave-verification>{`) may be the verifier's real answer, so the run is retried rather than
 *   read from a stale block. A candidate that fails before the first recorded block (prose that
 *   announces the block) is harmless.
 * - Work is bounded, not capped by count: every structural scan charges the characters it examines
 *   to one budget of `4 x text.length` (+ {@link SCAN_BUDGET_SLACK}); past it the parse is an error
 *   ("could not be read within the work budget"), never an earlier block. Nested candidates would
 *   otherwise re-walk the same text once each (quadratic).
 * - No block recorded: "not closed" if an opening tag occurred at all, else "has no ... block".
 * - The last recorded block that fails `JSON.parse` is "not valid JSON"; its items are then
 *   validated as above.
 */
export function parseSlaveVerification(text: string, requirementKeys: readonly string[]): Result<readonly VerificationItem[], string> {
  const open = `<${SLAVE_VERIFICATION_TAG}>`
  const close = `</${SLAVE_VERIFICATION_TAG}>`

  let budget = 4 * text.length + SCAN_BUDGET_SLACK
  let hadOpen = false
  let lastBlock: { readonly start: number; readonly end: number } | undefined
  let cursor = text.indexOf(open)
  while (cursor !== -1) {
    hadOpen = true
    const objectStart = skipWhitespace(text, cursor + open.length)
    if (text[objectStart] !== '{') {
      cursor = text.indexOf(open, cursor + open.length)
      continue
    }
    const scan = scanJsonObjectEnd(text, objectStart, budget)
    budget -= scan.examined
    if (scan.end === null && objectStart + scan.examined < text.length) {
      return err(`the ${open} block could not be read within the work budget`)
    }
    const afterObject = scan.end === null ? text.length : skipWhitespace(text, scan.end)
    if (scan.end !== null && text.startsWith(close, afterObject)) {
      lastBlock = { start: objectStart, end: scan.end }
      cursor = text.indexOf(open, afterObject + close.length)
      continue
    }
    if (lastBlock !== undefined) {
      return scan.end === null ? err(`the ${open} block is not closed`) : err(`the ${open} block is not valid JSON`)
    }
    cursor = text.indexOf(open, cursor + open.length)
  }

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
  /** Skeleton spec S8: what each package's latest report said -- leads, never evidence. */
  readonly leads?: readonly WorkerLead[]
}

/**
 * The `verification_goal` run-context section's text: which round this is, every requirement the
 * verifier must check (through {@link sanitisePersonText} -- another party's text is data), and
 * the integrated diff summary it is checking against. The diff stat goes through the same defuse
 * (fix round 1, C1): its file names and hunk headers are chosen by package workers, so a path a
 * worker named `<slave-report>...` (or containing a routing literal) must not reopen or steer this
 * run's own prompt. The workers' leads (skeleton spec S8), when there are any, close the section.
 */
export function renderVerificationGoal(input: VerificationGoalInput): string {
  const leads = renderVerificationLeads(input.leads ?? [])
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
    ...(leads === '' ? [] : ['', leads]),
  ].join('\n')
}

/**
 * Skeleton spec S8, plan A D11: what the workers said, framed as leads -- OBS-21's verifier never
 * heard that the integration worker had reported "the production Docker image cannot start". Every
 * line is another party's text, so it is sanitised (it lands in the VERIFIER's prompt, next to the
 * `<slave-verification>` block that run must write) and bounded per package and in total.
 */
export function renderVerificationLeads(leads: readonly WorkerLead[]): string {
  if (leads.length === 0) return ''
  const blocks = leads.map((lead) =>
    trimEvidence(
      [`- ${sanitisePersonText(lead.packageKey)}:`, ...lead.lines.map((line) => `  ${sanitisePersonText(line.replace(/\s+/gu, ' ').trim())}`)].join('\n'),
      VERIFICATION_LEADS_PER_PACKAGE_MAX_CHARS,
    ),
  )
  return trimEvidence(
    [
      'Reported by the workers (leads to check, never evidence -- a worker saying something works proves nothing, and a worker saying something is broken is where to look first):',
      ...blocks,
    ].join('\n'),
    VERIFICATION_LEADS_MAX_CHARS,
  )
}

/**
 * Skeleton spec S8: the rule for RUN, in the protocol whenever RUN is a key.
 *
 * Its second half says exactly what the orchestrator's tamper check compares (final review I2;
 * `tamperedReason` in apps/orchestrator/src/verification.ts): HEAD, every tracked file's status and
 * content, and every untracked file git does not ignore, less build and test output (dependency
 * installs, caches, dist/build, `*.log`). Gitignored files are not compared, and the exclude files
 * outside the tree are. Starting a product through its README commonly rewrites a lockfile or
 * writes a database or `.env` into the checkout; without this the round is discarded and, at the
 * retry cap, the version ends needs_human although the product runs.
 */
export const RUN_VERIFICATION_RULE = [
  `4. For ${RUN_REQUIREMENT_KEY}: start the product yourself through the path its README documents (Docker if it says Docker) and run a basic user flow against it; ` +
    `${SMOKE_SCRIPT_PATH} passing is not enough on its own. Your check for ${RUN_REQUIREMENT_KEY} is the commands you ran, not a call to ${SMOKE_SCRIPT_PATH}. Stop what you started.`,
  '   Starting it must leave this checkout as you found it: the verification is thrown away if HEAD moves, any tracked file changes, or a new file appears that git does not ignore ' +
    '(dependency installs, caches, build output and *.log files are exempt). So: install from the lockfile without rewriting it (npm ci, pnpm install --frozen-lockfile, ' +
    'yarn install --immutable, uv sync --frozen, poetry install with no lock or update, pip install -r, cargo build --locked); put databases, .env files and other data under ' +
    '$SLAVEOFAI_VERIFY_DIR (point the product at them through its settings), or copy the checkout into $SLAVEOFAI_VERIFY_DIR and start it there. Before you finish, ' +
    'restore every tracked file it changed and remove every file it created in the checkout (git status shows both); never commit, and never add ignore rules.',
].join('\n')

/** One command that runs the project's smoke script: an optional `bash`/`sh` with its flags, any
 *  path prefix (`./`, an absolute checkout path), and any arguments or redirections. */
const SMOKE_INVOCATION = new RegExp(
  `^(?:(?:bash|sh)(?:\\s+-\\w+)*\\s+)?(?:\\S*/)?${SMOKE_SCRIPT_PATH.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:\\s.*)?$`,
  'u',
)

/** `bash -c '<x>'` / `sh -e -c "<x>"`: a shell handed one quoted command string. */
const SHELL_DASH_C = /^(?:bash|sh)(?:\s+-\w+)*\s+-c\s+(['"])(.*)\1$/u

/** What a command wraps around the one it runs: `(`, `timeout N`, `env K=V…`, `K=V`. */
const COMMAND_WRAPPERS: readonly RegExp[] = [
  /^\(\s*/u,
  /^timeout\s+(?:-\S+\s+)*\d+[smhd]?\s+/u,
  /^env\s+(?:-\S+\s+)*/u,
  /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/u,
]

/** Commands that do nothing to the product: moving about, shell options, printing. */
const NO_OP_COMMAND = /^(?:cd(?:\s.*)?|set\s+[-+].*|true|:|echo(?:\s.*)?)$/u
/** After a pipe, what only copies the output along. */
const NO_OP_AFTER_PIPE = /^(?:tee(?:\s.*)?|cat(?:\s+-\w+)*)$/u

/**
 * One command line cut into its commands at an unquoted `&&`, `||`, `;` or `|`, each marked with
 * whether a pipe feeds it. Quote-aware (single and double), so `bash -c 'a; b'` stays one command.
 */
function shellSegments(line: string): readonly { readonly text: string; readonly piped: boolean }[] {
  const segments: { text: string; piped: boolean }[] = []
  let current = ''
  let quote: string | null = null
  let piped = false
  const cut = (nextPiped: boolean): void => {
    segments.push({ text: current, piped })
    current = ''
    piped = nextPiped
  }
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!
    if (quote !== null) {
      if (ch === quote) quote = null
      current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
    } else if ((ch === '&' || ch === '|') && line[i + 1] === ch) {
      cut(false)
      i += 1
    } else if (ch === ';') cut(false)
    else if (ch === '|') cut(true)
    else current += ch
  }
  cut(false)
  return segments
}

/** Strips every leading wrapper and a closing `)`, repeatedly: `(timeout 60 env A=1 bash x)` -> `bash x`. */
function unwrapCommand(text: string): string {
  let command = text.trim().replace(/\)+$/u, '').trim()
  for (let changed = true; changed; ) {
    changed = false
    for (const wrapper of COMMAND_WRAPPERS) {
      const next = command.replace(wrapper, '')
      if (next !== command) {
        command = next.trim()
        changed = true
      }
    }
  }
  return command
}

/**
 * What one command line does, for {@link runCheckLeansOnSmoke}: `smoke` when it runs smoke.sh and
 * nothing but no-ops besides, `noop` when it only moves about or prints, `other` when anything in
 * it does real work. A `sh|bash -c '<x>'` is unwrapped once (`depth`), and judged by what `<x>` does.
 */
function classifyLine(line: string, depth: number): 'smoke' | 'noop' | 'other' {
  let smoke = false
  for (const segment of shellSegments(line)) {
    const command = unwrapCommand(segment.text)
    // A substitution runs a command of its own inside any of the forms below.
    if (/\$\(|`/u.test(command)) return 'other'
    const inner = depth === 0 ? SHELL_DASH_C.exec(command) : null
    if (inner !== null) {
      const kind = classifyLine(inner[2] ?? '', depth + 1)
      if (kind === 'other') return 'other'
      smoke ||= kind === 'smoke'
    } else if (SMOKE_INVOCATION.test(command)) smoke = true
    else if (!(command === '' || NO_OP_COMMAND.test(command) || (segment.piped && NO_OP_AFTER_PIPE.test(command)))) return 'other'
  }
  return smoke ? 'smoke' : 'noop'
}

/**
 * Plan A D10 (spec ruling 3, "the verifier does not take smoke.sh on trust"): a RUN `pass` whose
 * check only runs scripts/smoke.sh took the project's own script on trust. The reason, or null when
 * RUN is absent, not a pass, or checked with commands of the verifier's own.
 *
 * Honest wrappers do not hide it (final review T7): each line is cut at `&&`, `||`, `;` and `|`;
 * `cd`, `set -…`, `true`, `echo` and a piped `tee`/`cat` count for nothing; a leading `(`,
 * `timeout N`, `env K=V` is stripped; any shell flags and any path prefix are allowed; and a
 * `sh|bash -c '…'` is judged by what it runs. Smoke-only means some line runs smoke.sh and no
 * command anywhere does anything else.
 */
export function runCheckLeansOnSmoke(items: readonly VerificationItem[]): string | null {
  const run = items.find((item) => item.key === RUN_REQUIREMENT_KEY)
  if (run === undefined || run.status !== 'pass') return null
  const kinds = run.check
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => classifyLine(line, 0))
  if (!kinds.includes('smoke') || kinds.includes('other')) return null
  return `${RUN_REQUIREMENT_KEY} passed on ${SMOKE_SCRIPT_PATH} alone; the verifier must start the product itself through the path the README documents`
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
    '2. Run it against this checkout. Send any output files your checks produce to $SLAVEOFAI_VERIFY_DIR, not into the checkout.',
    '3. Decide: pass (the check shows the requirement holds), fail (it shows it does not), or unverifiable (no check you can run here can show it either way -- say why).',
    ...(requirementKeys.includes(RUN_REQUIREMENT_KEY) ? [RUN_VERIFICATION_RULE] : []),
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
