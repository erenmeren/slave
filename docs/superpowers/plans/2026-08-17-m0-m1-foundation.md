# AI Team OS — M0 + M1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that a Claude Code run can be paused at a tool-call boundary and resumed from its session inside a git worktree (M0), then build the fully tested, dependency-free domain core that every later milestone is built on (M1).

**Architecture:** M0 is a throwaway spike whose only deliverable is a findings document and one reusable hook script. M1 creates an npm-workspaces monorepo whose `packages/domain` has zero runtime dependencies except Zod — pure functions for state machines, event schemas, guardrail evaluation, scheduling, and merge-queue decisions, each developed test-first.

**Tech Stack:** Node 26, TypeScript 5 (strict), Vitest, Zod, npm workspaces. No database, no UI, no framework in this plan.

**Spec:** `docs/superpowers/specs/2026-08-17-ai-team-os-design.md`

## Global Constraints

- Node >= 26; npm >= 12 (npm workspaces — do not introduce pnpm or yarn).
- TypeScript `strict: true`. `any` is forbidden; use `unknown` plus a narrowing guard.
- All code, comments, identifiers, test names, commit messages, and documentation are in **English**.
- `packages/domain` may depend on **Zod only**. No Prisma, no React, no `fs`, no `node:*`, no network.
- Every exported type and function is explicitly typed; no reliance on inference at module boundaries.
- Commit messages follow Conventional Commits (`feat:`, `test:`, `docs:`, `chore:`, `spike:`).
- Domain state transitions never throw. They return `Result<T, E>`.
- Spike code (Task 1-6) is explicitly throwaway and lives under `spike/`; only the findings document and the pause-gate hook script survive into later milestones.

---

## File Structure

### M0 — Spike (throwaway except where noted)

| File | Responsibility |
|---|---|
| `spike/m0-pause-resume/README.md` | How to re-run the spike |
| `spike/m0-pause-resume/pause-gate.sh` | PreToolUse hook: blocks the next tool call when the pause flag file exists. **Survives into M3.** |
| `spike/m0-pause-resume/settings.json` | Claude Code settings registering the hook |
| `docs/superpowers/spikes/2026-08-17-m0-pause-resume-findings.md` | The actual deliverable: measured behaviour and the resulting decision. **Survives.** |
| `docs/decisions/0001-pause-semantics.md` | ADR recording the pause mechanism M3 will implement. **Survives.** |

### M1 — Domain core

| File | Responsibility |
|---|---|
| `package.json` | npm workspaces root |
| `tsconfig.base.json` | Shared strict compiler options |
| `vitest.config.ts` | Test runner configuration |
| `packages/domain/package.json` | Domain package manifest |
| `packages/domain/tsconfig.json` | Extends the base config |
| `packages/domain/src/index.ts` | Public barrel export |
| `packages/domain/src/result.ts` | `Result<T, E>` and constructors |
| `packages/domain/src/ids.ts` | Branded identifier types |
| `packages/domain/src/task/state.ts` | `TaskStatus`, `TaskEvent`, `applyTaskEvent` |
| `packages/domain/src/run/state.ts` | `RunStatus`, `RunEvent`, `applyRunEvent` |
| `packages/domain/src/agent/derived.ts` | `deriveAgentStatus` — agent status is computed, never stored |
| `packages/domain/src/events/schema.ts` | Zod discriminated union of execution events |
| `packages/domain/src/guardrails/evaluate.ts` | `evaluateGuardrails` — pure limit checks |
| `packages/domain/src/scheduler/decide.ts` | `decide` — which runs to start, given the world |
| `packages/domain/src/merge/queue.ts` | `nextMergeCandidate` — serialized merge ordering |

Tests mirror the source tree under `packages/domain/test/`.

Split rationale: each file owns exactly one state machine or one decision function, so a subagent
can hold the whole file plus its test in context. `task/` and `run/` are separate because they are
separate machines with separate vocabularies — merging them would reintroduce exactly the
Agent/Run conflation the spec exists to prevent.

---

# PART 1 — M0: PAUSE / RESUME SPIKE

> **These six tasks are investigative.** There is no TDD cycle: each step runs a real command
> against the real `claude` CLI and records what actually happened. Do not write assertions about
> behaviour you have not observed. If a command behaves differently from what this plan predicts,
> **record the actual behaviour** — that is the entire point of the spike.

---

### Task 1: Spike scaffold and CLI capability inventory

**Files:**
- Create: `spike/m0-pause-resume/README.md`
- Create: `docs/superpowers/spikes/2026-08-17-m0-pause-resume-findings.md`

**Interfaces:**
- Consumes: nothing
- Produces: the findings document that Tasks 2-6 append to; the sample repository path
  `$SPIKE_REPO` used by all later spike tasks

- [ ] **Step 1: Create the spike directories**

```bash
mkdir -p spike/m0-pause-resume docs/superpowers/spikes docs/decisions
```

- [ ] **Step 2: Create a sample target repository outside the project**

The spike must not run agents against our own repo. Create a small Node project with one passing
test, which later tasks will ask the agent to modify.

```bash
export SPIKE_REPO="$HOME/.aiteamos-spike/sample-repo"
rm -rf "$SPIKE_REPO" && mkdir -p "$SPIKE_REPO"
cd "$SPIKE_REPO"
git init -q -b main
cat > package.json <<'EOF'
{
  "name": "sample-repo",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "node --test" }
}
EOF
cat > sum.js <<'EOF'
export function sum(a, b) {
  return a + b;
}
EOF
cat > sum.test.js <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert';
import { sum } from './sum.js';

test('sum adds two numbers', () => {
  assert.equal(sum(2, 3), 5);
});
EOF
git add -A && git -c user.email=spike@local -c user.name=spike commit -q -m "chore: sample repo"
npm test
```

Expected: one passing test.

- [ ] **Step 3: Record the CLI's actual capabilities**

Do not assume flag names. Capture them.

```bash
cd "$SPIKE_REPO"
claude --version
claude --help
```

- [ ] **Step 4: Write the findings document skeleton with the observed flags**

Create `docs/superpowers/spikes/2026-08-17-m0-pause-resume-findings.md`:

```markdown
# M0 Spike — Pause / Resume Findings

**Date:** 2026-08-17
**Question:** Can a Claude Code run be paused at a tool-call boundary and resumed from its
session id inside a git worktree, with a human instruction injected on resume?

## 0. Environment

- `claude --version`: <paste>
- Relevant flags observed in `--help`: <paste the flags for headless mode, output format,
  session resume, settings file, allowed tools, and permission mode>

## 1. Headless run and event stream

<filled by Task 2>

## 2. Session resume

<filled by Task 3>

## 3. Tool-call interception via PreToolUse hook

<filled by Task 4>

## 4. Resume after pause with instruction injection

<filled by Task 5>

## 5. Worktree isolation

<filled by Task 6>

## 6. Verdict and consequences for M3

<filled by Task 7>
```

- [ ] **Step 5: Write the spike README**

Create `spike/m0-pause-resume/README.md`:

```markdown
# M0 Spike — Pause / Resume

Throwaway investigation. Only `pause-gate.sh` and the findings document survive into M3.

## Re-running

    export SPIKE_REPO="$HOME/.aiteamos-spike/sample-repo"

Then follow the tasks in `docs/superpowers/plans/2026-08-17-m0-m1-foundation.md`, Part 1.
```

- [ ] **Step 6: Commit**

```bash
git add spike docs
git commit -m "spike: scaffold M0 pause/resume investigation"
```

---

### Task 2: Observe a headless run's event stream, session id, and usage

**Files:**
- Modify: `docs/superpowers/spikes/2026-08-17-m0-pause-resume-findings.md` (section 1)

**Interfaces:**
- Consumes: `$SPIKE_REPO` from Task 1
- Produces: the confirmed invocation form for a headless streaming run, and the JSON field names
  carrying `session_id`, tool calls, and token usage — M3's `ClaudeCodeAdapter` parses exactly these

- [ ] **Step 1: Run a headless task that must use tools**

```bash
cd "$SPIKE_REPO"
claude -p "Add a multiply(a, b) function to sum.js and a test for it in sum.test.js. Run npm test when done." \
  --output-format stream-json --verbose 2>&1 | tee /tmp/m0-run1.jsonl
```

If `--output-format stream-json` is not a valid flag, use the streaming flag observed in Task 1
Step 3 and record the substitution in the findings.

- [ ] **Step 2: Extract the structural facts from the stream**

```bash
head -1 /tmp/m0-run1.jsonl
grep -o '"session_id":"[^"]*"' /tmp/m0-run1.jsonl | head -1
grep -c '"type":"assistant"' /tmp/m0-run1.jsonl
grep -o '"name":"[A-Za-z]*"' /tmp/m0-run1.jsonl | sort | uniq -c
tail -1 /tmp/m0-run1.jsonl
```

- [ ] **Step 3: Confirm the work actually landed**

```bash
cd "$SPIKE_REPO" && git diff --stat && npm test
```

Expected: `sum.js` and `sum.test.js` modified, tests pass.

- [ ] **Step 4: Record section 1 of the findings**

Fill in section 1 with: the exact working command, the session id field path, which event types
appear per tool call, whether token usage and cost are present in the final event (and under which
keys), and whether the stream is line-delimited JSON.

- [ ] **Step 5: Commit**

```bash
git add docs
git commit -m "spike: record headless run event stream findings"
```

---

### Task 3: Verify session resume

**Files:**
- Modify: `docs/superpowers/spikes/2026-08-17-m0-pause-resume-findings.md` (section 2)

**Interfaces:**
- Consumes: the session id captured in Task 2
- Produces: the confirmed resume invocation — M3's `AgentRuntimeAdapter.resume` depends on it

- [ ] **Step 1: Resume the session with a follow-up instruction**

```bash
cd "$SPIKE_REPO"
SID=$(grep -o '"session_id":"[^"]*"' /tmp/m0-run1.jsonl | head -1 | cut -d'"' -f4)
echo "resuming $SID"
claude -p "Now also add a divide(a, b) function that throws on division by zero, with a test." \
  --resume "$SID" --output-format stream-json --verbose 2>&1 | tee /tmp/m0-run2.jsonl
```

- [ ] **Step 2: Verify the agent retained context**

```bash
cd "$SPIKE_REPO" && git diff --stat && npm test
grep -o '"session_id":"[^"]*"' /tmp/m0-run2.jsonl | head -1
```

Record whether the resumed run reports the **same** session id or a new one — this determines
whether `Checkpoint.sessionId` must be updated after every resume.

- [ ] **Step 3: Record section 2 of the findings**

Note: the exact resume command, whether context carried over (did it know about `multiply`?),
and the session id behaviour on resume.

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "spike: record session resume findings"
```

---

### Task 4: Intercept a tool call with a PreToolUse hook — the pause mechanism

**Files:**
- Create: `spike/m0-pause-resume/pause-gate.sh`
- Create: `spike/m0-pause-resume/settings.json`
- Modify: `docs/superpowers/spikes/2026-08-17-m0-pause-resume-findings.md` (section 3)

**Interfaces:**
- Consumes: `$SPIKE_REPO`
- Produces: `pause-gate.sh`, the hook contract M3 reuses — a run pauses when the flag file at
  `$AITEAMOS_PAUSE_FLAG` exists

> **Design note the spike must confirm.** Blocking a tool call is not by itself a pause: a denied
> tool may cause the model to try a different approach instead of stopping. The intended mechanism
> is two-part — **the hook blocks the side effect, then the orchestrator terminates the process**
> after observing the block in the stream. This task must establish which part is actually needed.

- [ ] **Step 1: Write the pause gate hook**

Create `spike/m0-pause-resume/pause-gate.sh`:

```bash
#!/usr/bin/env bash
# PreToolUse hook. Blocks the pending tool call when the pause flag file exists.
# The orchestrator sets the flag, observes the block in the event stream, then
# terminates the process. Contract: exit 0 = allow, structured deny = pause.
set -euo pipefail

FLAG="${AITEAMOS_PAUSE_FLAG:-/tmp/aiteamos-pause.flag}"

cat > /dev/null   # drain the hook payload on stdin

if [[ -f "$FLAG" ]]; then
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Paused by AI Team OS. Stop and wait."}}'
  exit 0
fi

exit 0
```

```bash
chmod +x spike/m0-pause-resume/pause-gate.sh
```

- [ ] **Step 2: Register the hook in a settings file**

Create `spike/m0-pause-resume/settings.json` (adjust the key names to match what Task 1's
`--help` and the hooks documentation actually specify; record any deviation):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "$AITEAMOS_SPIKE/pause-gate.sh" }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: Confirm the hook fires at all, with the flag absent**

```bash
export AITEAMOS_SPIKE="$PWD/spike/m0-pause-resume"
export AITEAMOS_PAUSE_FLAG=/tmp/aiteamos-pause.flag
rm -f "$AITEAMOS_PAUSE_FLAG"
cd "$SPIKE_REPO"
claude -p "Add a subtract(a, b) function to sum.js with a test." \
  --settings "$AITEAMOS_SPIKE/settings.json" \
  --output-format stream-json --verbose 2>&1 | tee /tmp/m0-run3.jsonl
```

Expected: the run completes normally. If it fails, the hook wiring is wrong — fix the settings
path/shape before continuing, and record what the correct shape turned out to be.

- [ ] **Step 4: Trigger a pause mid-run**

Start a longer task in the background, then set the flag while it is working.

```bash
cd "$SPIKE_REPO"
rm -f "$AITEAMOS_PAUSE_FLAG"
claude -p "Refactor sum.js into a Calculator class with add, subtract, multiply and divide methods. Update all tests. Run npm test after each change." \
  --settings "$AITEAMOS_SPIKE/settings.json" \
  --output-format stream-json --verbose > /tmp/m0-run4.jsonl 2>&1 &
CLAUDE_PID=$!
sleep 20
touch "$AITEAMOS_PAUSE_FLAG"
echo "flag set at $(date +%T)"
wait $CLAUDE_PID; echo "exit code: $?"
```

- [ ] **Step 5: Determine what the block actually did**

```bash
grep -n "Paused by AI Team OS" /tmp/m0-run4.jsonl | head -5
tail -3 /tmp/m0-run4.jsonl
grep -o '"session_id":"[^"]*"' /tmp/m0-run4.jsonl | head -1
cd "$SPIKE_REPO" && git status --short
```

Answer these three questions explicitly:
1. Did the process exit after the deny, or did the model keep trying other tools?
2. Is the session id still recoverable from the stream?
3. Is the working tree in a coherent state (no half-written file)?

If the answer to (1) is "it kept trying", record that **the orchestrator must kill the process on
observing the deny event** — that is a valid outcome for this spike, not a failure.

- [ ] **Step 6: Record section 3 of the findings**

Include the working hook settings shape, the deny payload format that the CLI accepted, the
observed behaviour after denial, and the resulting pause mechanism definition.

- [ ] **Step 7: Commit**

```bash
rm -f "$AITEAMOS_PAUSE_FLAG"
git add spike docs
git commit -m "spike: establish PreToolUse pause gate mechanism"
```

---

### Task 5: Resume after a pause with an injected instruction

**Files:**
- Modify: `docs/superpowers/spikes/2026-08-17-m0-pause-resume-findings.md` (section 4)

**Interfaces:**
- Consumes: the paused session id from Task 4
- Produces: confirmation that queued human messages can be delivered on resume — the behaviour
  the entire agent-messaging feature depends on

- [ ] **Step 1: Clear the pause flag and resume with an instruction**

```bash
rm -f "$AITEAMOS_PAUSE_FLAG"
cd "$SPIKE_REPO"
SID4=$(grep -o '"session_id":"[^"]*"' /tmp/m0-run4.jsonl | head -1 | cut -d'"' -f4)
claude -p "You were paused by the operator. New instruction: name the class MathKit instead of Calculator, then continue and finish the refactor." \
  --resume "$SID4" --settings "$AITEAMOS_SPIKE/settings.json" \
  --output-format stream-json --verbose 2>&1 | tee /tmp/m0-run5.jsonl
```

- [ ] **Step 2: Verify both continuity and obedience**

```bash
cd "$SPIKE_REPO"
grep -l "MathKit" *.js
git diff --stat
npm test
```

Expected: the class is named `MathKit` (the injected instruction was honoured) **and** the work
continues from where it stopped rather than restarting (continuity preserved).

- [ ] **Step 3: Record section 4 of the findings**

State plainly whether pause → instruct → resume works, and note anything the agent lost across
the boundary.

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "spike: record pause-instruct-resume findings"
```

---

### Task 6: Verify worktree isolation

**Files:**
- Modify: `docs/superpowers/spikes/2026-08-17-m0-pause-resume-findings.md` (section 5)

**Interfaces:**
- Consumes: `$SPIKE_REPO`
- Produces: confirmation that a run confined to a worktree leaves `main` untouched — the
  precondition for parallel agents

- [ ] **Step 1: Create a worktree and run an agent inside it**

```bash
cd "$SPIKE_REPO"
git worktree add -b aiteamos/TASK-001-greeting .aiteamos/worktrees/TASK-001
cd .aiteamos/worktrees/TASK-001
claude -p "Add a greet(name) function to a new file greet.js, with a test in greet.test.js. Then commit your work with message 'feat: add greet'." \
  --output-format stream-json --verbose 2>&1 | tee /tmp/m0-run6.jsonl
```

- [ ] **Step 2: Verify isolation**

```bash
cd "$SPIKE_REPO/.aiteamos/worktrees/TASK-001" && git log --oneline -2 && ls greet.js
cd "$SPIKE_REPO" && git log --oneline -1 && ls greet.js 2>&1
```

Expected: the commit and `greet.js` exist on the branch inside the worktree; `main` has neither.

- [ ] **Step 3: Run two agents concurrently in separate worktrees**

```bash
cd "$SPIKE_REPO"
git worktree add -b aiteamos/TASK-002-upper .aiteamos/worktrees/TASK-002
( cd .aiteamos/worktrees/TASK-001 && claude -p "Add a farewell(name) function with a test, then commit." --output-format stream-json --verbose > /tmp/m0-p1.jsonl 2>&1 ) &
( cd .aiteamos/worktrees/TASK-002 && claude -p "Add an upper(text) function with a test, then commit." --output-format stream-json --verbose > /tmp/m0-p2.jsonl 2>&1 ) &
wait
git -C .aiteamos/worktrees/TASK-001 log --oneline -3
git -C .aiteamos/worktrees/TASK-002 log --oneline -3
```

Expected: both branches advanced independently, no interference, no index lock errors.

- [ ] **Step 4: Record section 5 of the findings**

Note any git lock contention, whether `node_modules` or other untracked state caused problems in
fresh worktrees, and whether concurrent runs were genuinely independent.

- [ ] **Step 5: Commit**

```bash
git add docs
git commit -m "spike: record worktree isolation findings"
```

---

### Task 7: Write the verdict and the pause-semantics ADR

**Files:**
- Modify: `docs/superpowers/spikes/2026-08-17-m0-pause-resume-findings.md` (section 6)
- Create: `docs/decisions/0001-pause-semantics.md`

**Interfaces:**
- Consumes: sections 1-5 of the findings
- Produces: the binding definition of pause/resume that M3's adapter implements

- [ ] **Step 1: Write section 6 of the findings**

Answer the spike's question in one paragraph, then list the consequences: which
`ProviderCapabilities` flags are true for Claude Code, what a `Checkpoint` must actually contain
(does `sessionId` change on resume?), and whether the orchestrator must kill the process after a
deny.

- [ ] **Step 2: Write the ADR**

Create `docs/decisions/0001-pause-semantics.md`:

```markdown
# ADR 0001 — Pause Semantics

**Status:** Accepted
**Date:** 2026-08-17
**Context:** Spec §8; spike findings in `docs/superpowers/spikes/2026-08-17-m0-pause-resume-findings.md`

## Decision

<Write the mechanism that was actually measured, not the one that was predicted. Cover:
the pause trigger, what the hook does, what the orchestrator does after the hook fires,
what the checkpoint stores, and how resume delivers queued instructions.>

## Consequences

- `ProviderCapabilities` for Claude Code: <filled from measurement>
- `Checkpoint` fields required: <filled from measurement>
- Degradation path if a provider lacks hooks: pause becomes "stop at end of current run".

## Alternatives Rejected

- Freezing the in-flight LLM request: impossible.
- SIGSTOP on the process: leaves the working tree and any open file handles in an
  indeterminate state and does not survive a daemon restart.
```

- [ ] **Step 3: Verify no spike artefacts leak into the product tree**

```bash
git status --short
ls spike/m0-pause-resume
```

Expected: only `README.md`, `pause-gate.sh`, `settings.json` under `spike/`.

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs: add ADR 0001 pause semantics from M0 spike"
```

> **Gate:** if the spike showed that pause at tool-call boundaries is not achievable, stop and
> report. The domain work in Part 2 still proceeds unchanged — only the `RunStatus` pause branch
> semantics in Task 12 need their meaning restated in the ADR.

---

# PART 2 — M1: DOMAIN CORE (TDD)

---

### Task 8: Monorepo scaffold with a passing test

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`
- Create: `packages/domain/package.json`, `packages/domain/tsconfig.json`
- Create: `packages/domain/src/index.ts`
- Test: `packages/domain/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: the workspace layout and the `npm test` / `npm run typecheck` commands every later
  task runs

- [ ] **Step 1: Write the failing test**

Create `packages/domain/test/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { DOMAIN_VERSION } from '../src/index.js'

describe('domain package', () => {
  it('exposes a version constant', () => {
    expect(DOMAIN_VERSION).toBe('1')
  })
})
```

- [ ] **Step 2: Create the workspace root**

Create `package.json`:

```json
{
  "name": "ai-team-os",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "apps/*"],
  "engines": { "node": ">=26" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --build --force && tsc -p packages/domain/tsconfig.test.json"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "isolatedModules": true,
    "declaration": true,
    "composite": true,
    "skipLibCheck": true
  }
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    environment: 'node',
  },
})
```

Create `.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
.aiteamos/
```

- [ ] **Step 3: Create the domain package**

Create `packages/domain/package.json`:

```json
{
  "name": "@ai-team-os/domain",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "dependencies": {
    "zod": "^3.24.0"
  }
}
```

Create `packages/domain/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "include": ["src/**/*.ts"]
}
```

Create `packages/domain/tsconfig.test.json` — the build config only compiles `src`, so without
this the test files are never type-checked, and a strict-TypeScript project whose tests are
unchecked is only half strict:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "composite": false,
    "declaration": false,
    "types": ["vitest/globals"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `packages/domain/src/index.ts`:

```ts
export const DOMAIN_VERSION = '1'
```

- [ ] **Step 4: Install and run the test**

```bash
npm install
npx vitest run packages/domain/test/smoke.test.ts
```

Expected: 1 passed.

- [ ] **Step 5: Verify the typecheck command works**

```bash
npm run typecheck
```

Expected: exits 0 with no output.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold npm workspaces monorepo with strict TypeScript and vitest"
```

---

### Task 9: Result type and branded identifiers

**Files:**
- Create: `packages/domain/src/result.ts`
- Create: `packages/domain/src/ids.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/result.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }`
  - `ok<T>(value: T): Result<T, never>`, `err<E>(error: E): Result<never, E>`
  - `AgentId`, `TaskId`, `RunId`, `WorkspaceId` branded string types with constructors
    `agentId`, `taskId`, `runId`, `workspaceId`

- [ ] **Step 1: Write the failing test**

Create `packages/domain/test/result.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { err, ok, type Result } from '../src/result.js'
import { agentId, taskId } from '../src/ids.js'

describe('Result', () => {
  it('wraps a success value', () => {
    const r: Result<number, string> = ok(42)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(42)
  })

  it('wraps an error value', () => {
    const r: Result<number, string> = err('boom')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('boom')
  })
})

describe('branded ids', () => {
  it('preserves the underlying string', () => {
    expect(agentId('alex')).toBe('alex')
  })

  it('produces distinct brands that still compare by value', () => {
    expect(taskId('TASK-1')).toBe('TASK-1')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run packages/domain/test/result.test.ts
```

Expected: FAIL — cannot resolve `../src/result.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/domain/src/result.ts`:

```ts
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E }

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}
```

Create `packages/domain/src/ids.ts`:

```ts
declare const brand: unique symbol

type Brand<T, B extends string> = T & { readonly [brand]: B }

export type AgentId = Brand<string, 'AgentId'>
export type TaskId = Brand<string, 'TaskId'>
export type RunId = Brand<string, 'RunId'>
export type WorkspaceId = Brand<string, 'WorkspaceId'>

export const agentId = (value: string): AgentId => value as AgentId
export const taskId = (value: string): TaskId => value as TaskId
export const runId = (value: string): RunId => value as RunId
export const workspaceId = (value: string): WorkspaceId => value as WorkspaceId
```

Replace `packages/domain/src/index.ts`:

```ts
export const DOMAIN_VERSION = '1'

export * from './result.js'
export * from './ids.js'
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run packages/domain/test/result.test.ts && npm run typecheck
```

Expected: 4 passed, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat(domain): add Result type and branded identifiers"
```

---

### Task 10: Task state machine — the happy path

**Files:**
- Create: `packages/domain/src/task/state.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/task/state.test.ts`

**Interfaces:**
- Consumes: `Result`, `ok`, `err`, `AgentId`, `RunId`
- Produces:
  - `type TaskStatus` — the 12 statuses from spec §5.1
  - `interface TaskState { status, assigneeId, activeRunId, attempt, maxAttempts, lastRejectionReason }`
  - `type TaskEvent` — discriminated union
  - `interface IllegalTransition { kind: 'illegal_transition'; from: TaskStatus; event: TaskEvent['type'] }`
  - `applyTaskEvent(state: TaskState, event: TaskEvent): Result<TaskState, IllegalTransition>`
  - `initialTaskState(maxAttempts: number): TaskState`

- [ ] **Step 1: Write the failing test**

Create `packages/domain/test/task/state.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { agentId, runId } from '../../src/ids.js'
import { applyTaskEvent, initialTaskState, type TaskEvent, type TaskState } from '../../src/task/state.js'

function drive(state: TaskState, events: readonly TaskEvent[]): TaskState {
  return events.reduce((current, event) => {
    const result = applyTaskEvent(current, event)
    if (!result.ok) throw new Error(`illegal: ${result.error.from} + ${result.error.event}`)
    return result.value
  }, state)
}

const HAPPY_PATH: readonly TaskEvent[] = [
  { type: 'dependencies_satisfied' },
  { type: 'assigned', agentId: agentId('alex') },
  { type: 'run_started', runId: runId('run-1') },
  { type: 'run_succeeded' },
  { type: 'verify_passed' },
  { type: 'review_approved' },
  { type: 'merged' },
]

describe('applyTaskEvent — happy path', () => {
  it('starts in backlog', () => {
    expect(initialTaskState(3).status).toBe('backlog')
  })

  it('walks backlog to done', () => {
    expect(drive(initialTaskState(3), HAPPY_PATH).status).toBe('done')
  })

  it('records the assignee and the active run', () => {
    const state = drive(initialTaskState(3), HAPPY_PATH.slice(0, 3))
    expect(state.status).toBe('running')
    expect(state.assigneeId).toBe('alex')
    expect(state.activeRunId).toBe('run-1')
  })

  it('increments the attempt counter when a run starts', () => {
    const state = drive(initialTaskState(3), HAPPY_PATH.slice(0, 3))
    expect(state.attempt).toBe(1)
  })

  it('passes through verifying, reviewing and merging in order', () => {
    const statuses = HAPPY_PATH.reduce<string[]>((acc, event, index) => {
      acc.push(drive(initialTaskState(3), HAPPY_PATH.slice(0, index + 1)).status)
      return acc
    }, [])
    expect(statuses).toEqual([
      'ready', 'assigned', 'running', 'verifying', 'reviewing', 'merging', 'done',
    ])
  })

  it('rejects an event that does not belong to the current status', () => {
    const result = applyTaskEvent(initialTaskState(3), { type: 'verify_passed' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.from).toBe('backlog')
      expect(result.error.event).toBe('verify_passed')
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run packages/domain/test/task/state.test.ts
```

Expected: FAIL — cannot resolve `../../src/task/state.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/domain/src/task/state.ts`:

```ts
import { err, ok, type Result } from '../result.js'
import type { AgentId, RunId } from '../ids.js'

export type TaskStatus =
  | 'backlog'
  | 'ready'
  | 'blocked'
  | 'assigned'
  | 'running'
  | 'verifying'
  | 'reviewing'
  | 'merging'
  | 'rework'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface TaskState {
  readonly status: TaskStatus
  readonly assigneeId: AgentId | null
  readonly activeRunId: RunId | null
  readonly attempt: number
  readonly maxAttempts: number
  readonly lastRejectionReason: string | null
}

export type TaskEvent =
  | { readonly type: 'dependencies_satisfied' }
  | { readonly type: 'dependencies_unmet' }
  | { readonly type: 'assigned'; readonly agentId: AgentId }
  | { readonly type: 'run_started'; readonly runId: RunId }
  | { readonly type: 'run_succeeded' }
  | { readonly type: 'run_failed'; readonly reason: string }
  | { readonly type: 'verify_passed' }
  | { readonly type: 'verify_failed'; readonly reason: string }
  | { readonly type: 'review_approved' }
  | { readonly type: 'review_rejected'; readonly reason: string }
  | { readonly type: 'merged' }
  | { readonly type: 'merge_failed'; readonly reason: string }
  | { readonly type: 'cancelled' }

export interface IllegalTransition {
  readonly kind: 'illegal_transition'
  readonly from: TaskStatus
  readonly event: TaskEvent['type']
}

const TERMINAL: readonly TaskStatus[] = ['done', 'failed', 'cancelled']

export function initialTaskState(maxAttempts: number): TaskState {
  return {
    status: 'backlog',
    assigneeId: null,
    activeRunId: null,
    attempt: 0,
    maxAttempts,
    lastRejectionReason: null,
  }
}

function illegal(state: TaskState, event: TaskEvent): Result<TaskState, IllegalTransition> {
  return err({ kind: 'illegal_transition', from: state.status, event: event.type })
}

/** Route a rejection: back to rework, or to failed when attempts are exhausted. */
function reject(state: TaskState, reason: string): Result<TaskState, IllegalTransition> {
  const exhausted = state.attempt >= state.maxAttempts
  return ok({
    ...state,
    status: exhausted ? 'failed' : 'rework',
    activeRunId: null,
    lastRejectionReason: reason,
  })
}

export function applyTaskEvent(state: TaskState, event: TaskEvent): Result<TaskState, IllegalTransition> {
  if (event.type === 'cancelled') {
    return TERMINAL.includes(state.status)
      ? illegal(state, event)
      : ok({ ...state, status: 'cancelled', activeRunId: null })
  }

  switch (state.status) {
    case 'backlog':
    case 'blocked':
      if (event.type === 'dependencies_satisfied') return ok({ ...state, status: 'ready' })
      if (event.type === 'dependencies_unmet') return ok({ ...state, status: 'blocked' })
      return illegal(state, event)

    case 'ready':
    case 'rework':
      if (event.type === 'assigned') return ok({ ...state, status: 'assigned', assigneeId: event.agentId })
      if (event.type === 'dependencies_unmet') return ok({ ...state, status: 'blocked' })
      return illegal(state, event)

    case 'assigned':
      if (event.type === 'run_started') {
        return ok({ ...state, status: 'running', activeRunId: event.runId, attempt: state.attempt + 1 })
      }
      return illegal(state, event)

    case 'running':
      if (event.type === 'run_succeeded') return ok({ ...state, status: 'verifying', activeRunId: null })
      if (event.type === 'run_failed') return reject(state, event.reason)
      return illegal(state, event)

    case 'verifying':
      if (event.type === 'verify_passed') return ok({ ...state, status: 'reviewing' })
      if (event.type === 'verify_failed') return reject(state, event.reason)
      return illegal(state, event)

    case 'reviewing':
      if (event.type === 'review_approved') return ok({ ...state, status: 'merging' })
      if (event.type === 'review_rejected') return reject(state, event.reason)
      return illegal(state, event)

    case 'merging':
      if (event.type === 'merged') return ok({ ...state, status: 'done', lastRejectionReason: null })
      if (event.type === 'merge_failed') return reject(state, event.reason)
      return illegal(state, event)

    case 'done':
    case 'failed':
    case 'cancelled':
      return illegal(state, event)
  }
}
```

Add to `packages/domain/src/index.ts`:

```ts
export * from './task/state.js'
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run packages/domain/test/task/state.test.ts && npm run typecheck
```

Expected: 6 passed, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat(domain): add task state machine happy path"
```

---

### Task 11: Task state machine — rejection, rework, and attempt exhaustion

**Files:**
- Test: `packages/domain/test/task/rework.test.ts`
- Modify: `packages/domain/src/task/state.ts` (only if a test exposes a defect)

**Interfaces:**
- Consumes: everything produced by Task 10
- Produces: no new API — this task proves the rejection paths, which are the states the
  autonomous loop spends most of its time in

- [ ] **Step 1: Write the failing test**

Create `packages/domain/test/task/rework.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { agentId, runId } from '../../src/ids.js'
import { applyTaskEvent, initialTaskState, type TaskEvent, type TaskState } from '../../src/task/state.js'

function drive(state: TaskState, events: readonly TaskEvent[]): TaskState {
  return events.reduce((current, event) => {
    const result = applyTaskEvent(current, event)
    if (!result.ok) throw new Error(`illegal: ${result.error.from} + ${result.error.event}`)
    return result.value
  }, state)
}

const TO_RUNNING: readonly TaskEvent[] = [
  { type: 'dependencies_satisfied' },
  { type: 'assigned', agentId: agentId('alex') },
  { type: 'run_started', runId: runId('run-1') },
]

describe('rejection paths', () => {
  it('sends a failed verification back to rework', () => {
    const state = drive(initialTaskState(3), [
      ...TO_RUNNING,
      { type: 'run_succeeded' },
      { type: 'verify_failed', reason: '2 tests failing' },
    ])
    expect(state.status).toBe('rework')
    expect(state.lastRejectionReason).toBe('2 tests failing')
    expect(state.activeRunId).toBeNull()
  })

  it('sends a rejected review back to rework with the reviewer reason', () => {
    const state = drive(initialTaskState(3), [
      ...TO_RUNNING,
      { type: 'run_succeeded' },
      { type: 'verify_passed' },
      { type: 'review_rejected', reason: 'no input validation' },
    ])
    expect(state.status).toBe('rework')
    expect(state.lastRejectionReason).toBe('no input validation')
  })

  it('sends a failed merge back to rework rather than leaving done', () => {
    const state = drive(initialTaskState(3), [
      ...TO_RUNNING,
      { type: 'run_succeeded' },
      { type: 'verify_passed' },
      { type: 'review_approved' },
      { type: 'merge_failed', reason: 'post-merge tests red' },
    ])
    expect(state.status).toBe('rework')
    expect(state.lastRejectionReason).toBe('post-merge tests red')
  })

  it('allows reassignment from rework and increments the attempt', () => {
    const reworked = drive(initialTaskState(3), [
      ...TO_RUNNING,
      { type: 'run_failed', reason: 'crashed' },
      { type: 'assigned', agentId: agentId('alex') },
      { type: 'run_started', runId: runId('run-2') },
    ])
    expect(reworked.status).toBe('running')
    expect(reworked.attempt).toBe(2)
  })

  it('fails the task when attempts are exhausted', () => {
    let state = initialTaskState(2)
    state = drive(state, TO_RUNNING)
    state = drive(state, [{ type: 'run_failed', reason: 'first' }])
    expect(state.status).toBe('rework')

    state = drive(state, [
      { type: 'assigned', agentId: agentId('alex') },
      { type: 'run_started', runId: runId('run-2') },
      { type: 'run_failed', reason: 'second' },
    ])
    expect(state.status).toBe('failed')
    expect(state.attempt).toBe(2)
  })

  it('blocks a ready task whose dependencies regress', () => {
    const state = drive(initialTaskState(3), [
      { type: 'dependencies_satisfied' },
      { type: 'dependencies_unmet' },
    ])
    expect(state.status).toBe('blocked')
  })

  it('cancels from any non-terminal status', () => {
    const state = drive(initialTaskState(3), [...TO_RUNNING, { type: 'cancelled' }])
    expect(state.status).toBe('cancelled')
  })

  it('refuses to cancel a task that is already done', () => {
    const done = drive(initialTaskState(3), [
      ...TO_RUNNING,
      { type: 'run_succeeded' },
      { type: 'verify_passed' },
      { type: 'review_approved' },
      { type: 'merged' },
    ])
    const result = applyTaskEvent(done, { type: 'cancelled' })
    expect(result.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test**

```bash
npx vitest run packages/domain/test/task/rework.test.ts
```

Expected: PASS if Task 10's implementation is correct. If any case fails, fix
`packages/domain/src/task/state.ts` — do not weaken the test.

- [ ] **Step 3: Run the full suite**

```bash
npm test && npm run typecheck
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add packages
git commit -m "test(domain): cover task rework, attempt exhaustion and cancellation"
```

---

### Task 12: AgentRun state machine

**Files:**
- Create: `packages/domain/src/run/state.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/run/state.test.ts`

**Interfaces:**
- Consumes: `Result`, `ok`, `err`
- Produces:
  - `type RunStatus = 'starting' | 'working' | 'pause_requested' | 'paused' | 'resuming' | 'stopping' | 'stopped' | 'succeeded' | 'failed'`
  - `interface RunState { status, toolCalls, sessionId, pausedAtStep }`
  - `type RunEvent`
  - `applyRunEvent(state: RunState, event: RunEvent): Result<RunState, IllegalRunTransition>`
  - `initialRunState(): RunState`

- [ ] **Step 1: Write the failing test**

Create `packages/domain/test/run/state.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { applyRunEvent, initialRunState, type RunEvent, type RunState } from '../../src/run/state.js'

function drive(state: RunState, events: readonly RunEvent[]): RunState {
  return events.reduce((current, event) => {
    const result = applyRunEvent(current, event)
    if (!result.ok) throw new Error(`illegal: ${result.error.from} + ${result.error.event}`)
    return result.value
  }, state)
}

describe('applyRunEvent', () => {
  it('starts in starting', () => {
    expect(initialRunState().status).toBe('starting')
  })

  it('captures the session id when the run begins working', () => {
    const state = drive(initialRunState(), [{ type: 'started', sessionId: 'sess-1' }])
    expect(state.status).toBe('working')
    expect(state.sessionId).toBe('sess-1')
  })

  it('counts tool calls', () => {
    const state = drive(initialRunState(), [
      { type: 'started', sessionId: 'sess-1' },
      { type: 'tool_call', name: 'Read' },
      { type: 'tool_call', name: 'Edit' },
    ])
    expect(state.toolCalls).toBe(2)
  })

  it('walks the pause cycle back to working', () => {
    const state = drive(initialRunState(), [
      { type: 'started', sessionId: 'sess-1' },
      { type: 'tool_call', name: 'Read' },
      { type: 'pause_requested' },
      { type: 'paused', atStep: 1 },
      { type: 'resume_requested' },
      { type: 'resumed', sessionId: 'sess-1' },
    ])
    expect(state.status).toBe('working')
    expect(state.pausedAtStep).toBeNull()
  })

  it('records the step at which it paused', () => {
    const state = drive(initialRunState(), [
      { type: 'started', sessionId: 'sess-1' },
      { type: 'tool_call', name: 'Read' },
      { type: 'pause_requested' },
      { type: 'paused', atStep: 1 },
    ])
    expect(state.status).toBe('paused')
    expect(state.pausedAtStep).toBe(1)
  })

  it('updates the session id when resume returns a new one', () => {
    const state = drive(initialRunState(), [
      { type: 'started', sessionId: 'sess-1' },
      { type: 'pause_requested' },
      { type: 'paused', atStep: 0 },
      { type: 'resume_requested' },
      { type: 'resumed', sessionId: 'sess-2' },
    ])
    expect(state.sessionId).toBe('sess-2')
  })

  it('allows stopping from paused', () => {
    const state = drive(initialRunState(), [
      { type: 'started', sessionId: 'sess-1' },
      { type: 'pause_requested' },
      { type: 'paused', atStep: 0 },
      { type: 'stop_requested' },
      { type: 'stopped' },
    ])
    expect(state.status).toBe('stopped')
  })

  it('reaches succeeded from working', () => {
    const state = drive(initialRunState(), [
      { type: 'started', sessionId: 'sess-1' },
      { type: 'succeeded' },
    ])
    expect(state.status).toBe('succeeded')
  })

  it('rejects a pause request on a finished run', () => {
    const finished = drive(initialRunState(), [
      { type: 'started', sessionId: 'sess-1' },
      { type: 'succeeded' },
    ])
    const result = applyRunEvent(finished, { type: 'pause_requested' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.from).toBe('succeeded')
  })

  it('rejects a tool call before the run has started', () => {
    const result = applyRunEvent(initialRunState(), { type: 'tool_call', name: 'Read' })
    expect(result.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run packages/domain/test/run/state.test.ts
```

Expected: FAIL — cannot resolve `../../src/run/state.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/domain/src/run/state.ts`:

```ts
import { err, ok, type Result } from '../result.js'

export type RunStatus =
  | 'starting'
  | 'working'
  | 'pause_requested'
  | 'paused'
  | 'resuming'
  | 'stopping'
  | 'stopped'
  | 'succeeded'
  | 'failed'

export interface RunState {
  readonly status: RunStatus
  readonly toolCalls: number
  readonly sessionId: string | null
  readonly pausedAtStep: number | null
}

export type RunEvent =
  | { readonly type: 'started'; readonly sessionId: string }
  | { readonly type: 'tool_call'; readonly name: string }
  | { readonly type: 'pause_requested' }
  | { readonly type: 'paused'; readonly atStep: number }
  | { readonly type: 'resume_requested' }
  | { readonly type: 'resumed'; readonly sessionId: string }
  | { readonly type: 'stop_requested' }
  | { readonly type: 'stopped' }
  | { readonly type: 'succeeded' }
  | { readonly type: 'failed'; readonly reason: string }

export interface IllegalRunTransition {
  readonly kind: 'illegal_run_transition'
  readonly from: RunStatus
  readonly event: RunEvent['type']
}

const ACTIVE: readonly RunStatus[] = ['starting', 'working', 'pause_requested', 'paused', 'resuming', 'stopping']

export function initialRunState(): RunState {
  return { status: 'starting', toolCalls: 0, sessionId: null, pausedAtStep: null }
}

function illegal(state: RunState, event: RunEvent): Result<RunState, IllegalRunTransition> {
  return err({ kind: 'illegal_run_transition', from: state.status, event: event.type })
}

export function applyRunEvent(state: RunState, event: RunEvent): Result<RunState, IllegalRunTransition> {
  // A run may fail from any active status; the runtime can die at any moment.
  if (event.type === 'failed') {
    return ACTIVE.includes(state.status) ? ok({ ...state, status: 'failed' }) : illegal(state, event)
  }

  switch (state.status) {
    case 'starting':
      if (event.type === 'started') return ok({ ...state, status: 'working', sessionId: event.sessionId })
      return illegal(state, event)

    case 'working':
      if (event.type === 'tool_call') return ok({ ...state, toolCalls: state.toolCalls + 1 })
      if (event.type === 'pause_requested') return ok({ ...state, status: 'pause_requested' })
      if (event.type === 'stop_requested') return ok({ ...state, status: 'stopping' })
      if (event.type === 'succeeded') return ok({ ...state, status: 'succeeded' })
      return illegal(state, event)

    case 'pause_requested':
      if (event.type === 'paused') return ok({ ...state, status: 'paused', pausedAtStep: event.atStep })
      if (event.type === 'tool_call') return ok({ ...state, toolCalls: state.toolCalls + 1 })
      if (event.type === 'succeeded') return ok({ ...state, status: 'succeeded' })
      if (event.type === 'stop_requested') return ok({ ...state, status: 'stopping' })
      return illegal(state, event)

    case 'paused':
      if (event.type === 'resume_requested') return ok({ ...state, status: 'resuming' })
      if (event.type === 'stop_requested') return ok({ ...state, status: 'stopping' })
      return illegal(state, event)

    case 'resuming':
      if (event.type === 'resumed') {
        return ok({ ...state, status: 'working', sessionId: event.sessionId, pausedAtStep: null })
      }
      return illegal(state, event)

    case 'stopping':
      if (event.type === 'stopped') return ok({ ...state, status: 'stopped' })
      return illegal(state, event)

    case 'stopped':
    case 'succeeded':
    case 'failed':
      return illegal(state, event)
  }
}
```

Add to `packages/domain/src/index.ts`:

```ts
export * from './run/state.js'
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run packages/domain/test/run/state.test.ts && npm run typecheck
```

Expected: 10 passed, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat(domain): add agent run state machine with pause cycle"
```

---

### Task 13: Derived agent status

**Files:**
- Create: `packages/domain/src/agent/derived.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/agent/derived.test.ts`

**Interfaces:**
- Consumes: `RunStatus`, `RunState`
- Produces:
  - `type AgentStatus = 'idle' | 'starting' | 'working' | 'pausing' | 'paused' | 'resuming' | 'stopping'`
  - `deriveAgentStatus(activeRun: RunState | null): AgentStatus`

- [ ] **Step 1: Write the failing test**

Create `packages/domain/test/agent/derived.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { deriveAgentStatus } from '../../src/agent/derived.js'
import { initialRunState, type RunState, type RunStatus } from '../../src/run/state.js'

function runWith(status: RunStatus): RunState {
  return { ...initialRunState(), status }
}

describe('deriveAgentStatus', () => {
  it('is idle when there is no active run', () => {
    expect(deriveAgentStatus(null)).toBe('idle')
  })

  it('maps each active run status to an agent status', () => {
    expect(deriveAgentStatus(runWith('starting'))).toBe('starting')
    expect(deriveAgentStatus(runWith('working'))).toBe('working')
    expect(deriveAgentStatus(runWith('pause_requested'))).toBe('pausing')
    expect(deriveAgentStatus(runWith('paused'))).toBe('paused')
    expect(deriveAgentStatus(runWith('resuming'))).toBe('resuming')
    expect(deriveAgentStatus(runWith('stopping'))).toBe('stopping')
  })

  it('is idle once the run reaches a terminal status', () => {
    expect(deriveAgentStatus(runWith('succeeded'))).toBe('idle')
    expect(deriveAgentStatus(runWith('failed'))).toBe('idle')
    expect(deriveAgentStatus(runWith('stopped'))).toBe('idle')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run packages/domain/test/agent/derived.test.ts
```

Expected: FAIL — cannot resolve `../../src/agent/derived.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/domain/src/agent/derived.ts`:

```ts
import type { RunState } from '../run/state.js'

export type AgentStatus = 'idle' | 'starting' | 'working' | 'pausing' | 'paused' | 'resuming' | 'stopping'

/**
 * Agent status is always computed from the agent's active run. It is never stored,
 * so agent state and run state cannot drift apart.
 */
export function deriveAgentStatus(activeRun: RunState | null): AgentStatus {
  if (activeRun === null) return 'idle'

  switch (activeRun.status) {
    case 'starting':
      return 'starting'
    case 'working':
      return 'working'
    case 'pause_requested':
      return 'pausing'
    case 'paused':
      return 'paused'
    case 'resuming':
      return 'resuming'
    case 'stopping':
      return 'stopping'
    case 'succeeded':
    case 'failed':
    case 'stopped':
      return 'idle'
  }
}
```

Add to `packages/domain/src/index.ts`:

```ts
export * from './agent/derived.js'
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run packages/domain/test/agent/derived.test.ts && npm run typecheck
```

Expected: 3 passed, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat(domain): derive agent status from the active run"
```

---

### Task 14: Execution event schema

**Files:**
- Create: `packages/domain/src/events/schema.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/events/schema.test.ts`

**Interfaces:**
- Consumes: Zod
- Produces:
  - `executionEventSchema` — Zod discriminated union over `type`
  - `type ExecutionEvent = z.infer<typeof executionEventSchema>`
  - `parseExecutionEvent(input: unknown): Result<ExecutionEvent, string>`

This task covers a representative subset of the catalogue in spec §6.2. The remaining event types
are added in M2 when the orchestrator emits them; the union is the extension point.

- [ ] **Step 1: Write the failing test**

Create `packages/domain/test/events/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseExecutionEvent } from '../../src/events/schema.js'

const BASE = {
  seq: 1,
  ts: '2026-08-17T17:01:00.000Z',
  workspaceId: 'ws-1',
  actor: 'system',
} as const

describe('parseExecutionEvent', () => {
  it('accepts a task.started event', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'task.started',
      taskId: 'TASK-142',
      agentId: 'alex',
      runId: 'run-1',
      payload: { title: 'Implement Checkout API' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.type).toBe('task.started')
  })

  it('accepts a run.tool_call event with its tool name', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'run.tool_call',
      runId: 'run-1',
      payload: { name: 'Edit', summary: 'CheckoutService.java' },
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'run.tool_call') {
      expect(result.value.payload.name).toBe('Edit')
    }
  })

  it('accepts an agent.message_sent event with a category', () => {
    const result = parseExecutionEvent({
      ...BASE,
      type: 'agent.message_sent',
      agentId: 'alex',
      actor: 'human',
      payload: { category: 'instruction', body: 'Use Redis for this part.' },
    })
    expect(result.ok).toBe(true)
  })

  it('rejects an unknown event type', () => {
    const result = parseExecutionEvent({ ...BASE, type: 'nonsense.happened', payload: {} })
    expect(result.ok).toBe(false)
  })

  it('rejects an event whose payload does not match its type', () => {
    const result = parseExecutionEvent({ ...BASE, type: 'run.tool_call', runId: 'run-1', payload: {} })
    expect(result.ok).toBe(false)
  })

  it('rejects an event missing its envelope fields', () => {
    const result = parseExecutionEvent({ type: 'task.started', payload: { title: 'x' } })
    expect(result.ok).toBe(false)
  })

  it('rejects an unknown actor', () => {
    const result = parseExecutionEvent({
      ...BASE,
      actor: 'robot',
      type: 'task.started',
      taskId: 'TASK-1',
      payload: { title: 'x' },
    })
    expect(result.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run packages/domain/test/events/schema.test.ts
```

Expected: FAIL — cannot resolve `../../src/events/schema.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/domain/src/events/schema.ts`:

```ts
import { z } from 'zod'
import { err, ok, type Result } from '../result.js'

const envelope = {
  seq: z.number().int().nonnegative(),
  ts: z.string().datetime(),
  workspaceId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  actor: z.enum(['human', 'agent', 'system']),
}

/** One member per event type. The payload shape is bound to the type by construction. */
export const executionEventSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('task.created'), payload: z.object({ title: z.string() }) }),
  z.object({ ...envelope, type: z.literal('task.started'), payload: z.object({ title: z.string() }) }),
  z.object({ ...envelope, type: z.literal('task.done'), payload: z.object({ branch: z.string() }) }),
  z.object({
    ...envelope,
    type: z.literal('task.rework'),
    payload: z.object({ reason: z.string(), attempt: z.number().int().positive() }),
  }),
  z.object({ ...envelope, type: z.literal('run.started'), payload: z.object({ sessionId: z.string() }) }),
  z.object({
    ...envelope,
    type: z.literal('run.tool_call'),
    payload: z.object({ name: z.string(), summary: z.string() }),
  }),
  z.object({ ...envelope, type: z.literal('run.paused'), payload: z.object({ atStep: z.number().int() }) }),
  z.object({ ...envelope, type: z.literal('run.resumed'), payload: z.object({ sessionId: z.string() }) }),
  z.object({
    ...envelope,
    type: z.literal('agent.message_sent'),
    payload: z.object({
      category: z.enum(['instruction', 'feedback', 'context', 'priority_change', 'question_response']),
      body: z.string().min(1),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('guardrail.tripped'),
    payload: z.object({ guardrail: z.string(), detail: z.string() }),
  }),
])

export type ExecutionEvent = z.infer<typeof executionEventSchema>

export function parseExecutionEvent(input: unknown): Result<ExecutionEvent, string> {
  const parsed = executionEventSchema.safeParse(input)
  return parsed.success ? ok(parsed.data) : err(parsed.error.message)
}
```

Add to `packages/domain/src/index.ts`:

```ts
export * from './events/schema.js'
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run packages/domain/test/events/schema.test.ts && npm run typecheck
```

Expected: 7 passed, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat(domain): add Zod execution event schema"
```

---

### Task 15: Guardrail evaluation

**Files:**
- Create: `packages/domain/src/guardrails/evaluate.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/guardrails/evaluate.test.ts`

**Interfaces:**
- Consumes: nothing beyond plain types
- Produces:
  - `interface GuardrailLimits { maxConcurrentRuns, budgetUsd, runTimeoutMs, maxToolCallsPerRun, maxAttempts, consecutiveFailureLimit }`
  - `interface WorkspaceStats { activeRuns, spentUsd, consecutiveFailures, emergencyStopped }`
  - `type GuardrailBreach = { guardrail: string; detail: string; haltsScheduling: boolean }`
  - `evaluateGuardrails(limits: GuardrailLimits, stats: WorkspaceStats): readonly GuardrailBreach[]`

Defaults per spec §9.2: 3 concurrent runs, $20, 30 min, 200 tool calls, 3 attempts, 3 consecutive
failures. Budget emits a warning at 80%.

- [ ] **Step 1: Write the failing test**

Create `packages/domain/test/guardrails/evaluate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GUARDRAIL_LIMITS,
  evaluateGuardrails,
  type WorkspaceStats,
} from '../../src/guardrails/evaluate.js'

const CALM: WorkspaceStats = {
  activeRuns: 1,
  spentUsd: 2,
  consecutiveFailures: 0,
  emergencyStopped: false,
}

describe('evaluateGuardrails', () => {
  it('reports nothing when everything is within limits', () => {
    expect(evaluateGuardrails(DEFAULT_GUARDRAIL_LIMITS, CALM)).toEqual([])
  })

  it('halts scheduling when the concurrency limit is reached', () => {
    const breaches = evaluateGuardrails(DEFAULT_GUARDRAIL_LIMITS, { ...CALM, activeRuns: 3 })
    expect(breaches).toHaveLength(1)
    expect(breaches[0]?.guardrail).toBe('concurrency')
    expect(breaches[0]?.haltsScheduling).toBe(true)
  })

  it('warns at 80% of budget without halting', () => {
    const breaches = evaluateGuardrails(DEFAULT_GUARDRAIL_LIMITS, { ...CALM, spentUsd: 16 })
    expect(breaches).toHaveLength(1)
    expect(breaches[0]?.guardrail).toBe('budget_warning')
    expect(breaches[0]?.haltsScheduling).toBe(false)
  })

  it('halts when the budget is exhausted', () => {
    const breaches = evaluateGuardrails(DEFAULT_GUARDRAIL_LIMITS, { ...CALM, spentUsd: 20 })
    const budget = breaches.find((b) => b.guardrail === 'budget_exhausted')
    expect(budget?.haltsScheduling).toBe(true)
  })

  it('halts on the circuit breaker', () => {
    const breaches = evaluateGuardrails(DEFAULT_GUARDRAIL_LIMITS, { ...CALM, consecutiveFailures: 3 })
    const breaker = breaches.find((b) => b.guardrail === 'circuit_breaker')
    expect(breaker?.haltsScheduling).toBe(true)
  })

  it('halts on emergency stop regardless of other numbers', () => {
    const breaches = evaluateGuardrails(DEFAULT_GUARDRAIL_LIMITS, { ...CALM, emergencyStopped: true })
    expect(breaches.some((b) => b.guardrail === 'emergency_stop' && b.haltsScheduling)).toBe(true)
  })

  it('reports every simultaneous breach', () => {
    const breaches = evaluateGuardrails(DEFAULT_GUARDRAIL_LIMITS, {
      activeRuns: 5,
      spentUsd: 25,
      consecutiveFailures: 4,
      emergencyStopped: true,
    })
    expect(breaches.map((b) => b.guardrail).sort()).toEqual(
      ['budget_exhausted', 'circuit_breaker', 'concurrency', 'emergency_stop'].sort(),
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run packages/domain/test/guardrails/evaluate.test.ts
```

Expected: FAIL — cannot resolve `../../src/guardrails/evaluate.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/domain/src/guardrails/evaluate.ts`:

```ts
export interface GuardrailLimits {
  readonly maxConcurrentRuns: number
  readonly budgetUsd: number
  readonly runTimeoutMs: number
  readonly maxToolCallsPerRun: number
  readonly maxAttempts: number
  readonly consecutiveFailureLimit: number
}

export interface WorkspaceStats {
  readonly activeRuns: number
  readonly spentUsd: number
  readonly consecutiveFailures: number
  readonly emergencyStopped: boolean
}

export interface GuardrailBreach {
  readonly guardrail: string
  readonly detail: string
  readonly haltsScheduling: boolean
}

/** Spec §9.2 seeded defaults. */
export const DEFAULT_GUARDRAIL_LIMITS: GuardrailLimits = {
  maxConcurrentRuns: 3,
  budgetUsd: 20,
  runTimeoutMs: 30 * 60 * 1000,
  maxToolCallsPerRun: 200,
  maxAttempts: 3,
  consecutiveFailureLimit: 3,
}

const BUDGET_WARNING_RATIO = 0.8

export function evaluateGuardrails(
  limits: GuardrailLimits,
  stats: WorkspaceStats,
): readonly GuardrailBreach[] {
  const breaches: GuardrailBreach[] = []

  if (stats.emergencyStopped) {
    breaches.push({
      guardrail: 'emergency_stop',
      detail: 'Emergency stop is engaged for this workspace.',
      haltsScheduling: true,
    })
  }

  if (stats.activeRuns >= limits.maxConcurrentRuns) {
    breaches.push({
      guardrail: 'concurrency',
      detail: `${stats.activeRuns} active runs at limit ${limits.maxConcurrentRuns}.`,
      haltsScheduling: true,
    })
  }

  if (stats.spentUsd >= limits.budgetUsd) {
    breaches.push({
      guardrail: 'budget_exhausted',
      detail: `Spent $${stats.spentUsd} of $${limits.budgetUsd}.`,
      haltsScheduling: true,
    })
  } else if (stats.spentUsd >= limits.budgetUsd * BUDGET_WARNING_RATIO) {
    breaches.push({
      guardrail: 'budget_warning',
      detail: `Spent $${stats.spentUsd} of $${limits.budgetUsd}.`,
      haltsScheduling: false,
    })
  }

  if (stats.consecutiveFailures >= limits.consecutiveFailureLimit) {
    breaches.push({
      guardrail: 'circuit_breaker',
      detail: `${stats.consecutiveFailures} consecutive failed runs.`,
      haltsScheduling: true,
    })
  }

  return breaches
}
```

Add to `packages/domain/src/index.ts`:

```ts
export * from './guardrails/evaluate.js'
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run packages/domain/test/guardrails/evaluate.test.ts && npm run typecheck
```

Expected: 7 passed, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat(domain): add guardrail evaluation with seeded defaults"
```

---

### Task 16: Scheduler decision function

**Files:**
- Create: `packages/domain/src/scheduler/decide.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/scheduler/decide.test.ts`

**Interfaces:**
- Consumes: `TaskStatus`, `AgentId`, `TaskId`, `GuardrailLimits`, `WorkspaceStats`, `evaluateGuardrails`
- Produces:
  - `interface SchedulableTask { id: TaskId; status: TaskStatus; requiredRole: string; priority: number; dependenciesDone: boolean }`
  - `interface SchedulableAgent { id: AgentId; role: string; busy: boolean }`
  - `interface World { tasks; agents; limits; stats }`
  - `type Command = { kind: 'start_run'; taskId: TaskId; agentId: AgentId } | { kind: 'halt'; reason: string }`
  - `decide(world: World): readonly Command[]`

Rules: never exceed the concurrency limit; only `ready` or `rework` tasks with satisfied
dependencies are startable; an agent must match the task's `requiredRole` and be free; higher
`priority` wins, ties broken by task id for determinism; any halting guardrail breach yields a
single `halt` command and nothing else.

- [ ] **Step 1: Write the failing test**

Create `packages/domain/test/scheduler/decide.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { agentId, taskId } from '../../src/ids.js'
import { DEFAULT_GUARDRAIL_LIMITS } from '../../src/guardrails/evaluate.js'
import {
  decide,
  type Command,
  type SchedulableAgent,
  type SchedulableTask,
  type World,
} from '../../src/scheduler/decide.js'

const alex: SchedulableAgent = { id: agentId('alex'), role: 'backend', busy: false }
const emma: SchedulableAgent = { id: agentId('emma'), role: 'frontend', busy: false }

/** Command is a union; narrow before reading taskId so the tests type-check. */
function startedTaskIds(commands: readonly Command[]): readonly string[] {
  return commands.flatMap((c) => (c.kind === 'start_run' ? [c.taskId as string] : []))
}

function task(id: string, overrides: Partial<SchedulableTask> = {}): SchedulableTask {
  return {
    id: taskId(id),
    status: 'ready',
    requiredRole: 'backend',
    priority: 1,
    dependenciesDone: true,
    ...overrides,
  }
}

function world(overrides: Partial<World> = {}): World {
  return {
    tasks: [],
    agents: [alex, emma],
    limits: DEFAULT_GUARDRAIL_LIMITS,
    stats: { activeRuns: 0, spentUsd: 0, consecutiveFailures: 0, emergencyStopped: false },
    ...overrides,
  }
}

describe('decide', () => {
  it('starts nothing when there is nothing to do', () => {
    expect(decide(world())).toEqual([])
  })

  it('starts a ready task on a matching free agent', () => {
    const commands = decide(world({ tasks: [task('TASK-1')] }))
    expect(commands).toEqual([{ kind: 'start_run', taskId: 'TASK-1', agentId: 'alex' }])
  })

  it('starts a rework task too', () => {
    const commands = decide(world({ tasks: [task('TASK-1', { status: 'rework' })] }))
    expect(commands).toHaveLength(1)
  })

  it('ignores tasks whose dependencies are unmet', () => {
    expect(decide(world({ tasks: [task('TASK-1', { dependenciesDone: false })] }))).toEqual([])
  })

  it('ignores tasks in a non-startable status', () => {
    expect(decide(world({ tasks: [task('TASK-1', { status: 'running' })] }))).toEqual([])
  })

  it('leaves a task unscheduled when no agent has the required role', () => {
    expect(decide(world({ tasks: [task('TASK-1', { requiredRole: 'security' })] }))).toEqual([])
  })

  it('does not assign two tasks to the same agent in one tick', () => {
    const commands = decide(world({ tasks: [task('TASK-1'), task('TASK-2')] }))
    expect(startedTaskIds(commands)).toEqual(['TASK-1'])
  })

  it('schedules different roles in parallel', () => {
    const commands = decide(
      world({ tasks: [task('TASK-1'), task('TASK-2', { requiredRole: 'frontend' })] }),
    )
    expect(startedTaskIds(commands)).toEqual(['TASK-1', 'TASK-2'])
  })

  it('prefers higher priority, breaking ties by task id', () => {
    const commands = decide(
      world({ tasks: [task('TASK-9', { priority: 1 }), task('TASK-2', { priority: 5 })] }),
    )
    expect(startedTaskIds(commands)).toEqual(['TASK-2'])
  })

  it('respects the remaining concurrency budget', () => {
    const commands = decide(
      world({
        tasks: [task('TASK-1'), task('TASK-2', { requiredRole: 'frontend' })],
        stats: { activeRuns: 2, spentUsd: 0, consecutiveFailures: 0, emergencyStopped: false },
      }),
    )
    expect(commands).toHaveLength(1)
  })

  it('halts instead of scheduling when a guardrail trips', () => {
    const commands = decide(
      world({
        tasks: [task('TASK-1')],
        stats: { activeRuns: 0, spentUsd: 20, consecutiveFailures: 0, emergencyStopped: false },
      }),
    )
    expect(commands).toEqual([{ kind: 'halt', reason: 'budget_exhausted' }])
  })

  it('skips busy agents', () => {
    const commands = decide(
      world({ tasks: [task('TASK-1')], agents: [{ ...alex, busy: true }, emma] }),
    )
    expect(commands).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run packages/domain/test/scheduler/decide.test.ts
```

Expected: FAIL — cannot resolve `../../src/scheduler/decide.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/domain/src/scheduler/decide.ts`:

```ts
import type { AgentId, TaskId } from '../ids.js'
import type { TaskStatus } from '../task/state.js'
import {
  evaluateGuardrails,
  type GuardrailLimits,
  type WorkspaceStats,
} from '../guardrails/evaluate.js'

export interface SchedulableTask {
  readonly id: TaskId
  readonly status: TaskStatus
  readonly requiredRole: string
  readonly priority: number
  readonly dependenciesDone: boolean
}

export interface SchedulableAgent {
  readonly id: AgentId
  readonly role: string
  readonly busy: boolean
}

export interface World {
  readonly tasks: readonly SchedulableTask[]
  readonly agents: readonly SchedulableAgent[]
  readonly limits: GuardrailLimits
  readonly stats: WorkspaceStats
}

export type Command =
  | { readonly kind: 'start_run'; readonly taskId: TaskId; readonly agentId: AgentId }
  | { readonly kind: 'halt'; readonly reason: string }

const STARTABLE: readonly TaskStatus[] = ['ready', 'rework']

/**
 * Pure scheduling decision. No side effects, no I/O, fully deterministic:
 * the same world always produces the same commands.
 */
export function decide(world: World): readonly Command[] {
  const halting = evaluateGuardrails(world.limits, world.stats).find((b) => b.haltsScheduling)
  if (halting !== undefined) {
    return [{ kind: 'halt', reason: halting.guardrail }]
  }

  const candidates = world.tasks
    .filter((t) => STARTABLE.includes(t.status) && t.dependenciesDone)
    .toSorted((a, b) => (b.priority - a.priority) || a.id.localeCompare(b.id))

  const availableAgents = new Map<AgentId, SchedulableAgent>(
    world.agents.filter((a) => !a.busy).map((a) => [a.id, a]),
  )

  let slots = world.limits.maxConcurrentRuns - world.stats.activeRuns
  const commands: Command[] = []

  for (const candidate of candidates) {
    if (slots <= 0) break

    const agent = [...availableAgents.values()].find((a) => a.role === candidate.requiredRole)
    if (agent === undefined) continue

    commands.push({ kind: 'start_run', taskId: candidate.id, agentId: agent.id })
    availableAgents.delete(agent.id)
    slots -= 1
  }

  return commands
}
```

Add to `packages/domain/src/index.ts`:

```ts
export * from './scheduler/decide.js'
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run packages/domain/test/scheduler/decide.test.ts && npm run typecheck
```

Expected: 12 passed, typecheck clean.

If `toSorted` is unavailable, replace it with `[...array].sort(...)` — never sort in place, the
input is readonly by contract.

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat(domain): add deterministic scheduler decision function"
```

---

### Task 17: Merge queue ordering

**Files:**
- Create: `packages/domain/src/merge/queue.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/merge/queue.test.ts`

**Interfaces:**
- Consumes: `TaskId`
- Produces:
  - `interface MergeCandidate { taskId: TaskId; branch: string; enqueuedAt: number; blockedUntilRebase: boolean }`
  - `nextMergeCandidate(queue: readonly MergeCandidate[], mergeInProgress: boolean): MergeCandidate | null`

Rule (spec §10): merges are strictly serialized. While a merge is in progress, nothing else is
selected. Otherwise the earliest-enqueued candidate that does not need a rebase first is chosen;
ties break by task id for determinism.

- [ ] **Step 1: Write the failing test**

Create `packages/domain/test/merge/queue.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { taskId } from '../../src/ids.js'
import { nextMergeCandidate, type MergeCandidate } from '../../src/merge/queue.js'

function candidate(id: string, enqueuedAt: number, blockedUntilRebase = false): MergeCandidate {
  return { taskId: taskId(id), branch: `aiteamos/${id}`, enqueuedAt, blockedUntilRebase }
}

describe('nextMergeCandidate', () => {
  it('returns null for an empty queue', () => {
    expect(nextMergeCandidate([], false)).toBeNull()
  })

  it('returns null while a merge is already in progress', () => {
    expect(nextMergeCandidate([candidate('TASK-1', 1)], true)).toBeNull()
  })

  it('picks the earliest enqueued candidate', () => {
    const next = nextMergeCandidate([candidate('TASK-2', 20), candidate('TASK-1', 10)], false)
    expect(next?.taskId).toBe('TASK-1')
  })

  it('skips candidates that must rebase first', () => {
    const next = nextMergeCandidate(
      [candidate('TASK-1', 10, true), candidate('TASK-2', 20)],
      false,
    )
    expect(next?.taskId).toBe('TASK-2')
  })

  it('returns null when every candidate needs a rebase', () => {
    expect(nextMergeCandidate([candidate('TASK-1', 10, true)], false)).toBeNull()
  })

  it('breaks ties on enqueue time by task id', () => {
    const next = nextMergeCandidate([candidate('TASK-9', 10), candidate('TASK-3', 10)], false)
    expect(next?.taskId).toBe('TASK-3')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run packages/domain/test/merge/queue.test.ts
```

Expected: FAIL — cannot resolve `../../src/merge/queue.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/domain/src/merge/queue.ts`:

```ts
import type { TaskId } from '../ids.js'

export interface MergeCandidate {
  readonly taskId: TaskId
  readonly branch: string
  readonly enqueuedAt: number
  /** True while the branch is behind main and has not been rebased yet. */
  readonly blockedUntilRebase: boolean
}

/**
 * Merges are strictly serialized (spec §10): concurrent merges are exactly the case
 * where two independently green branches can break main together.
 */
export function nextMergeCandidate(
  queue: readonly MergeCandidate[],
  mergeInProgress: boolean,
): MergeCandidate | null {
  if (mergeInProgress) return null

  const eligible = [...queue]
    .filter((c) => !c.blockedUntilRebase)
    .sort((a, b) => (a.enqueuedAt - b.enqueuedAt) || a.taskId.localeCompare(b.taskId))

  return eligible[0] ?? null
}
```

Add to `packages/domain/src/index.ts`:

```ts
export * from './merge/queue.js'
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run packages/domain/test/merge/queue.test.ts && npm run typecheck
```

Expected: 6 passed, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat(domain): add serialized merge queue ordering"
```

---

### Task 18: M1 verification and domain model documentation

**Files:**
- Create: `docs/domain-model.md`
- Create: `docs/decisions/0002-derived-agent-status.md`

**Interfaces:**
- Consumes: everything from Tasks 8-17
- Produces: the milestone gate — evidence that M1 is genuinely complete

- [ ] **Step 1: Run the full suite and record the real output**

```bash
npm test
npm run typecheck
```

Expected: all test files pass, typecheck exits 0. Paste the actual counts into the commit message
in Step 4 — do not claim a number you did not see.

- [ ] **Step 2: Verify the dependency constraint really holds**

```bash
grep -rn "from 'node:" packages/domain/src || echo "no node imports: OK"
grep -rn "prisma\|react\|next" packages/domain/src || echo "no framework imports: OK"
cat packages/domain/package.json
```

Expected: zod is the only dependency; no `node:` imports.

- [ ] **Step 3: Write the domain model document**

Create `docs/domain-model.md` describing, with the actual exported names from the code: the
Agent/Task/AgentRun split and why agent status is derived; both state machines as transition
tables; the `Result` convention (transitions never throw); the event envelope; and where each
concept lives in `packages/domain/src`.

Create `docs/decisions/0002-derived-agent-status.md`:

```markdown
# ADR 0002 — Agent Status Is Derived, Never Stored

**Status:** Accepted
**Date:** 2026-08-17
**Context:** Spec §4.1-4.2

## Decision

`Agent` has no status column. Agent status is computed by `deriveAgentStatus(activeRun)` from
the agent's active `AgentRun`.

## Rationale

The original brief gave the agent a twelve-value status enum that overlapped with task and run
status. Three writable sources for one truth drift apart under concurrency; the observable
symptom would be an agent shown as "working" on a task that is blocked.

## Consequences

- The UI reads a computed value; no reconciliation job is needed.
- Statuses that belong to work (`blocked`, `reviewing`, `done`) live on `Task`; statuses that
  belong to execution (`paused`, `stopped`) live on `AgentRun`.
- Adding a new run status requires updating exactly one mapping function.
```

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs: add domain model and ADR 0002 derived agent status"
```

- [ ] **Step 5: Confirm the milestone gate**

Report: total tests passing, typecheck clean, dependency constraint verified, ADRs 0001 and 0002
written. M1 is complete only when all four are true.

---

## Deliberately Deferred From This Plan

- **`Checkpoint` type** — spec §8 defines its fields, but its exact shape depends on the M0
  findings (does the session id change on resume?) and it carries no behaviour to test. It is
  defined in M2, where it is first persisted. `RunState.sessionId` and `RunState.pausedAtStep`
  already carry the in-memory half.
- **Full event catalogue** — Task 14 implements a representative subset of spec §6.2. The
  remaining types are added in M2 as the orchestrator starts emitting them; the discriminated
  union is the designed extension point.
- **Skill and permission models** — no behaviour is exercised by M1's decision functions beyond
  `requiredRole`. They enter in M2 with the schema.

## Next Plan

`docs/superpowers/plans/<date>-m2-persistence-and-events.md` — Prisma schema, migrations, seed
data, event writes, and `LISTEN/NOTIFY`. It consumes the exported types from `@ai-team-os/domain`
unchanged; the domain package is the contract.
