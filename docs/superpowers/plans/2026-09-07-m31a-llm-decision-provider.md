# M31a LLM Decision Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A simulation whose purchasing decisions come from a Claude model, stepped by the daemon in two phases (decide outside any transaction, apply under the row lock), with the model provably unable to reach any tool, every call's real cost recorded, a cap that halts the run, and no real call in any test or gate.

**Architecture:** `packages/providers` gains `decideWithModel` (a zero-tool `claude -p --restricted --strict-mcp-config --tools ""` call with a deny-all hook, minimal env, empty cwd, stdin prompt). `packages/simulation` gains the pure prompt builder, the JSON-array extractor, an `LlmDecisionProvider` fed with parsed envelopes, and a `CompositeDecisionProvider`. `packages/control` gains `prepareModelDecision` / `applyModelDecision` and a `modelDecider` injection point on `tickSimulations`; it never imports providers. The daemon injects the decider. The engine is untouched.

**Tech Stack:** TypeScript (NodeNext, strict), zod 3, Prisma 7, Next.js app router, vitest, playwright-core; the Claude Code CLI ≥ 2.1 (`--restricted`, `--strict-mcp-config`, `--max-budget-usd`).

**Spec:** `docs/superpowers/specs/2026-09-07-m31a-llm-decision-provider-design.md` (M29 §2/§8 and M30 §2 stay binding).

## Global Constraints

- The model process is spawned ONLY by `decideWithModel` in `packages/providers`, ONLY from the orchestrator daemon; `packages/control/src/simulation/*` imports no providers (the decider is an injected function); `apps/web` spawns nothing.
- The spawn: `[...extraArgs, '-p', '--restricted', '--strict-mcp-config', '--tools', '', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--model', model, '--max-budget-usd', String(cap), '--settings', settingsPath]`, prompt on stdin, `cwd` a fresh temp dir, `env` exactly `{ PATH, HOME, LANG, TERM }`. Any `tool_call` event in the stream is an isolation breach: the answer is discarded, the run halts.
- Two-phase step: no DB transaction is open during the model call; `applyModelDecision` writes the usage row first, then checks `version`/status, then applies through `stepLocked` with a `CompositeDecisionProvider`.
- Cost honesty: `SimulationModelUsage.costUsd` is the CLI's `total_cost_usd` or `null`; the page never shows `$0.00` for an unmeasured call; the cap compares `sum(costUsd)` to `maxModelCostUsd` and halts with `model budget exhausted`.
- `decisionProvider` defaults to `rules`; an `llm` run requires `modelProvider: 'claude_code'`, a `model`, a `maxModelCostUsd > 0`, and (in the UI) a checked consent box.
- No test, CI job or gate makes a real model call: the fake CLI `packages/providers/test/fake-claude.mjs` with new fixtures `decision.ndjson` / `decision-breach.ndjson` stands in, selected through `SLAVEOFAI_CLAUDE_BIN=node` + `SLAVEOFAI_CLAUDE_ARGS="<fake> --fixture <name>"` as the CLI test already does.
- One vitest at a time; before "green": `npm run --silent typecheck` (not `tsc --build`), then `npm run web:build` (never while `next dev` runs); vocabulary gate green (noun `slave`).
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_015LdvAE5MLjx54f8H1WJvLx`.

## What the real calls established (spec §1 and §12; no task repeats them)

Four real calls on 2026-09-07 (haiku, ≈ $0.23 total): `--tools ""` alone leaves the user's MCP servers attached (the hook denied them); `--restricted --strict-mcp-config --tools ""` yields `tools: []`, `mcp_servers: []`, zero `tool_use`, zero hook invocations, one turn, $0.0038, and an answer that contains hallucinated `<function_calls>` prose BEFORE the JSON array — so `parseEnvelopes` must extract the array from surrounding text, not parse the whole answer.

## File structure

```
scripts/deny-all-gate.sh                                    the deny-everything PreToolUse hook (sh, one printf)
packages/providers/src/claude/decision.ts                   decideWithModel, preflightDenyAll, decisionArgs
packages/providers/src/index.ts                             export decision.js
packages/providers/test/fixtures/decision.ndjson, decision-breach.ndjson
packages/providers/test/claude-decision.test.ts
packages/simulation/src/decide/provider.ts                  kind gains 'llm'
packages/simulation/src/decide/llm.ts                       LlmDecisionProvider, CompositeDecisionProvider
packages/simulation/src/decide/llm-prompt.ts                buildDecisionPrompt, parseEnvelopes, TRADE_ACTION_DOCS (from trade)
packages/simulation/src/trade/action-docs.ts                TRADE_ACTION_DOCS
packages/simulation/test/decide/llm.test.ts
packages/db/prisma/schema.prisma + migrations/20260907090000_m31a_llm_decision_provider/migration.sql
packages/control/src/refusal.ts                             + llm_steps_in_daemon, unsupported_model_provider
packages/control/src/simulation/{shared,write,auto-run}.ts  summary fields, create input, step refusal, modelDecider on tickSimulations
packages/control/src/simulation/llm.ts                      prepareModelDecision, applyModelDecision, ModelDecider type
packages/control/test/integration/llm.test.ts
apps/orchestrator/src/daemon.ts, cli.ts                     modelDecider injection; create flags; status fields
apps/web/src/components/sim/NewSimulationDrawer.tsx, SimulationClient.tsx, SimulationStrip.tsx, SimulationsClient.tsx, apps/web/src/server/simulation.ts
scripts/gate-m31a-llm-decisions.mjs, package.json, .github/workflows/ci.yml, README.md, spec §12
```

---

### Task 1: The deny-all hook, `decideWithModel`, the fixtures

**Files:**
- Create: `scripts/deny-all-gate.sh`, `packages/providers/src/claude/decision.ts`, `packages/providers/test/fixtures/decision.ndjson`, `packages/providers/test/fixtures/decision-breach.ndjson`, `packages/providers/test/claude-decision.test.ts`
- Modify: `packages/providers/src/index.ts`, `packages/providers/test/fake-claude.mjs` (only if a fixture needs a new mode — it should not: `--fixture decision` replays the file)

**Interfaces:**
- Produces:
```ts
export interface ModelDecisionInput { readonly command: string; readonly extraArgs?: readonly string[]; readonly model: string; readonly prompt: string; readonly maxBudgetUsd: number; readonly hookPath: string; readonly timeoutMs?: number }
export type ModelDecisionOutcome =
  | { readonly kind: 'answer'; readonly text: string; readonly costUsd: number | null; readonly tokens: { readonly input: number; readonly output: number } | null; readonly numTurns: number }
  | { readonly kind: 'isolation_breach'; readonly tools: readonly string[]; readonly costUsd: number | null; readonly tokens: { readonly input: number; readonly output: number } | null }
  | { readonly kind: 'failed'; readonly reason: string; readonly costUsd: number | null; readonly tokens: { readonly input: number; readonly output: number } | null }
export function decisionArgs(input: { extraArgs?: readonly string[]; model: string; maxBudgetUsd: number; settingsPath: string }): readonly string[]
export async function preflightDenyAll(input: { hookPath: string }): Promise<void>   // throws unless the hook answers deny with AND without the pause flag
export async function decideWithModel(input: ModelDecisionInput): Promise<ModelDecisionOutcome>
export const DEFAULT_MODEL_TIMEOUT_MS = 120_000
```

- [ ] **Step 1: Fixtures and the failing tests**

`scripts/deny-all-gate.sh` (executable):
```sh
#!/usr/bin/env sh
# The PreToolUse hook a simulation's model call registers (M31a §4): every tool call is denied,
# whatever the tool, whatever the pause flag. The model must reach nothing; `--restricted
# --strict-mcp-config --tools ""` already gives it no tools, and this is the second lock.
cat > /dev/null
printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"simulation actors get no tools"}}'
exit 0
```
`packages/providers/test/fixtures/decision.ndjson` — three lines (copy the exact key set from `complete.ndjson`'s `system`/`assistant`/`result` lines and change only these values): a `system`/`init` line with `"tools":[]` and `"mcp_servers":[]`; an `assistant` line whose `content` is `[{"type":"text","text":"Some prose first.\n```json\n[{\"type\":\"place_purchase\",\"params\":{\"supplierId\":\"fast\",\"qty\":50},\"rationale\":\"order-2 at risk\",\"refs\":[\"order-2\"]}]\n```"}]`; a `result` line with `"num_turns":1`, `"total_cost_usd":0.0038`, `"usage":{"input_tokens":900,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":120}`, `"result":"<same text>"`.
`decision-breach.ndjson` — the same `system` line, an `assistant` line with `content: [{"type":"tool_use","id":"toolu_x","name":"Bash","input":{"command":"ls"}}]`, then the `assistant` text line above, then the `result` line with `"num_turns":3`, `"total_cost_usd":0.0121`.

`packages/providers/test/claude-decision.test.ts`:
```ts
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decideWithModel, decisionArgs, preflightDenyAll } from '../src/claude/decision.js'

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))
const HOOK = fileURLToPath(new URL('../../../scripts/deny-all-gate.sh', import.meta.url))
const base = { command: 'node', model: 'claude-haiku-4-5-20251001', prompt: 'observe and decide', maxBudgetUsd: 0.5, hookPath: HOOK }

describe('decisionArgs', () => {
  it('spawns restricted, MCP-strict, tool-less, session-less, budget-capped, with the settings file, and puts extra args first', () => {
    const args = decisionArgs({ extraArgs: ['/fake', '--fixture', 'decision'], model: 'm', maxBudgetUsd: 0.25, settingsPath: '/tmp/x/settings.json' })
    expect(args.slice(0, 3)).toEqual(['/fake', '--fixture', 'decision'])
    for (const flag of ['-p', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--include-hook-events']) expect(args).toContain(flag)
    expect(args).toContain('--tools')
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args[args.indexOf('--model') + 1]).toBe('m')
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('0.25')
    expect(args[args.indexOf('--settings') + 1]).toBe('/tmp/x/settings.json')
    expect(args).not.toContain('--permission-mode')
  })
})

describe('preflightDenyAll', () => {
  it('accepts the deny-all hook and refuses the pause gate (which allows without a flag)', async () => {
    await expect(preflightDenyAll({ hookPath: HOOK })).resolves.toBeUndefined()
    await expect(preflightDenyAll({ hookPath: fileURLToPath(new URL('../../../scripts/pause-gate.sh', import.meta.url)) })).rejects.toThrow(/did not deny/)
  })
})

describe('decideWithModel (fake CLI)', () => {
  it('returns the answer text with cost and tokens, sends the prompt on stdin, and passes a clean environment', async () => {
    const outcome = await decideWithModel({ ...base, extraArgs: [FAKE, '--fixture', 'decision'] })
    expect(outcome.kind).toBe('answer')
    if (outcome.kind !== 'answer') return
    expect(outcome.text).toContain('place_purchase')
    expect(outcome.costUsd).toBeCloseTo(0.0038, 6)
    expect(outcome.tokens).toEqual({ input: 900, output: 120 })
    expect(outcome.numTurns).toBe(1)
  })
  it('reports an isolation breach when the stream shows a tool call, keeping the cost', async () => {
    const outcome = await decideWithModel({ ...base, extraArgs: [FAKE, '--fixture', 'decision-breach'] })
    expect(outcome).toMatchObject({ kind: 'isolation_breach', tools: ['Bash'], costUsd: 0.0121 })
  })
  it('fails with a reason on a timeout and on a stream without a result line', async () => {
    const hung = await decideWithModel({ ...base, extraArgs: [FAKE, '--fixture', 'hang'], timeoutMs: 500 })
    expect(hung).toMatchObject({ kind: 'failed', reason: expect.stringMatching(/timeout/), costUsd: null })
    const crashed = await decideWithModel({ ...base, extraArgs: [FAKE, '--fixture', 'crash'] })
    expect(crashed.kind).toBe('failed')
  })
  it('gives the child only PATH, HOME, LANG and TERM', async () => {
    process.env['DATABASE_URL'] = 'postgres://should-not-leak'
    process.env['SLAVEOFAI_TEST_LEAK'] = '1'
    const outcome = await decideWithModel({ ...base, extraArgs: [FAKE, '--fixture', 'env-echo'] })
    // env-echo's result payload carries the child's process.env (see fake-claude.mjs).
    const text = outcome.kind === 'answer' ? outcome.text : outcome.kind === 'failed' ? outcome.reason : ''
    expect(text).not.toContain('should-not-leak')
    expect(text).not.toContain('SLAVEOFAI_TEST_LEAK')
    delete process.env['DATABASE_URL']; delete process.env['SLAVEOFAI_TEST_LEAK']
  })
})
```
(Read `fake-claude.mjs`'s `env-echo` mode to see where it puts the env — the `result` line's `result` field; if it puts it elsewhere, adapt the assertion to read that field via a `raw` outcome property: add `readonly resultText: string | null` to `answer`/`failed` if needed.)

- [ ] **Step 2: Run to verify it fails** — `npx vitest run packages/providers/test/claude-decision.test.ts` → FAIL.

- [ ] **Step 3: Implement `decision.ts`**

```ts
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGateScript } from '../runtime/gate-preflight.js'
import { terminateChild } from '../runtime/process.js'
import { parseStreamLine } from './stream.js'
import { writeSettingsFile } from './settings.js'
import type { RunOutcome } from '../types.js'

export const DEFAULT_MODEL_TIMEOUT_MS = 120_000
// … interfaces from the Interfaces block …

export function decisionArgs(input: { readonly extraArgs?: readonly string[]; readonly model: string; readonly maxBudgetUsd: number; readonly settingsPath: string }): readonly string[] {
  return [...(input.extraArgs ?? []), '-p', '--restricted', '--strict-mcp-config', '--tools', '', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--model', input.model, '--max-budget-usd', String(input.maxBudgetUsd), '--settings', input.settingsPath]
}

function isDeny(stdout: string): boolean {
  try { return (JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision === 'deny' } catch { return false }
}

/** The deny-all hook must deny whatever the pause flag says — the opposite contract of `preflightGate`. */
export async function preflightDenyAll(input: { readonly hookPath: string }): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'slaveofai-denyall-'))
  try {
    for (const flagPresent of [true, false]) {
      const run = await runGateScript({ hookPath: input.hookPath, flagPath: join(dir, 'flag'), flagPresent })
      if (run.exitCode !== 0 || !isDeny(run.stdout)) throw new Error(`preflightDenyAll: hook at ${input.hookPath} did not deny with the pause flag ${flagPresent ? 'present' : 'absent'} (exit ${String(run.exitCode)}, stdout ${JSON.stringify(run.stdout.slice(0, 200))})`)
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
}

export async function decideWithModel(input: ModelDecisionInput): Promise<ModelDecisionOutcome> {
  await preflightDenyAll({ hookPath: input.hookPath })
  const dir = await mkdtemp(join(tmpdir(), 'slaveofai-decision-'))
  const settingsPath = join(dir, 'settings.json')
  writeSettingsFile({ settingsPath, hookPath: input.hookPath })
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', LANG: process.env['LANG'] ?? 'C.UTF-8', TERM: 'dumb' }
  const child = spawn(input.command, decisionArgs({ ...(input.extraArgs !== undefined ? { extraArgs: input.extraArgs } : {}), model: input.model, maxBudgetUsd: input.maxBudgetUsd, settingsPath }), { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.end(input.prompt)
  let text = ''
  const tools: string[] = []
  let outcome: RunOutcome | null = null
  let buffer = ''
  let timedOut = false
  const timer = setTimeout((): void => { timedOut = true; void terminateChild(child, 2_000) }, input.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS)
  const handleLine = (line: string): void => {
    if (line.trim() === '') return
    const event = parseStreamLine(line)
    if (event.kind === 'text') text += event.text
    else if (event.kind === 'tool_call') tools.push(event.toolName)
    else if (event.kind === 'terminated') outcome = event.outcome
  }
  try {
    await new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: Buffer): void => { buffer += chunk.toString('utf8'); const lines = buffer.split('\n'); buffer = lines.pop() ?? ''; lines.forEach(handleLine) })
      child.on('close', (): void => { if (buffer !== '') handleLine(buffer); resolve() })
      child.on('error', (): void => resolve())
    })
  } finally {
    clearTimeout(timer)
    await rm(dir, { recursive: true, force: true })
  }
  const costUsd = outcome?.costUsd ?? null
  const tokens = outcome?.tokens ?? null
  if (tools.length > 0) return { kind: 'isolation_breach', tools, costUsd, tokens }
  if (timedOut) return { kind: 'failed', reason: 'timeout', costUsd, tokens }
  if (outcome === null) return { kind: 'failed', reason: 'the model process ended without a result line', costUsd, tokens }
  if (outcome.isError) return { kind: 'failed', reason: `result is_error: ${outcome.terminalReason}`, costUsd, tokens }
  return { kind: 'answer', text, costUsd, tokens, numTurns: outcome.numTurns }
}
```
Check `RunOutcome`'s field names in `types.ts` (`isError`, `terminalReason`, `numTurns`, `costUsd`, `tokens`) and `parseStreamLine`'s `text` event for an `assistant` line with a `text` content block (it is `kind: 'text'`). Add `export * from './claude/decision.js'` to `packages/providers/src/index.ts`.

- [ ] **Step 4: Green, typecheck, commit**

Run: `npx vitest run packages/providers/test/claude-decision.test.ts` → PASS; `npx vitest run packages/providers` once; `npm run --silent typecheck`.
```bash
git add scripts/deny-all-gate.sh packages/providers
git commit -m "feat(providers): m31a t1 — decideWithModel: a restricted, MCP-strict, tool-less, budget-capped model call with a deny-all hook and a clean environment"
```

---

### Task 2: Pure prompt, parse, providers

**Files:**
- Create: `packages/simulation/src/decide/llm-prompt.ts`, `packages/simulation/src/decide/llm.ts`, `packages/simulation/src/trade/action-docs.ts`
- Modify: `packages/simulation/src/decide/provider.ts` (`kind: 'rules' | 'recorded' | 'llm'`), `packages/simulation/src/index.ts`
- Test: `packages/simulation/test/decide/llm.test.ts`

**Interfaces:**
```ts
export interface ActionDoc { readonly type: string; readonly params: string; readonly when: string }
export const TRADE_ACTION_DOCS: readonly ActionDoc[]   // accept_order, place_purchase, ship_order, note
export function buildDecisionPrompt(input: { role: RoleDefinition; observation: Readonly<Record<string, unknown>>; actionDocs: readonly ActionDoc[]; day: number; currency: string; maxActions: number }): string
export function parseEnvelopes(text: string, maxActions: number): { readonly envelopes: readonly ActionEnvelope[] } | { readonly parseError: string }
export class LlmDecisionProvider implements DecisionProvider { readonly kind = 'llm'; constructor(answers: ReadonlyMap<string, readonly ActionEnvelope[]>); decide(request): readonly ActionEnvelope[] }   // a role without an answer → []
export class CompositeDecisionProvider implements DecisionProvider { readonly kind = 'llm'; constructor(input: { llmRoles: readonly string[]; llm: DecisionProvider; rules: DecisionProvider }); decide(request) }
```
Note on `kind`: the engine journals `provider: provider.kind` per decision point; the composite must report the kind of the provider that ACTUALLY answered — so make `decide` route AND make `kind` a getter that returns the last routed provider's kind is fragile. Instead: the engine's `step` reads `provider.kind` once per decision point; change `engine.ts` minimally so that a provider may expose `kindFor?(role: RoleDefinition): 'rules' | 'recorded' | 'llm'` and `step` records `provider.kindFor?.(role) ?? provider.kind`. The composite implements `kindFor`. (This is the one engine touch; it is additive and covered by the composite test.)

- [ ] **Step 1: Failing tests** — `llm.test.ts`: `buildDecisionPrompt` output contains the role's purpose, each action doc line, the observation as JSON, the words "ONLY a JSON array", the max count, and "synthetic"; `parseEnvelopes` handles: a bare array; a ```json fenced array; prose then a fenced array then prose (the r4 shape: `<function_calls>…</function_calls> The directory is empty. ```json [ … ] ```` → the array); `[]`; a non-array → `parseError`; an element failing the schema → `parseError` naming the index; more than `maxActions` → truncated to `maxActions`; `LlmDecisionProvider` answers its role and `[]` for another; `CompositeDecisionProvider` routes purchasing to llm and sales to rules and `kindFor` reports each; an engine `step` with the composite journals `provider: 'llm'` for purchasing and `'rules'` for the others (use `demoDefinition` + a one-day step).
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — `parseEnvelopes`: prefer the LAST ```json … ``` fenced block; else the substring from the first `[` to the matching last `]`; `JSON.parse`; `Array.isArray` check; per-element `actionEnvelopeSchema.safeParse` with `parseError: \`element ${i}: ${issues}\``; slice to `maxActions`. Prompt template (plain text, no markdown headings): role line, "You may propose these actions:" + one line per doc (`type params — when`), "Observation (JSON):" + `JSON.stringify(observation)`, the contract sentence, "This is a synthetic simulation; the numbers are not a real company's." Engine change: `record('decision', role.name, { index, provider: provider.kindFor?.(role) ?? provider.kind, observation, actions: proposed })` and the optional method on the interface.
- [ ] **Step 4: Green, typecheck, commit** — `npx vitest run packages/simulation`; `npm run --silent typecheck`.
```bash
git add packages/simulation
git commit -m "feat(simulation): m31a t2 — the decision prompt, the JSON-array extractor, LlmDecisionProvider and CompositeDecisionProvider"
```

---

### Task 3: Migration, create verb, refusals, summary, step refusal

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (`DecisionProviderKind { rules llm }`, `modelProvider ProviderKind?`, `model String?`, `maxModelCostUsd Float?` on `SimulationRun`; `simTime Int?`, `role String?` on `SimulationModelUsage`), migration `20260907090000_m31a_llm_decision_provider/migration.sql` (`ALTER TYPE "DecisionProviderKind" ADD VALUE IF NOT EXISTS 'llm'; ALTER TABLE "SimulationRun" ADD COLUMN "modelProvider" "ProviderKind", ADD COLUMN "model" TEXT, ADD COLUMN "maxModelCostUsd" DOUBLE PRECISION; ALTER TABLE "SimulationModelUsage" ADD COLUMN "simTime" INTEGER, ADD COLUMN "role" TEXT;`)
- Modify: `packages/control/src/refusal.ts` (`llm_steps_in_daemon { simulationId }` → "simulation <id> makes its decisions with a model; its steps happen in the daemon — start auto-run"; `unsupported_model_provider { provider, reason }` → "model provider <p> is not supported for simulations: <reason>"), `packages/control/src/simulation/shared.ts` (summary: `decisionProvider: 'rules' | 'llm'`, `modelProvider: 'claude_code' | 'cursor' | null`, `model: string | null`, `maxModelCostUsd: number | null`, `llmRoles: readonly string[]`), `write.ts` (`createSimulation` input + validation; `definition.llmRoles`; `stepSimulation` refuses `llm_steps_in_daemon` for an `llm` run), `packages/simulation/src/trade/definition.ts` (`llmRoles: z.array(z.string()).default([])` in the schema; `demoDefinition` accepts `llmRoles?`)
- Test: `packages/control/test/refusal-text.test.ts` (+2), `packages/control/test/integration/llm.test.ts` (new: create refusals — missing cap / cap ≤ 0 / cursor / missing model; a valid `llm` run has `decisionProvider 'llm'`, `llmRoles ['purchasing']`, summary fields; `stepSimulation` → `llm_steps_in_daemon`; `startAutoRun` still works on it), web/CLI fixtures gain the new summary fields (`decisionProvider: 'rules'`, `modelProvider: null`, `model: null`, `maxModelCostUsd: null`, `llmRoles: []`).

- [ ] Steps: tests first → migration + `db:generate` + `db:migrate` + `db:migrate:test` → implement → `npx vitest run packages/control/test/integration/llm.test.ts`, `packages/control/test/refusal-text.test.ts`, the four web sim test files, `npm run --silent typecheck` → commit `feat(db,control): m31a t3 — an llm run: provider, model, cost cap, llmRoles; steps refused outside the daemon`.

---

### Task 4: `prepareModelDecision`, `applyModelDecision`, `tickSimulations(modelDecider)`, the daemon

**Files:**
- Create: `packages/control/src/simulation/llm.ts`
- Modify: `packages/control/src/simulation/auto-run.ts` (`tickSimulations({ now, modelDecider? })`), `packages/control/src/simulation.ts` (barrel), `apps/orchestrator/src/daemon.ts` (inject the decider), `apps/orchestrator/src/cli.ts` (`tick` passes no decider; prints `skippedNoDecider`)
- Test: `packages/control/test/integration/llm.test.ts` (+ cases), `packages/control/test/integration/auto-run.test.ts` (+ llm run skipped without a decider)

**Interfaces:**
```ts
export type ModelDecider = (input: { readonly model: string; readonly prompt: string; readonly maxBudgetUsd: number }) => Promise<ModelDecisionOutcome>   // ModelDecisionOutcome re-declared structurally in control (control must not import providers' types either — copy the union into llm.ts as `ModelOutcome`)
export function prepareModelDecision(id: string, now: Date): Promise<Result<{ kind: 'skip'; reason: 'no_intent' | 'not_running' | 'not_due' } | { kind: 'budget' } | { kind: 'decide'; version: number; day: number; role: string; prompt: string; promptHash: string; model: string; remainingUsd: number }, ControlRefusal>>
export function applyModelDecision(id: string, input: { readonly expectedVersion: number; readonly role: string; readonly outcome: ModelOutcome; readonly promptHash: string; readonly now: Date }): Promise<Result<{ applied: boolean; reason?: 'stale' | 'breach' | 'failed' }, ControlRefusal>>
export const PER_CALL_CAP_USD = 1
```
- `prepareModelDecision`: `readSimulation(prisma, id)`; the three skip checks (intent, status running, `lastAutoStepAt + everyMs > now`); `spent = sum(costUsd)` via `aggregate`; `spent >= maxModelCostUsd` → journal `model_budget_exhausted { spentUsd, capUsd }` + `haltUnparsed(id, 'model budget exhausted')` (export it from auto-run.ts) → `{ kind: 'budget' }`; else build the prompt with `buildDecisionPrompt` (observation via `tradeModel.observe(state.sector, role)`, `TRADE_ACTION_DOCS` filtered to the role's `allowedActions`, `maxActions = limits.maxDecisionsPerStep`), `promptHash = createHash('sha256')` (control may use `node:crypto`), `remainingUsd = maxModelCostUsd - spent`.
- `applyModelDecision` (one `$transaction`, `locked`): write `SimulationModelUsage { seq: max(seq)+1, provider: 'claude_code', costUsd, tokensIn, tokensOut, simTime: row.simTime, role }` FIRST; then stale check (`row.version !== expectedVersion || row.status !== 'running'`) → journal `control { op: 'stale_decision', role, expectedVersion, actual: row.version }` → `{ applied: false, reason: 'stale' }`; `isolation_breach` → journal `control { op: 'isolation_breach', tools }` + row `{ status: 'halted', haltedReason: \`isolation breach: ${tools.join(', ')}\`, intent cleared }` + `auto_run_stopped { reason: 'halted' }` → `{ applied: false, reason: 'breach' }`; `failed` → answers `[]` with `parseError: reason`; `answer` → `parseEnvelopes(text, limits.maxDecisionsPerStep)`; then `stepLocked(tx, row, loaded, { untilDay: row.simTime + 1, lastAutoStepAt: now, provider: new CompositeDecisionProvider({ llmRoles, llm: new LlmDecisionProvider(new Map([[role, envelopes]])), rules: new RulesDecisionProvider(definition) }) })` — `stepLocked` gains an optional `provider` parameter (default `RulesDecisionProvider`); the engine's `decision` row for that role must carry `model`, `usageSeq` and `parseError` — pass them through a `decisionExtras` option on `stepLocked` that is merged into the `decision` payload for `role` (engine: `record('decision', …, { …, ...(extras?.[role.name] ?? {}) })` — one more additive engine option, `step(model, definition, state, provider, extras?)`).
- `tickSimulations({ now, modelDecider })`: for each candidate row, if `decisionProvider === 'llm'`: `modelDecider === undefined` → `skippedNoDecider += 1`, continue; `prepareModelDecision` → skip/budget/decide; on `decide`: `outcome = await modelDecider({ model, prompt, maxBudgetUsd: Math.min(remainingUsd, PER_CALL_CAP_USD) })` (NO transaction open), then `applyModelDecision`; a throw anywhere → `haltUnparsed(id, \`auto-run step failed: ${message}\`)`. The report gains `skippedNoDecider`.
- Daemon: `const modelDecider = (input) => decideWithModel({ command, extraArgs, hookPath: denyAllHookPath(), model: input.model, prompt: input.prompt, maxBudgetUsd: input.maxBudgetUsd, timeoutMs: Number(process.env['SLAVEOFAI_MODEL_TIMEOUT_MS'] ?? 120_000) })` where `command`/`extraArgs` come from the same `SLAVEOFAI_CLAUDE_BIN`/`SLAVEOFAI_CLAUDE_ARGS` reading `buildAdapterRegistry` uses (extract a small `claudeCommand()` helper in cli.ts) and `denyAllHookPath()` resolves `scripts/deny-all-gate.sh` like `hookPath()` resolves `pause-gate.sh` (env override `SLAVEOFAI_DENY_ALL_HOOK_PATH`).
- Tests (integration, fake decider functions — no CLI): `prepareModelDecision` skip/budget/decide (prompt contains the observation); `applyModelDecision` stale (usage row written, `stale_decision` row, version unchanged), breach (halt + reason + intent cleared + usage row), failed (day advances, decision row `parseError`, zero purchasing actions), answer (day advances, `purchase` placed as the answer said, decision row `provider: 'llm'`, `model`, `usageSeq` equal to the usage row's seq, other roles `provider: 'rules'`); cumulative cost: cap `0.01` with a decider returning `costUsd 0.006` → second tick halts with `model budget exhausted`; `tickSimulations` with a decider steps the llm run and without one reports `skippedNoDecider: 1`; a `rules` run in the same pass is unaffected.
- Commit: `feat(control,orchestrator): m31a t4 — two-phase model steps: prepare (unlocked) → decide (daemon, no tx) → apply (locked, usage first, stale/breach/parse handled); the daemon injects decideWithModel`.

---

### Task 5: UI and CLI

**Files:** `NewSimulationDrawer.tsx` (provider select `rules|llm`, `ModelSelect` on `claude_code`, cap field default `2.00`, consent checkbox `new-simulation-consent`, submit disabled until checked when `llm`; body adds `decisionProvider, modelProvider: 'claude_code', model, maxModelCostUsd`), `apps/web/src/app/api/sim/route.ts` (zod for the new fields), `SimulationStrip.tsx` (`llm provider · claude_code · <model>`), `SimulationClient.tsx` (no Step/Run-to-day for `llm`; the sentence "an llm run steps only through auto-run (the daemon makes the model calls); a call already in flight finishes and is billed"; model panel `$spent of $cap` + `unmeasured N` when > 0; Decisions rows: `llm` chip, model, `$cost` from the usage row matched by `usageSeq`, `parseError` line), `apps/web/src/server/simulation.ts` (snapshot `modelUsage` gains `spentUsd`, `capUsd`, `rows: [{ seq, simTime, role, costUsd }]`), `SimulationsClient.tsx` (`llm` chip), `cli.ts` (`--decision-provider`, `--model-provider`, `--model`, `--max-model-cost-usd`; `simulation-status` prints `spentUsd`/`capUsd`), tests: `simulations-page.test.tsx` (consent gating, body), `simulation-page.test.tsx` (strip, panel `$0.0038 of $2.00`, no step buttons, breach note, decision row chip/cost), `sim-routes.test.ts` (400 without cap for llm), `cli.test.ts` (create llm run refuses without cap; with cap the row has the fields). Commit `feat(web,cli): m31a t5 — an llm run from the drawer with consent and a cap; the page shows real spend against the cap and the model behind each decision`.

---

### Task 6: Gate, README, errata, full verification

**Files:** `scripts/gate-m31a-llm-decisions.mjs` (skeleton from `gate-m30-simulation-compare.mjs`; daemon spawned with `SLAVEOFAI_CLAUDE_BIN=node`, `SLAVEOFAI_CLAUDE_ARGS="<abs fake-claude.mjs> --fixture decision"`, `SLAVEOFAI_DENY_ALL_HOOK_PATH` default; stages: 1 company; 2 create an `llm` run from the UI — provider `llm`, model typed into the model input, cap `2`, consent checked; 3 auto-run every 250 ms until day 5; wait `simTime 5`; 4 prisma: five `SimulationModelUsage` rows with `role 'purchasing'`, `sum(costUsd) ≈ 5 × 0.0038`; five `decision` rows with `provider 'llm'` whose `usageSeq` match; purchasing's `action_applied` rows show `place_purchase fast 50` on the days the answer was valid; sales/operations/finance decisions `provider 'rules'`; the page's model panel text equals the formatted sum; 5 kill the daemon, restart it with `--fixture decision-breach`, `startAutoRun` again (through the UI's Auto-run), wait ≤ 15 s: the run is `halted` with `haltedReason 'isolation breach: Bash'`, the journal has `isolation_breach` then `halted`, usage rows are six, no further steps; 6 `/w/<seed>` untouched; teardown), `package.json` `gate:m31a-llm-decisions`, `.github/workflows/ci.yml` after `gate:m30-simulation-compare`, README (a "Let a model decide" paragraph: consent, cap, only purchasing, daemon needed, the isolation flags, cost shown against the cap; CLI flags), spec §12 (R-entries from the ledger + the r4 result already recorded), full verification (`typecheck`, `npm test`, `web:build`, gates m26/m11/m29/m30/m31a). Commit `test(gates),docs: m31a t6 — gate:m31a-llm-decisions on the fake CLI (answers, then a breach that halts), README, errata`.
