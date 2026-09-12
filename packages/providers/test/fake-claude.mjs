#!/usr/bin/env node
// A fake `claude` CLI for M3 adapter tests. Not compiled TypeScript --
// deliberately kept out of `tsc --build`'s way (spec §12.1, Task 5) -- and not
// covered by `npm test`'s `tsc --build` step at all.
//
// Interface: accepts `--fixture <name>` plus any of the real CLI's flags
// (`--output-format stream-json`, `--verbose`, `--permission-mode`,
// `--settings <path>`, `--include-hook-events`, `-p <prompt>`,
// `--resume <sessionId>`) without choking on any of them -- it only ever
// looks for `--fixture`, so every other flag, recognized or not, passes
// through inert. It replays `test/fixtures/<name>.ndjson` to stdout, one
// line at a time with a small delay between lines, and exits.
//
// Modes:
//   hang           writes nothing, never exits on its own.
//   crash          writes the first half of `fixtures/crash.ndjson`, then
//                  exits 1 -- a mid-stream crash built by withholding real
//                  lines at runtime, not by pre-truncating the fixture file.
//   env-echo       synthetic (no real capture carries this): emits a single
//                  terminal `result` line whose payload carries this
//                  process's own `process.env`, so a later task can prove
//                  git identity and the pause-flag path reach the child.
//   m8a-flow       synthetic, selected by prompt content rather than a fixed
//                  fixture name: makes the unattended M8a gate real end to
//                  end. A review prompt (containing `"verdict"`, the literal
//                  substring the review prompt always carries) replays the
//                  `review-approve` fixture with no side effect; any other
//                  prompt is treated as a work run, which leaves a real
//                  commit in the worktree (cwd) before replaying `complete`,
//                  so the merge pass downstream has something to merge.
//   m8-flow        synthetic, extends m8a-flow's selection with a planning
//                  arm for the M8b gate. A planning prompt (containing
//                  `"task graph"`, the literal substring the planning prompt
//                  always carries) replays the `plan-graph` fixture with no
//                  side effect -- no commit, no file written. WHICH plan it
//                  replays is `--plan-fixture <name>` from ARGV (M47),
//                  defaulting to `plan-graph`, so one gate can be answered
//                  with a graph written in capabilities without a mode of
//                  its own. A review prompt (containing `"verdict"`) replays
//                  the fixture `--review-fixture <name>` names (M49 erratum
//                  E8), defaulting to `review-approve` -- so one gate can run
//                  an approving project and a rejecting one side by side, each
//                  with its own daemon. Any other prompt is a work run and
//                  reuses the m8a-flow work body verbatim -- unless
//                  `--work-fixture <name>` is in ARGV (M51 erratum E16), in
//                  which case every work run in EVERY mode here REPLAYS that
//                  fixture and does nothing else: no file, no commit. A commit
//                  moves the behavioural breaker's worktree clock on every
//                  single run, which suppresses the very `no_progress` arm a
//                  breaker gate exists to measure.
//   m36-flow       synthetic, selected by ARGV rather than by prompt content:
//                  the two legs of M36's ask/answer round trip. A run spawned
//                  WITHOUT `--resume` is the asking leg -- it replays
//                  `complete` with the ask envelope from
//                  `--ask-json-base64` appended to that fixture's last
//                  assistant text block, which is what the orchestrator's
//                  pump reads its `<slave-ask>` block out of. A run spawned
//                  WITH `--resume <sessionId>` is the resumed leg: it is the
//                  same session continuing after its question was answered,
//                  so it does the m8a-flow work body (a real commit in the
//                  worktree) and replays `complete` unmodified -- no ask
//                  block, so the run concludes for real instead of waiting
//                  again. A review prompt (containing `"verdict"`) replays
//                  `review-approve`, same as m8a-flow, so a downstream review
//                  pass cannot land back on either of the two legs above.
//                  `--resume` is the discriminator because it is the ONE
//                  thing the runtime itself puts on the resumed argv
//                  (`ClaudeCodeAdapter.resume` appends it); keying off the
//                  resume prompt's wording would make this fake agree with a
//                  sentence in `deliver.ts` rather than with the protocol.
//   Every prompt-sniffing mode above also carries M38's SUPERVISOR arm,
//   checked FIRST: a prompt containing the literal `"candidateIndex"`
//   (which `buildDecisionPrompt` always emits) replays the
//   `supervisor-decision` fixture and does nothing else -- no commit, no
//   file. It is checked before `"verdict"`/`"task graph"` so a supervisor
//   prompt can never be mistaken for a review or a planning run, and it is
//   in every mode because a gate picks its mode for the RUNS it wants and
//   the Supervisor's call arrives on whatever mode that turned out to be.
//   Right behind it sits M39's ANSWER arm: a prompt containing the literal
//   `"sources"` (which `buildAnswerPrompt` always emits) replays the fixture
//   named by `--answer-fixture <name>` in ARGV, or by
//   `FAKE_CLAUDE_ANSWER_FIXTURE` in the environment, defaulting to
//   `supervisor-answer` -- so a gate chooses a sourced or an unsourced
//   answer per daemon spawn (erratum E3) without a mode of its own. Argv is
//   what a GATE has to use (erratum E6): a decision call's child is spawned
//   with `buildDecisionEnv()` -- exactly PATH, HOME, LANG and TERM, never
//   the parent's environment (M31a §4 ruling R1) -- so an env var set on the
//   daemon can never reach this arm through one. `SLAVEOFAI_CLAUDE_ARGS`
//   can: it is passed through as `extraArgs` on every decision call, which
//   is already how `--fixture` itself arrives.
//   M40 adds the RE-PLAN arm to every mode that has a `"task graph"`
//   check (today: `m8-flow` and `m41-flow`), in front of it: a prompt
//   containing the literal `"replan"` (which `REPLAN_INSTRUCTIONS` always
//   emits) replays `fixtures/replan-delta.ndjson` with `$CANCEL_ID`
//   substituted from `--replan-cancel <id>` in ARGV -- and with the
//   placeholder ELEMENT removed, so `cancel` is `[]`, when no such flag
//   was passed. It sits behind the two decision arms and in front of the
//   planning one: a re-plan answered with a first plan would rebuild the
//   board.
//   m41-flow       synthetic, M41's whole-story mode: every arm one gate
//                  needs, in one file, so a single daemon lineage can plan,
//                  work, ask, be answered, resume, be reviewed and be
//                  re-planned without ever changing modes. Precedence,
//                  first match wins: the two decision arms
//                  (`"candidateIndex"`, then `"sources"`), the re-plan arm
//                  (`"replan"`), planning (`"task graph"`), review
//                  (`"verdict"`), and finally work.
//                  Its planning arm replays `plan-graph-scenario`, NOT the
//                  stock `plan-graph`: the story needs a `core` task whose
//                  description carries the sentence `supervisor-answer`
//                  cites (`PostgreSQL on port 5433`), and editing the stock
//                  fixture would silently change what m8 and m40 measure.
//                  A work run is the ASKING leg -- the m36-flow body,
//                  `complete` with the `--ask-json-base64` envelope
//                  appended to its last assistant text block -- only when
//                  ALL THREE hold: `--ask-on-task <token>` (one word) is in ARGV,
//                  the prompt carries the literal `Task: <that title>`, and
//                  argv has NO `--resume`. Every other work run, the resumed
//                  leg included, writes `m41-work.txt`, commits it as `Fake
//                  Claude`, and replays `complete`.
//                  ARGV is the channel because a run's spawn args are the
//                  only deterministic per-daemon knob a gate has (M39 E6);
//                  `SLAVEOFAI_CLAUDE_ARGS` rides through as `extraArgs` on
//                  every run and every decision call. The TITLE is the
//                  discriminator, not the task id, because a work run's
//                  prompt does not contain its task's id at all (M41 E2):
//                  `apps/orchestrator/src/runContext.ts` renders the `task`
//                  section as `Task: <title>\n\n<description>`, and ids
//                  appear only in a planning or re-plan run's board lines.
//                  Two workers share the `backend` role in that story and
//                  exactly one of them may stop to ask, which is what the
//                  discriminator is for.
//   anything else  replays `fixtures/<name>.ndjson` verbatim, exit 0 -- real
//                  captures show process exit code 0 even for hook-crash,
//                  hook-deny, and permission-denied runs, so the fake matches
//                  that rather than inventing a nonzero exit for them.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir = path.join(here, 'fixtures')

// Only `--fixture <name>` is ever inspected. Every other argument --
// `--output-format stream-json`, `--verbose`, `--permission-mode
// bypassPermissions`, `--settings <path>`, `--include-hook-events`,
// `-p <prompt>`, `--resume <sessionId>`, or anything a future adapter passes
// -- is never parsed or validated, so none of them can make this script
// choke.
const args = process.argv.slice(2)
const fixtureFlagIndex = args.indexOf('--fixture')
const fixtureName = fixtureFlagIndex === -1 ? undefined : args[fixtureFlagIndex + 1]

if (fixtureName === undefined) {
  process.stderr.write('fake-claude: --fixture <name> is required\n')
  process.exit(2)
}

/**
 * One flag's value from ARGV, or `undefined` when the flag is absent or is followed by another
 * flag rather than a value. The shape `--fixture` has always been read with, factored out here
 * because M52 R3 turned ARGV into the ONLY channel a gate can reach a run's child on.
 */
function flagValue(name) {
  const index = args.indexOf(name)
  const value = index === -1 ? undefined : args[index + 1]
  return value === undefined || value.startsWith('-') ? undefined : value
}

/**
 * How long this script waits between fixture lines -- `--line-delay-ms <n>` from ARGV first, then
 * `FAKE_CLAUDE_LINE_DELAY_MS` from the environment, then 2ms.
 *
 * ARGV LEADS, AND SINCE M52 R3 IT IS THE ONLY CHANNEL THAT ARRIVES. `buildChildEnv`
 * (`packages/providers/src/runtime/process.ts`) hands a worker's child an explicit
 * `CHILD_ENV_ALLOW` list instead of the daemon's whole environment, so a gate that exports a knob
 * on the daemon no longer reaches the run's child at all: it would silently get the 2ms default
 * and measure a run that was over before the assertion ran -- which is exactly what this delay
 * exists to prevent (`gate-m8a-estop`, `gate-m51-breaker`). `SLAVEOFAI_CLAUDE_ARGS` rides through
 * as `extraArgs`, the same way `--fixture` has always arrived. The environment variable stays
 * supported for a caller that spawns this script DIRECTLY, which is what `fake-claude.test.ts`
 * does and what a person debugging by hand does.
 */
const lineDelayMs = Number(flagValue('--line-delay-ms') ?? process.env.FAKE_CLAUDE_LINE_DELAY_MS ?? 2)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readFixtureLines(name) {
  const filePath = path.join(fixturesDir, `${name}.ndjson`)
  const content = readFileSync(filePath, 'utf8')
  return content.split('\n').filter((line) => line.length > 0)
}

async function writeLines(lines) {
  for (const line of lines) {
    process.stdout.write(`${line}\n`)
    if (lineDelayMs > 0) await sleep(lineDelayMs)
  }
}

/** Replays `fixtures/<name>.ndjson` verbatim and exits 0 -- the default-branch body, factored out
 * so the `m8a-flow` synthetic mode can delegate to it after doing its own side effect. */
async function replayFixture(name) {
  const lines = readFixtureLines(name)
  await writeLines(lines)
  process.exit(0)
}

/**
 * The prompt this invocation was given, wherever the caller put it.
 *
 * A RUN carries it in argv (`-p <prompt>`, `ClaudeCodeAdapter.spawnRun`). A DECISION call --
 * M31a's `decideWithModel`, which is how the Supervisor's model call is made -- passes a BARE
 * `-p` and writes the prompt to stdin, so `args[after -p]` is the next flag and there is nothing
 * in argv to sniff. Reading stdin is gated on `--no-session-persistence`, a flag only
 * `decisionArgs` ever passes: a run's stdin is never written to and never ended, so a mode that
 * read it unconditionally would hang forever on the first work run.
 */
async function promptText() {
  const index = args.indexOf('-p')
  const inline = index === -1 ? undefined : args[index + 1]
  if (inline !== undefined && !inline.startsWith('-')) return inline
  if (!args.includes('--no-session-persistence')) return ''
  process.stdin.setEncoding('utf8')
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

/** M38: the Supervisor's decision call, recognised by the one literal `buildDecisionPrompt`
 *  guarantees. Returns true when it replayed (and so never returns at all -- `replayFixture`
 *  exits), so each mode reads as `if (await supervisorArm(prompt)) return`. */
async function supervisorArm(prompt) {
  if (!prompt.includes('"candidateIndex"')) return false
  await replayFixture('supervisor-decision')
  return true
}

/** M39 (erratum E3): the Supervisor's ANSWER call -- the second call it makes about a question,
 *  recognised by the one literal `buildAnswerPrompt` guarantees. Which fixture it replays comes
 *  from the environment, not from this file, so one gate can spawn a daemon that answers from a
 *  real quote and another that cites words nobody wrote -- the two halves of "sourced" -- without
 *  a second flow mode. Sits right after `supervisorArm` in every sniffing mode: both are decision
 *  calls, neither is a run, and the choose prompt carries no `"sources"` so the order between them
 *  is belt and braces rather than a discriminator. */
async function answerArm(prompt) {
  if (!prompt.includes('"sources"')) return false
  await replayFixture(answerFixtureName())
  return true
}

/**
 * Which fixture {@link answerArm} replays: `--answer-fixture <name>` from ARGV first, then
 * `FAKE_CLAUDE_ANSWER_FIXTURE` from the environment, then the sourced default.
 *
 * Argv leads because it is the only channel that reaches a real daemon's decision call (erratum
 * E6). `decideWithModel` spawns its child with `buildDecisionEnv()` -- PATH, HOME, LANG and TERM
 * and nothing else, deliberately, so a simulation actor never sees `DATABASE_URL` (M31a §4 ruling
 * R1) -- so a gate that exported `FAKE_CLAUDE_ANSWER_FIXTURE` on the daemon would silently get the
 * default here and measure a sourced answer while believing it had asked for an unsourced one.
 * `SLAVEOFAI_CLAUDE_ARGS` rides through as `extraArgs`, which is how `--fixture` already arrives.
 * The env var stays supported for a caller that spawns this script directly.
 */
function answerFixtureName() {
  const index = args.indexOf('--answer-fixture')
  const named = index === -1 ? undefined : args[index + 1]
  if (named !== undefined && !named.startsWith('-')) return named
  return process.env.FAKE_CLAUDE_ANSWER_FIXTURE ?? 'supervisor-answer'
}

/**
 * The `<slave-ask>` envelope the m36 and m41 asking legs patch into the stream --
 * `--ask-json-base64 <base64 of the JSON>` from ARGV first, then `FAKE_CLAUDE_ASK_JSON` from the
 * environment. Returns `undefined` when neither channel carries one; the caller decides whether
 * that is fatal for its arm.
 *
 * ARGV leads for `answerFixtureName`'s reason, which M52 R3 made true of a RUN as well: a run's
 * child gets `CHILD_ENV_ALLOW` and not the daemon's environment, so an env var exported by a gate
 * reaches neither a decision call nor a run any more.
 *
 * BASE64, not the raw JSON, and that is forced rather than chosen: `claudeCommandFrom`
 * (`apps/orchestrator/src/claude-command.ts`) splits `SLAVEOFAI_CLAUDE_ARGS` on SPACES, and an
 * envelope carries a question written in prose. Encoding it is one flag with no quoting rules and
 * no temp file to clean up; the gates log the decoded envelope themselves, so nothing a person
 * reads becomes less readable. The environment variable stays supported for a caller that spawns
 * this script directly.
 */
function askEnvelope() {
  const encoded = flagValue('--ask-json-base64')
  if (encoded !== undefined) return Buffer.from(encoded, 'base64').toString('utf8')
  return process.env.FAKE_CLAUDE_ASK_JSON
}

/**
 * M47: which plan a `"task graph"` prompt is answered with -- `--plan-fixture <name>` from ARGV,
 * defaulting to the stock `plan-graph`. Argv rather than an env var for `--answer-fixture`'s own
 * reason: `SLAVEOFAI_CLAUDE_ARGS` rides through as `extraArgs` on every spawn, and it is the one
 * per-daemon channel a gate can count on.
 *
 * A MODE was the alternative and would have been worse: every arm of `m8-flow` -- the two decision
 * arms, the re-plan arm, review, work -- is exactly what an M47 gate needs, and a copy of them
 * beside a different planning fixture is five arms that can drift from the five they were copied
 * from.
 */
function planFixtureName() {
  const index = args.indexOf('--plan-fixture')
  const named = index === -1 ? undefined : args[index + 1]
  return named === undefined || named.startsWith('-') ? 'plan-graph' : named
}

/**
 * M49 (plan erratum E8): which verdict a `"verdict"` prompt is answered with -- `--review-fixture
 * <name>` from ARGV, defaulting to the stock `review-approve`.
 *
 * `--plan-fixture`'s exact shape, for its exact reason: `SLAVEOFAI_CLAUDE_ARGS` rides through as
 * `extraArgs` on every spawn, and it is the one per-daemon channel a gate can count on. One
 * daemon's argv therefore decides every review IT runs, which is why a gate that wants an approval
 * and a rejection in the same story runs two projects with two daemons.
 */
function reviewFixtureName() {
  const index = args.indexOf('--review-fixture')
  const named = index === -1 ? undefined : args[index + 1]
  return named === undefined || named.startsWith('-') ? 'review-approve' : named
}

/**
 * M51 (plan erratum E16): which fixture a WORK run replays -- `--work-fixture <name>` from ARGV, or
 * `null` for "do the ordinary work body".
 *
 * `--plan-fixture`/`--review-fixture`'s shape, for their reason: `SLAVEOFAI_CLAUDE_ARGS` rides
 * through as `extraArgs` on every spawn and is the one per-daemon channel a gate can count on.
 *
 * When it IS given, the arm REPLAYS ONLY -- no file written, no commit. That is not an oversight:
 * M51's breaker reads a worktree clock, and the ordinary work body's commit would move it on every
 * single run, which would suppress the very `no_progress` arm the gate exists to measure. A gate
 * that wants both a loop and a commit runs two projects.
 */
function workFixtureName() {
  const index = args.indexOf('--work-fixture')
  const named = index === -1 ? undefined : args[index + 1]
  return named === undefined || named.startsWith('-') ? null : named
}

/** The WORK fall-through's first line in every prompt-sniffing mode: replays `--work-fixture
 *  <name>` and exits when the flag is there, and returns false when it is not, so each mode reads
 *  as `if (await workFixtureArm()) return` in front of its own work body. */
async function workFixtureArm() {
  const work = workFixtureName()
  if (work === null) return false
  await replayFixture(work)
  return true
}

/**
 * M40 (erratum E3): the RE-PLAN arm -- a planning run whose goal changed under a board that
 * already exists, recognised by the one literal `REPLAN_INSTRUCTIONS` guarantees.
 *
 * Checked BEFORE the `"task graph"` arm in every mode that has one: a re-plan prompt carries the
 * board and asks for a delta, and answering it with `plan-graph` would rebuild a board nobody
 * asked to rebuild. It stays BEHIND the two decision arms for the same reason they lead
 * everywhere else -- a decision call is not a run, whatever words its situation happens to quote.
 *
 * The one thing this fixture cannot carry statically is the id to cancel: it is a row created by
 * whoever seeded the workspace. `$CANCEL_ID` is substituted from `--replan-cancel <id>` in ARGV
 * (erratum E6: argv, not env, is what reaches a scrubbed child), and with no such flag the
 * placeholder ELEMENT is removed rather than replaced, so the delta reads `"cancel":[]` -- a
 * re-plan that adds work and cancels nothing, which is the shape most of them have.
 */
async function replanArm(prompt) {
  if (!prompt.includes('"replan"')) return false
  const cancelId = replanCancelId()
  let substituted = false
  const lines = readFixtureLines('replan-delta').map((line) => {
    const patched = substituteCancelId(JSON.parse(line), cancelId, () => {
      substituted = true
    })
    return JSON.stringify(patched)
  })
  if (!substituted) {
    process.stderr.write('fake-claude: replan-delta.ndjson carries no $CANCEL_ID placeholder to substitute\n')
    process.exit(2)
  }
  await writeLines(lines)
  process.exit(0)
}

/** The id `--replan-cancel <id>` names, or `null` when the flag is absent -- or present with
 *  another flag where its value should be, which is an omitted value, not an id. */
function replanCancelId() {
  const index = args.indexOf('--replan-cancel')
  const named = index === -1 ? undefined : args[index + 1]
  return named === undefined || named.startsWith('-') ? null : named
}

/** M41: the one-word TOKEN naming the task a work run must stop and ask about -- `--ask-on-task <token>` from
 *  ARGV, or `null` when the flag is absent, or present with another flag where its value should be
 *  (an omitted value is not a title). Same shape as {@link replanCancelId}, and argv for the same
 *  reason: it is the one per-daemon knob that reaches a run's child. */
function askOnTaskTitle() {
  const index = args.indexOf('--ask-on-task')
  const named = index === -1 ? undefined : args[index + 1]
  return named === undefined || named.startsWith('-') ? null : named
}

/**
 * M41: is THIS work run the asking leg?
 *
 * Three facts, all of them the runtime's rather than this file's. The FLAG says which task the
 * gate wants a question from. `Task: <title>` is the one line the run-context `task` section
 * always renders (`apps/orchestrator/src/runContext.ts`), and it is what identifies the task a
 * prompt is about -- erratum E2: the task's ID is not in a work run's prompt anywhere, so keying
 * on an id would silently never match and the story would run with no question in it. And
 * `--resume` is what `ClaudeCodeAdapter.resume` appends and nothing else does, so the resumed leg
 * of the very session that asked can never ask again (the m36-flow discriminator, unchanged).
 */
function isAskingLeg(prompt) {
  const token = askOnTaskTitle()
  if (token === null) return false
  if (args.includes('--resume')) return false
  // The `task` section's own first line, and the token that identifies WHICH task inside it. A
  // whole title cannot be the flag's value: `SLAVEOFAI_CLAUDE_ARGS` is split on a single space, so
  // a flag value must be one word. The line is matched, not the bare token, so a token that also
  // occurs in a description or an inbox message cannot turn some other run into an asking leg.
  const line = prompt.split('\n').find((one) => one.startsWith('Task: '))
  return line !== undefined && line.includes(token)
}

/** Rewrites `$CANCEL_ID` wherever it appears in a parsed fixture line's strings: replaced by the
 *  id when there is one, and otherwise removed ARRAY ELEMENT AND ALL (`"$CANCEL_ID"`, quotes
 *  included, since the delta lives inside a JSON string) so `cancel` comes out empty. Walks the
 *  parsed line rather than the raw text so the escaping of the embedded JSON is JSON's problem
 *  and not a regex's. */
function substituteCancelId(value, cancelId, onSubstitution) {
  if (typeof value === 'string') {
    const token = cancelId === null ? '"$CANCEL_ID"' : '$CANCEL_ID'
    if (!value.includes(token)) return value
    onSubstitution()
    return value.split(token).join(cancelId ?? '')
  }
  if (Array.isArray(value)) return value.map((entry) => substituteCancelId(entry, cancelId, onSubstitution))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, substituteCancelId(entry, cancelId, onSubstitution)]),
    )
  }
  return value
}

async function main() {
  if (fixtureName === 'hang') {
    // Write nothing and never exit on its own. Without something keeping
    // the event loop alive, an empty async function would let the process
    // exit cleanly the moment it returns -- the opposite of a hang.
    setInterval(() => {}, 60_000)
    return
  }

  if (fixtureName === 'crash') {
    const lines = readFixtureLines('crash')
    const half = Math.max(1, Math.floor(lines.length / 2))
    await writeLines(lines.slice(0, half))
    process.exit(1)
  }

  if (fixtureName === 'env-echo') {
    // Synthetic by necessity: no real capture carries the child's own
    // process.env, process.cwd(), or process.argv, because nothing about
    // the CLI's stream format ever would. A later task uses this to prove
    // that git identity, the pause-flag path, the worktree cwd, and (for
    // resume) the exact argv the adapter spawned with all reach the child
    // as intended.
    const resultLine = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      terminal_reason: 'completed',
      stop_reason: 'end_turn',
      num_turns: 1,
      total_cost_usd: 0,
      permission_denials: [],
      session_id: 'fake-env-echo',
      env: process.env,
      cwd: process.cwd(),
      argv: process.argv.slice(2),
    })
    // The routine Stop hook line, same real shape every fixture ends with
    // (spike doc §3.4), so a consumer reading this mode through the same
    // parser as every other mode sees the same terminal housekeeping.
    const stopHookLine = JSON.stringify({
      type: 'system',
      subtype: 'hook_response',
      hook_id: 'fake-env-echo-stop',
      hook_name: 'Stop',
      hook_event: 'Stop',
      output: '',
      stdout: '',
      stderr: '',
      exit_code: 1,
      outcome: 'cancelled',
      session_id: 'fake-env-echo',
    })
    await writeLines([resultLine, stopHookLine])
    process.exit(0)
  }

  if (fixtureName === 'm36-flow') {
    const prompt = await promptText()
    if (await supervisorArm(prompt)) return
    if (await answerArm(prompt)) return
    if (prompt.includes('"verdict"')) {
      await replayFixture('review-approve')
      return
    }
    if (args.includes('--resume')) {
      // The resumed leg: the same session, continuing with its answer in hand. The m8a-flow work
      // body verbatim -- a real commit in the worktree (cwd) -- and then `complete` UNmodified, so
      // this leg carries no ask block and concludes for real.
      if (await workFixtureArm()) return
      writeFileSync(path.join(process.cwd(), 'm36-work.txt'), `${prompt.slice(0, 80)}\n`)
      execFileSync('git', ['-c', 'user.name=Fake Claude', '-c', 'user.email=fake@slaveofai.local', 'add', '-A'], { cwd: process.cwd() })
      execFileSync('git', ['-c', 'user.name=Fake Claude', '-c', 'user.email=fake@slaveofai.local', 'commit', '-q', '-m', 'fake work after the answer'], { cwd: process.cwd() })
      await replayFixture('complete')
      return
    }
    // The asking leg. The envelope comes from the caller, not from this file: the recipient is a
    // slave id (or a role) that only the caller seeding the workspace knows.
    const askJson = askEnvelope()
    if (askJson === undefined || askJson.trim() === '') {
      process.stderr.write('fake-claude: m36-flow needs the <slave-ask> envelope -- pass --ask-json-base64 <base64> (or set FAKE_CLAUDE_ASK_JSON when spawning this script directly)\n')
      process.exit(2)
    }
    // Appended to the LAST assistant text block of the real `complete` capture rather than emitted
    // as a synthetic line of its own: the block then reaches the pump through the exact stream
    // shape a real run produces, and the fixture's own `system:init` line still supplies the
    // session id the checkpoint is written from.
    const lines = readFixtureLines('complete')
    let patched = false
    for (let i = lines.length - 1; i >= 0 && !patched; i -= 1) {
      const parsed = JSON.parse(lines[i])
      if (parsed.type !== 'assistant') continue
      const block = parsed.message?.content?.find?.((part) => part.type === 'text')
      if (block === undefined) continue
      block.text = `${block.text}\n\n<slave-ask>\n${askJson}\n</slave-ask>`
      lines[i] = JSON.stringify(parsed)
      patched = true
    }
    if (!patched) {
      process.stderr.write('fake-claude: m36-flow could not find an assistant text block in the complete fixture\n')
      process.exit(2)
    }
    await writeLines(lines)
    process.exit(0)
  }

  if (fixtureName === 'm8-flow') {
    const prompt = await promptText()
    if (await supervisorArm(prompt)) return
    if (await answerArm(prompt)) return
    if (await replanArm(prompt)) return
    if (prompt.includes('"task graph"')) {
      await replayFixture(planFixtureName())
      return
    }
    if (prompt.includes('"verdict"')) {
      // M49 E8: the VERDICT is chosen on argv here and nowhere else -- `m8a-flow` and `m41-flow`
      // are other milestones' stories and keep their fixed `review-approve`.
      await replayFixture(reviewFixtureName())
      return
    }
    // A work run: the m8a-flow work body verbatim -- leave a real commit in the worktree
    // (cwd), then replay success.
    if (await workFixtureArm()) return
    writeFileSync(path.join(process.cwd(), 'm8a-work.txt'), `${prompt.slice(0, 80)}\n`)
    execFileSync('git', ['-c', 'user.name=Fake Claude', '-c', 'user.email=fake@slaveofai.local', 'add', '-A'], { cwd: process.cwd() })
    execFileSync('git', ['-c', 'user.name=Fake Claude', '-c', 'user.email=fake@slaveofai.local', 'commit', '-q', '-m', 'fake work'], { cwd: process.cwd() })
    await replayFixture('complete')
    return
  }

  if (fixtureName === 'm41-flow') {
    const prompt = await promptText()
    if (await supervisorArm(prompt)) return
    if (await answerArm(prompt)) return
    if (await replanArm(prompt)) return
    if (prompt.includes('"task graph"')) {
      // The story's OWN plan (ruling R4): three `backend` tasks core -> api -> polish, whose
      // `core` description carries the sentence `supervisor-answer.ndjson` cites verbatim.
      await replayFixture('plan-graph-scenario')
      return
    }
    if (prompt.includes('"verdict"')) {
      await replayFixture('review-approve')
      return
    }
    if (isAskingLeg(prompt)) {
      // The asking leg, verbatim from m36-flow. The envelope comes from the caller, not from this
      // file: the recipient is a role (or a slave id) that only the caller seeding the workspace
      // knows. It rides on ARGV beside `--ask-on-task`: M52 R3 gave a run's child an explicit
      // environment allow list, so the env var this used to read no longer arrives from a daemon.
      const askJson = askEnvelope()
      if (askJson === undefined || askJson.trim() === '') {
        process.stderr.write('fake-claude: m41-flow was told to ask on this task but has no <slave-ask> envelope -- pass --ask-json-base64 <base64> (or set FAKE_CLAUDE_ASK_JSON when spawning this script directly)\n')
        process.exit(2)
      }
      // Appended to the LAST assistant text block of the real `complete` capture rather than
      // emitted as a synthetic line of its own: the block then reaches the pump through the exact
      // stream shape a real run produces, and the fixture's own `system:init` line still supplies
      // the session id the checkpoint is written from.
      const lines = readFixtureLines('complete')
      let patched = false
      for (let i = lines.length - 1; i >= 0 && !patched; i -= 1) {
        const parsed = JSON.parse(lines[i])
        if (parsed.type !== 'assistant') continue
        const block = parsed.message?.content?.find?.((part) => part.type === 'text')
        if (block === undefined) continue
        block.text = `${block.text}\n\n<slave-ask>\n${askJson}\n</slave-ask>`
        lines[i] = JSON.stringify(parsed)
        patched = true
      }
      if (!patched) {
        process.stderr.write('fake-claude: m41-flow could not find an assistant text block in the complete fixture\n')
        process.exit(2)
      }
      await writeLines(lines)
      process.exit(0)
    }
    // Any other work run, the RESUMED leg included: the m8a-flow work body verbatim -- a real
    // commit in the worktree (cwd) -- and then `complete` UNmodified, so this leg carries no ask
    // block and concludes for real.
    if (await workFixtureArm()) return
    writeFileSync(path.join(process.cwd(), 'm41-work.txt'), `${prompt.slice(0, 80)}\n`)
    execFileSync('git', ['-c', 'user.name=Fake Claude', '-c', 'user.email=fake@slaveofai.local', 'add', '-A'], { cwd: process.cwd() })
    execFileSync('git', ['-c', 'user.name=Fake Claude', '-c', 'user.email=fake@slaveofai.local', 'commit', '-q', '-m', 'fake work'], { cwd: process.cwd() })
    await replayFixture('complete')
    return
  }

  if (fixtureName === 'm8a-flow') {
    const prompt = await promptText()
    if (await supervisorArm(prompt)) return
    if (await answerArm(prompt)) return
    if (prompt.includes('"verdict"')) {
      await replayFixture('review-approve')
      return
    }
    // A work run: leave a real commit in the worktree (cwd), then replay success.
    if (await workFixtureArm()) return
    writeFileSync(path.join(process.cwd(), 'm8a-work.txt'), `${prompt.slice(0, 80)}\n`)
    execFileSync('git', ['-c', 'user.name=Fake Claude', '-c', 'user.email=fake@slaveofai.local', 'add', '-A'], { cwd: process.cwd() })
    execFileSync('git', ['-c', 'user.name=Fake Claude', '-c', 'user.email=fake@slaveofai.local', 'commit', '-q', '-m', 'fake work'], { cwd: process.cwd() })
    await replayFixture('complete')
    return
  }

  await replayFixture(fixtureName)
}

main()
