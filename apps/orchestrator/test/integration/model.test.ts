import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  addCompanyAgent,
  addCompanyTeam,
  assignCompany,
  createCompany,
  createTemplate,
  setAgentModel,
} from '@ai-team-os/control'
import { prisma } from '@ai-team-os/db/client'
import { workspaceId as brandWorkspaceId } from '@ai-team-os/domain'
import { ClaudeCodeAdapter, type AgentRuntimeAdapter, type StartRunInput } from '@ai-team-os/providers'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { resolveModel } from '../../src/model.js'
import { drainPumps, tick, type TickDeps } from '../../src/tick.js'

describe('resolveModel', () => {
  it('a worker override wins over its roster row and its template default', (): void => {
    const model = resolveModel({
      model: 'worker-model',
      companyAgent: { model: 'roster-model', template: { defaultModel: 'template-model' } },
    })
    expect(model).toBe('worker-model')
  })

  it('a roster override wins over the template default when the worker has none', (): void => {
    const model = resolveModel({
      model: null,
      companyAgent: { model: 'roster-model', template: { defaultModel: 'template-model' } },
    })
    expect(model).toBe('roster-model')
  })

  it('falls back to the template default when neither the worker nor the roster row overrides it', (): void => {
    const model = resolveModel({
      model: null,
      companyAgent: { model: null, template: { defaultModel: 'template-model' } },
    })
    expect(model).toBe('template-model')
  })

  it('resolves to undefined (the adapter default) when every link in the chain is null', (): void => {
    const model = resolveModel({
      model: null,
      companyAgent: { model: null, template: { defaultModel: null } },
    })
    expect(model).toBeUndefined()
  })

  it('a legacy agent with no roster link (companyAgent: null) resolves through its own column alone', (): void => {
    expect(resolveModel({ model: 'legacy-model', companyAgent: null })).toBe('legacy-model')
    expect(resolveModel({ model: null, companyAgent: null })).toBeUndefined()
  })
})

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const REAL_GATE = join(repoRoot, 'scripts/pause-gate.sh')

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

/** A real repository, matching `tick.test.ts`'s own fixture -- `provisionWorktree` uses real git. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiteamos-model-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'initial'], dir)
  return dir
}

interface Recorder {
  readonly adapter: AgentRuntimeAdapter
  readonly starts: StartRunInput[]
}

/** The `tick.test.ts` `recordingAdapter` precedent: the real adapter with `start()` observed. */
function recordingAdapter(): Recorder {
  const inner = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'complete'] })
  const starts: StartRunInput[] = []
  const adapter = {
    id: inner.id,
    getCapabilities: () => inner.getCapabilities(),
    start: async (input: StartRunInput) => {
      starts.push(input)
      return inner.start(input)
    },
    events: (runId: string) => inner.events(runId as never),
    cancel: (runId: string) => inner.cancel(runId as never),
  } as unknown as AgentRuntimeAdapter
  return { adapter, starts }
}

describe('the model chain reaches a dispatched run, and setAgentModel changes the NEXT one', () => {
  const repos: string[] = []

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace", "CompanyAgent", "CompanyTeam", "Company", "AgentTemplate" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true })
  })

  it("starts a run with the template's default model, then the NEXT run reflects setAgentModel", async (): Promise<void> => {
    const repoPath = makeRepo()
    repos.push(repoPath)
    const workspace = await prisma.workspace.create({
      data: { name: 'Checkout Platform', repoPath, baseBranch: 'main', verifyCommands: ['true'], setupCommands: [] },
    })

    // A roster worker materialized through the real M10 org verbs, not hand-inserted rows: this is
    // the actual path a worker's `companyAgentId` link is created through in production.
    const company = await createCompany('Acme Corp')
    if (!company.ok) throw new Error('setup: createCompany failed')
    const team = await addCompanyTeam(company.value.id, 'Engineering')
    if (!team.ok) throw new Error('setup: addCompanyTeam failed')
    const template = await createTemplate('Backend Engineer', 'backend', { defaultModel: 'test-model-a' })
    if (!template.ok) throw new Error('setup: createTemplate failed')
    const rosterAgent = await addCompanyAgent(team.value.id, template.value.id, 'Atlas')
    if (!rosterAgent.ok) throw new Error('setup: addCompanyAgent failed')

    const assigned = await assignCompany(workspace.id, company.value.id)
    if (!assigned.ok) throw new Error('setup: assignCompany failed')
    const worker = await prisma.agent.findFirstOrThrow({ where: { name: 'Atlas' } })
    expect(worker.model).toBeNull()

    const firstTask = await prisma.task.create({
      data: {
        workspaceId: workspace.id,
        title: 'First task',
        description: 'x',
        status: 'ready',
        requiredRole: 'backend',
        maxAttempts: workspace.maxAttempts,
      },
    })

    const recorder = recordingAdapter()
    const deps: TickDeps = {
      workspaceId: brandWorkspaceId(workspace.id),
      adapter: recorder.adapter,
      hookPath: REAL_GATE,
    }

    const first = await tick(deps)
    expect(first.started).toHaveLength(1)
    expect(recorder.starts[0]?.model).toBe('test-model-a')

    // Let the first run conclude (fixture `complete`) so the worker frees up, then override the
    // worker's own model -- the top of the chain, above the roster row and the template default.
    await drainPumps()
    const concludedTask = await prisma.task.findUniqueOrThrow({ where: { id: firstTask.id } })
    expect(concludedTask.activeRunId).toBeNull()

    const override = await setAgentModel(worker.id, 'test-model-b')
    expect(override.ok).toBe(true)

    await prisma.task.create({
      data: {
        workspaceId: workspace.id,
        title: 'Second task',
        description: 'x',
        status: 'ready',
        requiredRole: 'backend',
        maxAttempts: workspace.maxAttempts,
      },
    })

    const second = await tick(deps)
    expect(second.started).toHaveLength(1)
    expect(recorder.starts[1]?.model).toBe('test-model-b')

    await drainPumps()
  }, 30_000)
})
