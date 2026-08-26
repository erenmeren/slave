# M12: Provider Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every provider-specific decision behind the adapter contract, make
`ProviderCapabilities` load-bearing, and land the Cursor CLI as a second runtime that proves
the seam.

**Architecture:** Four series. **A** refactors the seam while the Claude adapter's behavior
stays frozen and the suite stays green (M11's baseline-green protocol). **B** turns model
resolution into `(provider, model)` pair resolution with additive schema columns. **C** makes
cost honest — `null` for unknown, refusals for unmeasurable budgets. **D** builds the Cursor
adapter on the finished contract. **E** puts provider on the M11 surfaces and closes with a
measured gate that runs both runtimes live.

**Tech Stack:** TypeScript, Prisma/Postgres, vitest, Next.js (App Router), `playwright-core`
for the gate, the `claude` and `cursor-agent` CLIs as child processes.

**Spec:** `docs/superpowers/specs/2026-08-25-m12-provider-adapters-design.md`

## Global Constraints

- **Refusal texts, verbatim** (`packages/control/src/refusal.ts`, in the existing switch that
  already returns `a model must be a non-empty text`):
  - `model_without_provider` → `a model must name the provider that runs it`
  - `invalid_provider` → `a provider must be a configured kind`
  - `unmeasurable_budget` → `a budget needs a provider that reports cost`
- **`ProviderCapabilities` has exactly four members** — `canPauseMidRun`, `canResumeSession`,
  `gate: 'all-tools' | 'shell-only' | 'none'`, `reportsCost`. Any member without a consumer
  in this plan is deleted, not kept "for later".
- **Unknown cost is `null`, never `0`.** No default, no coalesce, no sum that treats a
  missing figure as free.
- **Migrations are additive.** New columns are nullable; `AgentRun.costUsd` drops NOT NULL
  and keeps its existing values. No data is rewritten.
- **Series A freezes Claude behavior.** The mechanism on disk (flag file path, settings file
  shape, hook contract) is byte-identical before and after. Existing tests are not rewritten
  to fit the refactor; a test that must change is a signal to stop and report.
- **Capabilities are proven, not read from docs.** Every Cursor capability is verified
  against the installed binary and the evidence recorded in the task report. Unproven takes
  the conservative value: `false`, or `'none'` for the gate.
- **Gate PASS line, verbatim:** `two providers kept one promise`.
- **One vitest run at a time on this machine.** Never run suites in parallel, never `git push`
  while a suite runs (the pre-push hook runs the suite).
- **`npm run web:build` is part of every gate** — tsc and vitest miss bundler-only breakage.
- **Stage named files only.** Never `git add -A`; the tree carries unrelated untracked paths.

---

## Series A — The Honest Seam

### Task 1: The contract sheds what nothing reads

**Files:**
- Modify: `packages/providers/src/types.ts` (`RunOutcome.costUsd`)
- Modify: `packages/providers/src/claude/adapter.ts:16-24` (`ProviderCapabilities`)
- Test: `packages/providers/test/capabilities.test.ts` (create)

**Interfaces:**
- Produces: `ProviderCapabilities` with exactly four members; `RunOutcome.costUsd: number | null`.
  Every later task consumes these.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/providers/test/capabilities.test.ts
import { describe, expect, it } from 'vitest'
import { ClaudeCodeAdapter } from '../src/index.js'

describe('ProviderCapabilities', () => {
  it('exposes exactly the four members the system consumes', () => {
    const caps = new ClaudeCodeAdapter({ command: 'claude' }).getCapabilities()
    expect(Object.keys(caps).sort()).toEqual([
      'canPauseMidRun',
      'canResumeSession',
      'gate',
      'reportsCost',
    ])
  })

  it('describes the Claude runtime: mid-run pause, resumable, gates every tool, reports cost', () => {
    const caps = new ClaudeCodeAdapter({ command: 'claude' }).getCapabilities()
    expect(caps).toEqual({
      canPauseMidRun: true,
      canResumeSession: true,
      gate: 'all-tools',
      reportsCost: true,
    })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/providers/test/capabilities.test.ts`
Expected: FAIL — the returned object still carries `supportsHooks`, `streamsToolCalls`,
`supportsCustomSystemPrompt`, `enforcesToolPermissions`, `reportsTokenUsage`.

- [ ] **Step 3: Reduce the interface**

```typescript
// packages/providers/src/claude/adapter.ts
/**
 * What a runtime can promise. Every member has exactly one consumer in the system --
 * a capability nothing reads is a claim nothing checks, so it does not exist here.
 */
export interface ProviderCapabilities {
  /** Consumed by the pause strategy: can this runtime stop between tool calls? */
  readonly canPauseMidRun: boolean
  /** Consumed by the pause strategy: can a stopped session be continued? */
  readonly canResumeSession: boolean
  /** Consumed by gate semantics and the roster's provider mark. */
  readonly gate: 'all-tools' | 'shell-only' | 'none'
  /** Consumed by budget admission: does this runtime report spend in USD? */
  readonly reportsCost: boolean
}
```

- [ ] **Step 4: Make `costUsd` admit the unknown**

```typescript
// packages/providers/src/types.ts
export interface RunOutcome {
  readonly isError: boolean
  readonly terminalReason: string
  readonly stopReason: string | null
  readonly numTurns: number
  /**
   * USD, or `null` when the runtime does not report spend. Never `0` for an unmeasured
   * run -- zero is a figure the budget guardrail believes.
   */
  readonly costUsd: number | null
  readonly deniedToolUseIds: readonly string[]
}
```

Update `ClaudeCodeAdapter.getCapabilities()` to return the four-member object above. The
Claude parser keeps reading `total_cost_usd`, so Claude runs still produce a number; only the
type widens here. Fix the resulting type errors at `apps/orchestrator/src/pump.ts:552` by
writing the value through unchanged (Prisma accepts `null` after Task 6; until then, keep the
existing `?? 0` **only** at the DB write and mark it with `// TASK 6: drops when the column
goes nullable` so it cannot be forgotten).

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/providers/ && npm run typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/providers/src/types.ts packages/providers/src/claude/adapter.ts packages/providers/test/capabilities.test.ts
git commit -m "refactor(providers): capabilities keep only what the system reads"
```

---

### Task 2: The Claude adapter owns its own run files

**Files:**
- Modify: `packages/providers/src/claude/adapter.ts` (`start`, `resume`)
- Modify: `apps/orchestrator/src/tick.ts:461` (drop `writeSettingsFile`)
- Modify: `apps/orchestrator/src/planning.ts:280` (drop `writeSettingsFile`)
- Modify: `apps/orchestrator/src/review.ts:307` (drop `writeSettingsFile`)
- Modify: `apps/orchestrator/src/cli.ts:117-121` (hook path moves into the adapter's options)
- Test: `packages/providers/test/run-preparation.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's `ProviderCapabilities`.
- Produces: `StartRunInput` loses `settingsPath` and `hookPath`; it keeps `runId`, `prompt`,
  `worktreePath`, `pauseFlagPath`, `gitIdentity`, `model?`. `ClaudeCodeAdapterOptions` gains
  `hookPath: string`. The adapter derives its settings file inside the run directory.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/providers/test/run-preparation.test.ts
import { existsSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeCodeAdapter } from '../src/index.js'

describe('the Claude adapter prepares its own run files', () => {
  it('writes the settings file itself, registering the hook it was configured with', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm12-prep-'))
    const adapter = new ClaudeCodeAdapter({ command: '/bin/true', hookPath: '/tmp/gate.sh' })

    await adapter.start({
      runId: 'run-1',
      prompt: 'hello',
      worktreePath: dir,
      pauseFlagPath: join(dir, 'pause.flag'),
      gitIdentity: { name: 'a', email: 'a@b.c' },
    })

    const settings = join(dir, '.m12', 'settings.json')
    expect(existsSync(settings)).toBe(true)
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toMatchObject({
      hooks: { PreToolUse: [{ matcher: '*' }] },
    })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/providers/test/run-preparation.test.ts`
Expected: FAIL — `start` does not accept the input without `settingsPath`, and writes nothing.

- [ ] **Step 3: Move preparation inward**

In `adapter.ts`: `ClaudeCodeAdapterOptions` gains `readonly hookPath: string`. `start` and
`resume` call the existing `writeSettingsFile` themselves, into a directory the adapter
derives from `worktreePath`. `StartRunInput` drops `settingsPath` and `hookPath`. The
`Checkpoint` fields `settingsPath` and `hookPath` stay — a resumed run must find the same
files — but the adapter fills them rather than receiving them.

- [ ] **Step 4: Strip the orchestrator's knowledge**

Delete the `writeSettingsFile` import and call from `tick.ts`, `planning.ts` and `review.ts`,
and the corresponding `settingsPath`/`hookPath` arguments to `adapter.start`. In `cli.ts`,
`hookPath()` stops being threaded through `deps` and becomes the `hookPath` option passed to
`new ClaudeCodeAdapter(...)`. `runFilePaths` (`packages/control/src/paths.ts:13-17`) keeps
returning the run directory and `pauseFlagPath`; it stops returning `settingsPath`.

- [ ] **Step 5: Run the full suite — behavior must be frozen**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS with no test file modified. **If an existing test fails because it asserted
`settingsPath` flowing through the orchestrator, stop and report it** — that is the seam
moving, and the controller decides whether the assertion or the design gives way.

- [ ] **Step 6: Commit**

```bash
git add packages/providers/src/claude/adapter.ts apps/orchestrator/src/tick.ts apps/orchestrator/src/planning.ts apps/orchestrator/src/review.ts apps/orchestrator/src/cli.ts packages/control/src/paths.ts packages/providers/test/run-preparation.test.ts
git commit -m "refactor(providers): the adapter writes its own settings and hook wiring"
```

---

### Task 3: Pause routes through the adapter

**Files:**
- Modify: `packages/control/src/pause.ts:52` (stop writing the flag directly)
- Modify: `packages/control/src/emergency.ts` (fan-out goes through the adapter)
- Modify: `packages/providers/src/claude/adapter.ts` (`requestPause` writes the flag)
- Test: `packages/control/test/pause-through-adapter.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's capabilities, Task 2's adapter options.
- Produces: `requestPause(runId, reason)` is the only way pause is requested. Callers in
  `packages/control` receive an adapter (or a registry lookup, Task 5) rather than a path.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/control/test/pause-through-adapter.test.ts
import { describe, expect, it, vi } from 'vitest'
import { requestPause } from '../src/pause.js'

describe('requestPause', () => {
  it('asks the adapter to pause instead of writing the flag file itself', async () => {
    const adapter = {
      getCapabilities: () => ({
        canPauseMidRun: true,
        canResumeSession: true,
        gate: 'all-tools' as const,
        reportsCost: true,
      }),
      requestPause: vi.fn(async () => {}),
    }

    await requestPause({ runId: 'run-1', reason: 'operator', adapter })

    expect(adapter.requestPause).toHaveBeenCalledWith('run-1', 'operator')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/control/test/pause-through-adapter.test.ts`
Expected: FAIL — `requestPause` takes a path and calls `writeFileSync`.

- [ ] **Step 3: Implement the dispatch**

`ClaudeCodeAdapter.requestPause` writes the pause flag to the same path with the same
contents `pause.ts:52` writes today — the file on disk is byte-identical. `pause.ts` calls
the adapter. `emergency.ts`'s `pauseActiveRuns` fan-out follows the same route.

- [ ] **Step 4: Run the suite**

Run: `npm test && npm run typecheck`
Expected: PASS, no test file rewritten. Existing pause and emergency-stop integration tests
are the proof that the mechanism did not change.

- [ ] **Step 5: Commit**

```bash
git add packages/control/src/pause.ts packages/control/src/emergency.ts packages/providers/src/claude/adapter.ts packages/control/test/pause-through-adapter.test.ts
git commit -m "refactor(control): pause is requested through the adapter, not the filesystem"
```

---

### Task 4: `pump.ts` reads gate outcomes, not hook variants

**Files:**
- Modify: `apps/orchestrator/src/pump.ts:328,341,400-401`
- Create: `packages/providers/src/gate.ts`
- Test: `apps/orchestrator/test/gate-outcomes.test.ts` (create)

**Interfaces:**
- Produces:

```typescript
// packages/providers/src/gate.ts
/**
 * How a run's write gate ended, stated so the orchestrator never asks which
 * runtime produced it. A runtime with `gate: 'none'` produces neither.
 */
export type GateOutcome =
  | { readonly kind: 'stopped_by_gate'; readonly reason: string }
  | { readonly kind: 'gate_failed'; readonly detail: string }

export function classifyGateEvent(event: RuntimeEvent): GateOutcome | null
```

`classifyGateEvent` maps `hook_denied` to `stopped_by_gate`, and `hook_crashed` and
`hook_failed_open` to `gate_failed`. Everything else returns `null`.

**`permission_denied` is deliberately NOT a gate outcome** and keeps its existing handling in
`pump.ts`. It stops nothing and halts nothing — `pump.ts`'s own comment marks it "not a pause"
citing ADR 0001 — and it carries no `reason` to source one from. The defect this seam fixes is
narrower than "pump reads event variants": `RuntimeEvent` is already the provider-neutral
vocabulary, and any adapter may emit any variant. What must not stay Claude-shaped is the
*pause protocol* and the *workspace-halting circuit breaker*, which today are written in terms
of specific hook variants and so fall silently inert for a runtime whose gate differs. Say this
in the docstring, or the next reader will "fix" the omission.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/orchestrator/test/gate-outcomes.test.ts
import { describe, expect, it } from 'vitest'
import { classifyGateEvent } from '@ai-team-os/providers'

describe('classifyGateEvent', () => {
  it('reads a denial as the gate stopping the run', () => {
    expect(classifyGateEvent({ kind: 'hook_denied', hookName: 'pause-gate', reason: 'paused' }))
      .toEqual({ kind: 'stopped_by_gate', reason: 'paused' })
  })

  it('reads a crashed gate and a failed-open gate as gate failure', () => {
    expect(classifyGateEvent({ kind: 'hook_crashed', hookName: 'g', exitCode: 2, stderr: 'boom' }))
      .toMatchObject({ kind: 'gate_failed' })
    expect(classifyGateEvent({ kind: 'hook_failed_open', hookName: 'g', exitCode: 3, stderr: 'x' }))
      .toMatchObject({ kind: 'gate_failed' })
  })

  it('ignores events that say nothing about the gate', () => {
    expect(classifyGateEvent({ kind: 'text', text: 'hello' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run apps/orchestrator/test/gate-outcomes.test.ts`
Expected: FAIL — `classifyGateEvent` is not exported.

- [ ] **Step 3: Implement and rewire**

Write `gate.ts`, export it from `packages/providers/src/index.ts`, and replace the three
switch sites in `pump.ts` with `classifyGateEvent`. The workspace-halting behavior on
`gate_failed` is unchanged — only the question the code asks changes.

- [ ] **Step 4: Run the suite**

Run: `npm test && npm run typecheck`
Expected: PASS. `pump.ts`'s existing pause and gate-failure tests are the freeze proof.

- [ ] **Step 5: Commit**

```bash
git add packages/providers/src/gate.ts packages/providers/src/index.ts apps/orchestrator/src/pump.ts apps/orchestrator/test/gate-outcomes.test.ts
git commit -m "refactor(orchestrator): the pump reads gate outcomes, not hook variants"
```

---

### Task 5: The adapter registry

**Files:**
- Create: `packages/providers/src/registry.ts`
- Modify: `packages/providers/src/index.ts`
- Modify: `apps/orchestrator/src/cli.ts:131-136` (`buildAdapter`)
- Test: `packages/providers/test/registry.test.ts` (create)

**Interfaces:**
- Produces:

```typescript
/**
 * Mirrors the Prisma `ProviderKind` enum (`schema.prisma:202-205`) rather than importing it,
 * for the same reason `checkpoint.ts` mirrors its DB row: `packages/providers` does not
 * depend on `packages/db`. The two must be changed together; a member added to one and not
 * the other is a compile error at the registry's exhaustive switch.
 */
export type ProviderKind = 'claude_code' | 'cursor'

export interface AdapterSettings {
  readonly command?: string
  readonly extraArgs?: readonly string[]
}

export interface AdapterRegistry {
  /** Throws `UnknownProviderError` for a kind with no registered adapter. */
  resolve(kind: ProviderKind): AgentRuntimeAdapter
}

export function buildRegistry(options: {
  readonly claudeCode?: ClaudeCodeAdapterOptions
  readonly cursor?: CursorAdapterOptions   // registered in Task 12
}): AdapterRegistry
```

- [ ] **Step 1: Write the failing test**

```typescript
// packages/providers/test/registry.test.ts
import { describe, expect, it } from 'vitest'
import { buildRegistry } from '../src/index.js'

describe('buildRegistry', () => {
  it('resolves a configured kind to its adapter', () => {
    const registry = buildRegistry({ claudeCode: { command: 'claude', hookPath: '/tmp/g.sh' } })
    expect(registry.resolve('claude_code').id).toBe('claude-code')
  })

  it('refuses an unconfigured kind rather than falling back to Claude', () => {
    const registry = buildRegistry({ claudeCode: { command: 'claude', hookPath: '/tmp/g.sh' } })
    expect(() => registry.resolve('cursor')).toThrow(/cursor/)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/providers/test/registry.test.ts`
Expected: FAIL — `buildRegistry` is not exported.

- [ ] **Step 3: Implement, and replace `buildAdapter`**

`cli.ts` builds a registry instead of a single adapter and threads it through `deps`. Every
`deps.adapter.x(...)` call site (`tick.ts`, `planning.ts`, `review.ts`, `resume.ts`,
`sweep.ts:280`) becomes a registry lookup by the run's provider. Until Task 8 resolves a
real pair, every lookup passes `'claude_code'` — a single literal, in one helper, so Task 8
has exactly one line to change.

- [ ] **Step 4: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/providers/src/registry.ts packages/providers/src/index.ts apps/orchestrator/src/cli.ts apps/orchestrator/src/tick.ts apps/orchestrator/src/planning.ts apps/orchestrator/src/review.ts apps/orchestrator/src/resume.ts apps/orchestrator/src/sweep.ts packages/providers/test/registry.test.ts
git commit -m "feat(providers): an adapter registry replaces the hardcoded runtime"
```

---

## Series B — The Pair

### Task 6: The schema learns about providers

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (`Agent:122`, `AgentTemplate:145`,
  `CompanyAgent:186`, `AgentRun:348`, `Checkpoint`)
- Create: `packages/db/prisma/migrations/<timestamp>_m12_provider_pair/migration.sql`
- Modify: `packages/providers/src/claude/checkpoint.ts` (the mirrored `Checkpoint`)
- Test: `packages/db/test/integration/provider-schema.test.ts` (create)

**Interfaces:**
- Produces: nullable `provider ProviderKind?` on `Agent`, `AgentTemplate`, `CompanyAgent`,
  `AgentRun`, `Checkpoint`; `AgentRun.costUsd` becomes `Float?`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/db/test/integration/provider-schema.test.ts
import { describe, expect, it } from 'vitest'
import { prisma } from './helpers.js'   // the existing integration harness

describe('the provider pair columns', () => {
  it('accepts a null cost — an unmeasured run is not a free one', async () => {
    // Build the run through the harness's existing workspace/agent factory, then assert the
    // two columns this migration touches. Reuse whatever `seedWorkspaceWithAgent` the
    // integration helpers already expose rather than hand-rolling the FK chain.
    const { agentId } = await seedWorkspaceWithAgent()
    const run = await prisma.agentRun.create({
      data: { agentId, kind: 'implementation', status: 'running', costUsd: null },
    })
    expect(run.costUsd).toBeNull()
    expect(run.provider).toBeNull()
  })

  it('keeps every pre-M12 row readable with a null provider', async () => {
    const agent = await prisma.agent.findFirst()
    expect(agent === null || agent.provider === null || typeof agent.provider === 'string').toBe(true)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/db/test/integration/provider-schema.test.ts`
Expected: FAIL — `costUsd` is `Float @default(0)` and rejects null; `provider` does not exist.

- [ ] **Step 3: Write the migration**

```sql
-- additive: new columns are nullable, and costUsd only loses its NOT NULL.
ALTER TABLE "Agent"         ADD COLUMN "provider" "ProviderKind";
ALTER TABLE "AgentTemplate" ADD COLUMN "provider" "ProviderKind";
ALTER TABLE "CompanyAgent"  ADD COLUMN "provider" "ProviderKind";
ALTER TABLE "AgentRun"      ADD COLUMN "provider" "ProviderKind";
ALTER TABLE "Checkpoint"    ADD COLUMN "provider" "ProviderKind";
ALTER TABLE "AgentRun"      ALTER COLUMN "costUsd" DROP NOT NULL;
ALTER TABLE "AgentRun"      ALTER COLUMN "costUsd" DROP DEFAULT;
```

Existing rows keep their `costUsd` values. Dropping the default is what stops a future insert
from silently recording zero for an unmeasured run.

- [ ] **Step 4: Mirror it in the providers' `Checkpoint`**

Add `readonly provider?: ProviderKind` to the interface in `checkpoint.ts`, beside `model`,
with a comment pointing at the same duplication ruling its docstring already carries.

- [ ] **Step 5: Remove Task 1's marker**

Delete the `?? 0` and its `// TASK 6:` comment at `pump.ts:552`; write `outcome.costUsd`
through as-is.

- [ ] **Step 6: Run the gate**

Run: `npm run db:migrate:test && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations packages/providers/src/claude/checkpoint.ts apps/orchestrator/src/pump.ts packages/db/test/integration/provider-schema.test.ts
git commit -m "feat(db): provider columns and a cost that can be unknown"
```

---

### Task 7: Refusals and paired writes

**Files:**
- Modify: `packages/control/src/refusal.ts:30-31,72-75`
- Modify: `packages/control/src/org.ts` (`addCompanyAgent`, `setAgentModel`, template creation)
- Test: `packages/control/test/integration/org.test.ts` (extend — additions only)

**Interfaces:**
- Consumes: Task 6's columns.
- Produces: `ControlRefusal` gains `{ kind: 'model_without_provider' }`,
  `{ kind: 'invalid_provider'; provider: string }`,
  `{ kind: 'unmeasurable_budget'; workspaceId: string; provider: string }`.
  `setAgentModel` takes `{ model: string | null, provider: ProviderKind | null }`.

- [ ] **Step 1: Write the failing tests**

```typescript
// added to packages/control/test/integration/org.test.ts
it('refuses a model with no provider to run it', async () => {
  const result = await setAgentModel({ agentId, model: 'some-model', provider: null })
  expect(result).toEqual({ ok: false, refusal: { kind: 'model_without_provider' } })
})

it('refuses a provider kind nothing is configured for', async () => {
  const result = await setAgentModel({ agentId, model: 'm', provider: 'nope' as never })
  expect(result).toMatchObject({ ok: false, refusal: { kind: 'invalid_provider' } })
})

it('clears both halves of the pair together', async () => {
  const result = await setAgentModel({ agentId, model: null, provider: null })
  expect(result).toMatchObject({ ok: true })
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
  expect(agent.model).toBeNull()
  expect(agent.provider).toBeNull()
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/control/test/integration/org.test.ts`
Expected: FAIL — `setAgentModel` has no `provider` parameter.

- [ ] **Step 3: Add the refusal texts, verbatim**

```typescript
// packages/control/src/refusal.ts — in the existing switch
case 'model_without_provider':
  return 'a model must name the provider that runs it'
case 'invalid_provider':
  return 'a provider must be a configured kind'
case 'unmeasurable_budget':
  return 'a budget needs a provider that reports cost'
```

- [ ] **Step 4: Write the pair, or neither**

In `org.ts`, every site that writes a model writes the provider beside it, in the same
transaction. Setting one without the other is `model_without_provider`; clearing sets both to
`null`. Guards run before writes, mirroring the existing `invalid_model` placement.

- [ ] **Step 5: Run the suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/control/src/refusal.ts packages/control/src/org.ts packages/control/test/integration/org.test.ts
git commit -m "feat(control): a model and its provider are written as one"
```

---

### Task 8: `resolveRuntime` replaces `resolveModel`

**Files:**
- Modify: `apps/orchestrator/src/model.ts:8-16`
- Modify: `apps/orchestrator/src/tick.ts:463`, `planning.ts:284`, `review.ts:311`
- Test: `apps/orchestrator/test/resolve-runtime.test.ts` (create)

**Interfaces:**
- Produces:

```typescript
export interface ResolvedRuntime {
  readonly provider: ProviderKind
  readonly model: string | undefined
}

/**
 * The pair comes from ONE level: the first level that names a model supplies the provider
 * with it. Mixing levels is what makes an incompatible pair expressible, so it is not done.
 */
export function resolveRuntime(
  worker: {
    readonly model: string | null
    readonly provider: ProviderKind | null
    readonly companyAgent: {
      readonly model: string | null
      readonly provider: ProviderKind | null
      readonly template: { readonly defaultModel: string | null; readonly provider: ProviderKind | null }
    } | null
  },
  workspaceDefault: ProviderKind,
): ResolvedRuntime
```

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/orchestrator/test/resolve-runtime.test.ts
import { describe, expect, it } from 'vitest'
import { resolveRuntime } from '../src/model.js'

const template = (defaultModel: string | null, provider: 'claude_code' | 'cursor' | null) =>
  ({ defaultModel, provider })

describe('resolveRuntime', () => {
  it('takes both halves from the worker when the worker names a model', () => {
    expect(resolveRuntime(
      { model: 'w', provider: 'cursor', companyAgent: { model: 'c', provider: 'claude_code', template: template('t', 'claude_code') } },
      'claude_code',
    )).toEqual({ provider: 'cursor', model: 'w' })
  })

  it('falls to the roster row as a whole, never mixing the worker provider with the roster model', () => {
    expect(resolveRuntime(
      { model: null, provider: null, companyAgent: { model: 'c', provider: 'cursor', template: template('t', 'claude_code') } },
      'claude_code',
    )).toEqual({ provider: 'cursor', model: 'c' })
  })

  it('falls to the template, then to the workspace default with no model', () => {
    expect(resolveRuntime(
      { model: null, provider: null, companyAgent: { model: null, provider: null, template: template('t', 'cursor') } },
      'claude_code',
    )).toEqual({ provider: 'cursor', model: 't' })

    expect(resolveRuntime({ model: null, provider: null, companyAgent: null }, 'cursor'))
      .toEqual({ provider: 'cursor', model: undefined })
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run apps/orchestrator/test/resolve-runtime.test.ts`
Expected: FAIL — `resolveRuntime` is not exported.

- [ ] **Step 3: Read the workspace default from `ProviderConfiguration`**

The chain's last link is the workspace, and it lives in the table M3 created and nothing has
read since (`schema.prisma:246-255`). Add the reader beside the other workspace loads:

```typescript
/**
 * The workspace's default runtime. `ProviderConfiguration` is unique on
 * (workspaceId, kind); a workspace with exactly one row uses that kind. A workspace with
 * none has no default -- dispatch refuses with `invalid_provider` rather than assuming
 * Claude, because a silent fallback is how the wrong runtime bills someone's budget.
 */
export async function workspaceDefaultProvider(
  workspaceId: string,
): Promise<{ kind: ProviderKind; settings: AdapterSettings } | null>
```

Its `settings` JSON (`{ command?: string, extraArgs?: string[] }`) is passed to the registry
lookup so a workspace can point at its own binary. Test it: a workspace with a row resolves
to that kind; a workspace with none yields `null` and the dispatch site refuses.

- [ ] **Step 4: Implement, and feed the registry**

Each dispatch site resolves the pair once, passes `model` to `adapter.start` as today, and
uses `provider` for the registry lookup — replacing the `'claude_code'` literal Task 5 left in
one helper. `pump.ts`'s `spawn` carries the provider so the checkpoint records it.

- [ ] **Step 5: Run the gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/model.ts apps/orchestrator/src/world.ts apps/orchestrator/src/tick.ts apps/orchestrator/src/planning.ts apps/orchestrator/src/review.ts apps/orchestrator/src/pump.ts apps/orchestrator/test/resolve-runtime.test.ts
git commit -m "feat(orchestrator): a run resolves a provider and a model together"
```

---

## Series C — Cost Honesty

### Task 9: An unmeasurable budget is refused, and unknown is not zero

**Files:**
- Modify: `apps/orchestrator/src/world.ts:164,208` (the budget sum and guardrail)
- Modify: `packages/control/src/org.ts` (`assignCompany` and the budget write)
- Modify: `apps/web/src/server/overview.ts:151-164,173`, `org.ts:27-34`, `tasks.ts:61`,
  `graph.ts:121`
- Test: `apps/orchestrator/test/budget-admission.test.ts` (create), and additions to
  `apps/web/test/integration/server-org.test.ts`

**Interfaces:**
- Consumes: Task 1's `reportsCost`, Task 7's `unmeasurable_budget`, Task 8's `resolveRuntime`.
- Produces: cost reaches the web as `number | null`; `overview.ts` stops hardcoding
  `provider: 'claude-code'` and reports the run's actual provider. Two new functions in
  `apps/orchestrator/src/world.ts`:

```typescript
/** Known spend and how many runs could not be measured. Never folds `null` into the total. */
export function sumSpend(
  runs: readonly { readonly costUsd: number | null }[],
): { readonly known: number; readonly unknownRuns: number }

/**
 * May this run start? A budgeted workspace will not accept a runtime that cannot report
 * what it spends -- the guardrail is real or it is absent, never silently inert.
 */
export function admitRun(input: {
  readonly workspace: { readonly budgetUsd: number | null }
  readonly capabilities: Pick<ProviderCapabilities, 'reportsCost'>
}): { readonly ok: true } | { readonly ok: false; readonly refusal: ControlRefusal }
```

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/orchestrator/test/budget-admission.test.ts
describe('budget admission', () => {
  it('refuses to dispatch a cost-blind provider into a budgeted workspace', async () => {
    const result = await admitRun({ workspace: { budgetUsd: 20 }, capabilities: { reportsCost: false } })
    expect(result).toMatchObject({ ok: false, refusal: { kind: 'unmeasurable_budget' } })
  })

  it('admits a cost-blind provider when the workspace has no budget', async () => {
    const result = await admitRun({ workspace: { budgetUsd: null }, capabilities: { reportsCost: false } })
    expect(result).toMatchObject({ ok: true })
  })

  it('never counts an unknown cost as zero when summing spend', () => {
    expect(sumSpend([{ costUsd: 1.5 }, { costUsd: null }])).toEqual({ known: 1.5, unknownRuns: 1 })
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run apps/orchestrator/test/budget-admission.test.ts`
Expected: FAIL — `admitRun` and `sumSpend` do not exist.

- [ ] **Step 3: Implement both gates**

Write-time: `org.ts` refuses assigning a cost-blind provider to a workspace with a
`budgetUsd`, and refuses setting a `budgetUsd` on a workspace already resolved to one.
Dispatch-time: `world.ts` re-checks before starting a run. `sumSpend` returns known spend and
a count of unmeasured runs; the guardrail compares known spend against the budget and never
treats `null` as `0`.

- [ ] **Step 4: Surface the difference**

Every web reader returns `costUsd: number | null` unchanged; the M11 pages render `—` (the
existing unknown mark used by the Roster) rather than `$0.00`. `overview.ts:173` reports the
run's real provider.

- [ ] **Step 5: Run the gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/world.ts packages/control/src/org.ts apps/web/src/server apps/orchestrator/test/budget-admission.test.ts apps/web/test/integration/server-org.test.ts
git commit -m "feat: an unmeasurable budget is refused and an unknown cost stays unknown"
```

---

## Series D — The Cursor Runtime

### Task 10: The Cursor stream parser

**Files:**
- Create: `packages/providers/src/cursor/stream.ts`
- Create: `packages/providers/test/fixtures/cursor-run.ndjson`
- Test: `packages/providers/test/cursor-stream.test.ts` (create)

**Interfaces:**
- Produces: `parseCursorLine(line: string): RuntimeEvent` — total, pure, mirroring
  `packages/providers/src/claude/stream.ts:26-59`.

Mapping (spec §7): `system` init → `session_started` (from `session_id`); `assistant` →
`text`; `tool_call` → `tool_call`; `result` → `terminated`. On the `result` line:
`isError` from `is_error`, `terminalReason` from `subtype`, `costUsd: null`,
`stopReason: null`, and `numTurns` **derived** by counting assistant messages seen.

- [ ] **Step 1: Record a real fixture**

Run `cursor-agent` once, non-interactively, with `--output-format stream-json` on a trivial
prompt in a scratch directory, and save the NDJSON verbatim to the fixture path. Record the
exact command in the task report — the fixture's provenance is what makes the test evidence.

- [ ] **Step 2: Write the failing tests**

```typescript
// packages/providers/test/cursor-stream.test.ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseCursorLine } from '../src/cursor/stream.js'

const lines = readFileSync(new URL('./fixtures/cursor-run.ndjson', import.meta.url), 'utf8')
  .split('\n').filter(Boolean)

describe('parseCursorLine', () => {
  it('reads the session id off the init line', () => {
    expect(parseCursorLine(lines[0])).toMatchObject({ kind: 'session_started' })
  })

  it('reports an unknown cost on the terminal line rather than zero', () => {
    const terminal = parseCursorLine(lines[lines.length - 1])
    expect(terminal).toMatchObject({ kind: 'terminated' })
    expect(terminal.outcome.costUsd).toBeNull()
    expect(terminal.outcome.stopReason).toBeNull()
  })

  it('returns unparsable for a truncated line rather than throwing', () => {
    expect(parseCursorLine('{"type":"resu')).toMatchObject({ kind: 'unparsable' })
  })

  it('returns ignored for a recognized line it does not act on', () => {
    expect(parseCursorLine(JSON.stringify({ type: 'user', message: {} }))).toMatchObject({ kind: 'ignored' })
  })
})
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run packages/providers/test/cursor-stream.test.ts`
Expected: FAIL — `parseCursorLine` does not exist.

- [ ] **Step 4: Implement the parser**

Total function: every line returns a `RuntimeEvent`, never throws. Document the `numTurns`
derivation at the parse site as a fidelity gap — Cursor reports no turn count, and the
derived figure must never be presented as a reported one.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/providers/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/providers/src/cursor/stream.ts packages/providers/test/cursor-stream.test.ts packages/providers/test/fixtures/cursor-run.ndjson
git commit -m "feat(providers): the Cursor stream parser"
```

---

### Task 11: Cursor's flags and its shell gate

**Files:**
- Create: `packages/providers/src/cursor/flags.ts`
- Create: `scripts/cursor-shell-gate.sh`
- Test: `packages/providers/test/cursor-flags.test.ts` (create)

**Interfaces:**
- Produces: `cursorFlags(input): string[]` — mirrors `claudeFlags` at
  `packages/providers/src/claude/flags.ts:27-43`.

**These flags are verified against the installed binary** (`cursor-agent --help`, 2026-08-25),
not taken from vendor docs:

- `--print` — **mandatory**. `--output-format` "only works with --print"; without it the
  agent runs interactively and the stream parser receives nothing it can read.
- `--output-format stream-json` — the NDJSON Task 10 parses.
- `--force` — Cursor's equivalent of Claude's `--permission-mode bypassPermissions`: "Force
  allow commands unless explicitly denied". The trailing clause is load-bearing — it is what
  keeps the hook's `permission: "deny"` effective, so the write gate survives this flag.
- `--model <model>` only when a model resolved; omitted entirely otherwise, no sentinel.
- `--resume <sessionId>` on resume.
- **Never `-w`/`--worktree`.** Cursor has its own worktree feature; this system already
  manages worktrees and a second one under `~/.cursor/worktrees/` would split the run.

The gate is a `beforeShellExecution` hook. **Cursor has no `--settings`-style flag**: unlike
Claude, which takes a per-run absolute settings path, Cursor reads `.cursor/hooks.json` from
the workspace. Per-run isolation therefore comes from the run's own worktree — the adapter
writes `.cursor/hooks.json` into `worktreePath` (Task 12) and passes the pause-flag path to
the hook process by environment variable. The script reads that variable, and when the flag
file exists prints `{"permission":"deny","userMessage":"paused"}` on stdout and exits 0. Its
deny/allow contract is documented in a header comment the way `scripts/pause-gate.sh:1-24`
documents Claude's.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/providers/test/cursor-flags.test.ts
import { describe, expect, it } from 'vitest'
import { cursorFlags } from '../src/cursor/flags.js'

describe('cursorFlags', () => {
  it('always streams structured output', () => {
    expect(cursorFlags({ prompt: 'x' })).toContain('--output-format')
    expect(cursorFlags({ prompt: 'x' })).toContain('stream-json')
  })

  it('passes a resolved model and omits the flag entirely when there is none', () => {
    expect(cursorFlags({ prompt: 'x', model: 'm' })).toContain('--model')
    expect(cursorFlags({ prompt: 'x' })).not.toContain('--model')
  })

  it('continues a session by id on resume', () => {
    expect(cursorFlags({ prompt: 'x', resumeSessionId: 's-1' }).join(' ')).toContain('--resume s-1')
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/providers/test/cursor-flags.test.ts`
Expected: FAIL — `cursorFlags` does not exist.

- [ ] **Step 3: Implement flags and the gate script**

- [ ] **Step 4: Prove the gate script denies and allows**

Run it directly, twice, the way `preflightGate` proves Claude's:

```bash
PAUSE_FLAG=/tmp/absent  bash scripts/cursor-shell-gate.sh   # expect: no deny
touch /tmp/present && PAUSE_FLAG=/tmp/present bash scripts/cursor-shell-gate.sh   # expect: {"permission":"deny",...}
```

Record both outputs in the task report.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/providers/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/providers/src/cursor/flags.ts scripts/cursor-shell-gate.sh packages/providers/test/cursor-flags.test.ts
git commit -m "feat(providers): Cursor's flags and its shell-scoped write gate"
```

---

### Task 12: The Cursor adapter

**Files:**
- Create: `packages/providers/src/cursor/adapter.ts`
- Modify: `packages/providers/src/registry.ts`, `packages/providers/src/index.ts`
- Modify: `apps/orchestrator/src/cli.ts` (register the kind)
- Test: `packages/providers/test/cursor-adapter.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 10 and 11.
- Produces: `class CursorAdapter implements AgentRuntimeAdapter` with `id = 'cursor'` and
  `CursorAdapterOptions { command, gatePath, extraArgs?, killGraceMs? }`.

Capabilities — each **verified against the installed binary**, conservative when unproven:
`{ canPauseMidRun: false, canResumeSession: true, gate: 'shell-only', reportsCost: false }`.

Pause strategy: `requestPause` cancels the process and lets `pump.ts` write the checkpoint
carrying `sessionId` and `provider`; `awaitPause` resolves `'paused'` once the process is
gone, `'finished_first'` if it terminated on its own. `resume` starts a new process with
`--resume <sessionId>`.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/providers/test/cursor-adapter.test.ts
describe('CursorAdapter', () => {
  it('cannot pause mid-run but can resume a session', () => {
    expect(new CursorAdapter({ command: '/bin/true', gatePath: '/tmp/g.sh' }).getCapabilities())
      .toEqual({ canPauseMidRun: false, canResumeSession: true, gate: 'shell-only', reportsCost: false })
  })

  it('pauses by cancelling, and reports paused once the process is gone', async () => {
    const adapter = new CursorAdapter({ command: '/bin/sleep', extraArgs: ['30'], gatePath: '/tmp/g.sh' })
    const handle = await adapter.start({ runId: 'r1', prompt: 'x', worktreePath: dir, pauseFlagPath: flag, gitIdentity })
    await adapter.requestPause('r1', 'operator')
    await expect(adapter.awaitPause('r1', { deadlineMs: 5_000 })).resolves.toBe('paused')
    expect(() => process.kill(handle.pid, 0)).toThrow()
  })

  it('continues a session on resume', async () => {
    // `/bin/echo` makes the spawned argv observable: the adapter's own stdout carries it.
    const adapter = new CursorAdapter({ command: '/bin/echo', gatePath: '/tmp/g.sh' })
    const checkpoint = { ...baseCheckpoint, sessionId: 's-1', provider: 'cursor' as const }
    await adapter.resume('r1', checkpoint, null)

    const argv = []
    for await (const event of adapter.events('r1')) {
      if (event.kind === 'text') argv.push(event.text)
      if (event.kind === 'terminated') break
    }
    expect(argv.join(' ')).toContain('--resume s-1')
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/providers/test/cursor-adapter.test.ts`
Expected: FAIL — `CursorAdapter` does not exist.

- [ ] **Step 3: Implement the adapter and register the kind**

- [ ] **Step 4: Verify every capability against the real binary**

For each of the four, run `cursor-agent` and record the evidence in the task report: the
`--help` line or the observed stream behavior that proves it. A capability you cannot prove
takes its conservative value and the report says why.

- [ ] **Step 5: Run the gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/providers/src/cursor packages/providers/src/registry.ts packages/providers/src/index.ts apps/orchestrator/src/cli.ts packages/providers/test/cursor-adapter.test.ts
git commit -m "feat(providers): the Cursor adapter — cancel-based pause, session resume"
```

---

## Series E — Surfaces and the Gate

### Task 13: Provider on the M11 surfaces

**Files:**
- Modify: `apps/web/src/components/TemplateCatalog.tsx` (provider beside `defaultModel`)
- Modify: `apps/web/src/components/ModelOverrideEditor.tsx` (a pair editor)
- Modify: `apps/web/src/components/RosterTable.tsx` (provider and its gate mark)
- Modify: `apps/web/src/components/CompanyManager.tsx` (provider beside the member `model`)
- Modify: `apps/web/src/app/api/org/templates/route.ts`,
  `apps/web/src/app/api/agents/[agentId]/model/route.ts`,
  `apps/web/src/app/api/org/agents/route.ts`
- Modify: `scripts/gate-m11-shell.mjs` (stage 4 sets a model through the Roster editor and has
  been RED since Task 7 -- send the provider with it and delete the KNOWN RED comment there)
- Test: `apps/web/test/settings-page.test.tsx`, `apps/web/test/agents-page.test.tsx` (extend)

**Interfaces:**
- Consumes: Task 7's route bodies and refusal texts, Task 9's nullable cost.
- Produces: all THREE routes accept `{ model, provider }` and reject one without the other with
  the verbatim refusal text.

**Why the list grew (M12 Task 7 review, blocking findings 1 and 2):** Task 7 made a bare model
unwritable, which dead-ends three shipped UI flows at a 409 until this task lands -- the Roster
model override, the template `defaultModel`, and *adding a roster member with a model*
(`CompanyManager.tsx` -> `POST /api/org/agents`). The third was missing from this list, so that
flow would have stayed broken after Task 13 shipped. `scripts/gate-m11-shell.mjs` was missing for
the same reason: it drives the Roster editor in a real browser and asserts the DB column, so
`npm run gate:m11-shell` is red until this task repairs it. Neither is optional cleanup; both are
this task finishing the rollout Task 7 started.

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/web/test/agents-page.test.tsx
it('submits the model and its provider together', async () => {
  render(<RosterTable workers={[worker]} />)
  await user.selectOptions(screen.getByLabelText('provider'), 'cursor')
  await user.type(screen.getByLabelText('model override'), 'some-model')
  await user.click(screen.getByTestId('model-override-set'))
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/model'), expect.objectContaining({
    body: JSON.stringify({ model: 'some-model', provider: 'cursor' }),
  }))
})

it('shows the refusal text verbatim when a model arrives without a provider', async () => {
  fetchMock.mockResolvedValueOnce(json(409, { refusal: 'a model must name the provider that runs it' }))
  render(<RosterTable workers={[worker]} />)
  await user.type(screen.getByLabelText('model override'), 'some-model')
  await user.click(screen.getByTestId('model-override-set'))

  expect(await screen.findByText('a model must name the provider that runs it')).toBeInTheDocument()
  // M11's idiom: a refused write keeps what the operator typed.
  expect(screen.getByLabelText('model override')).toHaveValue('some-model')
})

it('marks a shell-only gate on the roster row', () => {
  render(<RosterTable workers={[{ ...worker, provider: 'cursor', gate: 'shell-only' }]} />)
  expect(screen.getByText(/shell only/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run apps/web/test/agents-page.test.tsx`
Expected: FAIL — there is no provider control.

- [ ] **Step 3: Implement the pair controls**

Follow M11's idioms exactly: `router.refresh()` after mutation, no optimistic state, 409
keeps the input, existing test-ids unchanged, new controls get `aria-label`s.

- [ ] **Step 4: Run the gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components apps/web/src/app/api apps/web/test
git commit -m "feat(web): the roster and the catalog name a provider beside the model"
```

---

### Task 14: The measured gate

**Files:**
- Create: `scripts/gate-m12-providers.mjs`
- Modify: `package.json` (script `"gate:m12-providers": "tsc --build && node --env-file=.env scripts/gate-m12-providers.mjs"`),
  `README.md` (the row: `The M12 gate: two runtimes kept one promise — paused, resumed, and budgeted alike`)

Follow `scripts/gate-m11-shell.mjs`'s skeleton: all-in-`try`, bounded waits, preflight cleanup
of prior `M12 Gate`-named rows, FK-ordered cleanup and process kill in `finally`,
`process.exit(exitCode)`. Fail fast with a clear message when `cursor-agent` is absent — the
gate never skips.

- [ ] **Step 1: Write the script complete** (no RED phase — the script is the assertion)

Stages, all asserted against the DB, not just the process:

1. One workspace, two workers: one resolved to `claude_code`, one to `cursor`.
2. Both runs reach a terminal state and write the same event and checkpoint shape.
3. Pause lands on both — hook on Claude, cancel on Cursor — and both resume and continue.
4. A budgeted workspace refuses the cost-blind provider with the exact text
   `a budget needs a provider that reports cost`.
5. `AgentRun.costUsd` is `null` for the Cursor run and a real number for the Claude run.

- [ ] **Step 2: Run `npm run gate:m12-providers` to PASS**

Expected final line: `PASS: two providers kept one promise`, exit 0. Product-shaped failures
→ STOP and report BLOCKED.

- [ ] **Step 3: package.json + README**

- [ ] **Step 4: Full gate**

Run: `npm test && npm run typecheck && npm run web:build`

- [ ] **Step 5: Commit**

```bash
git add scripts/gate-m12-providers.mjs package.json README.md
git commit -m "docs(m12): the two-runtime measured gate and README coverage"
```

---

## After the plan

M12 turns a contract with one implementation into a seam with two. Deferred beyond M12 and
recorded in the M11 backlog: the global `AgentRun` spend scan, the `sweep.test.ts` timing
flake, an auth/origin story before any non-loopback binding, and the spec §3 new-row rise.
Deferred by this spec: API-based adapters, failover chains, pricing tables, and providers
whose runs are not local child processes.
