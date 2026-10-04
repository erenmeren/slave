/**
 * Lead-flow plan A: the seed every lead-flow integration test shares. A real repository with a
 * smoke script, a workspace switched to the lead flow (`setFlow`, which makes the three system
 * seats), its goal set, an injected decider that answers ONLY the requirement extraction, and a
 * routing adapter that gives every run its own `m8-flow` fake: a lead turn commits one file of its
 * own and takes the test's extra argv; a verification run answers the items the test scripts for
 * it, or passes every key it was asked. `starts` records what each run was spawned with.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setFlow, setGoal, setLeadSettings, type ModelDecider, type ModelOutcome } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { workspaceId as brandWorkspaceId } from '@slave-of-ai/domain'
import { ClaudeCodeAdapter, readSpawnExtras, type SlaveRuntimeAdapter, type SpawnExtras } from '@slave-of-ai/providers'
import { drainPumps, tick, type TickDeps } from '../../src/tick.js'
import { worktreeRootFor } from '../../src/worktree.js'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const REAL_GATE = join(repoRoot, 'scripts/pause-gate.sh')
const repos: string[] = []

export const LEAD_TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "SmokeAttempt", "PackageHandOff", "GoalDecision", "ConductorCall", "RequirementSet", "WorkPackage", "GoalDelivery", "RunReport", "SupervisorDecision", "SlaveMessage", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "GoalVersion", "ProviderConfiguration", "Slave", "Person", "Team", "Workspace", "User" RESTART IDENTITY CASCADE'

export function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

/** A smoke script that fails its first `failures` runs, then passes -- counted outside the repository. */
function smokeScript(stateFile: string, failures: number): string {
  return ['#!/usr/bin/env bash', `n=$(cat '${stateFile}' 2>/dev/null || echo 0)`, `echo $((n + 1)) > '${stateFile}'`, `if [ "$n" -lt ${String(failures)} ]; then echo 'the product did not start' >&2; exit 1; fi`, 'echo "flow ok"', ''].join('\n')
}

function makeRepo(smokeFailures: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-lead-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'scripts/smoke.sh'), smokeScript(join(mkdtempSync(join(tmpdir(), 'lead-smoke-')), 'count'), smokeFailures))
  chmodSync(join(dir, 'scripts/smoke.sh'), 0o755)
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'initial'], dir)
  repos.push(dir)
  return dir
}

export function cleanUpLeadRepos(): void {
  for (const repo of repos) {
    rmSync(worktreeRootFor(repo), { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
}

/** What one run was spawned with. */
export interface LeadStart {
  readonly runId: string
  readonly kind: string
  readonly leadTurn: string | null
  /** 1-based, per kind: the n-th lead turn, the n-th verification run. */
  readonly ordinal: number
  readonly prompt: string
  readonly resumeSessionId: string | null
  /** The model the run was spawned with; null: no `--model` flag (C5). */
  readonly model: string | null
  readonly extras: SpawnExtras
  readonly verificationKeys: readonly string[]
  readonly confirms: boolean
}

export interface LeadSeedOptions {
  readonly budgetUsd?: number | null
  readonly timeLimitMs?: number
  readonly autoMerge?: boolean
  readonly smokeFailures?: number
  readonly roster?: readonly string[]
  /** Extra fake argv for the n-th lead turn (1-based). */
  readonly leadArgs?: (ordinal: number, leadTurn: string | null) => readonly string[]
  /** The items the n-th verification run answers; undefined: every key it was asked passes. */
  readonly verify?: (ordinal: number, run: { readonly keys: readonly string[]; readonly confirms: boolean }) => readonly object[] | undefined
  /** Runs after a run was spawned, while it is running. */
  readonly onStart?: (start: LeadStart) => Promise<void>
  /** The fake argv a RESUMED run (a paused run continued on its own row) is spawned with. */
  readonly resumeArgs?: readonly string[]
}

export interface LeadFixture {
  readonly workspaceId: string
  readonly repoPath: string
  readonly initialTip: string
  readonly deps: TickDeps
  /** Every model prompt the decider was asked that was not the requirement extraction. */
  readonly others: readonly string[]
  readonly starts: readonly LeadStart[]
}

const REQUIREMENTS = JSON.stringify({
  requirementsAnswer: [
    { text: 'GET /health answers 200', source: 'A health route.' },
    { text: 'GET /version prints the version', source: 'A version route.' },
  ],
})
const b64 = (value: unknown): string => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64')
export const base64 = b64

/** One verifier item, as a scripted run lists it. */
export function checked(key: string, status: 'pass' | 'fail' | 'unverifiable'): object {
  return {
    key,
    status,
    check: key === 'RUN' ? 'docker compose up -d && curl -fsS localhost:8080/health' : `curl -fsS localhost:8080/${key}`,
    output: status === 'pass' ? '200 OK' : status === 'fail' ? '404 Not Found' : '',
    reason: status === 'pass' ? '' : status === 'fail' ? `${key} answers 404` : `${key} needs a network this checkout lacks`,
  }
}

export async function seedLead(options: LeadSeedOptions = {}): Promise<LeadFixture> {
  const repoPath = makeRepo(options.smokeFailures ?? 0)
  const workspace = await prisma.workspace.create({
    data: { name: `Lead Flow ${String(Math.random()).slice(2)}`, repoPath, baseBranch: 'main', verifyCommands: ['true'], setupCommands: [], ...(options.budgetUsd === undefined ? {} : { budgetUsd: options.budgetUsd }) },
  })
  await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })
  const flow = await setFlow(workspace.id, 'lead', { ...(options.autoMerge === undefined ? {} : { autoMerge: options.autoMerge }) })
  if (!flow.ok) throw new Error('the fixture could not enter the lead flow')
  if (options.timeLimitMs !== undefined || options.roster !== undefined) {
    const set = await setLeadSettings(workspace.id, { ...(options.timeLimitMs === undefined ? {} : { timeLimitMs: options.timeLimitMs }), ...(options.roster === undefined ? {} : { roster: options.roster }) })
    if (!set.ok) throw new Error('the fixture lead settings were refused')
  }
  const goal = await setGoal(workspace.id, 'Add a health route. Add a version route.')
  if (!goal.ok) throw new Error('the fixture goal was refused')

  const others: string[] = []
  const decider: ModelDecider = async (input) => {
    const answer = (text: string): ModelOutcome => ({ kind: 'answer', text, costUsd: 0.02, tokens: null, numTurns: 1 })
    if (input.prompt.includes('"requirementsAnswer"')) return answer(REQUIREMENTS)
    others.push(input.prompt)
    return { kind: 'failed', reason: 'not scripted in this test', costUsd: null, tokens: null }
  }

  const starts: LeadStart[] = []
  const make = (extra: readonly string[]): ClaudeCodeAdapter => new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'm8-flow', ...extra], hookPath: REAL_GATE })
  const plain = make([])
  const byRun = new Map<string, SlaveRuntimeAdapter>()
  const pick = (runId: string): SlaveRuntimeAdapter => byRun.get(runId) ?? plain
  const adapter: SlaveRuntimeAdapter = {
    kind: plain.kind,
    getCapabilities: () => plain.getCapabilities(),
    listModels: () => plain.listModels(),
    async start(input) {
      const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: input.runId }, select: { kind: true, leadTurn: true, verificationKeys: true, confirmsRunId: true } })
      const ordinal = starts.filter((s) => s.kind === run.kind).length + 1
      let extra: readonly string[] = []
      if (run.kind === 'implementation') extra = ['--work-file', `lead-work-${String(ordinal)}.txt`, ...(options.leadArgs?.(ordinal, run.leadTurn) ?? [])]
      if (run.kind === 'verification') {
        const items = options.verify?.(ordinal, { keys: run.verificationKeys, confirms: run.confirmsRunId !== null })
        if (items !== undefined) extra = ['--verification-json-base64', b64({ items })]
      }
      const chosen = make(extra)
      const start: LeadStart = {
        runId: input.runId,
        kind: run.kind,
        leadTurn: run.leadTurn,
        ordinal,
        prompt: input.prompt,
        resumeSessionId: input.resumeSessionId ?? null,
        model: input.model ?? null,
        extras: readSpawnExtras(input.runDir),
        verificationKeys: run.verificationKeys,
        confirms: run.confirmsRunId !== null,
      }
      starts.push(start)
      byRun.set(input.runId, chosen)
      const handle = await chosen.start(input)
      if (options.onStart !== undefined) await options.onStart(start)
      return handle
    },
    events: (runId) => pick(runId).events(runId),
    cancel: (runId) => pick(runId).cancel(runId),
    resume: (runId, checkpoint, queuedInstruction, runToken) => {
      // A fresh adapter, as after a daemon restart: it has no memory of the run's first spawn.
      const chosen = options.resumeArgs === undefined ? pick(runId) : make(options.resumeArgs)
      byRun.set(runId, chosen)
      return chosen.resume(runId, checkpoint, queuedInstruction, runToken)
    },
  }

  return {
    workspaceId: workspace.id,
    repoPath,
    initialTip: git(['rev-parse', 'main'], repoPath),
    others,
    starts,
    deps: { workspaceId: brandWorkspaceId(workspace.id), registry: { resolve: () => adapter }, supervisorDecider: decider, supervisorModel: 'claude-sonnet-5' },
  }
}

/** A row a condition reads that does not exist yet (Prisma's `P2025`, from a `…OrThrow` read). */
const notYet = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { readonly code?: unknown }).code === 'P2025'

/**
 * Ticks, letting every pump finish between ticks, until `done` holds -- bounded. A condition that
 * reads the version's delivery or task before the conductor made them (the first tick only
 * extracts the requirements) does not hold yet.
 */
export async function tickUntil(f: LeadFixture, done: () => Promise<boolean>, limit = 60): Promise<void> {
  for (let i = 0; i < limit; i += 1) {
    await tick(f.deps)
    await drainPumps()
    const holds = await done().catch((error: unknown) => {
      if (notYet(error)) return false
      throw error
    })
    if (holds) return
  }
  throw new Error('tickUntil: the condition never held')
}

export async function leadDelivery(f: LeadFixture, goalVersion = 1): Promise<NonNullable<Awaited<ReturnType<typeof prisma.goalDelivery.findUnique>>>> {
  return prisma.goalDelivery.findUniqueOrThrow({ where: { workspaceId_goalVersion: { workspaceId: f.workspaceId, goalVersion } } })
}

export async function leadTaskOf(f: LeadFixture): Promise<NonNullable<Awaited<ReturnType<typeof prisma.task.findFirst>>>> {
  return prisma.task.findFirstOrThrow({ where: { workspaceId: f.workspaceId, workPackageId: { not: null } } })
}

/** The version's `workspace.lead_noted` lines, oldest first, as `kind: detail`. */
export async function leadNotes(f: LeadFixture): Promise<string[]> {
  const rows = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_lead_noted' }, orderBy: { seq: 'asc' }, select: { payload: true } })
  return rows.map((row) => `${(row.payload as { kind: string }).kind}: ${(row.payload as { detail: string }).detail}`)
}

/** Whether the version reached `state`. */
export const leadStateIs = (f: LeadFixture, state: string) => async (): Promise<boolean> => (await leadDelivery(f)).leadState === state
export const merged = (f: LeadFixture) => async (): Promise<boolean> => (await leadDelivery(f)).mergedAt !== null
