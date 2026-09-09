// M37's own gate (Task 5 brief): proves the milestone's central claim end to end, with a real
// daemon and the FAKE `claude` CLI -- one builder puts the slave in front of the model. A run's
// prompt carries the persona the OVERRIDE CHAIN actually resolves to, the skills the worker was
// assigned are really on disk in its worktree without dirtying it, a skill the catalog knows and
// the disk does not is recorded rather than promised, and every one of those facts is readable
// afterwards through the operator's own `show-context` verb.
//
// WHY A TEMP SKILLS ROOT. The injection copies real directories off the daemon host's disk. Read
// from the operator's own `~/.claude/skills`, this gate would copy whatever that machine happens to
// have installed into a slave's worktree and then assert against it -- a different assertion on
// every machine, and a gate that writes an operator's files into a temp repo. So the daemon
// subprocess AND this process both get `SLAVEOFAI_SKILL_ROOTS_JSON` (the seam
// `packages/control/src/skills.ts` added for exactly this), pointing all three roots at a temp tree
// this gate builds and deletes: `personal` holding one skill, `alpha`, and two empty directories
// for `pluginCache` and `project`. `skillRoots()` refuses a partial object, so all three are given.
//
// WHY `ghost` IS INSERTED BY HAND. "A skill whose files are gone" cannot be produced by writing a
// file; it is produced by a catalog row with no directory under it, which is exactly what a skill
// uninstalled since the last scan leaves behind. The row is inserted directly under the `personal`
// provider, and the assertion is that the run STARTS anyway, with `ghost` in the manifest's
// `missing` list and its name nowhere in the prompt -- naming a skill that is not there would send
// the run looking for it.
//
// WHY THE REVIEWER ROLE IS GRANTED MID-SCENARIO, AND WHY THAT IS THE STRONGER PROOF. The worker is
// created holding `runtimeRoles = ['backend']` and its literal `role` is `Senior Engineer`. So
// while stage 1 measures the worktree, NOTHING can be dispatched into it: a review run injects
// skills into the same worktree the implementation run left, and a gate that read that directory
// while a second dispatch was rewriting it would be a coin flip. It also turns stage 2's claim from
// an observation into a measurement: the task reaches `reviewing` and sits there with a
// `no_reviewer` guardrail event and no review run at all -- and then the operator's own
// `set-runtime-roles --roles backend,reviewer` is the only thing that changes, and the very next
// pass staffs the review onto that same worker whose title still reads `Senior Engineer`. `role`
// matched nothing; `runtimeRoles` matched everything (M37 §5).
//
// NEVER A MODEL CALL. The daemon is spawned with `SLAVEOFAI_CLAUDE_BIN=node`,
// `SLAVEOFAI_CLAUDE_ARGS="<fake-claude.mjs> --fixture m8a-flow"` and `SLAVEOFAI_REQUIRE_FAKE_CLI=1`
// (M32 item 7: lose the first two and the daemon refuses to start rather than falling back to the
// real binary), the same wiring `gate-m8a-estop.mjs` and `gate-m36-messaging.mjs` use. `m8a-flow`
// leaves a real commit in the worktree on a work run and replays `review-approve` on a prompt
// carrying the literal `"verdict"` -- which is why `REVIEW_VERDICT_INSTRUCTIONS` says so verbatim.
//
// STAGES
//   1. What the implementation run was told. The daemon starts the task's run; the run finishes.
//      Then, with nothing able to touch that worktree: the prompt carries the WORKER's profile and
//      not the template's it overrode, names `alpha` and never `ghost`; the manifest says profile
//      origin `slave`, `skills.copied = ['alpha']`, `skills.missing = ['ghost']`;
//      `<worktree>/.claude/skills/alpha/SKILL.md` is really on disk; `git status --porcelain` in
//      that worktree is EMPTY; and the file `git rev-parse --git-path info/exclude` names carries
//      `/.claude/skills/alpha/`, which is why it is empty.
//   2. Runtime roles, not the title. The task is `reviewing`, no review run exists, and a
//      `no_reviewer` guardrail event says why. The real CLI grants `reviewer`; a review run appears
//      on the SAME worker; its `RunContext` is `kind: review`, carries the same profile, carries
//      the diff of the work the implementation run committed, and has no `inbox`, `roster` or
//      `ask_protocol` section -- a reviewer is told none of those (M37 §3).
//   3. The operator can read it back. `show-context --run <id>` as a real subprocess, whose stdout
//      parses with `runContextManifestSchema` and deep-equals the row this gate already asserted.
//
// Shape borrowed from `gate-m36-messaging.mjs` (temp git repo + `prisma.workspace.create` setup,
// `preflightCleanup()`/`dumpGateRows()`/`fail()`/`waitUntil()`, the daemon lifecycle and its
// `findRealDaemonPids()` refusal, "print every measured value before asserting it", real CLI
// subprocesses through `execFileSync('node', [cliPath, ...])` with `loopbackChildEnv()`, `exitCode`
// starting at 1 and set to 0 only at the very end, teardown in FK order) and from
// `gate-m35-pipeline-honesty.mjs` for building a review's preconditions without a model call.

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { findRealDaemonPids } from './lib/daemon-process.mjs'
import { prisma } from '../packages/db/dist/client.js'
import { runContextManifestSchema } from '../packages/domain/dist/index.js'
import { isAlive, skillRoots, skillSourceDir, syncSkillCatalog } from '../packages/control/dist/index.js'

const POLL_INTERVAL_MS = 50
const DAEMON_PERIOD_MS = 500
// Generous, and every one of them bounds real work: a `git worktree add`, a fake CLI replay, a
// verify pass, a `git diff`. Tuned to "a slow machine still passes", not to "a fast one is proven".
const DISPATCH_TIMEOUT_MS = 90_000
const RUN_TIMEOUT_MS = 180_000
const REVIEW_TIMEOUT_MS = 120_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')

// Exact literals, never suffixed -- `preflightCleanup` removes whatever a prior crashed run left on
// these exact names, in the same FK order the `finally` block uses.
const WORKSPACE_NAME = 'M37 Gate Project'
const COMPANY_NAME = 'M37 Gate Company'
const TEMPLATE_NAME = 'M37 Gate Template'
const TASK_TITLE = 'M37 Gate Task'

// The two personas, and the two substrings the assertions actually key on. Both start the same way
// on purpose: the override chain is not proven by two texts that share no words, it is proven by
// the run seeing the one sentence only ONE of them contains.
const TEMPLATE_PROFILE =
  'You are Atlas, a catalog persona. THE TEMPLATE TEXT MUST NOT REACH A RUN whose worker carries a profile of its own.'
const SLAVE_PROFILE =
  'You are Atlas. THIS WORKER OVERRODE ITS TEMPLATE: prefer the smallest change that works, and say what you did not do.'
const TEMPLATE_MARK = 'THE TEMPLATE TEXT MUST NOT REACH A RUN'
const SLAVE_MARK = 'THIS WORKER OVERRODE ITS TEMPLATE'

// The skill that exists on disk, and the one the catalog remembers and the disk has forgotten.
// Their DESCRIPTIONS are what `preflightCleanup` identifies a leftover row by: the names alone are
// ordinary words an operator could have installed for real, and deleting a real `Skill` row
// cascades its `SlaveSkill` assignments away silently. These two strings are written by this file
// and by nothing else, so a row carrying one is unambiguously a previous run of this gate.
const PRESENT_SKILL = 'alpha'
const MISSING_SKILL = 'ghost'
const PRESENT_SKILL_DESCRIPTION = "the gate's temp-root skill: proof that an assigned skill reaches a run"
const MISSING_SKILL_DESCRIPTION = 'a catalogued skill whose files are not on disk'

/** Same as `gate-m36-messaging.mjs`'s `makeRepo` -- a real repository, because the tick provisions
 *  a real worktree in it and the fake CLI commits into that worktree. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m37-repo-'))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

/**
 * The three skill roots this gate's daemon and this process both read, as a temp tree.
 *
 * `personal` holds one real skill directory with a real `SKILL.md`; the other two are empty but
 * must exist as non-empty PATHS -- `skillRoots()` throws on an object missing any of the three,
 * deliberately, so a misconfigured daemon can never silently fall back to `~/.claude`.
 */
function makeSkillRoots() {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m37-skills-'))
  const roots = { personal: join(dir, 'personal'), pluginCache: join(dir, 'plugins'), project: join(dir, 'project') }
  mkdirSync(join(roots.personal, PRESENT_SKILL), { recursive: true })
  mkdirSync(roots.pluginCache, { recursive: true })
  mkdirSync(roots.project, { recursive: true })
  writeFileSync(
    join(roots.personal, PRESENT_SKILL, 'SKILL.md'),
    `---\nname: ${PRESENT_SKILL}\ndescription: ${PRESENT_SKILL_DESCRIPTION}\n---\n\nDo the smallest correct thing.\n`,
  )
  return { dir, roots }
}

/** Removes what a prior interrupted run left behind, in the same order the `finally` block uses:
 *  the workspace's events (no FK), the workspace (cascades Team/Slave/Task/SlaveRun/RunContext),
 *  then the org rows, which belong to no workspace and therefore cascade from nothing. */
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
  const staleTemplate = await prisma.slaveTemplate.findUnique({ where: { name: TEMPLATE_NAME } })
  if (staleTemplate !== null) {
    console.log(`preflight: removing a leftover ${TEMPLATE_NAME} (${staleTemplate.id})`)
    await prisma.companySlave.deleteMany({ where: { templateId: staleTemplate.id } }).catch(() => {})
    await prisma.slaveTemplate.delete({ where: { id: staleTemplate.id } }).catch(() => {})
  }

  // The catalog rows, which the `finally` block alone used to remove -- and a `finally` does not
  // run on SIGINT (review fix round 1). A Ctrl-C during this gate's several-minute wait left a
  // `ghost` row behind, and `Skill` is `@@unique([providerId, name])`, so the NEXT run died on a
  // P2002 inside `prisma.skill.create` before it had a workspace to clean up -- a gate that could
  // only be recovered with hand-written SQL against the shared dev database. Matched on the
  // description as well as the name, so a skill an operator genuinely installed under either name
  // is never deleted out from under them (that would cascade its `SlaveSkill` assignments too).
  const staleSkills = await prisma.skill.deleteMany({
    where: {
      provider: { name: 'personal' },
      OR: [
        { name: PRESENT_SKILL, description: PRESENT_SKILL_DESCRIPTION },
        { name: MISSING_SKILL, description: MISSING_SKILL_DESCRIPTION },
      ],
    },
  })
  if (staleSkills.count > 0) {
    console.log(`preflight: removing ${staleSkills.count} leftover gate skill row(s) under the personal provider`)
  }

  await restoreStampedSkills('preflight')
}

/**
 * Clears the `missingSince` stamps this gate's temp-root sync put on the operator's REAL skills.
 *
 * The `finally` block does this from `skillsPresentBefore`, the exact ids it read before syncing.
 * That is the precise answer and it is the one used when the gate finishes -- but a `finally` does
 * not run on SIGINT (the same hole that used to leave the gate's own `Skill` rows behind), and a
 * Ctrl-C between the sync and teardown leaves every real skill on the machine marked missing, in a
 * shared dev database, with nothing that ever puts them back. So the pre-flight repairs it too.
 *
 * Pre-flight has no `skillsPresentBefore` to work from -- it belongs to a process that is gone --
 * so it asks the question that list was a shortcut for: is this row stamped missing while its
 * files are right there under the real roots? Only a row the gate (or something else pointing the
 * catalog at a tree that is not the machine's) stamped can answer yes; a skill the operator really
 * uninstalled has no directory and is left stamped, which is the truth.
 */
async function restoreStampedSkills(label) {
  let roots
  try {
    roots = skillRoots()
  } catch (error) {
    // A malformed `SLAVEOFAI_SKILL_ROOTS_JSON` in the operator's own environment. Nothing to
    // repair against, and the run below sets its own value anyway.
    console.log(`${label}: cannot read the real skill roots (${error.message}); leaving missingSince stamps alone`)
    return
  }
  const stamped = await prisma.skill.findMany({
    where: { missingSince: { not: null } },
    select: { id: true, name: true, provider: { select: { name: true } } },
  })
  const restorable = stamped
    .filter((skill) => {
      const source = skillSourceDir(roots, skill.provider.name, skill.name)
      return source !== null && statSync(source, { throwIfNoEntry: false })?.isDirectory() === true
    })
    .map((skill) => skill.id)
  if (restorable.length === 0) return
  await prisma.skill.updateMany({ where: { id: { in: restorable } }, data: { missingSince: null } }).catch(() => {})
  console.log(
    `${label}: cleared missingSince on ${restorable.length} skill(s) whose files are on disk -- an earlier interrupted run ` +
      'left them stamped against a temp tree',
  )
}

let exitCode = 1
let repoPath = null
let skillsDir = null
let workspaceId = null
let companyId = null
let templateId = null
/** Skill rows this gate inserted itself, deleted at teardown -- never a row that was already there. */
const ownSkillIds = []
/** The `Skill` rows that were PRESENT before this gate pointed the catalog at a temp tree. Syncing
 *  against that tree stamps every real skill `missingSince`, which is the catalog telling the truth
 *  about the roots it was given and a lie about the machine; the `finally` block puts them back. */
let skillsPresentBefore = []
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

/** The `gate-m35`/`gate-m36` diagnostic throw: an Error carrying the state that made the call, not
 *  just the sentence that noticed. */
async function fail(message) {
  const dump = await dumpGateRows().catch(
    (cause) => `<could not dump gate rows: ${cause instanceof Error ? cause.message : String(cause)}>`,
  )
  throw new Error(`${message} -- gateRows=${dump}`)
}

/** One section source of a manifest, by kind -- the manifest is an ordered array, and every
 *  assertion below is about the one entry of a kind this gate's runs can only produce once. */
const sourceOfKind = (manifest, kind) => manifest.sections.find((section) => section.kind === kind)

try {
  if (!existsSync(ORCHESTRATOR_CLI)) throw new Error(`orchestrator CLI not built at ${ORCHESTRATOR_CLI} -- run tsc --build first`)
  if (!existsSync(FAKE_CLAUDE)) throw new Error(`the fake claude CLI is missing at ${FAKE_CLAUDE}`)

  // Refused rather than tolerated (`gate-m36-messaging.mjs`'s own refusal, for a related reason):
  // a daemon somebody else left running would be reading the operator's REAL skill roots while this
  // one points the catalog at a temp tree, and the two would fight over `Skill.missingSince` on
  // every scan.
  const strayDaemons = findRealDaemonPids()
  if (strayDaemons.length > 0) {
    throw new Error(
      `gate:m37-run-context REFUSED -- an orchestrator daemon is already running (pid ${strayDaemons.join(', ')}); ` +
        'this gate repoints the skill catalog at a temp tree and cannot do that under a daemon reading the real one',
    )
  }

  await preflightCleanup()

  // ---- Setup ------------------------------------------------------------------------------------
  repoPath = makeRepo()
  const skills = makeSkillRoots()
  skillsDir = skills.dir
  // Set here rather than at the top of the file because `skillRoots()` reads the environment at
  // CALL time, not at import time -- so an ESM import hoisted above this line still sees it.
  process.env.SLAVEOFAI_SKILL_ROOTS_JSON = JSON.stringify(skills.roots)
  console.log(`skill roots: ${process.env.SLAVEOFAI_SKILL_ROOTS_JSON}`)

  skillsPresentBefore = (await prisma.skill.findMany({ where: { missingSince: null }, select: { id: true } })).map(
    (row) => row.id,
  )
  const alphaBeforeSync = await prisma.skill.findFirst({
    where: { name: PRESENT_SKILL, provider: { name: 'personal' } },
    select: { id: true },
  })
  const synced = await syncSkillCatalog()
  console.log(
    `catalog synced against the temp roots: ${JSON.stringify(synced)} (${skillsPresentBefore.length} skill(s) were present ` +
      'before and are restored at teardown)',
  )

  const presentSkill = await prisma.skill.findFirstOrThrow({ where: { name: PRESENT_SKILL, provider: { name: 'personal' } } })
  // Owned by this gate exactly when the sync above CREATED it -- read before the sync rather than
  // inferred from `skillsPresentBefore` (review fix round 1). A previous run interrupted between
  // its sync and its teardown leaves an `alpha` row whose `missingSince` is null, which the
  // membership test would read as "somebody else's, leave it alone" -- and a row pointing at a
  // temp directory that no longer exists would then live in the catalog forever.
  if (alphaBeforeSync === null) ownSkillIds.push(presentSkill.id)
  // The catalog row with nothing under it. Inserted, not deleted from disk: this is what an
  // uninstalled skill leaves behind, and it is the only way to produce one.
  const missingSkill = await prisma.skill.create({
    data: { providerId: presentSkill.providerId, name: MISSING_SKILL, description: MISSING_SKILL_DESCRIPTION },
  })
  ownSkillIds.push(missingSkill.id)
  console.log(`skills: ${PRESENT_SKILL} ${presentSkill.id} (on disk), ${MISSING_SKILL} ${missingSkill.id} (no directory)`)

  const workspace = await prisma.workspace.create({
    data: {
      name: WORKSPACE_NAME,
      repoPath,
      baseBranch: 'main',
      autoMerge: false,
      verifyCommands: ['true'],
      setupCommands: [],
      maxAttempts: 5,
    },
  })
  workspaceId = workspace.id
  console.log(`workspace ${workspaceId} (${WORKSPACE_NAME}), repo ${repoPath}`)

  // Without this row every dispatch refuses with `invalid_provider` (M12 Task 8) and nothing runs.
  await prisma.providerConfiguration.create({ data: { workspaceId, kind: 'claude_code', settings: {} } })

  // The full override chain, because that is what is being proven: a template carrying a profile,
  // a roster row carrying none, and a worker carrying its own.
  const template = await prisma.slaveTemplate.create({
    data: { name: TEMPLATE_NAME, role: 'backend', description: 'the M37 gate template', profile: TEMPLATE_PROFILE },
  })
  templateId = template.id
  const company = await prisma.company.create({ data: { name: COMPANY_NAME } })
  companyId = company.id
  const companyTeam = await prisma.companyTeam.create({ data: { companyId, name: 'Engineering' } })
  const companySlave = await prisma.companySlave.create({
    data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas' },
  })

  const team = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
  const slave = await prisma.slave.create({
    data: {
      teamId: team.id,
      companySlaveId: companySlave.id,
      name: 'Atlas',
      // The TITLE. Matched by nothing since M37 -- and deliberately not any role in this scenario.
      role: 'Senior Engineer',
      // Only `backend` for now: see the header. `reviewer` is granted through the real CLI in
      // stage 2, and is the only thing that changes between "no review can happen" and "one does".
      runtimeRoles: ['backend'],
      profile: SLAVE_PROFILE,
    },
  })
  await prisma.slaveSkill.createMany({
    data: [
      { slaveId: slave.id, skillId: presentSkill.id },
      { slaveId: slave.id, skillId: missingSkill.id },
    ],
  })
  console.log(
    `slave ${slave.id} "Atlas": role ${JSON.stringify(slave.role)}, runtimeRoles ${JSON.stringify(slave.runtimeRoles)}, ` +
      `own profile set, template profile ${JSON.stringify(TEMPLATE_MARK)}, skills [${PRESENT_SKILL}, ${MISSING_SKILL}]`,
  )

  const task = await prisma.task.create({
    data: {
      workspaceId,
      title: TASK_TITLE,
      description: 'Synthetic task driven by scripts/gate-m37-run-context.mjs.',
      status: 'ready',
      requiredRole: 'backend',
      maxAttempts: 5,
    },
  })
  console.log(`task ${task.id} (ready, backend)`)

  /** The environment every child of this gate gets: the fake CLI, the refusal that guards it, and
   *  the temp skill roots the injection must read instead of the operator's own. */
  const childEnv = () =>
    loopbackChildEnv({
      SLAVEOFAI_CLAUDE_BIN: 'node',
      SLAVEOFAI_CLAUDE_ARGS: `${FAKE_CLAUDE} --fixture m8a-flow`,
      SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
      SLAVEOFAI_SKILL_ROOTS_JSON: JSON.stringify(skills.roots),
    })

  /** Runs the real orchestrator CLI as a subprocess, exactly as an operator's shell would. */
  const runCli = (args) =>
    execFileSync('node', [ORCHESTRATOR_CLI, ...args], {
      cwd: repoRoot,
      env: childEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  /** The daemon this gate currently expects to be alive. `waitUntil` fails immediately when it dies
   *  rather than sitting out a whole timeout. */
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

  // ================= Stage 1: what the implementation run was told ================================

  spawnDaemon('daemon')

  const startedRun = await waitUntil('the daemon to start a run for the task', DISPATCH_TIMEOUT_MS, async (note) => {
    const run = await prisma.slaveRun.findFirst({ where: { taskId: task.id } })
    note(run === null ? 'no SlaveRun row yet' : `run ${run.id} is ${run.status}`)
    return run
  })
  console.log(`implementation run ${startedRun.id} started (${startedRun.status}, kind ${startedRun.kind})`)

  // Waited out rather than measured mid-flight: the fake CLI's work body writes a file and commits
  // it, and `git status --porcelain` asked halfway through that would be measuring the fake, not
  // the injection. Nothing can touch this worktree afterwards -- the worker cannot be staffed as a
  // reviewer yet, which is the whole reason it holds only `backend` until stage 2.
  const finishedRun = await waitUntil('the implementation run to finish', RUN_TIMEOUT_MS, async (note) => {
    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: startedRun.id } })
    note(`run is ${run.status}`)
    return run.status === 'succeeded' ? run : null
  })
  console.log(`implementation run finished: status ${finishedRun.status}, worktree ${JSON.stringify(finishedRun.worktreePath)}`)
  if (finishedRun.worktreePath === null) await fail('the finished run records no worktree path')
  const worktreePath = finishedRun.worktreePath

  const implContext = await prisma.runContext.findUnique({ where: { runId: startedRun.id } })
  if (implContext === null) await fail(`the implementation run ${startedRun.id} has no RunContext row: it recorded nothing it saw`)
  const implManifest = runContextManifestSchema.parse(implContext.sections)
  console.log(`implementation manifest: ${JSON.stringify(implManifest)}`)
  console.log(`implementation prompt (${String(implContext.prompt.length)} chars):\n${implContext.prompt}`)

  if (implManifest.kind !== 'implementation') await fail(`the implementation run's manifest says kind ${implManifest.kind}`)

  // ---- The profile the override chain actually resolved to ----
  const carriesSlaveProfile = implContext.prompt.includes(SLAVE_MARK)
  const carriesTemplateProfile = implContext.prompt.includes(TEMPLATE_MARK)
  console.log(`prompt carries the WORKER's profile: ${String(carriesSlaveProfile)}; the TEMPLATE's: ${String(carriesTemplateProfile)}`)
  if (!carriesSlaveProfile) await fail("the prompt does not carry the worker's own profile text")
  if (carriesTemplateProfile) await fail('the prompt carries the TEMPLATE profile the worker overrode')
  const profileSource = sourceOfKind(implManifest, 'profile')
  console.log(`manifest profile source: ${JSON.stringify(profileSource)}`)
  if (profileSource === undefined) await fail('the manifest records no profile section')
  if (profileSource.origin !== 'slave') await fail(`the manifest says the profile came from ${profileSource.origin}, expected slave`)

  // ---- The skills it was offered, and the one it was not ----
  const namesPresent = implContext.prompt.includes(`- ${PRESENT_SKILL}: `)
  const namesMissing = implContext.prompt.includes(MISSING_SKILL)
  console.log(`prompt offers "${PRESENT_SKILL}": ${String(namesPresent)}; mentions "${MISSING_SKILL}" anywhere: ${String(namesMissing)}`)
  if (!namesPresent) await fail(`the prompt does not offer the installed skill ${PRESENT_SKILL}`)
  if (namesMissing) await fail(`the prompt names ${MISSING_SKILL}, a skill that is not in the worktree`)
  const skillsSource = sourceOfKind(implManifest, 'skills')
  console.log(`manifest skills source: ${JSON.stringify(skillsSource)}`)
  if (skillsSource === undefined) await fail('the manifest records no skills section')
  if (JSON.stringify(skillsSource.copied) !== JSON.stringify([PRESENT_SKILL])) {
    await fail(`the manifest's copied list is ${JSON.stringify(skillsSource.copied)}, expected ${JSON.stringify([PRESENT_SKILL])}`)
  }
  if (JSON.stringify(skillsSource.missing) !== JSON.stringify([MISSING_SKILL])) {
    await fail(`the manifest's missing list is ${JSON.stringify(skillsSource.missing)}, expected ${JSON.stringify([MISSING_SKILL])}`)
  }

  // ---- The files, on disk, in the worktree the run actually used ----
  const injectedSkill = join(worktreePath, '.claude', 'skills', PRESENT_SKILL, 'SKILL.md')
  console.log(`${injectedSkill} exists: ${String(existsSync(injectedSkill))}`)
  if (!existsSync(injectedSkill)) await fail(`the assigned skill was never copied into the worktree: ${injectedSkill} is not there`)
  const injectedGhost = join(worktreePath, '.claude', 'skills', MISSING_SKILL)
  console.log(`${injectedGhost} exists: ${String(existsSync(injectedGhost))}`)
  if (existsSync(injectedGhost)) await fail(`a directory was created for the missing skill: ${injectedGhost}`)

  // ---- And the tree the slave hands to verify and merge is still clean ----
  const porcelain = execFileSync('git', ['-C', worktreePath, 'status', '--porcelain'], { encoding: 'utf8' })
  console.log(`git status --porcelain in the worktree: ${JSON.stringify(porcelain)}`)
  if (porcelain !== '') await fail(`the injection dirtied the worktree: ${JSON.stringify(porcelain)}`)

  const reportedExclude = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--git-path', 'info/exclude'], {
    encoding: 'utf8',
  }).trim()
  const excludePath = isAbsolute(reportedExclude) ? reportedExclude : resolve(worktreePath, reportedExclude)
  const excludeText = readFileSync(excludePath, 'utf8')
  console.log(`git rev-parse --git-path info/exclude -> ${excludePath}\n${excludeText}`)
  if (!excludeText.includes(`/.claude/skills/${PRESENT_SKILL}/`)) {
    await fail(`${excludePath} does not name /.claude/skills/${PRESENT_SKILL}/ -- the clean tree above is a coincidence, not a mechanism`)
  }
  console.log(
    'stage 1 complete: the run saw the profile the chain resolves to and not the one it overrode, was offered the skill that ' +
      'is really in its worktree and never the one that is not, and the injection left the tree clean by being excluded from git',
  )

  // ================= Stage 2: runtime roles, not the title ========================================

  const reviewingTask = await waitUntil('the task to reach reviewing', REVIEW_TIMEOUT_MS, async (note) => {
    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    note(`task is ${row.status}`)
    return row.status === 'reviewing' ? row : null
  })
  console.log(`task after the implementation run: status ${reviewingTask.status}, branch ${JSON.stringify(reviewingTask.branch)}`)

  // The measured negative: not "no review happened yet", which is just time passing, but the
  // daemon's own one-shot escalation saying it looked for a reviewer and this workspace has none --
  // in a workspace whose only worker has `reviewer` nowhere but in the set it does not hold yet.
  const noReviewer = await waitUntil('the daemon to report that no reviewer is staffed', REVIEW_TIMEOUT_MS, async (note) => {
    const event = await prisma.executionEvent.findFirst({
      where: { workspaceId, taskId: task.id, type: 'guardrail_tripped', payload: { path: ['guardrail'], equals: 'no_reviewer' } },
    })
    note(event === null ? 'no no_reviewer guardrail event yet' : 'found it')
    return event
  })
  console.log(`no_reviewer guardrail event: ${JSON.stringify(noReviewer.payload)}`)
  const runsBeforeGrant = await prisma.slaveRun.findMany({ where: { taskId: task.id } })
  console.log(`runs for the task before the grant: ${JSON.stringify(runsBeforeGrant.map((r) => ({ id: r.id, kind: r.kind })))}`)
  if (runsBeforeGrant.length !== 1) {
    await fail(`the task has ${runsBeforeGrant.length} runs before any reviewer is staffed, expected only the implementation run`)
  }

  // The one thing that changes. The worker's TITLE is untouched by this verb and stays
  // `Senior Engineer` -- which is exactly the point.
  const grantOutput = runCli(['set-runtime-roles', '--slave', slave.id, '--roles', 'backend,reviewer', '--by', 'the M37 gate'])
  console.log(`set-runtime-roles printed: ${JSON.stringify(grantOutput.trim())}`)
  const slaveAfterGrant = await prisma.slave.findUniqueOrThrow({ where: { id: slave.id } })
  console.log(`slave after the grant: role ${JSON.stringify(slaveAfterGrant.role)}, runtimeRoles ${JSON.stringify(slaveAfterGrant.runtimeRoles)}`)
  if (slaveAfterGrant.role !== 'Senior Engineer') await fail(`set-runtime-roles changed the title to ${JSON.stringify(slaveAfterGrant.role)}`)
  if (!slaveAfterGrant.runtimeRoles.includes('reviewer')) await fail('the grant did not put reviewer in the runtime role set')

  const reviewRun = await waitUntil('a review run to be staffed', REVIEW_TIMEOUT_MS, async (note) => {
    // Ordered, not merely `findFirst`: with a fake CLI that replays in milliseconds, the tick that
    // dispatched this review can read the task as `reviewing` a moment before `concludeReview`
    // commits its approval, and dispatch a second, redundant review run (whose own conditioned
    // update then changes nothing). That is pre-existing scheduler behaviour, not M37's, and this
    // gate's subject is the FIRST review's recorded context either way.
    const run = await prisma.slaveRun.findFirst({ where: { taskId: task.id, kind: 'review' }, orderBy: { startedAt: 'asc' } })
    note(run === null ? 'no review run yet' : `review run ${run.id} is ${run.status}`)
    return run
  })
  console.log(`review run ${reviewRun.id} (${reviewRun.status}) staffed onto slave ${reviewRun.slaveId}`)
  if (reviewRun.slaveId !== slave.id) {
    await fail(`the review was staffed onto ${reviewRun.slaveId}, expected the only worker in this workspace ${slave.id}`)
  }

  const reviewContext = await waitUntil('the review run to record what it saw', REVIEW_TIMEOUT_MS, async (note) => {
    const row = await prisma.runContext.findUnique({ where: { runId: reviewRun.id } })
    note(row === null ? 'no RunContext row for the review run yet' : 'found it')
    return row
  })
  const reviewManifest = runContextManifestSchema.parse(reviewContext.sections)
  console.log(`review manifest: ${JSON.stringify(reviewManifest)}`)
  console.log(`review prompt (${String(reviewContext.prompt.length)} chars):\n${reviewContext.prompt}`)
  if (reviewManifest.kind !== 'review') await fail(`the review run's manifest says kind ${reviewManifest.kind}`)

  const reviewProfile = sourceOfKind(reviewManifest, 'profile')
  console.log(`review manifest profile source: ${JSON.stringify(reviewProfile)}`)
  if (reviewProfile === undefined || reviewProfile.origin !== 'slave') {
    await fail(`the review run was not given the reviewer's own profile -- ${JSON.stringify(reviewProfile)}`)
  }
  if (!reviewContext.prompt.includes(SLAVE_MARK)) await fail("the review prompt does not carry the reviewer's profile text")

  const diffSource = sourceOfKind(reviewManifest, 'review_diff')
  console.log(`review manifest diff source: ${JSON.stringify(diffSource)}`)
  if (diffSource === undefined) await fail('the review manifest records no diff section')
  if (diffSource.base !== 'main' || diffSource.head !== reviewingTask.branch) {
    await fail(`the review diff is recorded as ${diffSource.base}...${diffSource.head}, expected main...${String(reviewingTask.branch)}`)
  }
  // The diff is of the work the implementation run actually committed -- the fake CLI's own file.
  if (!reviewContext.prompt.includes('m8a-work.txt')) {
    await fail('the review prompt does not contain the diff of the work the implementation run committed')
  }

  const forbidden = ['inbox', 'roster', 'ask_protocol'].filter((kind) => sourceOfKind(reviewManifest, kind) !== undefined)
  console.log(`sections a reviewer must not be given, found in its manifest: ${JSON.stringify(forbidden)}`)
  if (forbidden.length > 0) await fail(`the review run was given ${JSON.stringify(forbidden)} -- a reviewer is told none of those`)

  // Teardown hygiene, not a claim of this milestone: everything above is about the row the review
  // run recorded BEFORE it spawned, and it is measurable the moment that row exists. But tearing
  // down while the child is still mid-replay kills it, which reads to the next tick as a review
  // that failed and gets a second one dispatched during the daemon's drain -- a live vendor child
  // and two spurious rows in the log for no reason. Whether the verdict itself is honoured is
  // `gate-m8a-merge.mjs`'s subject, so this only waits for the run to conclude.
  const concludedReview = await waitUntil('the review run to conclude', REVIEW_TIMEOUT_MS, async (note) => {
    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: reviewRun.id } })
    note(`review run is ${run.status}`)
    return run.endedAt === null ? null : run
  })
  const taskAfterReview = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
  console.log(`review run concluded: ${concludedReview.status}; the task is now ${taskAfterReview.status}`)
  console.log(
    'stage 2 complete: a worker whose title is "Senior Engineer" reviewed its own task the moment an operator put `reviewer` ' +
      'in its runtime role set, and the review saw its profile and the diff and nothing addressed to an implementer',
  )

  // ================= Stage 3: the operator can read it back =======================================

  const shown = runCli(['show-context', '--run', startedRun.id])
  console.log(`show-context --run ${startedRun.id} printed:\n${shown}`)
  const parsed = runContextManifestSchema.safeParse(JSON.parse(shown))
  console.log(`the printed manifest parses with runContextManifestSchema: ${String(parsed.success)}`)
  if (!parsed.success) await fail(`show-context printed a manifest the schema rejects: ${parsed.error.message}`)
  if (JSON.stringify(parsed.data) !== JSON.stringify(implManifest)) {
    await fail(
      `show-context printed a different manifest from the row\n  printed: ${JSON.stringify(parsed.data)}\n  row:     ${JSON.stringify(implManifest)}`,
    )
  }
  console.log('stage 3 complete: the recorded manifest is readable through the operator\'s own verb and is the row this gate asserted')

  console.log(
    'PASS: one builder put the slave in front of the model -- the profile its override chain resolves to, the skills that are ' +
      'really in its worktree (and the record of the one that is not), a clean tree, a review staffed on runtime roles rather ' +
      'than on a title, and the whole manifest readable afterwards through show-context',
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
    // Cascades Team/Slave (and its SlaveSkill links)/Task/SlaveRun/RunContext.
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
  }
  // The org rows belong to no workspace, so nothing above cascaded them: the company takes its
  // department template and roster slave with it, and the template goes last because a CompanySlave
  // holds a non-cascading reference to it.
  if (companyId !== null) await prisma.company.delete({ where: { id: companyId } }).catch(() => {})
  if (templateId !== null) await prisma.slaveTemplate.delete({ where: { id: templateId } }).catch(() => {})
  // Only rows this gate inserted, and only then the stamps its temp-root sync put on everybody
  // else's: a shared dev catalog must read the same before and after this gate ran.
  if (ownSkillIds.length > 0) await prisma.skill.deleteMany({ where: { id: { in: ownSkillIds } } }).catch(() => {})
  if (skillsPresentBefore.length > 0) {
    await prisma.skill
      .updateMany({ where: { id: { in: skillsPresentBefore }, missingSince: { not: null } }, data: { missingSince: null } })
      .catch(() => {})
  }
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true })
  if (skillsDir !== null) rmSync(skillsDir, { recursive: true, force: true })
  await prisma.$disconnect()
}

process.exit(exitCode)
