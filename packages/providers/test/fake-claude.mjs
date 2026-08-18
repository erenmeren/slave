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
//   anything else  replays `fixtures/<name>.ndjson` verbatim, exit 0 -- real
//                  captures show process exit code 0 even for hook-crash,
//                  hook-deny, and permission-denied runs, so the fake matches
//                  that rather than inventing a nonzero exit for them.
import { readFileSync } from 'node:fs'
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
    // process.env or process.cwd(), because nothing about the CLI's
    // stream format ever would. A later task uses this to prove that git
    // identity, the pause-flag path, and the worktree cwd the caller set
    // actually reach the spawned child.
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

  const lines = readFixtureLines(fixtureName)
  await writeLines(lines)
  process.exit(0)
}

main()
