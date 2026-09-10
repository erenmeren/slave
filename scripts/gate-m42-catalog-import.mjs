// M42's own gate: a catalog on disk becomes templates, and the persona reaches the model.
//
// Six stages, and each one measures a rule the import claims to follow:
//   1. A first import of the checked-in fixture catalog creates two templates and skips three, with
//      the three reasons R2 names -- name_taken, profile_too_long, invalid_persona -- and writes ONE
//      CatalogImport row whose counters and report say exactly that.
//   2. The same import again: two unchanged, nothing created, nothing written to either template.
//   3. The operator edits one imported template's profile through `set-profile` and BOTH persona
//      files are rewritten. The edited one is skipped `locally_edited` and keeps the operator's own
//      words; the other is `updated` and carries the new body.
//   4. `--role-map engineering=backend,testing=reviewer --dry-run` prints the translation it WOULD
//      have made and writes nothing: no template row moves and no CatalogImport row is added.
//   5. A company is built from the two imported templates through the real CLI and assigned to a
//      workspace; a real daemon dispatches one task with the fake CLI, and the run's recorded
//      RunContext carries the imported persona -- the product's own prefix line and a sentence of
//      the persona's body -- with a `profile` source whose origin is `template` and whose sha256 is
//      the hash of the stored profile. That is what "the persona is in front of the model" means.
//   6. Teardown, in FK order, on every exit path.
//
// WHICH PERSONA THE OPERATOR EDITS, AND WHY IT IS THE VERIFIER. Stage 3 needs a template whose
// profile a person has rewritten, and stage 5 needs one whose profile is still the IMPORT's own
// words -- and they cannot be the same row: an operator's edit replaces the imported text, so a run
// staffed from that template would carry the operator's sentence and prove nothing about a persona
// file. So the edit lands on `Gate Verifier` and stage 5 staffs `Gate Core Builder`, which is the
// row an import updated and nobody has touched by hand. The task brief had the two the other way
// round; every assertion either stage makes is unchanged, and only stage 4's drift line names the
// other half of the `--role-map` (`engineering` -> `backend` rather than `testing` -> `reviewer`),
// because the row a dry run can still report drift on is the one it did not skip.
//
// NEVER A MODEL CALL. The daemon is spawned with SLAVEOFAI_CLAUDE_BIN=node,
// SLAVEOFAI_CLAUDE_ARGS="<fake-claude.mjs> --fixture m8a-flow" and SLAVEOFAI_REQUIRE_FAKE_CLI=1
// (M32 item 7: lose the first two and the daemon refuses to start rather than falling back to the
// real binary).
//
// THE FIXTURE CATALOG IS COPIED TO A TEMP DIRECTORY FIRST, and stages 3 and 4 rewrite the COPY.
// The gate must never modify a file in this repository: a gate that leaves the working tree dirty
// is a gate that cannot be run twice, and `git status` after a green run has to be empty.
//
// THE GATE ASSERTS, IT NEVER FIXES. Every stage prints every measured value before asserting it; a
// failed assertion dumps every row this gate could have written and exits 1.
//
// Shape borrowed from `gate-m41-scenario.mjs` and `gate-m33-adopt.mjs` (temp repo, `preflightCleanup`,
// `dumpGateRows`, `fail`, `waitUntil`, `exitCode` starting at 1 and set to 0 only at the very end,
// teardown in FK order in a `finally`) and from `gate-m37-run-context.mjs` for the `m8a-flow`
// daemon wiring and the manifest reads.

import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { findRealDaemonPids } from './lib/daemon-process.mjs'
import { prisma } from '../packages/db/dist/client.js'
import { goalSha256, importedProfilePrefix, runContextManifestSchema } from '../packages/domain/dist/index.js'
import { isAlive } from '../packages/control/dist/index.js'

const POLL_INTERVAL_MS = 50
const DAEMON_PERIOD_MS = 500
const DISPATCH_TIMEOUT_MS = 90_000
const RUN_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const FIXTURE_CATALOG = join(repoRoot, 'scripts/fixtures/catalog-m42')

// Exact literals, never suffixed -- `preflightCleanup` removes whatever a prior crashed run left on
// these exact names, in the same FK order the `finally` block uses.
const CATALOG_NAME = 'catalog-m42'
const WORKSPACE_NAME = 'M42 Catalog Project'
const COMPANY_NAME = 'M42 Catalog Company'
const COLLISION_NAME = 'Gate Collision Persona'
const CORE_BUILDER_NAME = 'Gate Core Builder'
const VERIFIER_NAME = 'Gate Verifier'
const TASK_TITLE = 'M42 Catalog Gate Task'
/** Every template name this file -- and nothing else in the repository -- writes. Addressed by name
 *  as well as by `sourceId` so a run interrupted before its own teardown, or one whose catalog name
 *  came out different from what it expected, leaves no row behind in a shared dev database. */
const GATE_TEMPLATE_NAMES = [COLLISION_NAME, CORE_BUILDER_NAME, VERIFIER_NAME]

const CORE_BUILDER_SOURCE_ID = `${CATALOG_NAME}/engineering/core-builder`
const VERIFIER_SOURCE_ID = `${CATALOG_NAME}/testing/verifier`

// A sentence only the persona FILE contains. Stage 5's whole claim is that this reaches a prompt.
const CORE_BUILDER_BODY_SENTENCE = 'You write the module everything else stands on'

// What an operator writes over an imported profile. Already trimmed, because `setProfile` trims
// what it stores and stage 3 asserts the stored text is this string exactly.
const OPERATOR_PROFILE =
  'You are Gate Verifier, and a person wrote this over the imported text. An import never puts its own words back on top of it.'

// The sentences stage 3 appends to the two persona files in the COPY, so both files change on disk
// and the two rows can only differ by the policy, not by the input.
const CORE_BUILDER_APPENDED = 'The gate rewrote this file after the first import, so this row is an update.'
const VERIFIER_APPENDED = 'The gate rewrote this file too, and an operator has already written over the row.'

/** Same as `gate-m37-run-context.mjs`'s `makeRepo` -- a real repository, because the tick provisions
 *  a real worktree in it and the fake CLI commits into that worktree. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m42-repo-'))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

/** Every file under `dir`, with its byte count -- printed so a failure can be read against what was
 *  actually on disk rather than against what the fixture is supposed to hold. */
function listTree(dir, prefix = '') {
  const out = []
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listTree(full, `${prefix}${entry.name}/`))
    else out.push(`${prefix}${entry.name}  ${String(statSync(full).size)} bytes`)
  }
  return out
}

/** The templates this catalog owns, by `sourceId` -- never by name, which is exactly the thing an
 *  operator is free to change. */
const catalogTemplates = () =>
  prisma.slaveTemplate.findMany({ where: { sourceId: { startsWith: `${CATALOG_NAME}/` } }, orderBy: { sourceId: 'asc' } })

/** Every import run recorded for this catalog, oldest first. */
const catalogImports = () =>
  prisma.catalogImport.findMany({ where: { catalog: CATALOG_NAME }, orderBy: { startedAt: 'asc' } })

/** The fields stage 2 and stage 4 compare -- everything an import is allowed to move on a template. */
const snapshotOf = (template) =>
  JSON.stringify({
    id: template.id,
    name: template.name,
    role: template.role,
    description: template.description,
    profile: template.profile,
    profileSha256: template.profileSha256,
    sourceId: template.sourceId,
    sourceSha256: template.sourceSha256,
    sourceDivision: template.sourceDivision,
    importedAt: template.importedAt,
    defaultModel: template.defaultModel,
    provider: template.provider,
  })

/** Removes what a prior interrupted run left behind, in the same order the `finally` block uses:
 *  the workspace's events (no FK) then the workspace (cascades Team/Slave/Task/SlaveRun/RunContext),
 *  then the company (cascades CompanyTeam/CompanySlave), then the templates a CompanySlave used to
 *  point at, then this catalog's own import records. */
async function preflightCleanup() {
  const stale = await prisma.workspace.findUnique({ where: { name: WORKSPACE_NAME } })
  if (stale !== null) {
    console.log(`preflight: removing a leftover ${WORKSPACE_NAME} (${stale.id}) from an earlier interrupted run`)
    await prisma.executionEvent.deleteMany({ where: { workspaceId: stale.id } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: stale.id } }).catch(() => {})
  }
  const staleCompany = await prisma.company.findUnique({ where: { name: COMPANY_NAME } })
  if (staleCompany !== null) {
    console.log(`preflight: removing a leftover ${COMPANY_NAME} (${staleCompany.id})`)
    await prisma.company.delete({ where: { id: staleCompany.id } }).catch(() => {})
  }
  await deleteGateTemplates('preflight')
  const staleImports = await prisma.catalogImport.deleteMany({ where: { catalog: CATALOG_NAME } })
  if (staleImports.count > 0) console.log(`preflight: removing ${String(staleImports.count)} leftover CatalogImport row(s)`)
}

/** Every template this gate can have created: the imported ones, addressed by the `sourceId` prefix
 *  that only this catalog writes, plus the hand-made collision row, addressed by the exact name this
 *  file gives it and nothing else does. A `CompanySlave` holds a non-cascading reference, so the
 *  roster links go first. */
async function deleteGateTemplates(label) {
  const rows = await prisma.slaveTemplate.findMany({
    where: { OR: [{ sourceId: { startsWith: `${CATALOG_NAME}/` } }, { name: { in: GATE_TEMPLATE_NAMES } }] },
    select: { id: true, name: true },
  })
  if (rows.length === 0) return
  console.log(`${label}: removing ${String(rows.length)} gate template(s): ${JSON.stringify(rows.map((r) => r.name))}`)
  const ids = rows.map((r) => r.id)
  await prisma.companySlave.deleteMany({ where: { templateId: { in: ids } } }).catch(() => {})
  await prisma.slaveTemplate.deleteMany({ where: { id: { in: ids } } }).catch(() => {})
}

let exitCode = 1
let repoPath = null
let catalogRoot = null
let catalogDir = null
let scratchDir = null
let workspaceId = null
let companyId = null
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
          include: { tasks: true, teams: { include: { slaves: { include: { runs: { include: { context: true } } } } } } },
        })
  const events =
    workspaceId === null ? [] : await prisma.executionEvent.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
  const templates = await prisma.slaveTemplate
    .findMany({ where: { OR: [{ sourceId: { startsWith: `${CATALOG_NAME}/` } }, { name: { in: GATE_TEMPLATE_NAMES } }] } })
    .catch(() => [])
  const imports = await catalogImports().catch(() => [])
  const daemonTails = daemons.map((d) => ({
    label: d.label,
    pid: d.proc.pid ?? null,
    exited: d.exited,
    output: d.output.length > 6_000 ? `…${d.output.slice(-6_000)}` : d.output,
  }))
  return JSON.stringify({ workspace, events, templates, imports, daemonTails }, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  )
}

/** The `gate-m35`/`gate-m36` diagnostic throw: an Error carrying the state that made the call, not
 *  just the sentence that noticed. */
async function fail(message) {
  const dump = await dumpGateRows().catch(
    (cause) => `<could not dump gate rows: ${cause instanceof Error ? cause.message : String(cause)}>`,
  )
  throw new Error(`${message} -- gateRows=${dump}`)
}

/** One section source of a manifest, by kind. */
const sourceOfKind = (manifest, kind) => manifest.sections.find((section) => section.kind === kind)

/** The uuid a `create-*` verb prints, so the roster is built out of what the operator would read. */
function createdId(output, what) {
  const match = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/.exec(output)
  if (match === null) throw new Error(`${what} printed no id: ${JSON.stringify(output)}`)
  return match[1]
}

try {
  if (!existsSync(ORCHESTRATOR_CLI)) throw new Error(`orchestrator CLI not built at ${ORCHESTRATOR_CLI} -- run tsc --build first`)
  if (!existsSync(FAKE_CLAUDE)) throw new Error(`the fake claude CLI is missing at ${FAKE_CLAUDE}`)
  if (!existsSync(FIXTURE_CATALOG)) throw new Error(`the fixture catalog is missing at ${FIXTURE_CATALOG}`)

  // Refused rather than tolerated (`gate-m36-messaging.mjs`'s own refusal): another daemon would be
  // ticking this gate's workspace -- and every other one -- while it measures a single dispatch.
  const strayDaemons = findRealDaemonPids()
  if (strayDaemons.length > 0) {
    throw new Error(
      `gate:m42-catalog-import REFUSED -- an orchestrator daemon is already running (pid ${strayDaemons.join(', ')}); ` +
        'this gate spawns its own and measures the one run it dispatches',
    )
  }

  await preflightCleanup()

  // ---- The copy ---------------------------------------------------------------------------------
  // Stages 3 and 4 rewrite persona files. They rewrite THIS copy; `scripts/fixtures/catalog-m42`
  // is never touched, which is why `git status` is empty after a green run.
  //
  // The copy keeps the fixture's OWN directory name, because that name is the catalog's name: with
  // no `--catalog`, the walk takes `basename(dir)` (erratum E5), and that first segment is what
  // every `sourceId` this gate asserts on is built from. Copying into the `mkdtemp` directory
  // itself would name the catalog after a random temp suffix that changes on every run.
  catalogRoot = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m42-catalog-'))
  catalogDir = join(catalogRoot, CATALOG_NAME)
  cpSync(FIXTURE_CATALOG, catalogDir, { recursive: true })
  scratchDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m42-scratch-'))
  console.log(`catalog copied from ${FIXTURE_CATALOG} to ${catalogDir}:`)
  for (const line of listTree(catalogDir)) console.log(`  ${line}`)

  const coreBuilderPath = join(catalogDir, 'engineering', 'core-builder.md')
  const verifierPath = join(catalogDir, 'testing', 'verifier.md')

  const childEnv = () =>
    loopbackChildEnv({
      SLAVEOFAI_CLAUDE_BIN: 'node',
      SLAVEOFAI_CLAUDE_ARGS: `${FAKE_CLAUDE} --fixture m8a-flow`,
      SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
    })

  /** Runs the real orchestrator CLI as a subprocess, exactly as an operator's shell would. */
  const runCli = (args) => {
    try {
      return execFileSync('node', [ORCHESTRATOR_CLI, ...args], {
        cwd: repoRoot,
        env: childEnv(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      throw new Error(
        `the CLI refused \`${args.join(' ')}\` with status ${String(error.status)}\n` +
          `  stdout: ${String(error.stdout)}\n  stderr: ${String(error.stderr)}`,
      )
    }
  }

  /** The daemon this gate currently expects to be alive. */
  let activeDaemon = null

  /** Polls until `probe` returns something non-null, or fails naming what it last saw. */
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

  /** The real daemon, in the background -- the same thing an operator leaves running. */
  function spawnDaemon(label) {
    const proc = spawn('node', [ORCHESTRATOR_CLI, 'daemon', '--workspace', workspaceId, '--period', String(DAEMON_PERIOD_MS)], {
      cwd: repoRoot,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const state = { label, proc, output: '', exited: false }
    proc.stdout.on('data', (chunk) => {
      state.output += chunk.toString()
      process.stdout.write(`[${label}] ${chunk}`)
    })
    proc.stderr.on('data', (chunk) => {
      state.output += chunk.toString()
      process.stderr.write(`[${label}] ${chunk}`)
    })
    proc.on('exit', (code, signal) => {
      state.exited = true
      state.output += `\n<${label} exited: code=${String(code)} signal=${String(signal)}>\n`
    })
    proc.on('error', (error) => {
      state.exited = true
      state.output += `\n<${label} failed to start: ${String(error)}>\n`
    })
    daemons.push(state)
    activeDaemon = state
    console.log(`${label} spawned as pid ${String(proc.pid)}`)
    return state
  }

  /** SIGTERM, then SIGKILL if it will not go. */
  async function stopDaemon(state) {
    if (state.proc.exitCode === null && !state.exited) {
      state.proc.kill('SIGTERM')
      const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
      while (!state.exited && Date.now() < deadline) await delay(POLL_INTERVAL_MS)
      if (!state.exited) state.proc.kill('SIGKILL')
    }
    activeDaemon = null
  }

  // ---- The hand-made collision ------------------------------------------------------------------
  // The row stage 1's `name_taken` has to protect: made by a person, before any import ran.
  const collisionId = createdId(
    runCli(['create-template', '--name', COLLISION_NAME, '--role', 'backend', '--description', 'made by a person']),
    'create-template',
  )
  const collisionBefore = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: collisionId } })
  console.log(`hand-made template: ${snapshotOf(collisionBefore)}`)
  const collisionSnapshot = snapshotOf(collisionBefore)

  // ================= Stage 1: the first import ====================================================

  const firstOutput = runCli(['import-catalog', '--dir', catalogDir, '--by', 'gate'])
  console.log(`stage 1 -- import-catalog printed:\n${firstOutput}`)

  const afterFirst = await catalogTemplates()
  console.log(`templates under ${CATALOG_NAME}/ after the first import:`)
  for (const row of afterFirst) console.log(`  ${snapshotOf(row)}`)
  if (afterFirst.length !== 2) {
    await fail(`the first import left ${String(afterFirst.length)} template(s) under this catalog, expected 2`)
  }

  const bySourceId = new Map(afterFirst.map((row) => [row.sourceId, row]))
  const expectedRows = [
    { sourceId: CORE_BUILDER_SOURCE_ID, name: CORE_BUILDER_NAME, role: 'engineering', division: 'engineering' },
    { sourceId: VERIFIER_SOURCE_ID, name: VERIFIER_NAME, role: 'testing', division: 'testing' },
  ]
  for (const expected of expectedRows) {
    const row = bySourceId.get(expected.sourceId)
    if (row === undefined) await fail(`no template was created for ${expected.sourceId}`)
    console.log(
      `  ${expected.sourceId}: name ${JSON.stringify(row.name)}, role ${JSON.stringify(row.role)}, ` +
        `sourceDivision ${JSON.stringify(row.sourceDivision)}, importedAt ${JSON.stringify(row.importedAt)}, ` +
        `defaultModel ${JSON.stringify(row.defaultModel)}, provider ${JSON.stringify(row.provider)}`,
    )
    if (row.name !== expected.name) await fail(`${expected.sourceId} is named ${JSON.stringify(row.name)}, expected ${JSON.stringify(expected.name)}`)
    if (row.role !== expected.role) await fail(`${expected.sourceId} has role ${JSON.stringify(row.role)}, expected ${JSON.stringify(expected.role)} (R3: the role IS the division)`)
    if (row.sourceDivision !== expected.division) await fail(`${expected.sourceId} records sourceDivision ${JSON.stringify(row.sourceDivision)}, expected ${JSON.stringify(expected.division)}`)
    if (row.importedAt === null) await fail(`${expected.sourceId} has no importedAt`)
    if (row.defaultModel !== null) await fail(`${expected.sourceId} was given a model (${JSON.stringify(row.defaultModel)}); an import never chooses one (R3)`)
    if (row.provider !== null) await fail(`${expected.sourceId} was given a provider (${JSON.stringify(row.provider)}); an import never chooses one (R3)`)
    if (row.profile === null) await fail(`${expected.sourceId} stored no profile`)
    const recomputed = goalSha256(row.profile)
    console.log(`    profileSha256 ${String(row.profileSha256)} vs goalSha256(profile) ${recomputed}`)
    if (row.profileSha256 !== recomputed) {
      await fail(`${expected.sourceId}'s profileSha256 is not the hash of the profile it stored -- an operator edit could never be told from the import's own words`)
    }
    const prefix = importedProfilePrefix(row.sourceId, row.importedAt)
    console.log(`    expected prefix line: ${JSON.stringify(prefix)}`)
    console.log(`    stored profile opens with: ${JSON.stringify(row.profile.slice(0, prefix.length))}`)
    if (!row.profile.startsWith(prefix)) {
      await fail(`${expected.sourceId}'s profile does not open with the import's own prefix line (R4)`)
    }
  }

  const coreBuilder1 = bySourceId.get(CORE_BUILDER_SOURCE_ID)
  const verifier1 = bySourceId.get(VERIFIER_SOURCE_ID)

  // The operator's own row, untouched. Byte for byte -- a rename or a cleared profile here would be
  // the import deciding it knows better than the person who made it.
  const collisionAfter = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: collisionId } })
  console.log(`hand-made template after the import: ${snapshotOf(collisionAfter)}`)
  if (snapshotOf(collisionAfter) !== collisionSnapshot) {
    await fail(`the import changed the operator's own template\n  before: ${collisionSnapshot}\n  after:  ${snapshotOf(collisionAfter)}`)
  }
  if (collisionAfter.role !== 'backend' || collisionAfter.profile !== null || collisionAfter.sourceId !== null) {
    await fail(`the hand-made row is no longer hand-made: ${snapshotOf(collisionAfter)}`)
  }

  const importsAfterFirst = await catalogImports()
  console.log(`CatalogImport rows for ${CATALOG_NAME}: ${String(importsAfterFirst.length)}`)
  if (importsAfterFirst.length !== 1) {
    await fail(`the first import wrote ${String(importsAfterFirst.length)} CatalogImport row(s), expected exactly 1 (R5)`)
  }
  const firstImport = importsAfterFirst[0]
  console.log(
    `first import row: by ${JSON.stringify(firstImport.by)}, created ${String(firstImport.created)}, ` +
      `updated ${String(firstImport.updated)}, unchanged ${String(firstImport.unchanged)}, skipped ${String(firstImport.skipped)}, ` +
      `startedAt ${firstImport.startedAt.toISOString()}, finishedAt ${firstImport.finishedAt.toISOString()}`,
  )
  console.log(`first import report: ${JSON.stringify(firstImport.report)}`)
  if (firstImport.by !== 'gate') await fail(`the import records by ${JSON.stringify(firstImport.by)}, expected "gate"`)
  const firstCounters = { created: firstImport.created, updated: firstImport.updated, unchanged: firstImport.unchanged, skipped: firstImport.skipped }
  if (JSON.stringify(firstCounters) !== JSON.stringify({ created: 2, updated: 0, unchanged: 0, skipped: 3 })) {
    await fail(`the first import's counters are ${JSON.stringify(firstCounters)}, expected {"created":2,"updated":0,"unchanged":0,"skipped":3}`)
  }
  if (firstImport.finishedAt.getTime() < firstImport.startedAt.getTime()) {
    await fail(`the import finished (${firstImport.finishedAt.toISOString()}) before it started (${firstImport.startedAt.toISOString()})`)
  }
  const firstReasons = [...firstImport.report.skipped.map((row) => row.reason)].sort()
  console.log(`skipped reasons, sorted: ${JSON.stringify(firstReasons)}`)
  if (JSON.stringify(firstReasons) !== JSON.stringify(['invalid_persona', 'name_taken', 'profile_too_long'])) {
    await fail(`the first import's skip reasons are ${JSON.stringify(firstReasons)}, expected the three R2 names`)
  }
  const tooLong = firstImport.report.skipped.find((row) => row.reason === 'profile_too_long')
  console.log(`profile_too_long detail: ${JSON.stringify(tooLong.detail)}`)
  const declaredLength = Number.parseInt(tooLong.detail, 10)
  console.log(`the length it names: ${String(declaredLength)}`)
  if (!Number.isInteger(declaredLength) || declaredLength <= 16_000) {
    await fail(`the profile_too_long skip names ${JSON.stringify(tooLong.detail)}, which does not report a length over 16000`)
  }
  const nameTaken = firstImport.report.skipped.find((row) => row.reason === 'name_taken')
  console.log(`name_taken row: ${JSON.stringify(nameTaken)}`)
  if (nameTaken.name !== COLLISION_NAME) {
    await fail(`the name_taken skip names ${JSON.stringify(nameTaken.name)}, expected ${JSON.stringify(COLLISION_NAME)}`)
  }
  console.log('stage 1 complete: two personas became templates carrying their own provenance, three were refused with the three reasons R2 names, and the operator\'s own row is untouched')

  // ================= Stage 2: the same import again ===============================================

  const secondOutput = runCli(['import-catalog', '--dir', catalogDir, '--by', 'gate'])
  console.log(`stage 2 -- the same import again printed:\n${secondOutput}`)

  const importsAfterSecond = await catalogImports()
  if (importsAfterSecond.length !== 2) {
    await fail(`there are ${String(importsAfterSecond.length)} CatalogImport rows after the second import, expected 2`)
  }
  const secondImport = importsAfterSecond[1]
  const secondCounters = { created: secondImport.created, updated: secondImport.updated, unchanged: secondImport.unchanged, skipped: secondImport.skipped }
  console.log(`second import counters: ${JSON.stringify(secondCounters)}`)
  if (JSON.stringify(secondCounters) !== JSON.stringify({ created: 0, updated: 0, unchanged: 2, skipped: 3 })) {
    await fail(`the second import's counters are ${JSON.stringify(secondCounters)}, expected {"created":0,"updated":0,"unchanged":2,"skipped":3}`)
  }

  const afterSecond = new Map((await catalogTemplates()).map((row) => [row.sourceId, row]))
  for (const before of [coreBuilder1, verifier1]) {
    const after = afterSecond.get(before.sourceId)
    console.log(`  ${before.sourceId}\n    before: ${snapshotOf(before)}\n    after:  ${snapshotOf(after)}`)
    if (snapshotOf(after) !== snapshotOf(before)) {
      await fail(`${before.sourceId} was rewritten by an import that reported it unchanged`)
    }
  }
  console.log('stage 2 complete: a re-run of an unchanged catalog wrote nothing to either template and said so')

  // ================= Stage 3: an operator's own words, and a changed file =========================

  const operatorFile = join(scratchDir, 'operator-profile.md')
  writeFileSync(operatorFile, OPERATOR_PROFILE)
  const setOutput = runCli(['set-profile', '--template', verifier1.id, '--file', operatorFile, '--by', 'gate'])
  console.log(`stage 3 -- set-profile printed: ${JSON.stringify(setOutput.trim())}`)
  const verifierEdited = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: verifier1.id } })
  console.log(`the edited template now reads: ${JSON.stringify(verifierEdited.profile)}`)
  if (verifierEdited.profile !== OPERATOR_PROFILE) await fail('set-profile did not store the operator\'s text verbatim')

  // Both files change on disk, so the two rows can only differ by the policy.
  writeFileSync(coreBuilderPath, `${readFileSync(coreBuilderPath, 'utf8').trimEnd()}\n- ${CORE_BUILDER_APPENDED}\n`)
  writeFileSync(verifierPath, `${readFileSync(verifierPath, 'utf8').trimEnd()}\n\n${VERIFIER_APPENDED}\n`)
  console.log(`rewrote both persona files in the copy: ${coreBuilderPath} (${String(statSync(coreBuilderPath).size)} bytes), ${verifierPath} (${String(statSync(verifierPath).size)} bytes)`)

  const thirdOutput = runCli(['import-catalog', '--dir', catalogDir, '--by', 'gate'])
  console.log(`stage 3 -- import-catalog printed:\n${thirdOutput}`)

  const afterThird = new Map((await catalogTemplates()).map((row) => [row.sourceId, row]))
  const verifier3 = afterThird.get(VERIFIER_SOURCE_ID)
  const coreBuilder3 = afterThird.get(CORE_BUILDER_SOURCE_ID)
  console.log(`the edited row after the import: ${snapshotOf(verifier3)}`)
  console.log(`the rewritten row after the import: ${snapshotOf(coreBuilder3)}`)

  if (verifier3.profile !== OPERATOR_PROFILE) {
    await fail(`the import overwrote a profile a person wrote: ${JSON.stringify(verifier3.profile)}`)
  }
  if (verifier3.sourceSha256 !== verifier1.sourceSha256) {
    await fail(
      `the skipped row's sourceSha256 moved from ${String(verifier1.sourceSha256)} to ${String(verifier3.sourceSha256)} -- ` +
        'the next import would then see no disagreement at all',
    )
  }
  const thirdImport = (await catalogImports())[2]
  console.log(`third import report: ${JSON.stringify(thirdImport.report)}`)
  const locallyEdited = thirdImport.report.skipped.find((row) => row.sourceId === VERIFIER_SOURCE_ID)
  console.log(`the edited row's outcome: ${JSON.stringify(locallyEdited)}`)
  if (locallyEdited === undefined || locallyEdited.reason !== 'locally_edited') {
    await fail(`${VERIFIER_SOURCE_ID} was not skipped locally_edited: ${JSON.stringify(locallyEdited)}`)
  }

  const coreBuilderFileText = readFileSync(coreBuilderPath, 'utf8')
  if (!coreBuilder3.profile.includes(CORE_BUILDER_APPENDED)) {
    await fail(`the updated row does not carry the sentence added to its file: ${JSON.stringify(coreBuilder3.profile)}`)
  }
  const expectedSourceSha = goalSha256(coreBuilderFileText)
  console.log(`the updated row's sourceSha256 ${String(coreBuilder3.sourceSha256)} vs goalSha256(file) ${expectedSourceSha}`)
  if (coreBuilder3.sourceSha256 !== expectedSourceSha) {
    await fail('the updated row does not hash the file that is on disk')
  }
  if (coreBuilder3.profileSha256 !== goalSha256(coreBuilder3.profile)) {
    await fail('the updated row\'s profileSha256 is not the hash of the profile it stored')
  }
  const updatedRow = thirdImport.report.updated.find((row) => row.sourceId === CORE_BUILDER_SOURCE_ID)
  console.log(`the rewritten row's outcome: ${JSON.stringify(updatedRow)}`)
  if (updatedRow === undefined) await fail(`${CORE_BUILDER_SOURCE_ID} was not reported as updated`)

  const thirdCounters = { created: thirdImport.created, updated: thirdImport.updated, unchanged: thirdImport.unchanged, skipped: thirdImport.skipped }
  console.log(`third import counters: ${JSON.stringify(thirdCounters)}`)
  if (JSON.stringify(thirdCounters) !== JSON.stringify({ created: 0, updated: 1, unchanged: 0, skipped: 4 })) {
    await fail(`the third import's counters are ${JSON.stringify(thirdCounters)}, expected {"created":0,"updated":1,"unchanged":0,"skipped":4}`)
  }
  console.log('stage 3 complete: a profile a person wrote survived a changed file, and the file beside it updated in the same run')

  // ================= Stage 4: a dry run translates and writes nothing =============================

  const importCountBefore = await prisma.catalogImport.count()
  const beforeDry = new Map((await catalogTemplates()).map((row) => [row.sourceId, snapshotOf(row)]))
  console.log(`stage 4 -- CatalogImport rows in the whole table before the dry run: ${String(importCountBefore)}`)
  for (const [sourceId, snapshot] of beforeDry) console.log(`  before: ${sourceId} ${snapshot}`)

  // `--dry-run` LAST (erratum E11): `parseArgs` takes the next token as a flag's value, so a
  // `--dry-run` anywhere else swallows the flag that follows it.
  const dryOutput = runCli([
    'import-catalog',
    '--dir',
    catalogDir,
    '--role-map',
    'engineering=backend,testing=reviewer',
    '--dry-run',
  ])
  console.log(`stage 4 -- the dry run printed:\n${dryOutput}`)

  if (!dryOutput.includes('DRY RUN')) await fail('the dry run did not say it was one')
  // The drift line is on the row the dry run did NOT skip: `Gate Verifier` is still `locally_edited`
  // (an operator's words are on it and its file has changed), and a skipped row reports no role at
  // all. `Gate Core Builder` is unchanged since stage 3, so the map's `engineering=backend` half is
  // the translation this run would have made -- and does not.
  const driftLine = `role     ${CORE_BUILDER_NAME} stays "engineering" (the map said "backend")`
  console.log(`looking for the drift line: ${JSON.stringify(driftLine)}`)
  if (!dryOutput.includes(driftLine)) await fail('the dry run did not print the translation it would have made')

  const importCountAfter = await prisma.catalogImport.count()
  console.log(`CatalogImport rows in the whole table after the dry run: ${String(importCountAfter)}`)
  if (importCountAfter !== importCountBefore) {
    await fail(`the dry run recorded an import: ${String(importCountBefore)} rows became ${String(importCountAfter)}`)
  }
  const afterDry = new Map((await catalogTemplates()).map((row) => [row.sourceId, snapshotOf(row)]))
  for (const [sourceId, snapshot] of afterDry) {
    console.log(`  after:  ${sourceId} ${snapshot}`)
    if (beforeDry.get(sourceId) !== snapshot) {
      await fail(`the dry run wrote to ${sourceId}\n  before: ${String(beforeDry.get(sourceId))}\n  after:  ${snapshot}`)
    }
  }
  if (afterDry.size !== beforeDry.size) await fail(`the dry run changed how many templates this catalog owns: ${String(beforeDry.size)} -> ${String(afterDry.size)}`)
  console.log('stage 4 complete: a --role-map dry run printed the role it would have translated and moved nothing at all')

  // ================= Stage 5: the imported persona in front of the model ==========================

  repoPath = makeRepo()
  companyId = createdId(runCli(['create-company', '--name', COMPANY_NAME]), 'create-company')
  const engineeringTeamId = createdId(runCli(['add-team', '--company', companyId, '--name', 'Engineering']), 'add-team')
  const coreSlaveId = createdId(
    runCli(['add-slave', '--team', engineeringTeamId, '--template', coreBuilder3.id, '--name', 'Core']),
    'add-slave',
  )
  const testingTeamId = createdId(runCli(['add-team', '--company', companyId, '--name', 'Testing']), 'add-team')
  const verifySlaveId = createdId(
    runCli(['add-slave', '--team', testingTeamId, '--template', verifier3.id, '--name', 'Verify']),
    'add-slave',
  )
  console.log(`company ${companyId}: roster members ${coreSlaveId} (Core) and ${verifySlaveId} (Verify)`)

  workspaceId = createdId(
    runCli(['create-workspace', '--name', WORKSPACE_NAME, '--repo', repoPath, '--verify', 'true', '--provider', 'claude_code']),
    'create-workspace',
  )
  console.log(`workspace ${workspaceId} (${WORKSPACE_NAME}), repo ${repoPath}`)
  const assignOutput = runCli(['assign-company', '--workspace', workspaceId, '--company', companyId])
  console.log(`assign-company printed: ${JSON.stringify(assignOutput.trim())}`)

  const workers = await prisma.slave.findMany({ where: { team: { workspaceId } }, orderBy: { name: 'asc' } })
  for (const worker of workers) {
    console.log(`  worker ${worker.id} ${JSON.stringify(worker.name)}: role ${JSON.stringify(worker.role)}, runtimeRoles ${JSON.stringify(worker.runtimeRoles)}`)
  }
  if (workers.length !== 2) await fail(`the assignment materialised ${String(workers.length)} worker(s), expected 2`)
  const coreWorker = workers.find((worker) => worker.name === 'Core')
  const verifyWorker = workers.find((worker) => worker.name === 'Verify')
  if (coreWorker === undefined || verifyWorker === undefined) await fail(`the materialised workers are ${JSON.stringify(workers.map((w) => w.name))}`)
  // `--role-map` is load-bearing at import time exactly because this is where a template's role
  // ends up: `assignCompanyTx` copies it into the worker's dispatchable set, and nothing later can
  // reach back and change it.
  if (!coreWorker.runtimeRoles.includes('engineering')) {
    await fail(`the Core worker's runtimeRoles are ${JSON.stringify(coreWorker.runtimeRoles)}, expected to carry its template's role "engineering"`)
  }
  if (!verifyWorker.runtimeRoles.includes('testing')) {
    await fail(`the Verify worker's runtimeRoles are ${JSON.stringify(verifyWorker.runtimeRoles)}, expected to carry its template's role "testing"`)
  }

  const task = await prisma.task.create({
    data: {
      workspaceId,
      title: TASK_TITLE,
      description: 'Synthetic task driven by scripts/gate-m42-catalog-import.mjs.',
      status: 'ready',
      requiredRole: 'engineering',
      maxAttempts: 5,
    },
  })
  console.log(`task ${task.id} (ready, engineering)`)

  spawnDaemon('daemon')

  const startedRun = await waitUntil('the daemon to start a run for the task', DISPATCH_TIMEOUT_MS, async (note) => {
    const run = await prisma.slaveRun.findFirst({ where: { taskId: task.id } })
    note(run === null ? 'no SlaveRun row yet' : `run ${run.id} is ${run.status}`)
    return run
  })
  console.log(`run ${startedRun.id} started (${startedRun.status}, kind ${startedRun.kind}) on slave ${startedRun.slaveId}`)
  if (startedRun.slaveId !== coreWorker.id) {
    await fail(`the run was staffed onto ${startedRun.slaveId}, expected the worker materialised from the imported engineering template (${coreWorker.id})`)
  }

  const context = await waitUntil('the run to record what it was told', DISPATCH_TIMEOUT_MS, async (note) => {
    const row = await prisma.runContext.findUnique({ where: { runId: startedRun.id } })
    note(row === null ? 'no RunContext row yet' : 'found it')
    return row
  })
  const manifest = runContextManifestSchema.parse(context.sections)
  console.log(`manifest: ${JSON.stringify(manifest)}`)
  console.log(`prompt (${String(context.prompt.length)} chars):\n${context.prompt}`)

  const templateAtDispatch = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: coreBuilder3.id } })
  const profileSource = sourceOfKind(manifest, 'profile')
  console.log(`manifest profile source: ${JSON.stringify(profileSource)}`)
  console.log(`goalSha256(template.profile) = ${goalSha256(templateAtDispatch.profile)}`)
  if (profileSource === undefined) await fail('the manifest records no profile section')
  if (profileSource.origin !== 'template') {
    await fail(`the manifest says the profile came from ${profileSource.origin}, expected template -- nothing overrode the imported persona`)
  }
  if (profileSource.sha256 !== goalSha256(templateAtDispatch.profile)) {
    await fail(`the manifest's profile hash is ${profileSource.sha256}, expected the hash of the profile the import stored`)
  }

  const expectedPrefix = importedProfilePrefix(templateAtDispatch.sourceId, templateAtDispatch.importedAt)
  console.log(`the prompt must carry the prefix line: ${JSON.stringify(expectedPrefix)}`)
  if (!context.prompt.includes(expectedPrefix)) {
    await fail('the prompt does not carry the line saying where this persona came from (R4)')
  }
  console.log(`the prompt must carry a sentence of the persona's own body: ${JSON.stringify(CORE_BUILDER_BODY_SENTENCE)}`)
  if (!context.prompt.includes(CORE_BUILDER_BODY_SENTENCE)) {
    await fail('the prompt does not carry the persona file\'s own words -- the import did not reach the model')
  }
  console.log(`the prompt must carry the sentence stage 3 added to the file: ${JSON.stringify(CORE_BUILDER_APPENDED)}`)
  if (!context.prompt.includes(CORE_BUILDER_APPENDED)) {
    await fail('the prompt carries the persona as it was first imported, not as the file reads now')
  }

  // Teardown hygiene, not a claim of this milestone (`gate-m37-run-context.mjs`'s own note): tearing
  // down mid-replay kills a live vendor child and leaves the next tick a run that looks failed.
  const concluded = await waitUntil('the run to conclude', RUN_TIMEOUT_MS, async (note) => {
    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: startedRun.id } })
    note(`run is ${run.status}`)
    return run.endedAt === null ? null : run
  })
  console.log(`run concluded: ${concluded.status}`)

  await stopDaemon(daemons[daemons.length - 1])
  const strayAfter = findRealDaemonPids()
  console.log(`orchestrator daemons still running after the stop: ${JSON.stringify(strayAfter)}`)
  if (strayAfter.length > 0) await fail(`the gate's daemon is still running (pid ${strayAfter.join(', ')})`)

  console.log(
    'stage 5 complete: a company built from two imported templates staffed a project, and the run a real daemon dispatched was ' +
      'given the persona file\'s own words under the line saying where they came from',
  )

  console.log(
    'PASS: a directory of persona files became templates twice over -- creating what was new, refusing what it could not take with ' +
      'the reason for each, leaving an operator\'s own profile alone while updating the file beside it, translating a role in a dry ' +
      'run that wrote nothing, and putting the imported persona in front of a real run',
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
    // Vendor children BEFORE the rows they are named on, `gate-m13-runtime`'s rule.
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
    // Cascades Team/Slave/Task/SlaveRun/RunContext.
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
  }
  // The org rows belong to no workspace, so nothing above cascaded them: the company takes its
  // department templates and roster members with it, and the catalog templates go last because a
  // CompanySlave holds a non-cascading reference to them.
  if (companyId !== null) await prisma.company.delete({ where: { id: companyId } }).catch(() => {})
  await deleteGateTemplates('teardown').catch(() => {})
  await prisma.catalogImport.deleteMany({ where: { catalog: CATALOG_NAME } }).catch(() => {})
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true })
  if (catalogRoot !== null) rmSync(catalogRoot, { recursive: true, force: true })
  if (scratchDir !== null) rmSync(scratchDir, { recursive: true, force: true })
  await prisma.$disconnect()
}

process.exit(exitCode)
