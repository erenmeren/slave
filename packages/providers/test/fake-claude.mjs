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
//   M52 R8 hangs three optional side effects off the `--work-fixture` arm,
//   so they reach every mode that has one and change nothing in any mode
//   that is not asked for them. `--env-out <path>` appends this child's own
//   `process.env` as one JSON line -- the only honest way to prove an
//   ABSENCE (no `DATABASE_URL`, no deploy credential) is from inside the
//   process that is supposed not to hold it. `--broker-op <op>` (with
//   `--broker-environment`, `--broker-digest`, `--broker-out`) really
//   spawns `node "$SLAVEOFAI_BROKER_CLI" broker run <op> ...`, so the
//   request travels the channel the daemon is tailing under the identity
//   the daemon issued. `--gate-tool <ToolName>` (with `--gate-out`) runs
//   the REAL `PreToolUse` hook named by the `--settings` file and puts its
//   verdict back into the stream as a `tool_use`/`hook_started`/
//   `hook_response`/`tool_result` quartet -- which is the only way to
//   measure a refusal nobody recorded, because the interesting one is a
//   tool nobody ever denied.
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
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
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
 * so the `m8a-flow` synthetic mode can delegate to it after doing its own side effect.
 *
 * `extraAfterInit` (M52 R8) is the ONE thing that may be interleaved, and it goes AFTER the
 * fixture's first `system`/`init` line rather than in front of the stream: a `tool_use` that
 * arrived before a session id is a shape no real CLI produces, and the pump reads the session id
 * off that line to write its checkpoint. Everything else about the recording -- order, content,
 * the terminal `result` and the routine `Stop` -- is untouched. */
async function replayFixture(name, extraAfterInit = []) {
  const lines = readFixtureLines(name)
  if (extraAfterInit.length === 0) {
    await writeLines(lines)
    process.exit(0)
  }
  const initIndex = lines.findIndex((line) => {
    try {
      const parsed = JSON.parse(line)
      return parsed.type === 'system' && parsed.subtype === 'init'
    } catch {
      return false
    }
  })
  if (initIndex === -1) {
    process.stderr.write(`fake-claude: ${name}.ndjson has no system/init line to inject after\n`)
    process.exit(2)
  }
  await writeLines([...lines.slice(0, initIndex + 1), ...extraAfterInit, ...lines.slice(initIndex + 1)])
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
 *  as `if (await workFixtureArm()) return` in front of its own work body.
 *
 *  M52 R8 hangs three things off it, in this order and for a reason: the environment dump first
 *  (it is a fact about THIS process and must be recorded whatever the rest does), then the broker
 *  call (a real round trip through the orchestrator, which has to finish before the stream ends or
 *  the run would conclude with its own request unanswered), then the gate lines, which are part of
 *  the replay itself. Every one of them is a no-op unless its flag is on argv, so every existing
 *  caller of this arm behaves exactly as it did. */
async function workFixtureArm() {
  const work = workFixtureName()
  if (work === null) return false
  dumpChildEnv()
  runBrokerOp()
  await replayFixture(work, gateLinesFor(fixtureSessionId(work)))
  return true
}

/**
 * M52 R8: this process's OWN environment, appended as one JSON line to `--env-out <path>`.
 *
 * This is how a gate asserts an ABSENCE, which is the only interesting way to assert one: from
 * inside the child that is supposed not to hold the thing. `buildChildEnv`
 * (`packages/providers/src/runtime/process.ts`) hands a worker an explicit `CHILD_ENV_ALLOW` list
 * rather than the daemon's environment, so `DATABASE_URL` and the deploy credential are supposed
 * to be missing here -- and a dump taken by the child itself is the only evidence of that which
 * does not simply restate the code that built it.
 *
 * ARGV, not an environment variable, for the reason `--line-delay-ms` moved there: a name a gate
 * exported on the daemon does not reach this child at all any more. `FAKE_ENV_OUT` stays supported
 * for a caller that spawns this script directly.
 *
 * NDJSON and APPENDED, because a daemon runs several work runs into the same file and the gate
 * wants all of them -- keyed by `SLAVEOFAI_RUN_ID`, which is how it tells one run's child from
 * another's.
 */
function dumpChildEnv() {
  const out = flagValue('--env-out') ?? process.env.FAKE_ENV_OUT
  if (out === undefined || out === '') return
  appendFileSync(
    out,
    `${JSON.stringify({ runId: process.env.SLAVEOFAI_RUN_ID ?? null, cwd: process.cwd(), env: process.env })}\n`,
  )
}

/**
 * M52 R8: a WORK run that calls the broker for real before it replays its fixture.
 *
 * `--broker-op deploy_release` makes the work arm spawn the orchestrator's own thin client --
 * `node "$SLAVEOFAI_BROKER_CLI" broker run deploy_release --environment <--broker-environment>
 * --digest <--broker-digest>` -- with the child's own environment, exactly as a worker's `Bash`
 * tool call would, and records its stdout, stderr and exit code into `--broker-out` before
 * replaying.
 *
 * REALLY spawned, not simulated: the point of the stage is that the request travels through the
 * channel the daemon is tailing, under the identity the daemon issued, with no database in the
 * child. A fake that wrote the reply file itself would prove nothing at all.
 *
 * SYNCHRONOUS, and deliberately: the client blocks until the daemon's broker pass answers it, and
 * a run whose stream ended first would conclude with its own request still outstanding -- the reply
 * would land in a directory nobody was reading. The `spawnSync` is the same "the worker waits for
 * its tool call" shape a real `Bash` call has.
 *
 * The parameters ride on argv rather than in the environment for `--line-delay-ms`'s reason (M52
 * R3): a name exported on the daemon no longer reaches a run's child. `FAKE_BROKER_*` stay
 * supported for a caller that spawns this script directly.
 */
function runBrokerOp() {
  const op = flagValue('--broker-op')
  if (op === undefined) return
  const cli = process.env.SLAVEOFAI_BROKER_CLI
  const environment = flagValue('--broker-environment') ?? process.env.FAKE_BROKER_ENVIRONMENT
  const digest = flagValue('--broker-digest') ?? process.env.FAKE_BROKER_DIGEST
  const out = flagValue('--broker-out') ?? process.env.FAKE_BROKER_OUT
  const record = (entry) => {
    if (out === undefined || out === '') return
    appendFileSync(out, `${JSON.stringify({ runId: process.env.SLAVEOFAI_RUN_ID ?? null, op, ...entry })}\n`)
  }
  if (cli === undefined || cli === '') {
    // Recorded rather than thrown: "the orchestrator never told this child where its client is" is
    // itself a finding the gate must be able to read, and a child that died here would look to the
    // pump like a crashed run instead.
    record({ spawned: false, detail: 'SLAVEOFAI_BROKER_CLI is not set on this child' })
    return
  }
  const argv = [
    cli,
    'broker',
    'run',
    op,
    ...(environment === undefined ? [] : ['--environment', environment]),
    ...(digest === undefined ? [] : ['--digest', digest]),
  ]
  const run = spawnSync('node', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  record({
    spawned: true,
    status: run.status,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
    ...(run.error === undefined ? {} : { detail: String(run.error) }),
  })
}

/**
 * M52 R8: the real `PreToolUse` hook, run for real, on a tool the gate names -- and its verdict
 * put back into the stream in the exact shape the CLI reports one.
 *
 * `--gate-tool WebFetch` is what makes default-deny provable end to end. A RECORDING cannot prove
 * it: the interesting case is a tool nobody ever denied, refused because nobody granted it, and no
 * capture of that exists or could -- the sentence a recording carries was produced by the matrix
 * that existed the day it was recorded. So this arm reads the hook command out of the settings
 * file the adapter wrote (`--settings <path>`, which `claudeFlags` always passes), spawns it with
 * a `PreToolUse` payload naming the tool, and emits what came back. The hook then reads THIS
 * process's own `SLAVEOFAI_PERMISSIONS_FILE` and `SLAVEOFAI_RUN_TOKEN`, which is the whole point:
 * the verdict is the one a real tool call would have got, hashed against the same token.
 *
 * Four lines, in the order `permission-matrix-deny.ndjson` really carries them: the `tool_use`, the
 * `hook_started` that announces the hook and its id, the `hook_response` carrying the hook's stdout
 * DOUBLE-ENCODED (a JSON string inside the line, which is what `extractDenyReason` parses back),
 * and the `tool_result` the CLI echoes. A deny and an allow differ only in the body and in whether
 * the result is an error -- this arm asserts nothing itself, it reports.
 *
 * `--gate-out <path>` records the raw verdict (exit code, stdout, stderr) as NDJSON, so the gate
 * can read what the hook said without parsing it back out of the stream.
 */
function gateLinesFor(sessionId) {
  const tool = flagValue('--gate-tool')
  if (tool === undefined) return []
  const settingsPath = flagValue('--settings')
  if (settingsPath === undefined) {
    process.stderr.write('fake-claude: --gate-tool needs the --settings <path> the adapter passes, and there is none on this argv\n')
    process.exit(2)
  }
  let hookPath
  try {
    hookPath = JSON.parse(readFileSync(settingsPath, 'utf8'))?.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command
  } catch (error) {
    process.stderr.write(`fake-claude: could not read the PreToolUse hook out of ${settingsPath}: ${String(error)}\n`)
    process.exit(2)
  }
  if (typeof hookPath !== 'string' || hookPath === '') {
    process.stderr.write(`fake-claude: ${settingsPath} registers no PreToolUse hook command\n`)
    process.exit(2)
  }

  const suffix = randomBytes(6).toString('hex')
  const toolUseId = `toolu_fake_gate_${suffix}`
  const hookId = `hook_fake_gate_${suffix}`
  // `tool_name` is the ONE key the hook reads (`scripts/lib/permissions.sh`'s node one-liner, and
  // the measurement quoted in its header). The rest is the payload's real shape, so a hook that
  // ever starts reading more of it finds it.
  const payload = JSON.stringify({
    session_id: sessionId,
    cwd: process.cwd(),
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: GATE_TOOL_INPUT[tool] ?? {},
  })
  const run = spawnSync(hookPath, [], { input: payload, encoding: 'utf8' })
  const stdout = run.stdout ?? ''
  const stderr = run.stderr ?? ''
  const exitCode = run.status ?? 2
  const gateOut = flagValue('--gate-out') ?? process.env.FAKE_GATE_OUT
  if (gateOut !== undefined && gateOut !== '') {
    appendFileSync(
      gateOut,
      `${JSON.stringify({ runId: process.env.SLAVEOFAI_RUN_ID ?? null, tool, toolUseId, exitCode, stdout, stderr })}\n`,
    )
  }
  const denied = stdout.includes('"permissionDecision":"deny"')
  return [
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'fake-claude',
        id: `msg_${suffix}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: tool, input: GATE_TOOL_INPUT[tool] ?? {} }],
      },
      session_id: sessionId,
    }),
    JSON.stringify({
      type: 'system',
      subtype: 'hook_started',
      hook_id: hookId,
      hook_name: `PreToolUse:${tool}`,
      hook_event: 'PreToolUse',
      session_id: sessionId,
    }),
    JSON.stringify({
      type: 'system',
      subtype: 'hook_response',
      hook_id: hookId,
      hook_name: `PreToolUse:${tool}`,
      hook_event: 'PreToolUse',
      output: stdout.trim(),
      stdout: stdout.trim(),
      stderr,
      exit_code: exitCode,
      outcome: 'success',
      session_id: sessionId,
    }),
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: denied ? 'the gate refused this call' : 'ok',
            is_error: denied,
          },
        ],
      },
      session_id: sessionId,
    }),
  ]
}

/** What each `--gate-tool` name is called WITH. The hook reads only `tool_name`, so this exists so
 *  the emitted `tool_use` line is a shape a real transcript could carry rather than an empty
 *  object. A tool with no entry is called with `{}`, which is still a legal tool_use block. */
const GATE_TOOL_INPUT = {
  WebFetch: { url: 'https://example.invalid/m52', prompt: 'what does this page say' },
  Read: { file_path: 'README.md' },
  Bash: { command: 'true', description: 'a call the gate makes the hook judge' },
}

/** The `session_id` on a fixture's own `system`/`init` line, so injected lines belong to the same
 *  session the recording does. `null` (never an invented id) when the fixture has none -- the
 *  injected lines then carry `null` and a reader sees that they did. */
function fixtureSessionId(name) {
  for (const line of readFixtureLines(name)) {
    try {
      const parsed = JSON.parse(line)
      if (parsed.type === 'system' && parsed.subtype === 'init') return parsed.session_id ?? null
    } catch {
      /* a fixture line that is not JSON is not an init line */
    }
  }
  return null
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
