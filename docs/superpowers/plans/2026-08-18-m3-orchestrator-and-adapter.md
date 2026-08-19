# M3 Orchestrator and ClaudeCodeAdapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the pure decision core into a system that provisions real git worktrees, spawns real `claude` processes, streams their output into the event log, verifies the result, and advances the task — driven from a CLI, with pause and resume working.

**Architecture:** `packages/providers` holds the `AgentRuntimeAdapter` interface and `ClaudeCodeAdapter`; it depends on `packages/domain` only and never touches the database. `apps/orchestrator` is the single-writer daemon: it loads a `World` from Postgres, calls the domain's existing `decide()`, executes the returned commands, and reacts to observed run state. Run output is consumed by a per-run concurrent pump, not inside the tick.

**Tech Stack:** TypeScript (strict, no `any`), Node 26, Vitest, Prisma 7 + `@prisma/adapter-pg`, PostgreSQL 17 on port 5433, `node:child_process`, real `git`.

**Spec:** `docs/superpowers/specs/2026-08-18-m3-orchestrator-and-adapter-design.md`
**Parent spec:** `docs/superpowers/specs/2026-08-17-ai-team-os-design.md`
**Binding prior decision:** `docs/decisions/0001-pause-semantics.md`

## Global Constraints

- TypeScript strict. **No `any` anywhere**, in `src` or `test`.
- **Every exported function carries an explicit return type.** Load-bearing: `noImplicitReturns` is not set, so TS2366 exhaustiveness checking depends on it.
- **`packages/providers` must not depend on `packages/db`.** The adapter emits normalized events; the orchestrator persists them.
- `ExecutionEvent` has exactly one write path: `appendEvent()`.
- The `EventType` database enum and the domain Zod union stay in exact correspondence — M2's parity test enforces both directions.
- Postgres host port is **5433**, never 5432.
- **No run writes to the git common directory.** Identity comes from process environment.
- Integration tests run against a real database and **never skip silently**.
- Every `prisma migrate` / `prisma generate` needs `--config packages/db/prisma.config.ts` beside `--schema`; `migrate` does not generate the client.
- `npm test` is `tsc --build && vitest run`. The integration vitest project is serial (`fileParallelism: false` at the config's **root** level).
- Conventional commits with the trailer `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- `npm test` and `npm run typecheck` both pass before every commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/providers/src/types.ts` | `AgentRuntimeAdapter`, `ProviderCapabilities`, `RuntimeEvent`, `StartRunInput`, `RunOutcome` |
| `packages/providers/src/claude/stream.ts` | One NDJSON line → one `RuntimeEvent`. Pure. |
| `packages/providers/src/claude/flags.ts` | Mandatory CLI flag construction. Pure. |
| `packages/providers/src/claude/settings.ts` | Per-run settings file writer (absolute hook path) |
| `packages/providers/src/claude/adapter.ts` | Process lifecycle, pause protocol, resume |
| `packages/providers/test/fake-claude.mjs` | Test instrument: replays NDJSON fixtures |
| `packages/providers/test/fixtures/*.ndjson` | Captures derived from M0 |
| `scripts/pause-gate.sh` | `PreToolUse` hook, with a real JSON encoder |
| `apps/orchestrator/src/world.ts` | Database rows → domain `World` |
| `apps/orchestrator/src/worktree.ts` | Provision, setup commands, preserve |
| `apps/orchestrator/src/pump.ts` | `RuntimeEvent` → domain event → `appendEvent` |
| `apps/orchestrator/src/verify.ts` | Verify commands, artifacts, advance |
| `apps/orchestrator/src/tick.ts` | Load → decide → execute |
| `apps/orchestrator/src/sweep.ts` | Timeouts, dead pids, startup reconciliation |
| `apps/orchestrator/src/cli.ts` | `tick`, `daemon`, `pause`, `resume`, `cancel`, `status` |

---

## Task 1: Measure Q7 and Q8 before any adapter code

Spec §14. Both are load-bearing for a milestone that implements pause. This task writes **no product code**.

**Files:**
- Create: `docs/superpowers/spikes/2026-08-18-m3-hook-failure-modes.md`
- Modify: `docs/decisions/0001-pause-semantics.md` (Open Questions section)

**Interfaces:**
- Produces: a resolved or refuted answer to Q7 and Q8 that Task 8's pause design depends on.

- [ ] **Step 1: Build the Q7 probe**

Create a throwaway directory outside the repo. Write a hook that always exits 2 with no stdout:

```bash
#!/usr/bin/env bash
cat > /dev/null
printf 'deliberate hook crash\n' >&2
exit 2
```

Register it as `PreToolUse` with `matcher: "*"` in a settings file using its **absolute path**.

- [ ] **Step 2: Run it and observe whether the tool call proceeds**

```bash
claude -p "Create a file called probe.txt containing the word hello" \
  --output-format stream-json --verbose \
  --permission-mode bypassPermissions \
  --settings /abs/path/settings.json \
  --include-hook-events \
  2>&1 | tee q7-capture.jsonl
```

Then check whether `probe.txt` exists. **The file's existence is the answer**, not the event stream: if the crashing hook failed open, the tool ran.

- [ ] **Step 3: Build the Q8 probe**

Same shape, but with the real `spike/m0-pause-resume/pause-gate.sh` and a flag file armed **after** the run has read a file and is about to edit it. Prompt the model to edit an existing file with known content. Record the file's bytes before and after.

- [ ] **Step 4: Record what was observed, not what was expected**

Write `docs/superpowers/spikes/2026-08-18-m3-hook-failure-modes.md` with the exact commands, the captures, and a per-question verdict labelled `[Observed]` / `[Inferred]`. If a probe does not produce a clean answer, say so — an inconclusive measurement recorded honestly is worth more than a guess.

- [ ] **Step 5: Update ADR 0001's Open Questions**

Move Q7 and Q8 from Open Questions to a RESOLVED form with the evidence, in the same style the ADR already uses for Q1-Q3.

**If Q7 fails open:** stop and report it. The pause design in Task 8 changes — the orchestrator can no longer treat "flag written" as "side effects blocked" and must fall back to cancel-and-preserve. Do not proceed to Task 8 with a design the measurement contradicts.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/spikes/ docs/decisions/0001-pause-semantics.md
git commit -m "docs: measure Q7 and Q8 hook failure modes"
```

---

## Task 2: Widen the event union and the EventType enum together

Spec §9. Nine new types, every one drawn verbatim from parent spec §6.2's catalogue.

**Files:**
- Modify: `packages/domain/src/events/schema.ts`
- Modify: `packages/db/prisma/schema.prisma` (the `EventType` enum)
- Modify: `packages/db/src/enums.ts`
- Test: `packages/db/test/integration/enum-parity.test.ts` (already exists — it must keep passing)

**Interfaces:**
- Produces: nine new members of the domain `ExecutionEvent` union and the `EventType` enum: `task.verifying`, `task.verify_passed`, `task.verify_failed`, `task.failed`, `run.output`, `run.pause_requested`, `run.stopped`, `run.succeeded`, `run.failed`.

- [ ] **Step 1: Write the failing test**

Add to `packages/domain/test/events/schema.test.ts`:

```ts
it('parses each event type M3 adds', () => {
  const base = {
    seq: 1,
    ts: new Date().toISOString(),
    workspaceId: 'w1',
    actor: 'system' as const,
  }
  const cases = [
    { type: 'task.verifying', payload: { commandCount: 2 } },
    { type: 'task.verify_passed', payload: { branch: 'aiteamos/TASK-001-x' } },
    { type: 'task.verify_failed', payload: { command: 'npm test', exitCode: 1 } },
    { type: 'task.failed', payload: { reason: 'attempt cap reached' } },
    { type: 'run.output', payload: { text: 'hello' } },
    { type: 'run.pause_requested', payload: { requestedBy: 'operator' } },
    { type: 'run.stopped', payload: { reason: 'cancelled' } },
    { type: 'run.succeeded', payload: { numTurns: 4, costUsd: 0.12 } },
    { type: 'run.failed', payload: { reason: 'worktree provisioning failed' } },
  ]
  for (const c of cases) {
    const parsed = parseExecutionEvent({ ...base, ...c })
    expect(parsed.ok, `${c.type} should parse`).toBe(true)
  }
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project unit packages/domain/test/events/schema.test.ts`
Expected: FAIL — the discriminated union has no member for `task.verifying`.

- [ ] **Step 3: Add the nine members to the domain union**

In `packages/domain/src/events/schema.ts`, following the existing style exactly:

```ts
  z.object({ ...envelope, type: z.literal('task.verifying'), payload: z.object({ commandCount: z.number().int() }) }),
  z.object({ ...envelope, type: z.literal('task.verify_passed'), payload: z.object({ branch: z.string() }) }),
  z.object({
    ...envelope,
    type: z.literal('task.verify_failed'),
    payload: z.object({ command: z.string(), exitCode: z.number().int() }),
  }),
  z.object({ ...envelope, type: z.literal('task.failed'), payload: z.object({ reason: z.string() }) }),
  z.object({ ...envelope, type: z.literal('run.output'), payload: z.object({ text: z.string() }) }),
  z.object({ ...envelope, type: z.literal('run.pause_requested'), payload: z.object({ requestedBy: z.string() }) }),
  z.object({ ...envelope, type: z.literal('run.stopped'), payload: z.object({ reason: z.string() }) }),
  z.object({
    ...envelope,
    type: z.literal('run.succeeded'),
    payload: z.object({ numTurns: z.number().int(), costUsd: z.number() }),
  }),
  z.object({ ...envelope, type: z.literal('run.failed'), payload: z.object({ reason: z.string() }) }),
```

- [ ] **Step 4: Run the unit test again**

Expected: PASS.

- [ ] **Step 5: Run the parity test and watch it fail**

Run: `npx vitest run --project integration packages/db/test/integration/enum-parity.test.ts`
Expected: FAIL — the domain union now has nine members the database enum lacks. **This failure is the point of the task.** It proves M2's parity test is doing its job.

- [ ] **Step 6: Widen the database enum and the map**

In `packages/db/prisma/schema.prisma`, add to `enum EventType` using the same `@map` dotted-value convention as the existing ten. In `packages/db/src/enums.ts`, add the nine entries to `EVENT_TYPE_BY_DOMAIN_TYPE` — the `satisfies Record<DomainEventType, string>` will not compile until all nine are present.

- [ ] **Step 7: Migrate and generate**

```bash
npx prisma migrate dev --name widen_event_type_for_m3 \
  --schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts
npx prisma generate --schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts
npm run db:migrate:test
```

- [ ] **Step 8: Run the full suite and commit**

```bash
npm test && npm run typecheck
git add -A && git commit -m "feat(domain,db): widen the event union for M3"
```

---

## Task 3: Schema for runs, checkpoints, and workspace commands

Spec §10. One migration carrying five changes.

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Modify: `packages/db/src/seed.ts`
- Test: `packages/db/test/integration/checkpoint.test.ts` (create)

**Interfaces:**
- Produces: `Checkpoint` model; `AgentRun.pid`, `AgentRun.worktreePath`, `AgentRun.terminalAt`; `Workspace.verifyCommands: String[]`; `Workspace.setupCommands: String[]`; `Workspace.haltedReason: String?`, `Workspace.haltedAt: DateTime?`.

- [ ] **Step 1: Write the failing test**

`packages/db/test/integration/checkpoint.test.ts`:

```ts
import { prisma } from '../../src/client.js'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Checkpoint" RESTART IDENTITY CASCADE')
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('Checkpoint', () => {
  it('stores everything ADR 0001 requires to resume a run', async (): Promise<void> => {
    const workspace = await prisma.workspace.create({
      data: {
        name: 'w',
        repoPath: '/tmp/repo',
        verifyCommands: ['npm test'],
        setupCommands: ['npm ci'],
      },
    })
    expect(workspace.verifyCommands).toEqual(['npm test'])
    expect(workspace.setupCommands).toEqual(['npm ci'])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project integration packages/db/test/integration/checkpoint.test.ts`
Expected: FAIL — `verifyCommands` is not a known field (it is `verifyCommand`, a single string).

- [ ] **Step 3: Change the schema**

```prisma
model Checkpoint {
  id                String   @id @default(uuid())
  runId             String   @unique
  sessionId         String
  worktreePath      String
  pauseFlagPath     String
  lastToolUseId     String?
  lastToolName      String?
  numTurns          Int      @default(0)
  deniedToolUseIds  String[]
  headCommit        String
  dirtyFiles        String[]
  cumulativeCostUsd Float    @default(0)
  cumulativeTokens  Int      @default(0)
  pauseReason       String?
  requestedBy       String?
  ts                DateTime @default(now())

  run AgentRun @relation(fields: [runId], references: [id], onDelete: Cascade)
}
```

On `AgentRun` add `pid Int?`, `worktreePath String?`, `terminalAt DateTime?`, and the back-relation `checkpoint Checkpoint?`.

On `Workspace` replace `verifyCommand String` with `verifyCommands String[]` and add
`setupCommands String[]`, `haltedReason String?` and `haltedAt DateTime?`.

`haltedReason`/`haltedAt` are the persistent workspace halt (spec §13.1). They belong to this same
migration — spec §10 lists M3 as one migration — and they are what `loadWorld` maps onto
`stats.emergencyStopped` in Task 10. A local latch was rejected because it dies with the process;
these columns are chosen so the halt survives a daemon restart, which is the only reason to prefer
them. M8's emergency stop inherits these columns rather than adding its own.

- [ ] **Step 4: Update the seed**

In `packages/db/src/seed.ts`, change the workspace creation to supply `verifyCommands: ['npm run build', 'npm test']` and `setupCommands: ['npm ci']`. Keep the existing non-default `maxAttempts: 5` and the comment warning against tidying it back to 3 — that decorrelation is load-bearing for an existing test.

- [ ] **Step 5: Migrate, generate, re-seed**

```bash
npx prisma migrate dev --name m3_runs_checkpoints_commands \
  --schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts
npx prisma generate --schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts
npm run db:migrate:test && npm run db:seed
```

- [ ] **Step 6: Run the test, then the suite, then commit**

```bash
npm test && npm run typecheck
git add -A && git commit -m "feat(db): add checkpoints, run process fields, and command lists"
```

---

## Task 4: `packages/providers` scaffold and the stream parser

The parser is a pure function and carries the measured traps from spec §5.3: `hook_response.output`
is a JSON-encoded string needing a second parse; the line carries no `tool_use_id`, so correlation
goes through the following `tool_result`; `permission_denials` is checkpoint material, never a live
signal, and cannot tell a blocking crash from a genuine deny; `hook_response` events can arrive
after the terminal `result`, so the reader does not stop there.

**The classification is scoped to `hook_event === "PreToolUse"`, and the scope is not optional.**
Within that scope there are four shapes keyed on `exit_code`, never on `outcome`: deny (`0` plus
deny JSON), blocking crash (`2`), fail-open failure (non-zero and not `2` — the tool ran anyway),
and otherwise allow. Every other `hook_event` is ignored: `Stop` reports `exit_code: 1` on every
healthy run, so an unscoped parser reports a broken gate at the end of every successful run.

**Files:**
- Create: `packages/providers/package.json`, `tsconfig.json`, `tsconfig.test.json`
- Create: `packages/providers/src/types.ts`, `packages/providers/src/claude/stream.ts`, `packages/providers/src/index.ts`
- Test: `packages/providers/test/stream.test.ts`
- Modify: root `tsconfig.json` (add the reference), root `package.json` typecheck script, `vitest.config.ts`

**Interfaces:**
- Consumes: `RunId` from `@ai-team-os/domain`.
- Produces:
  - `type RuntimeEvent = { kind: 'session_started'; sessionId: string } | { kind: 'tool_call'; toolUseId: string; toolName: string } | { kind: 'text'; text: string } | { kind: 'hook_denied'; hookName: string; reason: string } | { kind: 'hook_crashed'; hookName: string; exitCode: number; stderr: string } | { kind: 'hook_failed_open'; hookName: string; exitCode: number; stderr: string } | { kind: 'permission_denied'; toolName: string; toolUseId: string } | { kind: 'terminated'; outcome: RunOutcome } | { kind: 'ignored'; line: string } | { kind: 'unparsable'; line: string }`
  - `hook_crashed` and `hook_failed_open` are separate variants on purpose (spec §5.3, §13.1): the first means the run stopped, the second means it kept going with no gate. `ignored` is a recognized line this parser does not act on — every `hook_response` whose `hook_event` is not `PreToolUse` — and is distinct from `unparsable`, which means the line could not be understood at all.
  - `interface RunOutcome { readonly isError: boolean; readonly terminalReason: string; readonly stopReason: string | null; readonly numTurns: number; readonly costUsd: number; readonly deniedToolUseIds: readonly string[] }`
  - `function parseStreamLine(line: string): RuntimeEvent`

- [ ] **Step 1: Scaffold the package**

Mirror `packages/events`' `package.json`, `tsconfig.json` and `tsconfig.test.json` exactly, changing only the name to `@ai-team-os/providers`. Its only dependency is `@ai-team-os/domain`. Add the project reference to the root `tsconfig.json`, add `tsc -p packages/providers/tsconfig.test.json` to the root `typecheck` script, and add the package's test globs to `vitest.config.ts`'s unit project.

- [ ] **Step 2: Write the failing tests**

`packages/providers/test/stream.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseStreamLine } from '../src/claude/stream.js'

describe('parseStreamLine', () => {
  it('reads the session id from the init line', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123' })
    expect(parseStreamLine(line)).toEqual({ kind: 'session_started', sessionId: 'abc-123' })
  })

  it('double-parses hook_response.output, which is a JSON-encoded string', () => {
    const inner = JSON.stringify({
      hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'Paused by AI Team OS.' },
    })
    const line = JSON.stringify({
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'PreToolUse:Bash',
      output: inner,
    })
    expect(parseStreamLine(line)).toEqual({
      kind: 'hook_denied',
      hookName: 'PreToolUse:Bash',
      reason: 'Paused by AI Team OS.',
    })
  })

  it('never conflates a permission-mode denial with a hook denial', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Edit',
      tool_use_id: 'tu_1',
    })
    expect(parseStreamLine(line)).toEqual({
      kind: 'permission_denied',
      toolName: 'Edit',
      toolUseId: 'tu_1',
    })
  })

  it('reads the outcome from the terminal result event, including its denials', () => {
    const line = JSON.stringify({
      type: 'result',
      is_error: false,
      terminal_reason: 'completed',
      stop_reason: 'end_turn',
      num_turns: 4,
      total_cost_usd: 0.12,
      permission_denials: [{ tool_use_id: 'tu_1' }, { tool_use_id: 'tu_2' }],
    })
    expect(parseStreamLine(line)).toEqual({
      kind: 'terminated',
      outcome: {
        isError: false,
        terminalReason: 'completed',
        stopReason: 'end_turn',
        numTurns: 4,
        costUsd: 0.12,
        deniedToolUseIds: ['tu_1', 'tu_2'],
      },
    })
  })

  it('returns unparsable rather than throwing on a malformed line', () => {
    expect(parseStreamLine('{not json')).toEqual({ kind: 'unparsable', line: '{not json' })
  })

  it('returns hook_crashed for a PreToolUse hook_response that exits 2', () => {
    // Measured shape: spike 2026-08-18 §1.4. output is the hook's stderr, not JSON --
    // treating a failed inner parse as `unparsable` would file a broken gate as stream noise.
    const line = JSON.stringify({
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'PreToolUse:Bash',
      hook_event: 'PreToolUse',
      output: 'deliberate hook crash\n',
      stderr: 'deliberate hook crash\n',
      exit_code: 2,
      outcome: 'error',
    })
    expect(parseStreamLine(line)).toMatchObject({ kind: 'hook_crashed', exitCode: 2 })
  })

  it('returns hook_failed_open for a PreToolUse hook_response that exits non-zero and not 2', () => {
    // Measured: exit 127 (path missing), 126 (not executable), 1 (script failed) all let the
    // tool run -- spike 2026-08-18 §6. Must NOT share a variant with hook_crashed.
    const line = JSON.stringify({
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'PreToolUse:Write',
      hook_event: 'PreToolUse',
      output: '/bin/sh: line 1: /nope/hook.sh: No such file or directory\n',
      stderr: '/bin/sh: line 1: /nope/hook.sh: No such file or directory\n',
      exit_code: 127,
      outcome: 'error',
    })
    expect(parseStreamLine(line)).toMatchObject({ kind: 'hook_failed_open', exitCode: 127 })
  })

  it('ignores a Stop hook_response that exits 1 rather than classifying it', () => {
    // REGRESSION GUARD. Every healthy run ends with exactly this line -- all four captures,
    // spike 2026-08-18 §3.4. Classified by exit_code without checking hook_event it reads as
    // hook_failed_open, which under spec §13.1 cancels the run, fails it, and halts the
    // workspace. On every successful run.
    const line = JSON.stringify({
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'Stop',
      hook_event: 'Stop',
      output: '',
      stderr: '',
      exit_code: 1,
      outcome: 'cancelled',
    })
    expect(parseStreamLine(line)).toEqual({ kind: 'ignored', line })
  })
})
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run --project unit packages/providers/test/stream.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the parser**

Write `packages/providers/src/types.ts` with the types from the Interfaces block, then `packages/providers/src/claude/stream.ts`. Use Zod (already a domain dependency) or hand-written narrowing — no `any`, and every branch returns explicitly. The malformed cases return `{ kind: 'unparsable', line }`; nothing throws, because a bad line must not kill a run.

- [ ] **Step 5: Run the tests, then commit**

```bash
npm test && npm run typecheck
git add -A && git commit -m "feat(providers): add the claude stream parser"
```

---

## Task 5: The fake `claude` CLI and its fixtures

Spec §12.1. This is the instrument every later adapter task is tested with.

**Files:**
- Create: `packages/providers/test/fake-claude.mjs`
- Create: `packages/providers/test/fixtures/complete.ndjson`, `hook-deny.ndjson`, `hook-crash.ndjson`, `hook-fail-open.ndjson`, `permission-denied.ndjson`, `crash.ndjson`, `malformed.ndjson`
- Test: `packages/providers/test/fake-claude.test.ts`

**Interfaces:**
- Produces: an executable that takes `--fixture <name>` plus the real CLI's flags, writes the fixture's lines to stdout with a small delay between them, and exits. Mode `hang` writes nothing and sleeps. Mode `crash` writes half the fixture then exits 1.

- [ ] **Step 1: Write the fixtures**

Derive them from real captures where those exist; otherwise hand-write lines in the exact shapes Task 4's tests encode. `complete.ndjson` is: one `system/init`, two `assistant` text lines, two tool calls with results, one terminal `result` with `is_error: false`. `hook-deny.ndjson` is the same up to the first tool call, then a `hook_response` deny, then a `tool_result` with `is_error: true`.

The two hook-failure fixtures come from Task 1's captures verbatim
(`docs/superpowers/spikes/2026-08-18-m3-hook-failure-modes.md`), because inventing their shapes is
what the measurement was for:

- `hook-crash.ndjson` — `PreToolUse` `hook_response` with `exit_code: 2`, `outcome: "error"`,
  plain-text `output`, followed by a `tool_result` with `is_error: true` and content
  `PreToolUse:<Tool> hook error: [<path>]: <stderr>`, and **no** `PostToolUse`. The tool did not run.
- `hook-fail-open.ndjson` — `PreToolUse` `hook_response` with `exit_code: 127`, `outcome: "error"`,
  plain-text `output`, then `PostToolUse` **fires**, the `tool_result` is an ordinary success, and
  the terminal `result` has `is_error: false` with `permission_denials: []`. This fixture must keep
  making tool calls after the point a pause flag would be armed — that is the behaviour Task 8's
  backstop test detects.

**Every fixture ends with a `Stop` `hook_response` carrying `exit_code: 1`, `outcome: "cancelled"`,
including the healthy ones.** All four captures do, and Task 4's regression guard depends on it
being present in normal traffic rather than only in a failure fixture.

- [ ] **Step 2: Write the failing test**

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)

describe('fake-claude', () => {
  it('replays a fixture as NDJSON on stdout', async (): Promise<void> => {
    const { stdout } = await run('node', [FAKE, '--fixture', 'complete'])
    const lines = stdout.trim().split('\n').map((l) => JSON.parse(l) as { type: string })
    expect(lines[0]?.type).toBe('system')
    expect(lines.at(-1)?.type).toBe('result')
  })

  it('exits non-zero and truncates the stream in crash mode', async (): Promise<void> => {
    await expect(run('node', [FAKE, '--fixture', 'crash'])).rejects.toMatchObject({ code: 1 })
  })
})
```

- [ ] **Step 3: Run it, watch it fail, implement the fake, run it again**

Expected first: FAIL (file not found). Then PASS.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test(providers): add the fake claude cli and fixtures"
```

---

## Task 6: `ClaudeCodeAdapter` — start, events, cancel

**Files:**
- Create: `packages/providers/src/claude/flags.ts`, `packages/providers/src/claude/settings.ts`, `packages/providers/src/claude/adapter.ts`
- Test: `packages/providers/test/adapter-start.test.ts`, `packages/providers/test/flags.test.ts`

**Interfaces:**
- Produces:
  - `function claudeFlags(input: { settingsPath: string }): readonly string[]`
  - `class ClaudeCodeAdapter implements AgentRuntimeAdapter` with `readonly id: 'claude-code'`, `getCapabilities()`, `start(input: StartRunInput): Promise<RunHandle>`, `events(runId: RunId): AsyncIterable<RuntimeEvent>`, `cancel(runId: RunId): Promise<void>`
  - `interface StartRunInput { readonly runId: RunId; readonly prompt: string; readonly worktreePath: string; readonly pauseFlagPath: string; readonly settingsPath: string; readonly gitIdentity: { readonly name: string; readonly email: string } }`
  - `interface RunHandle { readonly runId: RunId; readonly pid: number }`
  - `function preflightGate(input: { hookPath: string; flagPath: string }): Promise<void>` — throws if the hook does not discriminate.
- Consumes: `parseStreamLine` from Task 4, the fake CLI from Task 5.

- [ ] **Step 1: Write the failing flag test**

```ts
it('includes every mandatory flag and neither forbidden one', () => {
  const flags = claudeFlags({ settingsPath: '/abs/s.json' })
  expect(flags).toEqual(
    expect.arrayContaining([
      '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--settings', '/abs/s.json',
      '--include-hook-events',
    ]),
  )
  expect(flags).not.toContain('--no-session-persistence')
  expect(flags).not.toContain('--fork-session')
})

// Spec §5.5: a written settings file is not an armed gate. Q9 measured that a wrong or
// unexecutable hook path lets every tool call through with an empty `permission_denials`
// and a terminal event indistinguishable from a healthy run.
it('preflight rejects a hook path that does not exist', async (): Promise<void> => {
  await expect(preflightGate({ hookPath: '/nope/hook.sh', flagPath })).rejects.toThrow()
})

it('preflight rejects a hook that is present but not executable', async (): Promise<void> => {
  chmodSync(hookPath, 0o644)
  await expect(preflightGate({ hookPath, flagPath })).rejects.toThrow()
})

it('preflight rejects a hook that denies unconditionally', async (): Promise<void> => {
  // Both directions, not one. The real pause-gate.sh emits deny JSON and exits 0 when
  // AITEAMOS_PAUSE_FLAG is unset -- its deliberate loud-misconfiguration path -- so a
  // check asserting only "flag present => deny" passes a hook that gates nothing through
  // by denying everything, and the run accomplishes nothing while looking armed.
  await expect(preflightGate({ hookPath: alwaysDenyHook, flagPath })).rejects.toThrow()
})

it('preflight accepts a hook that discriminates', async (): Promise<void> => {
  await expect(preflightGate({ hookPath: realGate, flagPath })).resolves.toBeUndefined()
})

it('refuses a relative settings path', () => {
  expect(() => claudeFlags({ settingsPath: 'rel/s.json' })).toThrow(/absolute/)
})
```

The relative-path rejection matters: ADR 0001 measured only the absolute form, and a settings file the CLI cannot find means the hook never runs — which means pause silently does not work.

`preflightGate` spawns the hook script directly to see whether it discriminates. `pause-gate.sh` opens by draining its stdin (`cat > /dev/null`) before it does anything else, so the spawned child's stdin must be closed immediately — or written an empty payload and ended — or the drain blocks forever and the pre-flight hangs instead of passing or failing.

- [ ] **Step 2: Write the failing adapter test**

```ts
it('streams normalized events and reports the pid', async (): Promise<void> => {
  const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'complete'] })
  const handle = await adapter.start(input)
  expect(handle.pid).toBeGreaterThan(0)

  const seen: RuntimeEvent[] = []
  for await (const event of adapter.events(input.runId)) seen.push(event)

  expect(seen[0]).toEqual({ kind: 'session_started', sessionId: expect.any(String) })
  expect(seen.at(-1)?.kind).toBe('terminated')
  expect(seen.some((e) => e.kind === 'unparsable')).toBe(false)
})

it('sets git identity in the child environment and never writes git config', async (): Promise<void> => {
  // fixture 'env-echo' prints process.env keys as a result payload
  const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'env-echo'] })
  await adapter.start(input)
  const env = await collectEnvFrom(adapter, input.runId)
  expect(env['GIT_AUTHOR_NAME']).toBe(input.gitIdentity.name)
  expect(env['GIT_COMMITTER_EMAIL']).toBe(input.gitIdentity.email)
  expect(env['AITEAMOS_PAUSE_FLAG']).toBe(input.pauseFlagPath)
})
```

- [ ] **Step 3: Run them, watch them fail, implement**

The adapter spawns with `cwd: input.worktreePath`, the env above, and `claudeFlags(...)`. It reads stdout line by line, maps each through `parseStreamLine`, and yields. `cancel()` sends `SIGTERM`, escalating to `SIGKILL` after a grace period.

`getCapabilities()` returns ADR 0001's object verbatim, `supportsCustomSystemPrompt: false` included.

- [ ] **Step 4: Prove the tests bite**

Remove `--include-hook-events` from `claudeFlags` — the flag test must fail. Restore. Remove `GIT_AUTHOR_NAME` from the spawned env — the identity test must fail. Restore. Report both run counts.

- [ ] **Step 5: Commit**

```bash
npm test && npm run typecheck
git add -A && git commit -m "feat(providers): add ClaudeCodeAdapter start, events and cancel"
```

---

## Task 7: `pause-gate.sh` gains a real JSON encoder

ADR 0001 §7, binding. **A malformed deny is an allow**, so this lands before anything writes a dynamic reason.

**Files:**
- Create: `scripts/pause-gate.sh` (from `spike/m0-pause-resume/pause-gate.sh`)
- Test: `packages/providers/test/pause-gate.test.ts`

**Interfaces:**
- Produces: a hook script whose deny payload is valid JSON for **any** reason string.

- [ ] **Step 1: Write the failing test**

```ts
const REASONS = [
  'plain reason',
  'has "double quotes"',
  'has \\ backslash',
  'has\nnewline',
  'has\ttab',
  'unicode ünïcödé and emoji 🚀',
]

it.each(REASONS)('produces valid JSON for reason %j', async (reason): Promise<void> => {
  const { stdout } = await runHook({ flagExists: true, reason })
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string }
  }
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny')
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe(reason)
})
```

The round-trip assertion is the point: it is not enough that the output parses, the reason must survive intact.

Add the two discrimination cases alongside it, because Task 6's `preflightGate` asserts them and this is where the script itself is under test:

```ts
it('emits nothing and exits 0 when the flag is absent', async (): Promise<void> => {
  const { stdout, code } = await runHook({ flagExists: false })
  expect(stdout).toBe('')
  expect(code).toBe(0)
})

it('denies loudly when AITEAMOS_PAUSE_FLAG is unset', async (): Promise<void> => {
  const { stdout, code } = await runHook({ flagVar: undefined })
  expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  expect(code).toBe(0)
})
```

The second is existing behaviour, kept deliberately (ADR 0001 §2) — it is recorded here so the port does not lose it, and so it is visible *why* the pre-flight has to test both directions rather than just the deny.

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL on the quote, backslash, newline and tab cases — `printf` interpolation produces malformed JSON.

- [ ] **Step 3: Implement the encoder**

Copy the script to `scripts/pause-gate.sh` and replace the `printf`-interpolated payload with a real encoder. Prefer piping the reason through a small encoder rather than hand-rolling escapes in bash. Keep every existing property: `set -uo pipefail` without `-e`, explicit exits on every path, the unset-`AITEAMOS_PAUSE_FLAG` loud denial, and the write-failure exit 2.

- [ ] **Step 4: Run the tests again, and re-verify the write-failure path**

```bash
AITEAMOS_PAUSE_FLAG=/tmp/flag ./scripts/pause-gate.sh > /dev/full ; echo "exit=$?"
```
Expected: `exit=2` and a message on stderr.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "fix(hooks): give pause-gate.sh a real JSON encoder"
```

---

## Task 8: Adapter — `requestPause` and the kill protocol

Spec §5.5. **Do not start this task if Task 1 found Q7 fails open** — report instead.

**Files:**
- Modify: `packages/providers/src/claude/adapter.ts`
- Test: `packages/providers/test/adapter-pause.test.ts`

**Interfaces:**
- Produces: `requestPause(runId: RunId, reason: string): Promise<void>`; `awaitPause(runId: RunId, options: { deadlineMs: number }): Promise<PauseOutcome>`; a `{ kind: 'terminated' }` event whose outcome reflects the kill; `PauseOutcome = 'paused' | 'finished_first' | 'gate_failed'`.
- Consumes: `preflightGate` from Task 6 (`packages/providers/src/claude/flags.ts`).

`requestPause` takes a `reason` because ADR 0001 §5's checkpoint requires `pauseReason` and
`requestedBy`, and an operator-supplied reason has no other door into the system. It travels in
the pause flag file's own contents, not an environment variable: a child's environment is fixed
when the run is spawned, but the reason is only known later, when the operator actually requests
the pause — an env var cannot carry a value that doesn't exist yet. `scripts/pause-gate.sh`
already reads the reason from the flag file and preserves it byte-for-byte, falling back to a
static default when the file is empty (Task 7, commit `b2f83d8`); this task only has to write it.

- [ ] **Step 1: Write the failing tests**

```ts
it('kills the process on the first observed hook deny, not on the model stopping', async (): Promise<void> => {
  const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'hook-deny'] })
  const handle = await adapter.start(input)
  await adapter.requestPause(input.runId, 'operator pause')

  const seen: RuntimeEvent[] = []
  for await (const event of adapter.events(input.runId)) seen.push(event)

  const denyIndex = seen.findIndex((e) => e.kind === 'hook_denied')
  expect(denyIndex).toBeGreaterThanOrEqual(0)
  // Nothing after the deny except the terminal event: the process was killed,
  // it did not run to the fixture's natural end.
  expect(seen.slice(denyIndex + 1).filter((e) => e.kind === 'tool_call')).toEqual([])
  expect(await isAlive(handle.pid)).toBe(false)
})

it('treats "pause requested, run finished anyway" as a normal outcome', async (): Promise<void> => {
  const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'complete'] })
  await adapter.start(input)
  await adapter.requestPause(input.runId, 'operator pause')
  const outcome = await adapter.awaitPause(input.runId, { deadlineMs: 2000 })
  expect(outcome).toBe('finished_first')
})

it('reports gate_failed, not finished_first, when tool calls proceed after the flag is written', async (): Promise<void> => {
  // Spec §5.5's runtime backstop. `finished_first` means "no further tool calls", which is
  // benign; this fixture keeps making them with nothing denying, which is not. Conflating the
  // two reports an ungated run as a clean finish -- the failure the Q9 measurement found.
  const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'hook-fail-open'] })
  await adapter.start(input)
  await adapter.requestPause(input.runId, 'operator pause')
  const outcome = await adapter.awaitPause(input.runId, { deadlineMs: 2000 })
  expect(outcome).toBe('gate_failed')
})

it('uses a per-run flag path so pausing one run cannot freeze another', async (): Promise<void> => {
  const a = await startRun({ runId: runIdA, pauseFlagPath: flagA })
  const b = await startRun({ runId: runIdB, pauseFlagPath: flagB })
  await adapter.requestPause(runIdA, 'operator pause')
  expect(existsSync(flagA)).toBe(true)
  expect(existsSync(flagB)).toBe(false)
})
```

- [ ] **Step 2: Run them, watch them fail, implement**

`start()` calls `preflightGate` (Task 6) against the run's hook and flag paths before the run is
considered pausable — `preflightGate` was proven in Task 6 but wired into nothing in production
until here, and a run whose hook does not discriminate must not be allowed to reach a state where
`requestPause` looks armed while gating nothing. `requestPause` writes `reason` into the flag
file's contents. The stream reader, on the first `hook_denied` event, sends `SIGTERM` and escalates to `SIGKILL` after the grace period. `awaitPause` resolves `'paused'` when the process exits after a deny; `'finished_first'` when the terminal `result` arrives with no tool call after the flag write; and `'gate_failed'` when tool calls *did* occur after the flag write unaccompanied by a `hook_denied` or `hook_crashed` — spec §5.5's runtime backstop. The flag is cleared in all three cases. `gate_failed` is the pause path's entry into the pause gate failure of spec §13.1: cancel, `run.failed` + `guardrail.tripped`, count the attempt, halt the workspace.

- [ ] **Step 3: Prove the tests bite**

Remove the kill (let the deny pass through) — the first test must fail. Collapse `gate_failed` into `finished_first` — the backstop test must fail. Share one flag path between runs — the last must fail. Report run counts in every direction.

- [ ] **Step 4: Commit**

```bash
npm test && npm run typecheck
git add -A && git commit -m "feat(providers): implement the pause protocol"
```

---

## Task 9: Adapter — checkpoint capture and `resume`

**Files:**
- Modify: `packages/providers/src/claude/adapter.ts`
- Create: `packages/providers/src/claude/checkpoint.ts`
- Test: `packages/providers/test/adapter-resume.test.ts`

**Interfaces:**
- Produces:
  - `interface Checkpoint { readonly sessionId: string; readonly worktreePath: string; readonly pauseFlagPath: string; readonly lastToolUseId: string | null; readonly lastToolName: string | null; readonly numTurns: number; readonly deniedToolUseIds: readonly string[]; readonly headCommit: string; readonly dirtyFiles: readonly string[]; readonly cumulativeCostUsd: number; readonly cumulativeTokens: number }`
  - `resume(runId: RunId, checkpoint: Checkpoint, queuedInstruction: string | null): Promise<RunHandle>`

- [ ] **Step 1: Write the failing tests**

```ts
it('refuses to resume while the pause flag still exists', async (): Promise<void> => {
  writeFileSync(checkpoint.pauseFlagPath, '')
  await expect(adapter.resume(runId, { ...checkpoint, pauseFlagPath: BLOCKED }, null))
    .rejects.toThrow(/pause flag/)
})

it('resumes with the same session id and never mints a new one', async (): Promise<void> => {
  const handle = await adapter.resume(runId, checkpoint, 'name the class MathKit')
  const args = spawnedArgsFor(handle)
  expect(args).toContain('--resume')
  expect(args).toContain(checkpoint.sessionId)
  expect(args).not.toContain('--fork-session')
})

it('passes the queued instruction as the prompt', async (): Promise<void> => {
  const handle = await adapter.resume(runId, checkpoint, 'do the other thing')
  expect(spawnedArgsFor(handle)).toContain('do the other thing')
})
```

The first test is the important one: ADR 0001 measured that a surviving flag makes the hook deny everything, so a resume that does not verify the flag's absence produces a run that cannot act and looks like a pause loop.

- [ ] **Step 2: Run them, watch them fail, implement**

`resume` clears the flag, `stat`s it to confirm absence, and spawns with the same worktree, settings and posture plus `--resume <sessionId>`.

- [ ] **Step 3: Prove the flag check bites**

Remove the absence verification — the first test must fail.

- [ ] **Step 4: Commit**

```bash
npm test && npm run typecheck
git add -A && git commit -m "feat(providers): add checkpoint capture and resume"
```

---

## Task 10: `apps/orchestrator` scaffold and `loadWorld`

**Files:**
- Create: `apps/orchestrator/package.json`, `tsconfig.json`, `tsconfig.test.json`, `src/world.ts`
- Test: `apps/orchestrator/test/integration/world.test.ts`
- Modify: root `tsconfig.json`, root `package.json`, `vitest.config.ts`

**Interfaces:**
- Produces: `function loadWorld(workspaceId: WorkspaceId): Promise<LoadedWorld>` where `interface LoadedWorld { readonly world: World; readonly skippedNoRole: number }`
- Consumes: `World`, `SchedulableTask`, `SchedulableAgent` from `@ai-team-os/domain`; `prisma` from `@ai-team-os/db/client`.

- [ ] **Step 1: Write the failing test**

```ts
it('marks a task ready only when every dependency is done', async (): Promise<void> => {
  const { world } = await loadWorld(workspaceId)
  const blocked = world.tasks.find((t) => t.id === blockedTaskId)
  expect(blocked?.dependenciesDone).toBe(false)
})

it('counts tasks with no required role instead of silently dropping them', async (): Promise<void> => {
  const { world, skippedNoRole } = await loadWorld(workspaceId)
  expect(world.tasks.some((t) => t.id === roleless)).toBe(false)
  expect(skippedNoRole).toBe(1)
})

it('reports an agent busy when it holds a non-terminal run', async (): Promise<void> => {
  const { world } = await loadWorld(workspaceId)
  expect(world.agents.find((a) => a.id === agentWithRun)?.busy).toBe(true)
})
```

- [ ] **Step 2: Run them, watch them fail, implement**

`dependenciesDone` is computed in SQL from `TaskDependency`. `busy` comes from a non-terminal `AgentRun`. `stats.emergencyStopped` is **`Workspace.haltedReason !== null`** — a pause gate failure sets it (spec §4, §13.1), and M8 adds the human-facing emergency stop on top of the same column. It is not hardcoded `false`.

- [ ] **Step 3: Prove the role test bites**

Give the roleless task a role in the fixture — `skippedNoRole` must drop to 0 and the task must appear.

- [ ] **Step 4: Commit**

```bash
npm test && npm run typecheck
git add -A && git commit -m "feat(orchestrator): add loadWorld"
```

---

## Task 11: Worktree provisioning and setup commands

Real git, a temporary fixture repository.

**Files:**
- Create: `apps/orchestrator/src/worktree.ts`
- Test: `apps/orchestrator/test/integration/worktree.test.ts`

**Interfaces:**
- Produces:
  - `function provisionWorktree(input: { repoPath: string; baseBranch: string; taskKey: string; slug: string; setupCommands: readonly string[] }): Promise<WorktreeHandle>`
  - `interface WorktreeHandle { readonly path: string; readonly branch: string; readonly headCommit: string }`

- [ ] **Step 1: Write the failing tests**

```ts
it('creates a worktree on its own branch from the base branch', async (): Promise<void> => {
  const wt = await provisionWorktree({ ...base, taskKey: 'TASK-001', slug: 'add-thing' })
  expect(wt.branch).toBe('aiteamos/TASK-001-add-thing')
  expect(wt.path).toContain('.aiteamos/worktrees/TASK-001')
  expect(existsSync(join(wt.path, '.git'))).toBe(true)
})

it('runs the setup commands inside the worktree before returning', async (): Promise<void> => {
  const wt = await provisionWorktree({ ...base, setupCommands: ['touch SETUP_RAN'] })
  expect(existsSync(join(wt.path, 'SETUP_RAN'))).toBe(true)
})

it('fails loudly when a setup command fails, and preserves the worktree', async (): Promise<void> => {
  await expect(provisionWorktree({ ...base, setupCommands: ['exit 3'] }))
    .rejects.toThrow(/setup command/)
  expect(existsSync(expectedPath)).toBe(true)
})

it('leaves the base branch untouched', async (): Promise<void> => {
  const before = headOf(base.repoPath, base.baseBranch)
  await provisionWorktree(base)
  expect(headOf(base.repoPath, base.baseBranch)).toBe(before)
})

it('writes nothing to the git common directory', async (): Promise<void> => {
  const before = readFileSync(join(base.repoPath, '.git/config'), 'utf8')
  await provisionWorktree(base)
  expect(readFileSync(join(base.repoPath, '.git/config'), 'utf8')).toBe(before)
})
```

The last test encodes spec §7.3's general rule, which the M0 spike surfaced through a git-identity collision between two concurrent agents.

- [ ] **Step 2: Run them, watch them fail, implement**

Every git invocation the orchestrator issues uses `git -c user.name=... -c user.email=...` so nothing persists.

- [ ] **Step 3: Commit**

```bash
npm test && npm run typecheck
git add -A && git commit -m "feat(orchestrator): provision worktrees with setup commands"
```

---

## Task 12: The event pump

Spec §5.6. `RuntimeEvent` → domain event → `appendEvent`, one concurrent pump per run.

**Files:**
- Create: `apps/orchestrator/src/pump.ts`
- Test: `apps/orchestrator/test/integration/pump.test.ts`

**Interfaces:**
- Produces: `function pumpRun(input: { runId: RunId; taskId: TaskId; agentId: AgentId; workspaceId: WorkspaceId; events: AsyncIterable<RuntimeEvent>; cancel: () => Promise<void> }): Promise<RunOutcome | null>`
- Consumes: `appendEvent` from `@ai-team-os/events`; `cancel` is the caller's binding of the adapter's `cancel(runId)` (Task 6) — the pump reacts to a gate failure, it does not hold the process handle.

- [ ] **Step 1: Write the failing tests**

```ts
it('emits run.started only when the session id arrives, not at spawn', async (): Promise<void> => {
  await pumpRun({ ...ids, events: fromArray([
    { kind: 'session_started', sessionId: 's-1' },
    { kind: 'terminated', outcome: okOutcome },
  ]) })
  const types = await eventTypesFor(ids.runId)
  expect(types[0]).toBe('run.started')
})

it('maps a permission-mode denial to guardrail.tripped, never to run.paused', async (): Promise<void> => {
  await pumpRun({ ...ids, events: fromArray([
    { kind: 'permission_denied', toolName: 'Edit', toolUseId: 'tu_1' },
    { kind: 'terminated', outcome: okOutcome },
  ]) })
  const types = await eventTypesFor(ids.runId)
  expect(types).toContain('guardrail.tripped')
  expect(types).not.toContain('run.paused')
})

it('records an unparsable line without killing the run', async (): Promise<void> => {
  const outcome = await pumpRun({ ...ids, events: fromArray([
    { kind: 'unparsable', line: '{bad' },
    { kind: 'session_started', sessionId: 's-1' },
    { kind: 'terminated', outcome: okOutcome },
  ]) })
  expect(outcome).not.toBeNull()
  const types = await eventTypesFor(ids.runId)
  expect(types).toContain('run.started')
})

it('reports a clean-completion-with-denials run as failed', async (): Promise<void> => {
  await pumpRun({ ...ids, events: fromArray([
    { kind: 'session_started', sessionId: 's-1' },
    { kind: 'terminated', outcome: { ...okOutcome, deniedToolUseIds: ['tu_1'] } },
  ]) })
  expect(await eventTypesFor(ids.runId)).toContain('run.failed')
})

it('reacts to a blocking hook crash before any terminated event arrives: cancels, fails the run, halts the workspace', async (): Promise<void> => {
  const cancel = vi.fn(async (): Promise<void> => {})
  await pumpRun({ ...ids, cancel, events: fromArray([
    { kind: 'session_started', sessionId: 's-1' },
    { kind: 'hook_crashed', hookName: 'PreToolUse:Bash', exitCode: 2, stderr: 'deliberate hook crash' },
  ]) })
  expect(cancel).toHaveBeenCalled()
  const types = await eventTypesFor(ids.runId)
  expect(types).toContain('run.failed')
  expect(types).toContain('guardrail.tripped')
  const failedEvent = await prisma.executionEvent.findFirstOrThrow({ where: { runId: ids.runId, type: 'run_failed' } })
  expect((failedEvent.payload as { reason: string }).reason).toMatch(/stopped/i)
  const task = await prisma.task.findUniqueOrThrow({ where: { id: ids.taskId } })
  expect(task.attempt).toBe(1)
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: ids.workspaceId } })
  expect(workspace.haltedReason).not.toBeNull()
  expect(workspace.haltedAt).not.toBeNull()
})

it('reacts to a fail-open hook failure with a reason that must not read like the blocking crash above', async (): Promise<void> => {
  const cancel = vi.fn(async (): Promise<void> => {})
  await pumpRun({ ...ids, cancel, events: fromArray([
    { kind: 'session_started', sessionId: 's-1' },
    { kind: 'hook_failed_open', hookName: 'PreToolUse:Write', exitCode: 127, stderr: '/bin/sh: line 1: /nope/hook.sh: No such file or directory' },
  ]) })
  expect(cancel).toHaveBeenCalled()
  const failedEvent = await prisma.executionEvent.findFirstOrThrow({ where: { runId: ids.runId, type: 'run_failed' } })
  // Spec §13.1: the blocking crash says the run was stopped; this one must say the run kept
  // going ungated for the whole window between the flag and the cancel landing. Same wording
  // as the test above is the conflation ADR 0001 and spec §13.1 warn against.
  expect((failedEvent.payload as { reason: string }).reason).toMatch(/ungated|no gate|kept (going|running|acting)/i)
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: ids.workspaceId } })
  expect(workspace.haltedReason).not.toBeNull()
})
```

The fourth test is the one that matters most: ADR 0001 recorded a run reporting `is_error: false` while landing nothing, detectable only through `permission_denials`. The last two are the pause gate failure of spec §13.1 (not the pause path of Task 8 — this is the pump reacting to a gate failure that arrives outside a requested pause): the pump must not wait for `terminated` to react, and the two shapes must never share a `run.failed` reason.

- [ ] **Step 2: Run them, watch them fail, implement**

On `hook_crashed` or `hook_failed_open`, the pump does not wait for the stream to end. It calls
`cancel()` immediately (`SIGTERM`, escalating to `SIGKILL` — the one control that does not depend
on the hook), emits `run.failed` carrying the gate reason and `guardrail.tripped`, increments
`Task.attempt`, and writes `Workspace.haltedReason` and `haltedAt` (spec §13.1). This is the only
place either column is ever set to a non-null value; clearing them is an operator action (Task 16).
`decide()` already returns `halt` once `stats.emergencyStopped` is true (Task 10, Task 13) — this
task only has to make the column true. Keep the two `run.failed` reasons distinct: `hook_crashed`
reports a run that stopped and landed nothing beyond the crash; `hook_failed_open` reports a run
that kept acting with no gate at all, and must name that window rather than imply the run was under
control.

- [ ] **Step 3: Prove the denial mapping bites**

Four mutations, because there are now four shapes to conflate (spec §5.3, §12.3), not two:

1. Swap the `permission_denied` and `hook_denied` handlers — the denial test must fail.
2. Map `hook_failed_open` onto `hook_crashed` — a test must fail. This is the dangerous
   conflation: it reports a run that kept acting as one that stopped.
3. Make the pump defer its gate-failure reaction to the end of the stream — react to
   `hook_crashed`/`hook_failed_open` only once `terminated` arrives, instead of immediately. Both
   gate-failure tests above must fail, because neither of their event arrays ever reaches a
   `terminated`: that is the point of them. A gate failure that waits for the stream to end is a
   gate failure that never fires, because the run whose gate has failed is precisely the run that
   may never terminate on its own.
   (The matching conflation on the *parser* side — dropping the `hook_event` guard so every
   `hook_response` is classified by `exit_code`, which makes every healthy run end in a fabricated
   gate failure — belongs to Task 4, whose `Stop`-hook test already covers it. It is named here
   only so the two halves of one hazard are findable from each other. It is not a mutation of this
   task's code and must not be run as one of them.)
4. Remove the workspace halt write on a gate failure — the blocking-crash test above, which
   already asserts `haltedReason` and `haltedAt` are set, must fail. Whether that write then stops
   a second run from starting on the next tick, and whether it survives a restart in a fresh
   process, are Task 13's and Task 15's proofs respectively (it is a `Workspace` column precisely
   so that both hold) — not this task's, which only has to show the pump writes it.

Restore after each. Report run counts.

- [ ] **Step 4: Commit**

```bash
npm test && npm run typecheck
git add -A && git commit -m "feat(orchestrator): add the per-run event pump"
```

---

## Task 13: The tick — decide and execute

**Files:**
- Create: `apps/orchestrator/src/tick.ts`
- Test: `apps/orchestrator/test/integration/tick.test.ts`

**Interfaces:**
- Produces: `function tick(deps: TickDeps): Promise<TickReport>` where `interface TickReport { readonly started: readonly RunId[]; readonly halted: string | null; readonly skippedNoRole: number }`
- Consumes: `loadWorld` (Task 10), `provisionWorktree` (Task 11), `pumpRun` (Task 12), `decide` from `@ai-team-os/domain`, the adapter from Task 6.

- [ ] **Step 1: Write the failing tests**

```ts
it('starts a run for a ready task and records its pid and worktree', async (): Promise<void> => {
  const report = await tick(deps)
  expect(report.started).toHaveLength(1)
  const run = await prisma.agentRun.findFirstOrThrow()
  expect(run.pid).toBeGreaterThan(0)
  expect(run.worktreePath).toContain('.aiteamos/worktrees/')
})

it('emits guardrail.tripped and starts nothing when decide halts', async (): Promise<void> => {
  await setBudgetExhausted(workspaceId)
  const report = await tick(deps)
  expect(report.started).toEqual([])
  expect(report.halted).not.toBeNull()
  expect(await eventTypesFor(workspaceId)).toContain('guardrail.tripped')
})

it('does not repeat guardrail.tripped on a second tick while still halted', async (): Promise<void> => {
  await setBudgetExhausted(workspaceId)
  await tick(deps)
  const countAfterFirst = (await eventTypesFor(workspaceId)).filter((t) => t === 'guardrail.tripped').length
  await tick(deps)
  const countAfterSecond = (await eventTypesFor(workspaceId)).filter((t) => t === 'guardrail.tripped').length
  expect(countAfterSecond).toBe(countAfterFirst)
})

it('records a provisioning failure as a failed run that counts as an attempt', async (): Promise<void> => {
  await setSetupCommands(workspaceId, ['exit 3'])
  await tick(deps)
  const run = await prisma.agentRun.findFirstOrThrow()
  expect(run.status).toBe('failed')
  const task = await prisma.task.findFirstOrThrow()
  expect(task.attempt).toBe(1)
  expect(await eventTypesFor(workspaceId)).toContain('run.failed')
})

it('gives a reworked task a second run instead of burning its attempts on provisioning', async (): Promise<void> => {
  // Task 11's fix round: `decide()` lists `rework` in STARTABLE, so a task that failed verify
  // arrives back at `provisionWorktree` with the same key, and the worktree and branch from its
  // first attempt are still there (spec §7.4 preserves them). `provisionWorktree` refuses with a
  // typed `WorktreeExistsError` rather than clobbering; what it CANNOT know is why the leftovers
  // exist, so the policy is this task's. Treating it as a plain provisioning failure is the one
  // outcome that is definitely wrong: it counts an attempt (spec §13) without a run, and the task
  // reaches its cap without a second agent ever starting.
  await givenReworkedTaskWithExistingWorktree()
  const report = await tick(deps)
  expect(report.started).toHaveLength(1)
  const task = await prisma.task.findFirstOrThrow()
  expect(task.attempt).toBe(1) // the failed verify's attempt, not a second one for provisioning
})

it('starts no second run on the next tick after a gate failure halted the workspace', async (): Promise<void> => {
  // The halt Task 12's pump writes on a gate failure (spec §13.1) is the same
  // `Workspace.haltedReason` column `decide()` reads as `stats.emergencyStopped` — this is the
  // tick's side of proving that a halted workspace stays uncontrollable-run-free, not the pump's.
  await prisma.workspace.update({ where: { id: workspaceId }, data: { haltedReason: 'gate failure', haltedAt: new Date() } })
  const report = await tick(deps)
  expect(report.started).toEqual([])
})
```

- [ ] **Step 2: Run them, watch them fail, implement**

**`WorktreeExistsError` must be handled explicitly, and the policy decided here.** Two candidates,
and the report must say which was chosen and why: *adopt* the existing worktree (the branch is where
the first attempt's work lives, and §8's rework is meant to continue that work rather than start
beside it) or *escalate* (the worktree may be the wreckage of a crash, which §7.4 preserved on
purpose for an operator to look at). They are indistinguishable from inside `provisionWorktree`,
which is why it raises a typed error instead of guessing. Whichever is chosen, the error must not
fall through to the generic provisioning-failure path.

**`taskKey` and `slug` have to come from somewhere, and nothing says where.** `Task` has no `key`
column (§10, `schema.prisma`), and neither spec §7.1 nor this plan names a source. This task
invents them, so it owns the rule: both are validated against `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` by
`provisionWorktree` (they become a path segment and a branch name), and a synthesized value that
fails it throws at provisioning. Deriving a slug from a human-written title therefore needs
sanitising, not truncating. Persist whatever is synthesized — the same key must be reproducible on
the task's second run, or the adopt case above can never match.

`decide()` returns the `halt` command on every tick the condition holds (spec §3.2), but
`guardrail.tripped` is emitted only **on the transition into halted** — never on a tick that
observes a halt already in effect. At the default 1000ms period, a persistent halt (§13.1) that
waits for an operator would otherwise write one event per second, forever, into an append-only log.
Track whether the previous tick was already halted (in memory is enough; the persistence that
matters is `Workspace.haltedReason` itself, not this flag) and only emit on the `false → true` edge.

- [ ] **Step 3: Prove the attempt counting bites**

Stop incrementing `attempt` on provisioning failure — the third test must fail, and note in the report that without it a permanently unprovisionable task loops forever. Ignore an already-set `Workspace.haltedReason` when computing `stats.emergencyStopped` — the new halted-workspace test must fail, showing a second run start on the very next tick, which is exactly the uncontrolled continuation the pump's halt write exists to prevent.

- [ ] **Step 4: Commit**

```bash
npm test && npm run typecheck
git add -A && git commit -m "feat(orchestrator): add the tick loop"
```

---

## Task 14: Verify and advance

Spec §8.

**Files:**
- Create: `apps/orchestrator/src/verify.ts`
- Test: `apps/orchestrator/test/integration/verify.test.ts`

**Interfaces:**
- Produces:
  - `function runVerify(input: { taskId: TaskId; worktreePath: string; artifactDir: string; commands: readonly string[]; timeoutMs: number }): Promise<VerifyResult>`
  - `interface VerifyResult { readonly passed: boolean; readonly failedCommand: string | null; readonly exitCode: number | null; readonly output: string }`
  - `function advance(input: { taskId: TaskId; result: VerifyResult; branch: string }): Promise<void>`

- [ ] **Step 1: Write the failing tests**

```ts
it('refuses to pass a task whose verify list is empty', async (): Promise<void> => {
  const result = await runVerify({ ...base, commands: [] })
  expect(result.passed).toBe(false)
  await advance({ taskId, result, branch })
  expect((await task()).status).not.toBe('done')
  expect(await eventTypesFor(workspaceId)).toContain('guardrail.tripped')
})

it('runs the commands in order and stops at the first failure', async (): Promise<void> => {
  const result = await runVerify({ ...base, commands: ['touch A', 'exit 1', 'touch B'] })
  expect(result.passed).toBe(false)
  expect(result.failedCommand).toBe('exit 1')
  expect(existsSync(join(worktreePath, 'A'))).toBe(true)
  expect(existsSync(join(worktreePath, 'B'))).toBe(false)
})

it('attaches the failure output to the next run through lastRejectionReason', async (): Promise<void> => {
  const result = await runVerify({ ...base, commands: ['echo BOOM >&2; exit 1'] })
  await advance({ taskId, result, branch })
  const t = await task()
  expect(t.status).toBe('rework')
  expect(t.lastRejectionReason).toContain('BOOM')
})

it('moves the task to done with its branch when every command passes', async (): Promise<void> => {
  const result = await runVerify({ ...base, commands: ['true'] })
  await advance({ taskId, result, branch: 'aiteamos/TASK-001-x' })
  const t = await task()
  expect(t.status).toBe('done')
  expect(t.branch).toBe('aiteamos/TASK-001-x')
})

it('moves the task to failed when the attempt cap is reached', async (): Promise<void> => {
  await setAttempt(taskId, 5) // seeded maxAttempts is 5
  const result = await runVerify({ ...base, commands: ['false'] })
  await advance({ taskId, result, branch })
  expect((await task()).status).toBe('failed')
})
```

- [ ] **Step 2: Run them, watch them fail, implement**

Each command's exit code and captured output is written as an `Artifact` row. Task transitions emit `task.verifying`, then `task.verify_passed` + `task.done`, or `task.verify_failed` + `task.rework`, or `task.failed`.

`artifactDir` is explicit rather than derived from `worktreePath`, because the logs must not be written *inside* the worktree — that is what the agent commits from, and Task 13 already had to move the run's settings file and pause flag out for the same reason. Deriving the path by walking up from the worktree would couple verify to Task 11's layout constant silently.

Run the commands with the shared runner from Task 11's provisioning rather than a second `execFile`: `npm test` is the same class of arbitrary shell as `npm ci`, and every hazard that runner fixed applies here unchanged — a 1 MiB buffer that kills a chatty-but-passing command and reports it as a failure, a timeout that misses a descendant outside the process group, an open stdin that hangs anything reading it, and per-chunk UTF-8 decoding that corrupts multi-byte output.

- [ ] **Step 3: Prove the empty-list refusal bites**

Make an empty list pass — the first test must fail. This is the behaviour spec §8 exists to protect: assuming success.

Seed the attempt-cap test at `maxAttempts - 1`, not at `maxAttempts`: starting at the cap leaves `>=` and `>` indistinguishable once the attempt is incremented, so the test cannot see an off-by-one in the one comparison it exists for. Pair it with a below-cap case, or every task quietly gets one attempt fewer than its workspace configured.

- [ ] **Step 4: Commit**

```bash
npm test && npm run typecheck
git add -A && git commit -m "feat(orchestrator): add verify and advance"
```

---

## Task 15: Sweep and startup reconciliation

Spec §3.3 and §3.4.

**Files:**
- Create: `apps/orchestrator/src/sweep.ts`
- Test: `apps/orchestrator/test/integration/sweep.test.ts`

**Interfaces:**
- Produces: `function sweep(deps: SweepDeps): Promise<SweepReport>`, `function reconcileOrphans(deps: SweepDeps): Promise<number>`
- `interface SweepReport { readonly timedOut: readonly RunId[]; readonly overToolCap: readonly RunId[]; readonly deadPids: readonly RunId[] }`

- [ ] **Step 1: Write the failing tests**

```ts
it('marks a run failed when its pid is gone but its status is not terminal', async (): Promise<void> => {
  await givenRun({ status: 'working', pid: 999999 }) // certainly not running
  const count = await reconcileOrphans(deps)
  expect(count).toBe(1)
  const run = await prisma.agentRun.findFirstOrThrow()
  expect(run.status).toBe('failed')
  expect(await eventTypesFor(workspaceId)).toContain('run.failed')
})

it('preserves the worktree of an orphaned run', async (): Promise<void> => {
  await givenRun({ status: 'working', pid: 999999, worktreePath })
  await reconcileOrphans(deps)
  expect(existsSync(worktreePath)).toBe(true)
})

it('cancels a run past its wall-clock timeout', async (): Promise<void> => {
  await givenRun({ status: 'working', startedAt: hoursAgo(2) })
  const report = await sweep(deps)
  expect(report.timedOut).toHaveLength(1)
  expect(await eventTypesFor(workspaceId)).toContain('guardrail.tripped')
})

it('cancels a run past the tool-call ceiling', async (): Promise<void> => {
  await givenRun({ status: 'working', toolCalls: 500 }) // seeded cap is 200
  const report = await sweep(deps)
  expect(report.overToolCap).toHaveLength(1)
})

it('leaves a paused run alone: it legitimately has no process, and failing it would destroy the pause', async (): Promise<void> => {
  // A paused run's process was killed by the adapter on purpose -- that is what pausing *is*
  // (Task 8) -- so it presents with a dead pid and a non-terminal status, which is precisely the
  // orphan shape the first test above fails. The sweep must discriminate on status, not on
  // liveness alone, or the first daemon restart destroys every paused run in the fleet along with
  // the checkpoint written to preserve it.
  await givenRun({ status: 'paused', pid: 999999 })
  const count = await reconcileOrphans(deps)
  expect(count).toBe(0)
  const run = await prisma.agentRun.findFirstOrThrow()
  expect(run.status).toBe('paused')
})

it('a workspace halt written by a gate failure is still there for the fresh process that reconciles at startup', async (): Promise<void> => {
  // Task 12's pump writes `Workspace.haltedReason` on a gate failure; this is startup
  // reconciliation's proof that a restart cannot lose it -- the column is chosen precisely so a
  // fresh process, with nothing held over in memory, still sees it (Task 3).
  await prisma.workspace.update({ where: { id: workspaceId }, data: { haltedReason: 'gate failure', haltedAt: new Date() } })
  const restarted = new PrismaClient() // simulates the restart: no state carried from the old process
  await reconcileOrphans({ ...deps, prisma: restarted })
  const workspace = await restarted.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
  expect(workspace.haltedReason).toBe('gate failure')
  await restarted.$disconnect()
})
```

- [ ] **Step 2: Run them, watch them fail, implement**

Liveness is `process.kill(pid, 0)` in a try/catch — never a coarse "is the run old" heuristic.

`paused` is excluded from the orphan pass *before* liveness is ever consulted. Spec §3.4 says the
pass marks every non-terminal run with a dead pid `failed`, and `paused` is non-terminal — but a
paused run has no process by design, so the rule as written would fail exactly the runs this
milestone built the pause protocol to preserve. Excluding it is completing the rule against Task 8's
behaviour, not contradicting §3.4: the rule's subject is a run whose process died *unexpectedly*,
and a paused run's did not.

- [ ] **Step 3: Prove the orphan sweep bites**

Skip the orphan pass at startup — the first test must fail, and note that without it every daemon restart leaves the database describing runs that are not running. Remove the `paused` exclusion so the pass discriminates on liveness alone — the paused-run test must fail, and it is worth noting in the report that this mutation is the shape of the bug: it is silent, it looks like the sweep working, and it destroys state on a restart rather than on the change that introduced it. Have the orphan pass clear `Workspace.haltedReason` alongside the runs it fails — the restart test must fail; clearing a workspace-wide halt automatically, on any pass, is reserved for the operator's `clear-halt` (Task 16), never automatic (spec §13.1).

- [ ] **Step 4: Commit**

```bash
npm test && npm run typecheck
git add -A && git commit -m "feat(orchestrator): add the sweep and startup reconciliation"
```

---

## Task 16: CLI and daemon

**Files:**
- Create: `apps/orchestrator/src/cli.ts`, `apps/orchestrator/src/daemon.ts`
- Modify: root `package.json` (add an `orchestrator` script)
- Test: `apps/orchestrator/test/integration/cli.test.ts`

**Interfaces:**
- Produces: `tick`, `daemon`, `pause --run <id>`, `resume --run <id> [--message <text>]`, `cancel --run <id>`, `clear-halt --workspace <id>`, `status`.

- [ ] **Step 1: Write the failing tests**

```ts
it('runs exactly one tick and prints a report', async (): Promise<void> => {
  const { stdout } = await runCli(['tick'])
  expect(JSON.parse(stdout)).toMatchObject({ started: expect.any(Array) })
})

it('pauses a run and reports the outcome', async (): Promise<void> => {
  const { stdout } = await runCli(['pause', '--run', runId])
  expect(stdout).toMatch(/paused|finished_first/)
})

it('exits non-zero for an unknown run', async (): Promise<void> => {
  await expect(runCli(['pause', '--run', 'nope'])).rejects.toMatchObject({ code: 1 })
})

it('clears a workspace safety halt', async (): Promise<void> => {
  await runCli(['clear-halt', '--workspace', workspaceId])
  const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
  expect(ws.haltedReason).toBeNull()
  expect(ws.haltedAt).toBeNull()
})
```

- [ ] **Step 2: Run them, watch them fail, implement**

The daemon wires the periodic timer **and** the M2 `subscribeEvents` wake-up to the same `tick`. On shutdown it awaits the subscription's `close()`, which can take up to ~6.25 seconds — budget past that, do not race it.

`clear-halt --workspace <id>` writes `haltedReason = null`, `haltedAt = null` and is the only thing that does — clearing is an operator action, never automatic (spec §11, §13.1). Its help text must make it unmistakable that it retracts a **workspace-wide safety halt** and starts nothing by itself, so that it cannot be read as a variant of `resume --run`, which continues one paused run. `status` prints any workspace halt with its reason alongside the run list: the halt reason lives in `Workspace.haltedReason`, because `decide()` surfaces only the guardrail *name* (`emergency_stop`) and that says nothing about the hook path that caused it.

- [ ] **Step 3: Commit**

```bash
npm test && npm run typecheck
git add -A && git commit -m "feat(orchestrator): add the CLI and daemon"
```

---

## Task 17: The milestone gate, documentation, and an ADR

Spec §16.

**Files:**
- Create: `apps/orchestrator/test/integration/milestone-gate.test.ts`
- Create: `docs/decisions/0004-orchestrator-command-boundary.md`
- Modify: `README.md`, `docs/architecture.md` (create if absent)

**Interfaces:**
- Consumes: everything from Tasks 1-16.

- [ ] **Step 1: Write the end-to-end gate test**

Against the fake `claude`, from a seeded ready task: tick → worktree provisioned, setup ran → run streamed → verify green → task `done` with a branch. Then the red path: verify fails → task `rework` with `lastRejectionReason` set. Then the pause path: pause → checkpoint written → resume → run completes.

- [ ] **Step 2: Run it and make it pass**

- [ ] **Step 3: Run the gate once by hand against the real CLI**

Record the captures under `docs/superpowers/spikes/`. State plainly in the report which steps were exercised against the real CLI and which only against the fake — spec §16 requires steps 3-4 to have a real run behind them.

- [ ] **Step 4: Write ADR 0004**

Record the boundary decision: `decide()` was not widened, so M3's reactive behaviour lives outside the pure core, and the cost is paid by the explicit mutations listed in spec §12.3. Include the alternative that was rejected (widening the `Command` union) and why: it would force `World` to carry process state.

- [ ] **Step 5: Document**

README gains an orchestrator section: how to run a tick, how to run the daemon, what a worktree looks like, and the fact that a fresh worktree needs setup commands. `docs/architecture.md` gets the topology and the dependency rule that `packages/providers` never imports `packages/db`.

- [ ] **Step 6: Commit**

```bash
npm test && npm run typecheck
git add -A && git commit -m "feat(orchestrator): close the M3 milestone gate"
```

---

## Self-Review Notes

**Spec coverage:** §1 → Tasks 13-14; §2 → Task 4 (scaffold) and enforced throughout; §3 → Tasks 13, 15; §4 → Task 10; §5 → Tasks 4, 6, 8, 9, 12; §6 → Tasks 3, 9; §7 → Task 11; §8 → Task 14; §9 → Task 2; §10 → Tasks 2, 3; §11 → Task 16; §12 → Tasks 5 and the mutation steps in 6, 8, 9, 12, 13, 14, 15; §13 → Tasks 12, 13, 14, 15; §14 → Task 1; §16 → Task 17.

**Ordering constraint:** Task 1 gates Task 8. Task 7 gates Task 8. Task 2 gates Task 12 (the pump emits types that must exist). Task 3 gates Tasks 10, 13, 14. Tasks 4-6 gate Task 13.

**Known plan risk:** Task 5's fixtures are hand-derived where M0's captures do not cover a shape. A fixture that does not match the real CLI produces an adapter that passes its tests and fails against reality. Task 17 Step 3 is the check that catches it — that is why the real run is part of the gate rather than optional.
