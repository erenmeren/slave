// M56a's own gate (spec section 3): "nothing a provider does changed, and here are the bytes".
//
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
//   npm run gate:m56a-provider-contract
//
// NEVER A MODEL CALL, AND ZERO SPEND. Every child is a fake: `scripts/gate-fakes/fake-claude.sh`
// and `scripts/gate-fakes/fake-cursor-agent.sh`, the second armed by `loopbackChildEnv` itself
// (M56a R10). The two gates that DO spend -- `gate:m12-providers` and `gate:m13-runtime` -- are not
// in CI, are not this gate's business, and are run by hand once before this milestone merges.
//
// IT ARMS ITSELF. Unlike every gate before it, this one sets `SLAVEOFAI_REQUIRE_FAKE_CLI=1` and
// both `SLAVEOFAI_*_BIN` variables on its OWN process when the caller left them unset, and prints
// what it used. Stage 5 calls `buildAdapterRegistry()` in process, so the gate is a process that
// builds adapters and must be armed like any other; and a gate whose zero-spend guarantee depended
// on the shell that invoked it would be a guarantee written in the wrong place. A caller's own
// values always win -- `loopbackChildEnv` never overrides what it is handed either.
//
// NO BROWSER STAGE. Nothing rendered changed, and a Playwright stage asserting that is slower than
// the `web:build` the milestone's web task already gates on.
//
// THE GOLDENS ARE READ, NEVER WRITTEN. `scripts/fixtures/m56a-goldens/` was captured from the tree
// this milestone forked from, before its first edit. This gate compares against those bytes and has
// no mode that regenerates them: a golden a gate can rewrite is not a golden.
//
// THE GATE ASSERTS, IT NEVER FIXES, and every stage prints every measured value before asserting it.
//
// TWELVE STAGES, each measuring one thing the milestone claims:
//   1.  Two manifests, complete, and nobody holds a second copy of the union.
//   2.  The permission verdict is byte-identical -- twelve files, byte for byte -- and the two
//       per-vendor tables that feed it now derive from the manifests (R5's inversion, from the
//       tables' own side).
//   3.  The argv is byte-identical, and the two silent failures are still refused.
//   4.  `capabilitiesOf` equals the golden AND equals the projection -- two paths, five answers.
//   5.  The registry is a table, and an unconfigured kind still refuses.
//   6.  `runFiles` is a record and the checkpoint columns did not move (real daemon, both providers).
//   7.  The spend net covers every registered binary (six unit cases and two live daemons).
//   8.  No `case 'claude_code'` outside a checked-in allow-list.
//   9.  The ladder is read, not written: two ADR anchors, one unchanged byte count, two rungs.
//   10. The model list, the settings cards and the simulation refusal all still say what they said.
//   11. Both providers' event sets are the manifest's.
//   12. Nothing else moved: two catalogues, one lane map, one enum, no migration, one clean tree.
//
// THE TWO GREPS ARE CODE-ONLY (M56a erratum E21). A line whose first non-space characters are
// `//`, `*` or `/*` is a comment, and this tree's comments name the two vendors constantly and on
// purpose -- the wrinkle warnings at `packages/control/src/index.ts:18` and
// `apps/web/src/server/overview.ts:764` exist precisely to say what the spelling used to be. The
// allow-lists admit no comment: a comment is not a dispatch, so it never needs admitting.
//
// Scaffolding borrowed from `scripts/gate-m37-run-context.mjs`, function for function --
// `preflightCleanup()`, `dumpGateRows()`, `fail()`, `waitUntil(description, timeoutMs, probe)`
// whose probe reports what it last SAW, the daemon lifecycle and its `findRealDaemonPids()`
// refusal, "print every measured value before asserting it", FK-ordered cleanup in `finally`,
// `exitCode` starting at 1 and set to 0 only by falling off the end of the `try`, and
// `process.exit(exitCode)` as the last line. Stage 6's two-provider dispatch is
// `scripts/gate-m13-runtime.mjs:938-941` and `:1122-1250`'s -- one worker per provider in one
// team, each paused through `requestPause` and read back off its `Checkpoint` row -- with one
// difference: this gate ALWAYS runs the fakes, because `loopbackChildEnv` arms them, and it has no
// real-binary mode at all.

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { findRealDaemonPids } from './lib/daemon-process.mjs'
import { prisma } from '../packages/db/dist/client.js'
import {
  ACTION_KINDS,
  ENFORCE_BY_PROVIDER,
  LANE_BY_TYPE,
  PERMISSION_KINDS,
  PERMISSION_RUN_KINDS,
  PROVIDER_KINDS,
  PROVIDER_LABEL,
  PROVIDER_MANIFESTS,
  RUNTIME_EVENT_KINDS,
  SITUATION_KINDS,
  TOOLS_BY_KIND,
  manifestFor,
  providerManifestSchema,
} from '../packages/domain/dist/index.js'
import {
  CHILD_ENV_ALLOW,
  PROVIDER_ADAPTERS,
  UnknownProviderError,
  UnregistrableProviderError,
  admitAdapter,
  buildRegistry,
  capabilitiesOf,
  claudeFlags,
  cursorFlags,
  listProviderModels,
  parseCursorLine,
  parseCursorModels,
  parseStreamLine,
  signalPause,
} from '../packages/providers/dist/index.js'
import {
  createSimulation,
  isAlive,
  refusalText,
  requestPause,
  writePermissionsFile,
} from '../packages/control/dist/index.js'
import {
  REQUIRE_FAKE_CLI_REFUSAL,
  fakeCliRefusal,
  requireFakeCliRefusal,
} from '../apps/orchestrator/dist/require-fake-cli.js'
import { buildAdapterRegistry } from '../apps/orchestrator/dist/cli.js'

const POLL_INTERVAL_MS = 50
const DAEMON_PERIOD_MS = 500
// Generous, and every one of them bounds real work: a `git worktree add`, a fake CLI replay, a
// kill with its grace window. Tuned to "a slow machine still passes", not to "a fast one is proven".
const DISPATCH_TIMEOUT_MS = 120_000
const WORKING_TIMEOUT_MS = 180_000
const PAUSE_SETTLE_TIMEOUT_MS = 180_000
const DAEMON_START_TIMEOUT_MS = 120_000
const DAEMON_REFUSAL_TIMEOUT_MS = 60_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const GOLDENS = join(repoRoot, 'scripts/fixtures/m56a-goldens')
const FAKE_CLAUDE = join(repoRoot, 'scripts/gate-fakes/fake-claude.sh')
const FAKE_CURSOR = join(repoRoot, 'scripts/gate-fakes/fake-cursor-agent.sh')

// The ADR's size on the tree this milestone forked from, read at execution time and written in
// (spec §3 stage 9). "The ADR gains no new text" is a ruling, and a ruling a number can state is a
// ruling a reviewer sees broken in the same commit that breaks it.
const PAUSE_ADR = 'docs/decisions/0001-pause-semantics.md'
const PAUSE_ADR_BYTES = 38_862

// The fixed inputs `scripts/fixtures/m56a-goldens/permissions-*.json` were captured with, so the
// twelve comparisons are total rather than field-wise (spec §3 stage 2).
const GOLDEN_RUN_ID = '00000000-0000-4000-8000-000000000m56'
const GOLDEN_RUN_TOKEN = 'm56a-golden-token-not-a-secret'
// Claude's governed vocabulary, as a count somebody can re-run (M56a erratum E22). The `mcp__*`
// prefix rule covers every name this list cannot enumerate, and it is asserted separately.
const CLAUDE_VOCABULARY_NAMES = 38

/**
 * The spend net's two sentences, as BYTES rather than as a call (spec §3 stage 7, fix round 1).
 *
 * The Claude one is the historical constant this milestone promised to preserve byte for byte: it
 * was `refusing to start: SLAVEOFAI_REQUIRE_FAKE_CLI is set but SLAVEOFAI_CLAUDE_BIN is not the fake
 * CLI` before R10 widened the net, and `requireFakeCliRefusal(envVar)` has to keep rendering exactly
 * that for the `SLAVEOFAI_CLAUDE_BIN` case. Spelled out here, and never derived: asking
 * `requireFakeCliRefusal('SLAVEOFAI_CLAUDE_BIN')` whether it equals
 * `REQUIRE_FAKE_CLI_REFUSAL` compares one call to the same call -- `require-fake-cli.ts:18` DEFINES
 * the constant as that call -- so the template could be reworded any way at all and the comparison
 * would still hold. A golden is bytes somebody wrote down; this is the same rule stage 10 follows
 * for the two `unsupported_model_provider` sentences, applied to the one sentence a widened net had
 * the most opportunity to move.
 *
 * The Cursor one is the same template with the other hole filled, and is pinned the same way so the
 * hole itself is proven to be a hole rather than a second hard-coded string.
 */
const HISTORICAL_CLAUDE_REFUSAL =
  'refusing to start: SLAVEOFAI_REQUIRE_FAKE_CLI is set but SLAVEOFAI_CLAUDE_BIN is not the fake CLI'
const CURSOR_BIN_REFUSAL =
  'refusing to start: SLAVEOFAI_REQUIRE_FAKE_CLI is set but SLAVEOFAI_CURSOR_BIN is not the fake CLI'

// Exact literals, never suffixed -- `preflightCleanup` removes whatever a prior crashed run left on
// these exact names, in the same FK order the `finally` block uses.
const WORKSPACE_NAME = 'M56a Gate Project'
const CLAUDE_WORKER = 'M56a Gate Claude'
const CURSOR_WORKER = 'M56a Gate Cursor'
const TASK_TITLE = 'M56a Gate Task'
const PAUSE_REQUESTER = 'the M56a gate'
// A model that is never resolved against a vendor: both workers must carry an explicit
// `(model, provider)` pair, because `resolveRuntime` only consults a level that NAMES a model --
// a worker with a null model falls through to the workspace default and both runs land on one
// runtime, which is the one thing stage 6 cannot afford.
const CLAUDE_MODEL = 'fake-claude'
const CURSOR_MODEL = 'auto'

const readGolden = (name) => JSON.parse(readFileSync(join(GOLDENS, name), 'utf8'))

/** Deep equality that does not care what order an object's keys were written in -- the goldens are
 *  JSON files and key order is not behaviour. Stage 2 is the byte comparison; this is everything
 *  else. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    )
  }
  return value
}

/** A line whose first non-space characters open a comment (M56a erratum E21). */
const isCommentLine = (text) => /^\s*(\/\/|\*|\/\*)/.test(text)

/**
 * `git grep -n -E`, as a list of `{ path, line, text }`.
 *
 * `dist/` is always excluded (a build output is not a copy somebody wrote); `excludeTests` drops
 * `test/` directories and `*.test.*` files, and `codeOnly` drops comment lines. Both are per-stage
 * because stage 1's union grep and stages 5/8's dispatch greps have different subjects.
 *
 * `git grep` only sees TRACKED files, which is why `packages/db/src/generated/enums.ts` never
 * appears in a hit list and is checked with `existsSync` instead.
 */
function gitGrep(pattern, paths, options = {}) {
  const { excludeTests = false, codeOnly = false } = options
  let stdout = ''
  try {
    stdout = execFileSync('git', ['grep', '-n', '-E', pattern, '--', ...paths], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch (error) {
    // `git grep` exits 1 when nothing matched, which is an answer and not a failure.
    if (error !== null && typeof error === 'object' && error.status === 1) stdout = ''
    else throw error
  }
  const hits = []
  for (const raw of stdout.split('\n')) {
    if (raw === '') continue
    const first = raw.indexOf(':')
    const second = raw.indexOf(':', first + 1)
    const path = raw.slice(0, first)
    const text = raw.slice(second + 1)
    if (path.includes('/dist/') || path.startsWith('dist/')) continue
    if (excludeTests && (path.includes('/test/') || /\.test\./.test(basename(path)))) continue
    if (codeOnly && isCommentLine(text)) continue
    hits.push({ path, line: Number(raw.slice(first + 1, second)), text })
  }
  return hits
}

const describeHits = (hits) => (hits.length === 0 ? '<none>' : hits.map((h) => `${h.path}:${h.line}: ${h.text.trim()}`).join('\n    '))

/** Every `*.ndjson` under `dir`, recursively, sorted -- stage 11 replays all of them. */
function ndjsonFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...ndjsonFiles(path))
    else if (entry.name.endsWith('.ndjson')) found.push(path)
  }
  return found
}

/** `a` appears inside `b` in order, with gaps allowed (M56a erratum E12). */
function isSubsequence(a, b) {
  let index = 0
  for (const item of b) if (index < a.length && a[index] === item) index += 1
  return index === a.length
}

/** GitHub's own heading anchor: lower-case, drop everything but letters, digits, spaces and
 *  hyphens, then spaces to hyphens. */
const slugify = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .replace(/ +/g, '-')

let exitCode = 1
let repoPath = null
let workspaceId = null
let statusBefore = null
/** Every daemon this gate has ever spawned, in order -- the `finally` block kills whichever of them
 *  is somehow still alive, not just the last one. */
const daemons = []

/** Every row this gate could have written, for a FAIL's diagnostic dump. BigInt `seq` stringified. */
async function dumpGateRows() {
  const workspace =
    workspaceId === null
      ? null
      : await prisma.workspace.findUnique({
          where: { id: workspaceId },
          include: { tasks: true, teams: { include: { slaves: { include: { runs: { include: { checkpoint: true } } } } } } },
        })
  const events =
    workspaceId === null ? [] : await prisma.executionEvent.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
  const daemonTails = daemons.map((d) => ({
    label: d.label,
    pid: d.proc.pid ?? null,
    exited: d.exited,
    output: d.output.length > 6_000 ? `…${d.output.slice(-6_000)}` : d.output,
  }))
  return JSON.stringify({ workspace, events, daemonTails }, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  )
}

/** The `gate-m35`/`gate-m36`/`gate-m37` diagnostic throw: an Error carrying the state that made the
 *  call, not just the sentence that noticed. */
async function fail(message) {
  const dump = await dumpGateRows().catch(
    (cause) => `<could not dump gate rows: ${cause instanceof Error ? cause.message : String(cause)}>`,
  )
  throw new Error(`${message} -- gateRows=${dump}`)
}

/** Prints the measured value, then asserts it. Deep equality, key order ignored. */
async function assertEqual(actual, expected, label) {
  const seen = JSON.stringify(canonical(actual))
  const want = JSON.stringify(canonical(expected))
  console.log(`  ${label}: ${seen}`)
  if (seen !== want) await fail(`${label}\n    actual:   ${seen}\n    expected: ${want}`)
}

/** The refusals the flag builders exist to raise, each asserted by its own sentence. */
async function assertThrows(thunk, pattern, label) {
  let message = null
  try {
    await thunk()
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  console.log(`  ${label}: ${message === null ? '<did not throw>' : JSON.stringify(message)}`)
  if (message === null) await fail(`${label}: nothing was thrown`)
  if (!pattern.test(message)) await fail(`${label}: the message does not match ${String(pattern)}`)
}

/** Same as `gate-m36-messaging.mjs`'s `makeRepo` -- a real repository, because the tick provisions a
 *  real worktree in it and the fake CLIs write into that worktree. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m56a-repo-'))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

/** Removes what a prior interrupted run left behind, in the same order the `finally` block uses. */
async function preflightCleanup() {
  const stale = await prisma.workspace.findUnique({ where: { name: WORKSPACE_NAME } })
  if (stale !== null) {
    console.log(`preflight: removing a leftover ${WORKSPACE_NAME} (${stale.id}) from an earlier interrupted run`)
    await prisma.executionEvent.deleteMany({ where: { workspaceId: stale.id } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: stale.id } }).catch(() => {})
  }
}

try {
  if (!existsSync(ORCHESTRATOR_CLI)) throw new Error(`orchestrator CLI not built at ${ORCHESTRATOR_CLI} -- run tsc --build first`)
  for (const fake of [FAKE_CLAUDE, FAKE_CURSOR]) {
    if (!existsSync(fake)) throw new Error(`a rehearsal fake is missing at ${fake}; this gate has no real-binary mode`)
  }

  // ARMED BEFORE ANYTHING ELSE. `buildAdapterRegistry()` (stage 5) reads these out of THIS process's
  // environment, and `loopbackChildEnv` reads the flag off the environment it is handed; a caller's
  // own values are never overridden.
  for (const [name, value] of [
    ['SLAVEOFAI_REQUIRE_FAKE_CLI', '1'],
    ['SLAVEOFAI_CLAUDE_BIN', FAKE_CLAUDE],
    ['SLAVEOFAI_CURSOR_BIN', FAKE_CURSOR],
  ]) {
    const existing = process.env[name]
    if (existing === undefined || existing.trim() === '') process.env[name] = value
  }
  console.log(
    `armed: SLAVEOFAI_REQUIRE_FAKE_CLI=${process.env['SLAVEOFAI_REQUIRE_FAKE_CLI']} ` +
      `SLAVEOFAI_CLAUDE_BIN=${process.env['SLAVEOFAI_CLAUDE_BIN']} ` +
      `SLAVEOFAI_CURSOR_BIN=${process.env['SLAVEOFAI_CURSOR_BIN']}`,
  )

  // Refused rather than tolerated (`gate-m36`/`gate-m37`'s own refusal): stage 6 dispatches two runs
  // and pauses them, and somebody else's daemon in the same database would claim them first.
  const strayDaemons = findRealDaemonPids()
  if (strayDaemons.length > 0) {
    throw new Error(
      `gate:m56a-provider-contract REFUSED -- an orchestrator daemon is already running (pid ${strayDaemons.join(', ')}); ` +
        'stage 6 dispatches and pauses two runs of its own and cannot do that beside another scheduler',
    )
  }

  statusBefore = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' })
  console.log(`git status --porcelain before the run (${statusBefore.split('\n').filter((l) => l !== '').length} line(s))`)

  await preflightCleanup()

  /** Polls until `probe` returns something non-null, or fails naming what it last saw. */
  let activeDaemon = null
  async function waitUntil(description, timeoutMs, probe) {
    const deadline = Date.now() + timeoutMs
    let lastSeen = '<nothing yet>'
    for (;;) {
      const result = await probe((seen) => {
        lastSeen = seen
      })
      if (result !== null && result !== undefined) return result
      if (activeDaemon !== null && activeDaemon.exited) {
        await fail(`the ${activeDaemon.label} exited while waiting for ${description} -- last seen: ${lastSeen}`)
      }
      if (Date.now() >= deadline) {
        await fail(`timed out after ${String(timeoutMs)}ms waiting for ${description} -- last seen: ${lastSeen}`)
      }
      await delay(POLL_INTERVAL_MS)
    }
  }

  /** The real daemon, in the background -- the same thing an operator leaves running. `extraEnv` is
   *  spread AFTER `loopbackChildEnv()`, which is stage 7's own point: the helper arms the fakes, so
   *  an override that puts a real binary name back has to come after it. */
  function spawnDaemon(label, extraEnv = {}, { track = true } = {}) {
    const proc = spawn(
      'node',
      [ORCHESTRATOR_CLI, 'daemon', '--workspace', workspaceId, '--period', String(DAEMON_PERIOD_MS)],
      {
        cwd: repoRoot,
        // THE STEP GAP ARRIVES ON ARGV (M52 R3), the same channel `gate-m14-fidelity.mjs` uses:
        // `fake-claude.sh` walks eight "tool calls" and, at its own 700 ms default, is finished in
        // under six seconds -- before a gate that waits for BOTH runs to be dispatched can pause
        // either. Two seconds a step gives stage 6 a run that is still working when it asks.
        env: { SLAVEOFAI_CLAUDE_ARGS: '--step-gap-ms 2000', ...loopbackChildEnv(), ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const state = { label, proc, output: '', stderr: '', exited: false, code: null }
    proc.stdout.on('data', (chunk) => {
      state.output += chunk.toString()
      process.stdout.write(`[${label}] ${chunk}`)
    })
    proc.stderr.on('data', (chunk) => {
      state.output += chunk.toString()
      state.stderr += chunk.toString()
      process.stderr.write(`[${label}] ${chunk}`)
    })
    proc.on('exit', (code, signal) => {
      state.exited = true
      state.code = code
      state.output += `\n<${label} exited: code=${String(code)} signal=${String(signal)}>\n`
    })
    proc.on('error', (error) => {
      state.exited = true
      state.output += `\n<${label} failed to start: ${String(error)}>\n`
    })
    daemons.push(state)
    if (track) activeDaemon = state
    console.log(`${label} spawned as pid ${String(proc.pid)}`)
    return state
  }

  async function stopDaemon(state) {
    if (state === activeDaemon) activeDaemon = null
    if (state.exited) return
    state.proc.kill('SIGTERM')
    const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (!state.exited && Date.now() < deadline) await delay(POLL_INTERVAL_MS)
    if (!state.exited) state.proc.kill('SIGKILL')
  }

  // ================= Stage 1: two manifests, and one union ========================================
  console.log('\n=== stage 1: two manifests, complete, and nobody holds a second copy of the union')

  await assertEqual(Object.keys(PROVIDER_MANIFESTS).sort(), [...PROVIDER_KINDS].sort(), 'PROVIDER_MANIFESTS members')
  for (const kind of PROVIDER_KINDS) {
    const manifest = manifestFor(kind)
    if (manifest.kind !== kind) await fail(`stage 1: PROVIDER_MANIFESTS.${kind} reports kind ${JSON.stringify(manifest.kind)}`)
    const parsed = providerManifestSchema.safeParse(PROVIDER_MANIFESTS[kind])
    console.log(`  ${kind}: schema ${parsed.success ? 'ok' : 'REJECTED'}, ${manifest.differences.length} stated difference(s)`)
    if (!parsed.success) await fail(`stage 1: ${kind}'s manifest fails its own schema: ${JSON.stringify(parsed.error.issues)}`)
    if (manifest.differences.length === 0) {
      await fail(`stage 1: ${kind} states no limitation -- a provider with none is one nobody measured`)
    }
  }

  // NOT code-only, unlike stages 5 and 8 (M56a erratum E21): stage 1's claim is that the union
  // exists in exactly one place, and a comment carrying a second copy of a list is still a second
  // copy of the list somebody will one day edit only one of. Only `dist/` and the ten test files
  // that spell the two members deliberately (erratum E5) are excluded.
  const unionHits = gitGrep("'claude_code' *\\| *'cursor'", ['packages', 'apps', 'scripts'], { excludeTests: true })
  console.log(`  union literal hits:\n    ${describeHits(unionHits)}`)
  if (unionHits.length !== 1 || unionHits[0].path !== 'packages/domain/src/provider/kind.ts') {
    await fail(`stage 1: the union literal exists in ${unionHits.length} place(s); exactly one, in packages/domain/src/provider/kind.ts, is the claim`)
  }
  const arrayHits = gitGrep("\\['claude_code', *'cursor'\\]", ['packages', 'apps', 'scripts'], { excludeTests: true })
  console.log(`  array literal hits:\n    ${describeHits(arrayHits)}`)
  if (arrayHits.length !== 1 || arrayHits[0].path !== 'packages/domain/src/provider/kind.ts') {
    await fail(`stage 1: the PROVIDER_KINDS array literal exists in ${arrayHits.length} place(s); exactly one is the claim`)
  }
  console.log('stage 1 complete: two measured manifests, one union literal, one array literal')

  // ================= Stage 2: the permission verdict, byte for byte ===============================
  console.log('\n=== stage 2: the permission verdict is byte-identical -- twelve files, byte for byte')

  const grantSets = { baseline: [], granted: PERMISSION_KINDS.map((kind) => ({ kind, mode: 'allow' })) }
  let compared = 0
  for (const provider of PROVIDER_KINDS) {
    for (const runKind of PERMISSION_RUN_KINDS) {
      for (const [setName, rows] of Object.entries(grantSets)) {
        const dir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m56a-perm-'))
        try {
          const written = writePermissionsFile(dir, {
            rows,
            provider,
            runKind,
            runId: GOLDEN_RUN_ID,
            runToken: GOLDEN_RUN_TOKEN,
          })
          const goldenPath = join(GOLDENS, `permissions-${provider}-${runKind}-${setName}.json`)
          const actual = readFileSync(written)
          const expected = readFileSync(goldenPath)
          console.log(`  ${provider}/${runKind}/${setName}: ${actual.length} bytes vs golden ${expected.length} bytes`)
          if (Buffer.compare(actual, expected) !== 0) {
            // Five different stories, and a byte diff tells none of them.
            const a = JSON.parse(actual.toString('utf8'))
            const b = JSON.parse(expected.toString('utf8'))
            const differing = Object.keys(b).filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
            await fail(
              `stage 2: permissions-${provider}-${runKind}-${setName}.json differs from the golden in ` +
                `${JSON.stringify(differing)}\n    actual:   ${JSON.stringify(differing.map((k) => a[k]))}` +
                `\n    expected: ${JSON.stringify(differing.map((k) => b[k]))}`,
            )
          }
          compared += 1
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }
    }
  }
  if (compared !== 12) await fail(`stage 2: compared ${compared} permission files, expected twelve`)

  // R5's inversion, from the tables' own side: the two per-vendor tables still hold what they held,
  // and each one now DERIVES from the manifest it was inverted into.
  await assertEqual(TOOLS_BY_KIND, readGolden('tools-by-kind.json'), 'TOOLS_BY_KIND against its golden')
  await assertEqual(ENFORCE_BY_PROVIDER, readGolden('enforce-by-provider.json'), 'ENFORCE_BY_PROVIDER against its golden')
  const goldenEnforce = readGolden('enforce-by-provider.json')
  for (const kind of PROVIDER_KINDS) {
    // VALUE equality, not identity (M56a erratum E22): `ENFORCE_BY_PROVIDER[kind]` is a string, and
    // `===` between two equal strings proves nothing about where either came from.
    const fromTable = ENFORCE_BY_PROVIDER[kind]
    const fromManifest = manifestFor(kind).toolRestrictions.enforce
    console.log(`  ${kind}: ENFORCE_BY_PROVIDER=${fromTable}, manifest=${fromManifest}, golden=${goldenEnforce[kind]}`)
    if (fromTable !== fromManifest || fromTable !== goldenEnforce[kind]) {
      await fail(`stage 2: ${kind}'s enforce mode disagrees between the table, the manifest and the golden`)
    }
    for (const permissionKind of PERMISSION_KINDS) {
      await assertEqual(
        TOOLS_BY_KIND[permissionKind][kind],
        manifestFor(kind).toolVocabulary[permissionKind],
        `TOOLS_BY_KIND.${permissionKind}.${kind} derives from the manifest`,
      )
    }
  }
  const claudeVocabulary = Object.keys(readGolden('permissions-claude_code-implementation-granted.json').vocabulary)
  console.log(`  Claude's governed vocabulary: ${claudeVocabulary.length} names`)
  if (claudeVocabulary.length !== CLAUDE_VOCABULARY_NAMES) {
    await fail(`stage 2: Claude's golden vocabulary holds ${claudeVocabulary.length} names, expected ${CLAUDE_VOCABULARY_NAMES}`)
  }
  const prefixes = readGolden('permissions-claude_code-implementation-granted.json').prefixes
  await assertEqual(prefixes, [{ prefix: 'mcp__', kind: 'network_fetch' }], 'the one prefix rule the vocabulary cannot enumerate')
  console.log('stage 2 complete: twelve verdicts byte for byte, and both per-vendor tables derive from the manifests')

  // ================= Stage 3: the argv, byte for byte =============================================
  console.log('\n=== stage 3: the argv is byte-identical, and the two silent failures are still refused')

  const argv = readGolden('argv.json')
  await assertEqual(claudeFlags({ settingsPath: argv.claudeSettingsPath }), argv.claude, 'claudeFlags')
  await assertEqual(cursorFlags({}), argv.cursorPlain, 'cursorFlags({})')
  await assertEqual(cursorFlags({ model: 'auto' }), argv.cursorModel, 'cursorFlags({ model })')
  await assertEqual(
    cursorFlags({ resume: { sessionId: 'm56a-golden-session' } }),
    argv.cursorResume,
    'cursorFlags({ resume })',
  )
  await assertEqual(
    cursorFlags({ model: 'auto', resume: { sessionId: 'm56a-golden-session' } }),
    argv.cursorModelAndResume,
    'cursorFlags({ model, resume })',
  )

  const everyArgv = [argv.claude, argv.cursorPlain, argv.cursorModel, argv.cursorResume, argv.cursorModelAndResume]
  // THE GATE LIVES UNDER ITS OWN STAGE-8 RULE. Every per-kind fact this script needs is a total
  // table keyed by `ProviderKind`, never a `case` or an `===` on a vendor's name: a gate that
  // dispatched on a literal would be the first hit its own grep reported, and answering that with
  // an allow-list entry for itself is exactly the widening that grep exists to make visible.
  const GOLDEN_ARGV_OF = { claude_code: argv.claude, cursor: argv.cursorPlain }
  for (const kind of PROVIDER_KINDS) {
    const { headlessFlags, neverPass } = manifestFor(kind).invocation
    const real = GOLDEN_ARGV_OF[kind]
    console.log(`  ${kind}: headlessFlags ${JSON.stringify(headlessFlags)} against ${JSON.stringify(real)}`)
    // An in-order SUBSEQUENCE, not a prefix: `--settings <path>` sits INSIDE Claude's constant half.
    if (!isSubsequence(headlessFlags, real)) {
      await fail(`stage 3: ${kind}'s headlessFlags are not an in-order subsequence of its argv`)
    }
    console.log(`  ${kind}: neverPass ${JSON.stringify(neverPass)}`)
    for (const flag of neverPass) {
      for (const one of everyArgv) {
        if (one.includes(flag)) await fail(`stage 3: ${kind} declares ${flag} never-pass and an argv carries it: ${JSON.stringify(one)}`)
      }
    }
  }

  await assertThrows(() => claudeFlags({ settingsPath: 'settings.json' }), /absolute/, 'a relative --settings is refused')
  await assertThrows(() => cursorFlags({ resume: { sessionId: '  ' } }), /non-empty/, 'a blank --resume id is refused')
  console.log('stage 3 complete: five argv shapes element for element, every never-pass flag absent, both refusals intact')

  // ================= Stage 4: capabilitiesOf, from two directions =================================
  console.log('\n=== stage 4: capabilitiesOf equals the golden AND equals the projection')

  const capabilityGolden = readGolden('capabilities.json')
  for (const kind of PROVIDER_KINDS) {
    const capabilities = capabilitiesOf(kind)
    await assertEqual(capabilities, capabilityGolden[kind], `capabilitiesOf(${kind}) against the golden`)
    const manifest = manifestFor(kind)
    const projection = {
      canPauseMidRun: manifest.pause.rung === 'hook',
      canResumeSession: manifest.resume.mode !== 'none',
      gate: manifest.toolRestrictions.mechanism === 'none' ? 'none' : 'all-tools',
      reportsCost: manifest.usageCost === 'reported',
      reportsToolResults: manifest.events.produces.includes('tool_result'),
    }
    await assertEqual(capabilities, projection, `capabilitiesOf(${kind}) against R4's projection over its manifest`)
    // The identity the adapter's delegation rests on: one table, not two that agree today.
    console.log(`  capabilitiesOf(${kind}) is the same object twice: ${String(capabilitiesOf(kind) === capabilitiesOf(kind))}`)
    if (capabilitiesOf(kind) !== capabilitiesOf(kind)) {
      await fail(`stage 4: capabilitiesOf(${kind}) hands out a fresh object per call, so there is no one table`)
    }
  }
  console.log('stage 4 complete: five members, two kinds, two independent paths to the same answers')

  // ================= Stage 5: the registry ========================================================
  console.log('\n=== stage 5: the registry is a table, and an unconfigured kind still refuses')

  await assertEqual(Object.keys(PROVIDER_ADAPTERS).sort(), [...PROVIDER_KINDS].sort(), 'PROVIDER_ADAPTERS members')

  const empty = buildRegistry({})
  for (const kind of PROVIDER_KINDS) {
    let caught = null
    try {
      empty.resolve(kind)
    } catch (error) {
      caught = error
    }
    console.log(`  buildRegistry({}).resolve(${kind}) threw: ${caught === null ? '<nothing>' : caught.constructor.name}`)
    if (!(caught instanceof UnknownProviderError)) {
      await fail(`stage 5: an empty registry did not refuse ${kind} with UnknownProviderError`)
    }
  }

  const wiring = {
    command: FAKE_CLAUDE,
    scripts: {
      hookPath: join(repoRoot, 'scripts/pause-gate.sh'),
      gatePath: join(repoRoot, 'scripts/cursor-shell-gate.sh'),
    },
  }
  for (const configured of PROVIDER_KINDS) {
    // The command comes out of that kind's OWN `binEnvVar`, which this process armed at the top --
    // one more reading that a third provider gets for free, and no vendor name in the middle of it.
    const command = process.env[manifestFor(configured).invocation.binEnvVar]
    const partial = buildRegistry({ [configured]: { ...wiring, command } })
    const resolved = partial.resolve(configured)
    console.log(`  a registry given only ${configured} resolves it to ${resolved.constructor.name} (kind ${resolved.kind})`)
    if (resolved.kind !== configured) await fail(`stage 5: a registry given only ${configured} resolved it to kind ${resolved.kind}`)
    for (const other of PROVIDER_KINDS) {
      if (other === configured) continue
      let caught = null
      try {
        partial.resolve(other)
      } catch (error) {
        caught = error
      }
      console.log(`  ...and refuses ${other}: ${caught === null ? '<nothing>' : caught.constructor.name}`)
      if (!(caught instanceof UnknownProviderError)) {
        await fail(`stage 5: a registry given only ${configured} did not refuse ${other}`)
      }
    }
  }

  const neitherCapability = {
    kind: 'cursor',
    getCapabilities: () => ({
      canPauseMidRun: false,
      canResumeSession: false,
      gate: 'none',
      reportsCost: false,
      reportsToolResults: false,
    }),
  }
  await assertThrows(
    () => admitAdapter('cursor', neitherCapability),
    /declares neither canPauseMidRun nor canResumeSession/,
    'admitAdapter refuses an adapter with neither pause capability',
  )
  let admitError = null
  try {
    admitAdapter('cursor', neitherCapability)
  } catch (error) {
    admitError = error
  }
  if (!(admitError instanceof UnregistrableProviderError)) {
    await fail(`stage 5: admitAdapter threw ${admitError === null ? '<nothing>' : admitError.constructor.name}, expected UnregistrableProviderError`)
  }

  // The whole wiring loop, in a process with both bin variables set to the fakes.
  const live = buildAdapterRegistry()
  for (const kind of PROVIDER_KINDS) {
    const adapter = live.resolve(kind)
    console.log(`  buildAdapterRegistry().resolve(${kind}) -> ${adapter.constructor.name}, kind ${JSON.stringify(adapter.kind)}`)
    if (adapter.kind !== kind) await fail(`stage 5: buildAdapterRegistry resolved ${kind} to an adapter reporting ${JSON.stringify(adapter.kind)}`)
    if (adapter.constructor.name !== PROVIDER_ADAPTERS[kind].adapterName) {
      await fail(`stage 5: ${kind} resolved to ${adapter.constructor.name}, and PROVIDER_ADAPTERS says ${PROVIDER_ADAPTERS[kind].adapterName}`)
    }
  }

  // The spelling wrinkle, closed. Code-only: the tree's two warning comments say what the spelling
  // USED to be, which is exactly what a warning comment is for.
  //
  // THE PATTERN IS ASSEMBLED RATHER THAN SPELLED, and that is not decoration. This grep covers
  // `scripts/`, which since this file was committed includes this file: a gate that spelled the
  // hyphenated id in its own source would match itself, and the only other ways out are a carve-out
  // for this one path -- a silent exclusion a reviewer cannot see -- or a grep that stops covering
  // the gate. Assembling it keeps the search TOTAL, this file included, for one line of explanation.
  const hyphenatedId = `'claude${'-'}code'`
  const hyphenatedComments = gitGrep(hyphenatedId, ['packages', 'apps', 'scripts'], { excludeTests: true })
  const hyphenated = gitGrep(hyphenatedId, ['packages', 'apps', 'scripts'], { excludeTests: true, codeOnly: true })
  console.log(`  ${hyphenatedId} mentions (comments included):\n    ${describeHits(hyphenatedComments)}`)
  console.log(`  ${hyphenatedId} in CODE:\n    ${describeHits(hyphenated)}`)
  if (hyphenated.length !== 0) {
    await fail(`stage 5: the hyphenated adapter id is back in code at ${describeHits(hyphenated)}`)
  }
  console.log('stage 5 complete: one table, two refusals, both kinds resolved under the enum spelling')

  // ================= Stage 6: runFiles, and the two columns =======================================
  console.log('\n=== stage 6: runFiles is a record and the checkpoint columns did not move')

  // The structural half first: it spawns nothing, so a manifest that declares three channels fails
  // in a second rather than after two dispatches.
  for (const kind of PROVIDER_KINDS) {
    const { channels, persisted } = manifestFor(kind).runFiles
    console.log(`  ${kind}: channels ${JSON.stringify(channels)}, persisted ${JSON.stringify(persisted)}`)
    if (channels.length !== 2) {
      await fail(`stage 6: ${kind} declares ${channels.length} run-file channels; only two survive a pause until Checkpoint gains a Json column`)
    }
    for (const name of persisted) {
      if (!channels.includes(name)) await fail(`stage 6: ${kind} persists a channel it does not declare: ${name}`)
    }
  }

  const runFilesAllowlist = readGolden('run-files-allowlist.json')
  const runFilesHits = gitGrep('runFiles', ['packages', 'apps'], { excludeTests: true }).filter((hit) =>
    /^(apps|packages)\/[^/]+\/src\//.test(hit.path),
  )
  const runFilesFiles = [...new Set(runFilesHits.map((hit) => hit.path))].sort()
  console.log(`  files under a package's src/ that spell runFiles:\n    ${runFilesFiles.join('\n    ')}`)
  for (const path of runFilesFiles) {
    if (!runFilesAllowlist.runFilesMayAppearIn.includes(path)) {
      await fail(`stage 6: ${path} spells runFiles and is not on scripts/fixtures/m56a-goldens/run-files-allowlist.json`)
    }
  }
  for (const path of runFilesAllowlist.runFilesMayAppearIn) {
    if (!existsSync(join(repoRoot, path))) await fail(`stage 6: the run-files allow-list names ${path}, which is not on disk`)
  }
  for (const entry of runFilesAllowlist.columnPairMayAppearIn) {
    const source = readFileSync(join(repoRoot, entry.path), 'utf8')
    if (!source.includes('settingsPath') || !source.includes('hookPath')) {
      await fail(`stage 6: the allow-list carries ${entry.path} for the column pair and the file no longer spells both names`)
    }
  }
  for (const path of runFilesAllowlist.commentOnlyIn) {
    const code = gitGrep('settingsPath', [path], { codeOnly: true })
    const all = gitGrep('settingsPath', [path])
    console.log(`  ${path}: ${all.length} settingsPath mention(s), ${code.length} of them in code`)
    if (code.length !== 0) {
      await fail(`stage 6: ${path} names settingsPath in CODE -- the orchestrator maps run files through checkpointRunFiles and nowhere else:\n    ${describeHits(code)}`)
    }
  }

  // ---- And now the live half: a real daemon, one run per provider, both paused ----
  repoPath = makeRepo()
  const workspace = await prisma.workspace.create({
    data: {
      name: WORKSPACE_NAME,
      repoPath,
      baseBranch: 'main',
      autoMerge: false,
      verifyCommands: ['true'],
      setupCommands: [],
      maxAttempts: 1,
      // NOT the column default of 20 (M13 Decision 4): a budgeted workspace REFUSES a cost-blind
      // provider at admission, which is exactly right and exactly what stage 6 cannot measure --
      // the Cursor run would never reach a checkpoint to read the two columns off. That refusal is
      // `gate:m13-runtime` stage 4's whole subject and is not re-proved here.
      budgetUsd: null,
      // Nothing this stage measures involves the Supervisor, and a staffing proposal in the middle
      // of two paused runs is noise in a log this gate expects somebody to read.
      supervisorEnabled: false,
    },
  })
  workspaceId = workspace.id
  console.log(`  workspace ${workspaceId} (${WORKSPACE_NAME}), repo ${repoPath}`)
  await prisma.providerConfiguration.create({ data: { workspaceId, kind: 'claude_code', settings: {} } })

  const team = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
  const workers = {}
  for (const [kind, name, model] of [
    ['claude_code', CLAUDE_WORKER, CLAUDE_MODEL],
    ['cursor', CURSOR_WORKER, CURSOR_MODEL],
  ]) {
    workers[kind] = await prisma.slave.create({
      data: { teamId: team.id, name, role: 'backend', runtimeRoles: ['backend'], model, provider: kind },
    })
    console.log(`  worker ${name} = ${workers[kind].id} (${kind}/${model})`)
  }
  for (const suffix of ['A', 'B']) {
    await prisma.task.create({
      data: {
        workspaceId,
        title: `${TASK_TITLE} (${suffix})`,
        description: 'Synthetic task driven by scripts/gate-m56a-provider-contract.mjs.',
        status: 'ready',
        requiredRole: 'backend',
        maxAttempts: 1,
      },
    })
  }

  const stage6Daemon = spawnDaemon('daemon')

  const runFor = async (kind) => prisma.slaveRun.findFirst({ where: { slaveId: workers[kind].id }, orderBy: { startedAt: 'asc' } })
  const dispatched = await waitUntil('both workers to be dispatched with a pid and a provider', DISPATCH_TIMEOUT_MS, async (note) => {
    const rows = {}
    for (const kind of PROVIDER_KINDS) rows[kind] = await runFor(kind)
    const ready = (run) => run !== null && run.pid !== null && run.provider !== null
    if (PROVIDER_KINDS.every((kind) => ready(rows[kind]))) return rows
    note(
      PROVIDER_KINDS.map((kind) =>
        rows[kind] === null ? `${kind}: no run` : `${kind}: ${rows[kind].status} pid=${String(rows[kind].pid)} provider=${String(rows[kind].provider)}`,
      ).join('; '),
    )
    return null
  })
  for (const kind of PROVIDER_KINDS) {
    console.log(`  ${kind} run ${dispatched[kind].id}: provider ${JSON.stringify(dispatched[kind].provider)}, pid ${String(dispatched[kind].pid)}`)
    if (dispatched[kind].provider !== kind) {
      await fail(`stage 6: the ${kind} worker's run resolved to ${JSON.stringify(dispatched[kind].provider)}`)
    }
  }

  // CONCURRENTLY, not one kind after the other. Both children are alive from the same tick, and a
  // gate that paused Claude and only then started watching Cursor would be measuring whichever
  // runtime it happened to ask about first -- and would lose the second one to its own terminal
  // line while it was busy with the first.
  const checkpoints = {}
  const pauseAndRead = async (kind) => {
    const runId = dispatched[kind].id
    await waitUntil(`${kind} to be working with at least one tool call recorded`, WORKING_TIMEOUT_MS, async (note) => {
      const row = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })
      note(`${row.status} toolCalls=${String(row.toolCalls)}`)
      if (['succeeded', 'failed', 'cancelled', 'paused'].includes(row.status)) {
        await fail(`stage 6: the ${kind} run reached ${row.status} before it could be paused, so its checkpoint would not be a pause's`)
      }
      return row.status === 'working' && row.toolCalls >= 1 ? row : null
    })
    const requested = await requestPause(runId, PAUSE_REQUESTER, 'human')
    if (!requested.ok) await fail(`stage 6: requestPause refused the ${kind} run: ${refusalText(requested.error)}`)
    checkpoints[kind] = await waitUntil(`${kind} to settle paused with a checkpoint`, PAUSE_SETTLE_TIMEOUT_MS, async (note) => {
      const row = await prisma.slaveRun.findUnique({ where: { id: runId }, include: { checkpoint: true } })
      if (row === null) return note('the run row disappeared')
      note(`status ${row.status}, checkpoint ${row.checkpoint === null ? 'none' : 'written'}`)
      if (row.status !== 'paused' || row.checkpoint === null) return null
      return row
    })
    console.log(
      `  ${kind} paused: checkpoint provider ${JSON.stringify(checkpoints[kind].checkpoint.provider)}, ` +
        `settingsPath ${JSON.stringify(checkpoints[kind].checkpoint.settingsPath)}, ` +
        `hookPath ${JSON.stringify(checkpoints[kind].checkpoint.hookPath)}`,
    )
  }
  await Promise.all(PROVIDER_KINDS.map((kind) => pauseAndRead(kind)))

  const SETTINGS_FILE_OF = {
    claude_code: (row) => join(dirname(row.checkpoint.pauseFlagPath), 'settings.json'),
    cursor: (row) => join(row.worktreePath, '.cursor', 'hooks.json'),
  }
  for (const kind of PROVIDER_KINDS) {
    const { checkpoint } = checkpoints[kind]
    for (const [column, value] of [
      ['settingsPath', checkpoint.settingsPath],
      ['hookPath', checkpoint.hookPath],
    ]) {
      if (typeof value !== 'string' || value === '') await fail(`stage 6: the ${kind} checkpoint's ${column} is ${JSON.stringify(value)}`)
      if (!isAbsolute(value)) await fail(`stage 6: the ${kind} checkpoint's ${column} is not absolute: ${JSON.stringify(value)}`)
      if (!existsSync(value)) await fail(`stage 6: the ${kind} checkpoint's ${column} names a file that is not on disk: ${value}`)
    }
    // The file THAT provider actually wrote, in the column the orchestrator put it in. A table,
    // because the SHAPE of a run file's path is a per-vendor fact the manifest deliberately does
    // not carry (`runFiles` names channels, not paths) -- and because this gate is held to its own
    // stage-8 rule: a `Record<ProviderKind, ...>` fails the build for a third kind, an `===` on a
    // vendor's name fails nothing.
    const expectedSettings = SETTINGS_FILE_OF[kind](checkpoints[kind])
    console.log(`  ${kind}: settingsPath expected ${expectedSettings}`)
    if (checkpoint.settingsPath !== expectedSettings) {
      await fail(`stage 6: the ${kind} checkpoint's settingsPath is ${checkpoint.settingsPath}, and its adapter wrote ${expectedSettings}`)
    }
    if (checkpoint.provider !== kind) {
      await fail(`stage 6: the ${kind} checkpoint records provider ${JSON.stringify(checkpoint.provider)}`)
    }
  }
  await stopDaemon(stage6Daemon)
  console.log('stage 6 complete: two channels per provider, one mapping site, and two checkpoints holding the files their adapters wrote')

  // ================= Stage 7: the spend net =======================================================
  console.log('\n=== stage 7: the spend net covers every registered binary')

  const bothFakes = { SLAVEOFAI_REQUIRE_FAKE_CLI: '1', SLAVEOFAI_CLAUDE_BIN: FAKE_CLAUDE, SLAVEOFAI_CURSOR_BIN: FAKE_CURSOR }

  // The sentences first, against the BYTES above and never against another call of the same
  // function. `REQUIRE_FAKE_CLI_REFUSAL` is asserted too, because it is what twenty-nine gates and
  // two test files actually import.
  await assertEqual(
    requireFakeCliRefusal('SLAVEOFAI_CLAUDE_BIN'),
    HISTORICAL_CLAUDE_REFUSAL,
    "the historical Claude sentence, byte for byte (R10's one promise about wording)",
  )
  await assertEqual(REQUIRE_FAKE_CLI_REFUSAL, HISTORICAL_CLAUDE_REFUSAL, 'REQUIRE_FAKE_CLI_REFUSAL, the constant every caller imports')
  await assertEqual(
    requireFakeCliRefusal('SLAVEOFAI_CURSOR_BIN'),
    CURSOR_BIN_REFUSAL,
    'the same sentence with the other variable in the hole',
  )
  if (!CURSOR_BIN_REFUSAL.includes('SLAVEOFAI_CURSOR_BIN')) {
    await fail('stage 7: the Cursor refusal does not name SLAVEOFAI_CURSOR_BIN, so it would send somebody to the wrong line')
  }

  for (const [label, env, expected] of [
    ['cursor variable unset', { SLAVEOFAI_REQUIRE_FAKE_CLI: '1', SLAVEOFAI_CLAUDE_BIN: FAKE_CLAUDE }, CURSOR_BIN_REFUSAL],
    ['cursor variable empty', { ...bothFakes, SLAVEOFAI_CURSOR_BIN: '' }, CURSOR_BIN_REFUSAL],
    ['cursor variable is the real binary', { ...bothFakes, SLAVEOFAI_CURSOR_BIN: '/usr/local/bin/cursor-agent' }, CURSOR_BIN_REFUSAL],
    ['claude variable unset', { SLAVEOFAI_REQUIRE_FAKE_CLI: '1', SLAVEOFAI_CURSOR_BIN: FAKE_CURSOR }, HISTORICAL_CLAUDE_REFUSAL],
    ['claude variable is the real binary', { ...bothFakes, SLAVEOFAI_CLAUDE_BIN: '/usr/bin/claude' }, HISTORICAL_CLAUDE_REFUSAL],
    ['both fakes', bothFakes, null],
  ]) {
    const answer = fakeCliRefusal(env)
    console.log(`  ${label}: ${JSON.stringify(answer)}`)
    if (answer !== expected) await fail(`stage 7: fakeCliRefusal(${label}) answered ${JSON.stringify(answer)}, expected ${JSON.stringify(expected)}`)
  }

  // The live proof. The override comes AFTER `loopbackChildEnv()`, which is the stage's own point:
  // the helper arms the fake, so the net has to catch a real binary name however it got there.
  const refusing = spawnDaemon('refusing-daemon', { SLAVEOFAI_CURSOR_BIN: '/usr/local/bin/cursor-agent' }, { track: false })
  await waitUntil('the mis-armed daemon to refuse to start', DAEMON_REFUSAL_TIMEOUT_MS, async (note) => {
    note(refusing.exited ? `exited code=${String(refusing.code)}` : 'still running')
    return refusing.exited ? refusing : null
  })
  console.log(`  the mis-armed daemon exited with code ${String(refusing.code)} and said: ${JSON.stringify(refusing.stderr.trim())}`)
  if (refusing.code === 0) await fail('stage 7: a daemon pointed at the real cursor-agent exited 0')
  if (!refusing.stderr.includes(CURSOR_BIN_REFUSAL)) {
    await fail(`stage 7: the mis-armed daemon did not print the SLAVEOFAI_CURSOR_BIN refusal; it said ${JSON.stringify(refusing.stderr)}`)
  }

  const armed = spawnDaemon('armed-daemon', {}, { track: false })
  await waitUntil('the correctly-armed daemon to announce itself', DAEMON_START_TIMEOUT_MS, async (note) => {
    note(armed.exited ? `exited code=${String(armed.code)}` : `${armed.output.length} byte(s) of output so far`)
    if (armed.exited) await fail(`stage 7: the daemon with both fakes exited (code ${String(armed.code)}): ${armed.output}`)
    return armed.output.includes('skill catalog synced') ? armed : null
  })
  console.log('  the daemon with both fakes started and announced itself -- the state CI now runs in')
  await stopDaemon(armed)
  console.log('stage 7 complete: six unit cases, one refusal a real binary name cannot slip past, one daemon that starts')

  // ================= Stage 8: no vendor literal outside the allow-list ============================
  console.log('\n=== stage 8: no `case \'claude_code\'` outside a checked-in allow-list')

  const literalAllowlist = readGolden('provider-literal-allowlist.json')
  const allowed = new Set(literalAllowlist.files.map((entry) => entry.path))
  const literalHits = gitGrep("case '(claude_code|cursor)'|[!=]== *'(claude_code|cursor)'", ['packages', 'apps', 'scripts'], {
    excludeTests: true,
    codeOnly: true,
  })
  console.log(`  dispatch-shaped hits in code:\n    ${describeHits(literalHits)}`)
  for (const hit of literalHits) {
    if (!allowed.has(hit.path)) await fail(`stage 8: ${hit.path}:${hit.line} dispatches on a provider NAME: ${hit.text.trim()}`)
  }
  // And the other direction, so the list cannot rot.
  for (const entry of literalAllowlist.files) {
    if (!existsSync(join(repoRoot, entry.path))) {
      await fail(`stage 8: the allow-list names ${entry.path}, which is not on disk -- an entry nothing covers is an entry nobody reviews`)
    }
    if (typeof entry.why !== 'string' || entry.why.trim() === '') await fail(`stage 8: the allow-list carries ${entry.path} with no reason`)
  }
  const matchedPaths = new Set(literalHits.map((hit) => hit.path))
  for (const path of literalAllowlist.mustStillMatch) {
    console.log(`  ${path} still asserts the provider it dispatched with: ${String(matchedPaths.has(path))}`)
    if (!matchedPaths.has(path)) {
      await fail(`stage 8: ${path} is allow-listed for asserting a dispatched run's recorded provider and no longer asserts one`)
    }
  }
  console.log('stage 8 complete: four gate scripts assert their data, and nothing else dispatches on a vendor name')

  // ================= Stage 9: the ladder is read, not written =====================================
  console.log('\n=== stage 9: the ladder is read, not written')

  const adrBytes = statSync(join(repoRoot, PAUSE_ADR)).size
  console.log(`  ${PAUSE_ADR}: ${adrBytes} bytes (the constant this gate carries is ${PAUSE_ADR_BYTES})`)
  if (adrBytes !== PAUSE_ADR_BYTES) {
    await fail(
      `stage 9: ${PAUSE_ADR} is ${adrBytes} bytes and this gate was written against ${PAUSE_ADR_BYTES}. ` +
        'The ADR is the rationale and the manifest is the claim: a deliberate ADR edit moves this number in the same commit.',
    )
  }
  const slugs = readFileSync(join(repoRoot, PAUSE_ADR), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('#'))
    .map((line) => slugify(line.replace(/^#+\s*/, '')))
  console.log(`  headings found: ${JSON.stringify(slugs)}`)
  for (const kind of PROVIDER_KINDS) {
    const { rung, adr } = manifestFor(kind).pause
    const [file, anchor] = adr.split('#')
    console.log(`  ${kind}: rung ${rung}, adr ${adr}`)
    if (file !== PAUSE_ADR) await fail(`stage 9: ${kind}'s pause.adr names ${file}, not ${PAUSE_ADR}`)
    if (!slugs.includes(anchor)) await fail(`stage 9: ${kind}'s pause.adr anchor ${JSON.stringify(anchor)} matches no heading in ${PAUSE_ADR}`)
  }
  if (manifestFor('claude_code').pause.rung !== 'hook') await fail("stage 9: Claude's rung is no longer `hook`")
  if (manifestFor('cursor').pause.rung !== 'signal') await fail("stage 9: Cursor's rung is no longer `signal`")

  const signalDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m56a-pause-'))
  try {
    const flagPath = join(signalDir, 'pause.flag')
    await signalPause('claude_code', { pauseFlagPath: flagPath, pid: null }, 'the M56a gate')
    const written = existsSync(flagPath) ? readFileSync(flagPath, 'utf8') : null
    console.log(`  signalPause('claude_code', { pid: null }) wrote ${JSON.stringify(written)}`)
    if (written !== 'the M56a gate\n') await fail(`stage 9: the gated pause wrote ${JSON.stringify(written)}`)
    await assertThrows(
      () => signalPause('cursor', { pauseFlagPath: join(signalDir, 'cursor.flag'), pid: null }, 'the M56a gate'),
      /cannot pause a cursor run with no recorded pid/,
      "signalPause('cursor', { pid: null }) throws its existing sentence",
    )
  } finally {
    rmSync(signalDir, { recursive: true, force: true })
  }
  console.log('stage 9 complete: two anchors that resolve, one byte count that did not move, two rungs, two strategies')

  // ================= Stage 10: models, cards, refusals ============================================
  console.log('\n=== stage 10: the model list, the settings cards and the simulation refusal')

  const modelsGolden = readGolden('models.json')
  await assertEqual(await listProviderModels('claude_code'), modelsGolden.claude_code, "listProviderModels('claude_code')")

  const stubDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m56a-models-'))
  try {
    const capture = join(repoRoot, 'packages/providers/test/fixtures/cursor/models.txt')
    const stub = join(stubDir, 'stub-cursor-agent.sh')
    writeFileSync(stub, `#!/usr/bin/env bash\ncat ${JSON.stringify(capture)}\n`, { mode: 0o700 })
    const listed = await listProviderModels('cursor', { cursorCommand: stub })
    await assertEqual(listed.models, modelsGolden.cursorParsed, "listProviderModels('cursor') against the recorded capture")
    console.log(`  source: ${listed.source}`)
    if (listed.source !== 'account') await fail(`stage 10: the Cursor listing reports source ${JSON.stringify(listed.source)}, expected account`)
    // And the parser itself, on the same bytes, so a listing that went through a different function
    // could not agree by accident.
    await assertEqual(parseCursorModels(readFileSync(capture, 'utf8')), modelsGolden.cursorParsed, 'parseCursorModels over the same capture')
  } finally {
    rmSync(stubDir, { recursive: true, force: true })
  }

  // The cards, against the three tables they are now derived from (M56a errata E17 and E24).
  // `version`, `state` and `slavesBound` are placeholders in the golden and are skipped here:
  // `apps/web/test/integration/settings-snapshot.test.ts` makes the web-side comparison with the
  // same normalisation, because `apps/web` has no `dist` a gate can import.
  const cardsGolden = readGolden('settings-cards.json')
  const realCards = cardsGolden.filter((card) => card.state !== 'later')
  const laterCards = cardsGolden.filter((card) => card.state === 'later')
  await assertEqual(realCards.map((card) => card.kind), [...PROVIDER_KINDS], 'the golden REAL cards are exactly the registered kinds, in order')
  for (const card of realCards) {
    console.log(`  ${card.kind}: label ${JSON.stringify(card.label)}, adapter ${JSON.stringify(card.adapter)}, capabilities ${JSON.stringify(card.capabilities)}`)
    await assertEqual(card.label, PROVIDER_LABEL[card.kind], `the ${card.kind} card's label against PROVIDER_LABEL`)
    await assertEqual(card.adapter, PROVIDER_ADAPTERS[card.kind].adapterName, `the ${card.kind} card's adapter against PROVIDER_ADAPTERS`)
    const capabilities = capabilitiesOf(card.kind)
    await assertEqual(
      card.capabilities,
      { gate: capabilities.gate, reportsCost: capabilities.reportsCost, canPauseMidRun: capabilities.canPauseMidRun },
      `the ${card.kind} card's capability triple against capabilitiesOf`,
    )
  }
  console.log(`  LATER cards: ${JSON.stringify(laterCards)}`)
  await assertEqual(
    laterCards,
    [
      { kind: 'codex', label: 'OpenAI Codex', state: 'later', version: null, adapter: 'CodexAdapter — planned', capabilities: null },
      { kind: 'gemini', label: 'Gemini', state: 'later', version: null, adapter: 'GeminiAdapter — planned', capabilities: null },
    ],
    'the two placeholder cards are unchanged (R12: this milestone adds no provider)',
  )
  for (const card of laterCards) {
    if (PROVIDER_KINDS.includes(card.kind)) await fail(`stage 10: ${card.kind} is a placeholder card and a registered kind at the same time`)
  }

  const cursorSim = await createSimulation({
    companyId: '00000000-0000-4000-8000-00000000m56a',
    name: 'M56a Gate Refusal Probe',
    sector: 'trade',
    policy: 'A',
    decisionProvider: 'llm',
    modelProvider: 'cursor',
    model: 'auto',
    maxModelCostUsd: 1,
  })
  console.log(`  createSimulation(modelProvider: 'cursor') answered: ${cursorSim.ok ? 'OK -- it was ACCEPTED' : JSON.stringify(refusalText(cursorSim.error))}`)
  if (cursorSim.ok) await fail('stage 10: a cost-blind provider was accepted for an llm simulation')
  await assertEqual(
    refusalText(cursorSim.error),
    'model provider cursor is not supported for simulations: it reports no cost, so a cap cannot be enforced',
    'the cost-blind refusal',
  )
  const unknownSim = await createSimulation({
    companyId: '00000000-0000-4000-8000-00000000m56a',
    name: 'M56a Gate Refusal Probe',
    sector: 'trade',
    policy: 'A',
    decisionProvider: 'llm',
    modelProvider: 'codex',
    model: 'auto',
    maxModelCostUsd: 1,
  })
  console.log(`  createSimulation(modelProvider: 'codex') answered: ${unknownSim.ok ? 'OK -- it was ACCEPTED' : JSON.stringify(refusalText(unknownSim.error))}`)
  if (unknownSim.ok) await fail('stage 10: an unregistered provider name was accepted for an llm simulation')
  await assertEqual(
    refusalText(unknownSim.error),
    'model provider codex is not supported for simulations: it is not a configured provider',
    'the unknown-provider refusal',
  )
  console.log('stage 10 complete: two listings, four cards, two refusal sentences byte for byte')

  // ================= Stage 11: the event sets =====================================================
  console.log('\n=== stage 11: both providers\' event sets are the manifest\'s')

  const replay = async (kind, files, parse) => {
    const allowed = new Set([...manifestFor(kind).events.produces, 'ignored', 'unparsable'])
    const produced = new Set()
    let lines = 0
    for (const file of files) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        lines += 1
        produced.add(parse(line).kind)
      }
    }
    console.log(`  ${kind}: ${files.length} fixture(s), ${lines} line(s), produced ${JSON.stringify([...produced].sort())}`)
    for (const produced_ of produced) {
      if (!allowed.has(produced_)) {
        await fail(`stage 11: replaying ${kind}'s fixtures produced ${produced_}, which its manifest does not declare`)
      }
    }
  }
  await replay('claude_code', ndjsonFiles(join(repoRoot, 'packages/providers/test/fixtures')).filter((f) => !f.includes('/cursor/')), parseStreamLine)
  await replay('cursor', ndjsonFiles(join(repoRoot, 'packages/providers/test/fixtures/cursor')), parseCursorLine)

  // The complement, which is what actually pins the two rows (M56a erratum E15): `usage` never comes
  // out of `parseStreamLine` -- the ADAPTER pushes it -- so the replay above can only prove a subset.
  const claudeMissing = RUNTIME_EVENT_KINDS.filter((kind) => !manifestFor('claude_code').events.produces.includes(kind))
  await assertEqual(claudeMissing, ['ignored', 'unparsable'], "Claude's row is every semantic kind there is")
  await assertEqual(
    [...manifestFor('cursor').events.produces].sort(),
    ['permission_denied', 'session_started', 'terminated', 'text', 'tool_call', 'tool_result'],
    "Cursor's six",
  )
  for (const forbidden of ['usage', 'hook_started', 'hook_denied', 'hook_crashed', 'hook_failed_open']) {
    if (manifestFor('cursor').events.produces.includes(forbidden)) await fail(`stage 11: Cursor's row claims ${forbidden}`)
  }
  for (const kind of PROVIDER_KINDS) {
    if (!manifestFor(kind).events.produces.includes('tool_result')) {
      await fail(
        `stage 11: ${kind}'s row does not carry tool_result -- it is what makes reportsToolResults true by projection rather than by assertion`,
      )
    }
  }
  console.log('stage 11 complete: every replayed kind is declared, Claude produces every semantic kind, Cursor produces six')

  // ================= Stage 12: nothing else moved =================================================
  console.log('\n=== stage 12: nothing else moved')

  console.log(`  SITUATION_KINDS: ${SITUATION_KINDS.length}; ACTION_KINDS: ${ACTION_KINDS.length}; LANE_BY_TYPE: ${Object.keys(LANE_BY_TYPE).length}`)
  if (SITUATION_KINDS.length !== 17) await fail(`stage 12: SITUATION_KINDS is ${SITUATION_KINDS.length}, expected seventeen`)
  if (ACTION_KINDS.length !== 17) await fail(`stage 12: ACTION_KINDS is ${ACTION_KINDS.length}, expected seventeen`)
  if (Object.keys(LANE_BY_TYPE).length !== 61) {
    await fail(`stage 12: LANE_BY_TYPE holds ${Object.keys(LANE_BY_TYPE).length} event types, expected 61 -- this milestone adds none`)
  }

  const enumRows = await prisma.$queryRaw`SELECT unnest(enum_range(NULL::"ProviderKind"))::text AS value`
  const enumValues = enumRows.map((row) => row.value).sort()
  await assertEqual(enumValues, [...PROVIDER_KINDS].sort(), 'the Postgres ProviderKind enum')

  const diff = execFileSync(
    'npx',
    ['prisma', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'packages/db/prisma/schema.prisma', '--config', 'packages/db/prisma.config.ts'],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  console.log(`  prisma migrate diff: ${JSON.stringify(diff.trim())}`)
  if (!diff.includes('No difference detected')) {
    await fail(`stage 12: the schema and the database disagree, so this milestone needs a migration it says it does not: ${diff}`)
  }

  await assertEqual(
    [...CHILD_ENV_ALLOW],
    ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'],
    'CHILD_ENV_ALLOW, the same twelve names in the same order',
  )

  for (const script of [
    'scripts/pause-gate.sh',
    'scripts/cursor-shell-gate.sh',
    'scripts/tool-result-tap.sh',
    'scripts/lib/pause-flag.sh',
    'scripts/lib/permissions.sh',
  ]) {
    const onDisk = readFileSync(join(repoRoot, script))
    const committed = execFileSync('git', ['show', `HEAD:${script}`], { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 })
    console.log(`  ${script}: ${onDisk.length} bytes on disk, ${committed.length} at HEAD`)
    if (Buffer.compare(onDisk, committed) !== 0) await fail(`stage 12: ${script} differs from HEAD -- no hook-plane script may move in this milestone`)
  }

  const statusAfter = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' })
  if (statusAfter !== statusBefore) {
    await fail(
      `stage 12: this gate changed the working tree.\n    before: ${JSON.stringify(statusBefore)}\n    after:  ${JSON.stringify(statusAfter)}`,
    )
  }
  console.log('  git status --porcelain is what it was before this gate ran')
  console.log('stage 12 complete: two catalogues, one lane map, one enum, no migration, twelve names, five scripts, one clean tree')

  console.log(
    '\nPASS: nothing a provider does changed, and here are the bytes -- twelve permission verdicts byte for byte, five argv ' +
      'shapes element for element, both capability rows two different ways, one paused run per provider whose two checkpoint ' +
      'columns hold the two files its adapter actually wrote, and a grep that fails the build the moment a second copy of the ' +
      'provider list appears anywhere in the tree',
  )
  exitCode = 0
} finally {
  for (const state of daemons) {
    if (state.proc.exitCode === null && !state.exited) {
      state.proc.kill('SIGTERM')
      const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
      while (!state.exited && Date.now() < deadline) await delay(POLL_INTERVAL_MS)
      if (!state.exited) state.proc.kill('SIGKILL')
    }
  }
  if (workspaceId !== null) {
    // Vendor children BEFORE the rows they are named on, `gate-m13-runtime`'s rule: a gate that
    // exits leaving a child running is a gate that keeps going after it has reported.
    const runs = await prisma.slaveRun.findMany({ where: { slave: { team: { workspaceId } } }, select: { pid: true } }).catch(() => [])
    for (const run of runs) {
      if (run.pid === null || !isAlive(run.pid)) continue
      try {
        process.kill(run.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    await prisma.executionEvent.deleteMany({ where: { workspaceId } }).catch(() => {})
    // Cascades Team/Slave/Task/SlaveRun/Checkpoint/ProviderConfiguration.
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
  }
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true })
  await prisma.$disconnect()
}

process.exit(exitCode)
