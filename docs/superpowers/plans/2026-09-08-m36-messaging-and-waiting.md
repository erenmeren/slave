# M36 Messaging and Waiting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A worker that cannot continue without an answer from another worker asks for it, stops without failing, and resumes on the answer with its provider session intact. The message survives an orchestrator restart.

**Why now:** this is the second milestone of the Supervisor sequence (M35 pipeline honesty shipped first). The Supervisor of later milestones coordinates workers; it cannot do that until workers can address each other durably and until "waiting" is a state distinct from failure.

**The mechanism (decided with the user 2026-09-08, over an always-alive agent with a stop-hook mailbox):** the worker's run CONCLUDES to ask. Its provider session is preserved in a `Checkpoint` and resumed later with `claude -p "<answer>" --resume <sessionId>` in the same worktree, so the worker does not re-read the codebase and costs nothing while waiting. Rejected alternative: keeping the process alive (munder-difflin's stop-hook mailbox) — it burns budget and wall-clock while waiting, loses everything on an orchestrator restart, and defeats `runTimeoutMs` / `maxToolCallsPerRun`.

**Architecture:** no new services, no queue, no MCP. Postgres rows plus the existing `appendEvent`, pause/resume and checkpoint machinery.

## Global Constraints
- **Sender identity is derived from the run, never from model output.** A worker cannot name itself as someone else.
- **Scope is enforced server-side.** A worker can only read or address messages inside its own workspace. A cross-workspace id is refused, not silently empty.
- **Asking is not failing.** A run that concludes with a well-formed question charges no attempt, is not `failed`, and does not consume a review or verify pass.
- **Free-form model output never mutates state.** The question block is parsed with zod and refused when invalid, exactly as `planGraphSchema`, `parseReviewVerdict` and the simulation decision envelope already do. A malformed block is an ordinary failed run.
- Durability: a message and a waiting task survive an orchestrator restart. Delivery is idempotent — replaying the same answer must not produce two resumes or two messages.
- Never resume a task that was cancelled, superseded, or explicitly stopped by the operator. Never resume the same waiting task twice concurrently.
- M35's guarantees stay: `done` still requires integration, a failed run still releases its task, `blocked` still has an exit.
- One vitest at a time; `npm run --silent typecheck`; `npm run web:build` last for web tasks, never while `next dev` runs; vocabulary gate (`slave`). Commit trailer as in M35.
- Never a real model call. Tests and gates use `packages/providers/test/fake-claude.mjs`.

## File structure
```
packages/db/prisma/schema.prisma + a migration (SlaveMessage columns, TaskStatus value, Checkpoint reason)
packages/domain/src/messaging/          (message contracts, the ask envelope's zod schema)
packages/control/src/messaging.ts       (send/read/answer verbs, scope + sender enforcement)
apps/orchestrator/src/ask.ts            (conclude-with-a-question path)
apps/orchestrator/src/verify.ts, tick.ts (waiting is not failure; deliver answers)
apps/web/                               (the waiting state and the question are visible; no redesign)
apps/orchestrator/src/cli.ts            (inspect and answer from the CLI)
scripts/gate-m36-messaging.mjs, package.json, ci.yml, README
```

---

### Task 1: Durable, scoped messages

**Files:** `packages/db/prisma/schema.prisma` + migration; `packages/domain/src/messaging/`; `packages/control/src/messaging.ts`; tests.

`SlaveMessage` exists today and NOTHING reads or writes it — confirm that before you start (`git grep -n "slaveMessage" -- packages apps | grep -v generated`). Its current columns are `id, taskId?, slaveId, category, body, actor, createdAt`. Extend it rather than adding a parallel table; the enum `MessageCategory` already carries `instruction | feedback | context | priority_change | question_response`.

Add what a worker-to-worker thread needs: a recipient, a workspace scope, a thread id, a reply-to, a message type (at least `question`, `answer`, `information`, `blocker`, `handoff`), whether a reply is expected, and delivery/read state. Decide whether the existing `slaveId`/`category`/`actor` columns are reused or joined by new ones, and justify it — a human-sent instruction and a worker-sent question should not need two tables.

Control verbs: send, list-for-a-slave, and mark-read. **`sendMessage` takes the sending RUN's id, not a slave id from the caller** — it resolves the sender from `SlaveRun.slaveId`, so a model that names someone else is ignored. Every read and write is scoped to the run's workspace; a recipient in another workspace refuses (reuse `cross_workspace` if it exists — `git grep cross_workspace`). Writes are idempotent on a key, following the `namespacedKey` idiom in `packages/control/src/simulation/`.

Emit `slave.message_sent` on a send. That `EventType` already exists AND `apps/web`'s communication graph already renders it (`communicationFold.ts`, `communicationGraph.ts`) with no production writer — so this task lights up an existing read side. Verify that claim and say what the graph will now show.

- [ ] Tests first (a send resolves the sender from the run and ignores any caller-supplied identity; a cross-workspace recipient refuses; a replay of the same key writes once; a thread reads back in order; the event is emitted) → migration → implement → the covering test files one at a time → typecheck.
- [ ] Commit `feat(db,domain,control): m36 t1 — durable worker-to-worker messages, scoped and sender-derived`.

---

### Task 2: A worker asks, and waiting is not failure

**Files:** `packages/domain/src/messaging/` (the ask envelope schema); `apps/orchestrator/src/ask.ts` (new); `apps/orchestrator/src/verify.ts` (branch before its succeeded/failed handling); `packages/db` (a `TaskStatus` value); tests.

A worker that cannot continue ends its run with a structured block naming who it needs and what it needs to know. Parse it with zod off the run's captured output (`run.output` events are already captured and capped in `pump.ts` — check the cap is large enough and say so). A valid block:
- writes a `question` message (Task 1's verb) addressed to a role or a named slave in the same workspace,
- **writes a `Checkpoint` for the run** so the session can be resumed later. Today a checkpoint is written only on pause (`apps/orchestrator/src/pump.ts:256` upserts it) — read that call and make the ask path produce an equivalent row, or explain why the pause path already covers it.
- moves the task to a NEW status meaning "waiting for another worker" — add it to `TaskStatus`. **Do not reuse `blocked`**: M35 gave `blocked` the meaning "a human must look at this", with `unblock-task` as its exit, and this state resolves by itself when an answer arrives. The scheduler must not pick a waiting task (`packages/domain/src/scheduler/decide.ts`, `STARTABLE`),
- charges NO attempt and does not mark the run `failed`.

An invalid or absent block is an ordinary run outcome — do not invent a rescue path.

- [ ] Tests first (a well-formed ask parks the task waiting with no attempt charged and a checkpoint written; a malformed block behaves exactly as today's failed run; the scheduler skips a waiting task; a waiting task is not swept as an orphan) → implement → covering files one at a time → typecheck.
- [ ] Commit `feat(orchestrator,db,domain): m36 t2 — a worker can ask and wait without failing`.

---

### Task 3: The answer arrives and the worker resumes

**Files:** `apps/orchestrator/src/tick.ts` (or a sibling pass) for delivery; `packages/control/src/messaging.ts` (answer verb); `apps/orchestrator/src/cli.ts`; tests.

The recipient's next run must SEE the pending question. Keep this minimal — the full run-context builder is the next milestone. Inject only the unanswered messages addressed to this slave, and record which message ids were supplied so a later debugger can reconstruct the run's inputs.

When an answer exists for a waiting task's question, the orchestrator resumes the waiting run via the existing path: `requestResume(runId, answerText)` writes `SlaveRun.queuedMessage`, and `executeResume` replays it as the resumed prompt with `--resume <sessionId>`. Before resuming, verify the task is still current: not cancelled, not superseded, not stopped by the operator, and still the same task the question was asked from. Never resume the same waiting task twice concurrently — guard the way `claimResume` already does.

Also give a human the same power: a CLI verb to answer a pending question, so an operator can unstick a project without a second worker.

- [ ] Tests first (an answer resumes exactly the waiting task that asked and no other; a late answer to a cancelled or superseded task does NOT resume it; two answers delivered concurrently produce one resume; the recipient's run context contains the question and the supplied ids are recorded; the operator CLI answer works) → implement → covering files one at a time → typecheck → `web:build` if web is touched.
- [ ] Commit `feat(orchestrator,control,cli): m36 t3 — an answer resumes the waiting worker, exactly once`.

---

### Task 4: Restart durability, gate, docs, verification

**Files:** `scripts/gate-m36-messaging.mjs`, `package.json`, `.github/workflows/ci.yml`, `README.md`.

The gate must prove the milestone's claim with real processes and the fake CLI (never a real model call): a worker asks, its task goes waiting with no attempt charged, **the orchestrator is stopped and started again**, the answer is delivered, and the waiting worker resumes and finishes. The restart is the point — it is what separates a durable message from an in-memory one.

- [ ] Full verification: typecheck, vocabulary, `npx vitest run` (full), `web:build`, gates m36, m35, m33, m11.
- [ ] Commit `test(gates),docs: m36 t4 — gate:m36-messaging; README`.
