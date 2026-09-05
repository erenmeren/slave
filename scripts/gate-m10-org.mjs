// The M10 gate (design spec §9): "a company staffed a project from templates and shipped its goal,
// unattended -- twice, in parallel". `packages/control/test/integration/org.test.ts` proves the
// catalog/company/assign-company machinery function-by-function; this script proves it the way an
// operator would actually run it -- the real CLI's `create-template`/`create-company`/`add-team`/
// `add-agent`/`assign-company` verbs, building ONE company roster and assigning it to TWO fresh
// project workspaces, then two live `daemon` subprocesses against the fake `claude` CLI's `m8-flow`
// fixture (the same planning+review+work fixture `gate-m8-plan.mjs` uses), observed with nothing
// but DB reads from the moment the roster is assigned to the moment every task both projects
// produced is `done`.
//
// Shape borrowed verbatim from `scripts/gate-m8-plan.mjs` (itself borrowed from
// `scripts/gate-m8a-merge.mjs`/`scripts/measure-graph-status-latency.mjs`): dist imports,
// everything created inside `try`, `finally` kills the daemons and cleans up in FK order, a
// `PASS:`/`FAIL:` line, `exitCode` starts at 1, `process.exit(exitCode)` at the very end. The
// FAIL-path diagnostic dumps follow `scripts/gate-m8a-estop.mjs`'s style -- a thrown error carries
// the run/task/event state that made the call, not just "it timed out" -- for BOTH stages that can
// fail here: the roster-materialization assertion, and the poll-to-done assertion.

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE } from '../packages/db/dist/index.js'
import { prisma } from '../packages/db/dist/client.js'

const POLL_INTERVAL_MS = 15
const STAGE_TIMEOUT_MS = 240_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')

/** Same as `milestone-gate.test.ts`'s `makeRepo` -- a real repository, because the orchestrator's
 *  tick provisions a real worktree in it regardless of which CLI it spawns. */
function makeRepo(suffix) {
  const dir = mkdtempSync(join(tmpdir(), `slaveofai-gate-m10-org-${suffix}-`))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

/** Runs the real orchestrator CLI and returns its stdout, trimmed. Throws (execFileSync's own
 *  behavior) on a non-zero exit -- a refusal here is a setup bug in this gate, not a case to
 *  tolerate. */
function cli(args) {
  return execFileSync('node', [ORCHESTRATOR_CLI, ...args], { encoding: 'utf8' }).trim()
}

/** Every verb this gate calls prints exactly `<noun> <id> created` on success (`cli.ts`'s own
 *  wording) -- the id is always the second word. */
function createdId(stdout) {
  const id = stdout.split(' ')[1]
  if (id === undefined) throw new Error(`could not parse an id out of CLI output: ${JSON.stringify(stdout)}`)
  return id
}

const runTimestamp = new Date().toISOString()

let exitCode = 1
let repoPathA = null
let repoPathB = null
let workspaceIdA = null
let workspaceIdB = null
let companyId = null
let templateIds = []
let daemonA = null
let daemonB = null

try {
  // 1. Two fresh repos, two fresh workspaces -- `autoMerge: true`, `verifyCommands: ['true']`, NO
  // staff and NO tasks (spec §9: staffing comes entirely from the company roster below, work comes
  // entirely from the goal-driven planner, same as `gate-m8-plan.mjs`'s single-workspace version).
  repoPathA = makeRepo('a')
  repoPathB = makeRepo('b')
  const workspaceA = await prisma.workspace.create({
    data: {
      name: `M10 Org Gate Project A ${runTimestamp}`,
      repoPath: repoPathA,
      autoMerge: true,
      verifyCommands: ['true'],
      setupCommands: [],
    },
  })
  const workspaceB = await prisma.workspace.create({
    data: {
      name: `M10 Org Gate Project B ${runTimestamp}`,
      repoPath: repoPathB,
      autoMerge: true,
      verifyCommands: ['true'],
      setupCommands: [],
    },
  })
  // Claim both workspaces for the `finally` cleanup BEFORE anything else can throw: that block
  // only deletes an id it was handed, so an await between the create and the assignment orphans
  // the row in the dev DB. The provider-configuration creates below sit in exactly that window.
  workspaceIdA = workspaceA.id
  workspaceIdB = workspaceB.id
  // Without these rows, dispatch refuses with `invalid_provider` (M12 Task 8) and nothing ever runs.
  await prisma.providerConfiguration.create({
    data: { workspaceId: workspaceA.id, kind: 'claude_code', settings: {} },
  })
  await prisma.providerConfiguration.create({
    data: { workspaceId: workspaceB.id, kind: 'claude_code', settings: {} },
  })
  console.log(`workspace A: ${workspaceA.id}`)
  console.log(`workspace B: ${workspaceB.id}`)

  // 2. The catalog and the roster, entirely through the real CLI: three templates (manager,
  // backend, reviewer -- the exact three roles `dispatchPlanning`/scheduling/`dispatchReview`
  // match on), one company, one company team, three roster members instantiated from those
  // templates.
  const managerTemplateId = createdId(
    cli(['create-template', '--name', `M10 Gate Manager Template ${runTimestamp}`, '--role', 'manager']),
  )
  const backendTemplateId = createdId(
    cli(['create-template', '--name', `M10 Gate Backend Template ${runTimestamp}`, '--role', 'backend']),
  )
  const reviewerTemplateId = createdId(
    cli(['create-template', '--name', `M10 Gate Reviewer Template ${runTimestamp}`, '--role', 'reviewer']),
  )
  templateIds = [managerTemplateId, backendTemplateId, reviewerTemplateId]

  companyId = createdId(cli(['create-company', '--name', `M10 Gate Company ${runTimestamp}`]))
  const companyTeamId = createdId(cli(['add-team', '--company', companyId, '--name', 'Gate Roster']))

  createdId(cli(['add-agent', '--team', companyTeamId, '--template', managerTemplateId, '--name', 'Atlas']))
  createdId(cli(['add-agent', '--team', companyTeamId, '--template', backendTemplateId, '--name', 'Nova']))
  createdId(cli(['add-agent', '--team', companyTeamId, '--template', reviewerTemplateId, '--name', 'Rhea']))

  // 3. The same company roster, assigned to BOTH projects (spec §9: one company serving two
  // projects at once) -- additive materialization creates one project team + three project workers
  // per workspace.
  cli(['assign-company', '--workspace', workspaceA.id, '--company', companyId])
  cli(['assign-company', '--workspace', workspaceB.id, '--company', companyId])

  // 4. Assert the materialization, not just that `assign-company` exited 0: each workspace has
  // exactly 3 workers, every one `companyAgentId`-linked, and the two worker sets are DISTINCT rows
  // (different `Agent.id`) sharing the SAME roster identities (same `companyAgentId`s, same names).
  const workersA = await prisma.agent.findMany({ where: { team: { workspaceId: workspaceA.id } } })
  const workersB = await prisma.agent.findMany({ where: { team: { workspaceId: workspaceB.id } } })
  {
    const dump = () =>
      `workersA=${JSON.stringify(workersA.map((w) => ({ id: w.id, name: w.name, role: w.role, companyAgentId: w.companyAgentId })))} ` +
      `workersB=${JSON.stringify(workersB.map((w) => ({ id: w.id, name: w.name, role: w.role, companyAgentId: w.companyAgentId })))}`

    if (workersA.length !== 3) throw new Error(`workspace A materialized ${workersA.length} worker(s), expected 3 -- ${dump()}`)
    if (workersB.length !== 3) throw new Error(`workspace B materialized ${workersB.length} worker(s), expected 3 -- ${dump()}`)

    const unlinkedA = workersA.filter((w) => w.companyAgentId === null)
    const unlinkedB = workersB.filter((w) => w.companyAgentId === null)
    if (unlinkedA.length > 0 || unlinkedB.length > 0) {
      throw new Error(`some materialized workers carry no companyAgentId -- ${dump()}`)
    }

    const idsA = new Set(workersA.map((w) => w.id))
    const idsB = new Set(workersB.map((w) => w.id))
    const overlappingIds = [...idsA].filter((id) => idsB.has(id))
    if (overlappingIds.length > 0) {
      throw new Error(`workspace A and B share Agent row id(s) ${JSON.stringify(overlappingIds)} -- expected DISTINCT rows -- ${dump()}`)
    }

    const rosterA = new Set(workersA.map((w) => w.companyAgentId))
    const rosterB = new Set(workersB.map((w) => w.companyAgentId))
    const sameRoster = rosterA.size === rosterB.size && [...rosterA].every((id) => rosterB.has(id))
    if (!sameRoster) {
      throw new Error(`workspace A and B do not share the same roster identities -- ${dump()}`)
    }
    const namesA = new Set(workersA.map((w) => w.name))
    const namesB = new Set(workersB.map((w) => w.name))
    const sameNames = namesA.size === namesB.size && [...namesA].every((n) => namesB.has(n))
    if (!sameNames) {
      throw new Error(`workspace A and B workers do not share the same names -- ${dump()}`)
    }
  }
  console.log('materialization asserted: 3+3 companyAgentId-linked workers, distinct rows, shared roster identities')

  // 5. Set the goal via the real CLI on BOTH projects (the human's own path, and the one that
  // emits the `workspace.goal_set` event `dispatchPlanning`'s retry cap keys on), then start TWO
  // real daemons in the background, one per workspace, against the fake CLI's `m8-flow` fixture --
  // same env shape as `gate-m8-plan.mjs`'s single spawn, applied per-spawn to each of the two so
  // neither ever runs against the real `claude` binary.
  cli(['set-goal', '--workspace', workspaceA.id, '--goal', 'Ship the demo feature end to end (project A)'])
  cli(['set-goal', '--workspace', workspaceB.id, '--goal', 'Ship the demo feature end to end (project B)'])

  function spawnDaemon(workspaceId, label) {
    const proc = spawn('node', [ORCHESTRATOR_CLI, 'daemon', '--workspace', workspaceId, '--period', '500'], {
      env: {
        ...process.env,
        SLAVEOFAI_CLAUDE_BIN: 'node',
        SLAVEOFAI_CLAUDE_ARGS: `${FAKE_CLAUDE} --fixture m8-flow`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.stdout.on('data', (chunk) => process.stdout.write(`[daemon-${label}] ${chunk}`))
    proc.stderr.on('data', (chunk) => process.stderr.write(`[daemon-${label}] ${chunk}`))
    proc.exited = false
    proc.on('exit', () => {
      proc.exited = true
    })
    proc.on('error', (error) => {
      proc.exited = true
      console.error(`[daemon-${label}] failed to start:`, error)
    })
    return proc
  }
  daemonA = spawnDaemon(workspaceA.id, 'A')
  daemonB = spawnDaemon(workspaceB.id, 'B')

  // 6. Poll -- zero writes -- until every task in BOTH workspaces reaches `done`.
  let allDone = false
  {
    const deadline = Date.now() + STAGE_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (daemonA.exited) throw new Error('daemon A exited before every task reached done')
      if (daemonB.exited) throw new Error('daemon B exited before every task reached done')
      const tasksA = await prisma.task.findMany({ where: { workspaceId: workspaceA.id } })
      const tasksB = await prisma.task.findMany({ where: { workspaceId: workspaceB.id } })
      const doneA = tasksA.length > 0 && tasksA.every((t) => t.status === 'done')
      const doneB = tasksB.length > 0 && tasksB.every((t) => t.status === 'done')
      if (doneA && doneB) {
        allDone = true
        break
      }
      await delay(POLL_INTERVAL_MS)
    }
    if (!allDone) {
      // m8a-estop-style diagnostic: dump exactly what happened in BOTH workspaces -- task state,
      // and every event type recorded so far -- instead of a bare timeout message.
      const tasksA = await prisma.task.findMany({ where: { workspaceId: workspaceA.id } })
      const tasksB = await prisma.task.findMany({ where: { workspaceId: workspaceB.id } })
      const eventsA = await prisma.executionEvent.findMany({ where: { workspaceId: workspaceA.id }, orderBy: { seq: 'asc' } })
      const eventsB = await prisma.executionEvent.findMany({ where: { workspaceId: workspaceB.id }, orderBy: { seq: 'asc' } })
      throw new Error(
        `not every task in both workspaces reached "done" within ${STAGE_TIMEOUT_MS}ms: ` +
          `tasksA=${JSON.stringify(tasksA.map((t) => ({ id: t.id, title: t.title, status: t.status, attempt: t.attempt })))} ` +
          `tasksB=${JSON.stringify(tasksB.map((t) => ({ id: t.id, title: t.title, status: t.status, attempt: t.attempt })))} ` +
          `eventTypesA=${JSON.stringify(eventsA.map((e) => DOMAIN_EVENT_TYPE_BY_DB_VALUE[e.type]))} ` +
          `eventTypesB=${JSON.stringify(eventsB.map((e) => DOMAIN_EVENT_TYPE_BY_DB_VALUE[e.type]))}`,
      )
    }
  }
  console.log('every task in both workspaces reached done')

  const taskCountA = await prisma.task.count({ where: { workspaceId: workspaceA.id } })
  const taskCountB = await prisma.task.count({ where: { workspaceId: workspaceB.id } })

  // 7. Assert the pipeline actually ran through the roster, not a shortcut: every implementation
  // run in either workspace traces back to a worker with a non-null `companyAgentId`.
  const implRuns = await prisma.agentRun.findMany({
    where: { kind: 'implementation', agent: { team: { workspaceId: { in: [workspaceA.id, workspaceB.id] } } } },
    include: { agent: true },
  })
  if (implRuns.length === 0) {
    throw new Error('no implementation runs were recorded in either workspace -- nothing to trace')
  }
  const untraced = implRuns.filter((run) => run.agent.companyAgentId === null)
  if (untraced.length > 0) {
    throw new Error(
      `${untraced.length} implementation run(s) trace to a worker with no companyAgentId: ` +
        JSON.stringify(untraced.map((r) => ({ runId: r.id, agentId: r.agentId, agentName: r.agent.name }))),
    )
  }

  // 8. Assert each repo's `main` really has merge commits -- both projects, not just one.
  function assertMerged(repoPath, label) {
    const mergeSubjects = execFileSync('git', ['log', '--merges', '--format=%s', 'main'], {
      cwd: repoPath,
      encoding: 'utf8',
    })
    const merges = mergeSubjects.split('\n').filter((line) => line.includes('merge(T-'))
    if (merges.length === 0) {
      throw new Error(`project ${label}'s main has no "merge(T-...)" commit subject: ${JSON.stringify(mergeSubjects)}`)
    }
    return merges.length
  }
  const mergesA = assertMerged(repoPathA, 'A')
  const mergesB = assertMerged(repoPathB, 'B')
  console.log(`project A: ${taskCountA} task(s), ${mergesA} merge(s) -- project B: ${taskCountB} task(s), ${mergesB} merge(s)`)

  console.log(
    `PASS: a company staffed ${taskCountA}+${taskCountB} tasks across two projects from templates, unattended`,
  )
  exitCode = 0
} finally {
  for (const daemon of [daemonA, daemonB]) {
    if (daemon !== null && daemon.exitCode === null) {
      daemon.kill('SIGTERM')
      const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
      while (daemon.exitCode === null && Date.now() < exitDeadline) await delay(50)
      if (daemon.exitCode === null) daemon.kill('SIGKILL')
    }
  }
  // FK-ordered cleanup: events first (no FK from ExecutionEvent to Workspace -- M2's append-only
  // log outlives entity lifecycles by design), then the workspaces (cascades
  // Team/Agent/Task/AgentRun/Checkpoint/TaskDependency/Artifact/AgentMessage), then the company
  // (cascades CompanyTeam/CompanyAgent -- safe only once no Agent row references a CompanyAgent
  // any more, which the workspace deletes above already guarantee), then the templates.
  for (const workspaceId of [workspaceIdA, workspaceIdB]) {
    if (workspaceId !== null) {
      await prisma.executionEvent.deleteMany({ where: { workspaceId } }).catch(() => {})
    }
  }
  for (const workspaceId of [workspaceIdA, workspaceIdB]) {
    if (workspaceId !== null) {
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
    }
  }
  if (companyId !== null) {
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {})
  }
  for (const templateId of templateIds) {
    await prisma.agentTemplate.delete({ where: { id: templateId } }).catch(() => {})
  }
  if (repoPathA !== null) rmSync(repoPathA, { recursive: true, force: true })
  if (repoPathB !== null) rmSync(repoPathB, { recursive: true, force: true })
  await prisma.$disconnect()
}

process.exit(exitCode)
