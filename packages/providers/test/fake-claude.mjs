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
//                  side effect -- no commit, no file written. A review
//                  prompt (containing `"verdict"`) replays `review-approve`,
//                  same as m8a-flow. Any other prompt is a work run and
//                  reuses the m8a-flow work body verbatim.
//   m36-flow       synthetic, selected by ARGV rather than by prompt content:
//                  the two legs of M36's ask/answer round trip. A run spawned
//                  WITHOUT `--resume` is the asking leg -- it replays
//                  `complete` with the ask envelope in
//                  `FAKE_CLAUDE_ASK_JSON` appended to that fixture's last
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

const lineDelayMs = Number(process.env.FAKE_CLAUDE_LINE_DELAY_MS ?? 2)

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
      writeFileSync(path.join(process.cwd(), 'm36-work.txt'), `${prompt.slice(0, 80)}\n`)
      execFileSync('git', ['-c', 'user.name=Fake Claude', '-c', 'user.email=fake@slaveofai.local', 'add', '-A'], { cwd: process.cwd() })
      execFileSync('git', ['-c', 'user.name=Fake Claude', '-c', 'user.email=fake@slaveofai.local', 'commit', '-q', '-m', 'fake work after the answer'], { cwd: process.cwd() })
      await replayFixture('complete')
      return
    }
    // The asking leg. The envelope comes from the environment, not from this file: the recipient
    // is a slave id (or a role) that only the caller seeding the workspace knows.
    const askJson = process.env.FAKE_CLAUDE_ASK_JSON
    if (askJson === undefined || askJson.trim() === '') {
      process.stderr.write('fake-claude: m36-flow needs FAKE_CLAUDE_ASK_JSON (the <slave-ask> envelope) in the environment\n')
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
    if (prompt.includes('"task graph"')) {
      await replayFixture('plan-graph')
      return
    }
    if (prompt.includes('"verdict"')) {
      await replayFixture('review-approve')
      return
    }
    // A work run: the m8a-flow work body verbatim -- leave a real commit in the worktree
    // (cwd), then replay success.
    writeFileSync(path.join(process.cwd(), 'm8a-work.txt'), `${prompt.slice(0, 80)}\n`)
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
    writeFileSync(path.join(process.cwd(), 'm8a-work.txt'), `${prompt.slice(0, 80)}\n`)
    execFileSync('git', ['-c', 'user.name=Fake Claude', '-c', 'user.email=fake@slaveofai.local', 'add', '-A'], { cwd: process.cwd() })
    execFileSync('git', ['-c', 'user.name=Fake Claude', '-c', 'user.email=fake@slaveofai.local', 'commit', '-q', '-m', 'fake work'], { cwd: process.cwd() })
    await replayFixture('complete')
    return
  }

  await replayFixture(fixtureName)
}

main()
