# AI Team OS — Design Specification

- **Date:** 2026-08-17
- **Status:** Approved (brainstorming complete, ready for implementation planning)
- **Author:** Design session between user and Claude

---

## 1. Product Interpretation

AI Team OS is a **local-first control room for an autonomous AI software team**.

The user defines a workspace (a git repository) and a goal. A virtual company of AI agents —
manager, architect, developers, QA, security — decomposes that goal into tasks, executes them
in parallel in isolated git worktrees, verifies its own work with real test and build commands,
reviews its own diffs, and merges to `main`. The human watches, interrupts, redirects, and stops.

The product is **not** a task tracker with AI-themed avatars. The tracker, the org chart, and the
graphs exist to make a genuinely running multi-process runtime legible and controllable. If the
runtime is fake, the product has no reason to exist.

### What makes it different

- Real processes doing real work on a real repository, not simulated status.
- Full autonomy with real brakes: budget ceilings, attempt caps, circuit breakers, emergency stop.
- Machine-verified completion: a task is `done` only when tests and build pass **and** an
  independent QA agent approves the diff.
- Genuine interruptibility: pause at tool-call boundaries, inject instructions, resume from session.

---

## 2. Decisions Confirmed During Brainstorming

| # | Decision | Rationale |
|---|---|---|
| D1 | **Real working tool**, not a mock dashboard | The runtime is the product; mock adapters would defer the only hard problem |
| D2 | **Workspace = a directory path**; new projects get `git init` | One code path for existing and greenfield repos |
| D3 | **One task = one git worktree + one branch** | Parallelism is the product's core claim; shared working tree makes it impossible |
| D4 | **Single user, single machine, localhost** | No auth, no tenancy, no deploy complexity — full budget goes to the runtime |
| D5 | **Full autonomy**: AI Manager plans, assigns, and hands off without human step approval | User's explicit choice; makes guardrails mandatory rather than optional |
| D6 | **Definition of Done = verify commands green + independent QA agent approval** | An autonomous agent self-declaring success is the primary failure mode |
| D7 | **Two processes**: `apps/web` (Next.js UI) + `apps/orchestrator` (long-lived daemon) | Next.js lifecycle is hostile to long-lived child processes; the team must survive UI restarts |
| D8 | **SSE, not WebSocket** | Stream is unidirectional; commands are POSTs; `Last-Event-ID` gives replay for free |
| D9 | **State tables + append-only event log**, not event sourcing | We need timeline/replay/analytics, not arbitrary state reconstruction |
| D10 | **Auto-merge to `main` allowed when verification passes**, through a serialized merge queue with post-merge re-verification | User's explicit choice; the merge queue makes it safe under parallel agents |
| D11 | **Claude Code is the only real adapter in the MVP**; Cursor adapter is an interface-conformance stub | `claude` is installed locally, `cursor-agent` is not; two real integrations would split the MVP |
| D12 | **Visual identity: Mission Control** | Dark, dense, instrument-like; motion encodes information |

---

## 3. Architecture

### 3.1 Topology

```
apps/web  ──reads──>  PostgreSQL  <──writes──  apps/orchestrator
    │                     │                          │
    │                     └── LISTEN/NOTIFY ─────────┘
    │                                                │
    └── POST /commands ──────────────────────────────┘   (single writer)
                                                     │
                                          child processes (claude ...)
                                                     │
                                          git worktrees per task
```

**Single-writer rule:** only the orchestrator mutates runtime state. `apps/web` reads the
database and POSTs commands. This eliminates write races by construction.

### 3.2 Package Layout

```
ai-team-os/
  apps/
    web/                  Next.js App Router UI (read + command dispatch)
    orchestrator/         Long-lived Node daemon (the only writer)
  packages/
    domain/               Pure TypeScript: entities, state machines, events, Zod schemas
    db/                   Prisma schema + generated client
    providers/            AgentRuntimeAdapter + ClaudeCodeAdapter + CursorAdapter (stub)
    events/               Event bus, LISTEN/NOTIFY publisher and subscriber
  docs/
    architecture.md  domain-model.md  event-model.md  provider-adapters.md  decisions/
```

**`packages/domain` has zero dependencies.** No Prisma, no React, no `fs`, no network. Everything
in it is a pure function. This is what makes the state machines and the scheduler testable in
milliseconds without a database or a browser, and it is where TDD delivers real value.

---

## 4. Domain Model

### 4.1 The Central Correction: Agent ≠ Run

The original brief modelled the agent as the thing that has a status. That conflates a durable
persona with a transient process and guarantees that agent status and task status will drift apart.

| Concept | What it is | Lifetime |
|---|---|---|
| **Agent** | Persona: name, role, department, provider, model, skills, permissions. **No status column.** | Permanent |
| **Task** | Unit of work. Owner of progress, dependencies, and outcome. | Project lifetime |
| **AgentRun** | One attempt by one agent at one task: worktree, session id, pid, tokens, cost, attempt number. | Minutes to hours |

**Agent status is derived**, computed from the agent's active run. It is never stored.

### 4.2 Status Mapping (nothing from the brief was dropped)

| Original status | New owner |
|---|---|
| `idle` | Agent (derived — no active run) |
| `assigned` | Task |
| `planning` | AgentRun (skill phase) |
| `working` | AgentRun |
| `waiting` | Task → `blocked` |
| `pause_requested`, `paused` | AgentRun |
| `review` | Task → `reviewing` |
| `blocked` | Task |
| `failed` | Both, with different meaning: a failed run does not fail the task — the task goes to `rework` until attempts are exhausted |
| `completed` | Task → `done` |
| `stopped` | AgentRun |

### 4.3 Additions Not in the Original Brief

- `Task.verifying` — verification commands are running.
- `Task.rework` — verification or QA review rejected the work; the rejection reason is attached
  as input to the next run.
- `AgentRun.attemptNumber` + `Task.maxAttempts` — an unbounded rework loop is an infinite
  money-burning loop in autonomous mode.

---

## 5. State Machines

All transitions are pure functions in `packages/domain`:

```ts
applyTaskEvent(state: TaskState, event: TaskEvent): Result<TaskState, IllegalTransition>
applyRunEvent(state: RunState, event: RunEvent): Result<RunState, IllegalTransition>
```

Exhaustive discriminated unions. Illegal transitions return an error; they are never silently
swallowed. **This is the first TDD target, before any database or UI code.**

### 5.1 Task

```
backlog → ready → assigned → running → verifying → reviewing → done
                     ↑          │          │           │
                     │          ↓          ↓           ↓
                     └────── rework ←──────┴───────────┘
                                │
   blocked ←── (unmet deps)     └──> failed (attempts exhausted)
                                cancelled (human stop)
```

### 5.2 AgentRun

```
starting → working → succeeded | failed
              │
              ├─→ pause_requested → paused → resuming → working
              └─→ stopping → stopped
```

### 5.3 Agent (derived)

`idle` when there is no active run; otherwise projected from the active run's state.

---

## 6. Event Model

### 6.1 Envelope

```ts
{
  seq: bigint            // monotonic; doubles as SSE Last-Event-ID
  ts: DateTime
  type: EventType        // namespaced: 'task.started', 'run.paused', ...
  workspaceId: string
  taskId?: string
  agentId?: string
  runId?: string
  actor: 'human' | 'agent' | 'system'
  payload: unknown       // validated by a per-type Zod schema
}
```

`type` + `payload` form a single **Zod discriminated union** in `packages/domain` — the single
source of truth shared by the orchestrator (writing) and the web app (reading). No hand-matched
event strings anywhere.

### 6.2 Event Catalogue (MVP)

`workspace.created` · `agent.created` · `agent.message_sent` ·
`task.created` `task.assigned` `task.started` `task.progress` `task.blocked` `task.unblocked`
`task.verifying` `task.verify_passed` `task.verify_failed` `task.review_requested`
`task.review_approved` `task.review_rejected` `task.rework` `task.done` `task.failed` `task.cancelled` ·
`run.started` `run.tool_call` `run.output` `run.pause_requested` `run.paused` `run.resumed`
`run.stopped` `run.succeeded` `run.failed` ·
`skill.started` `skill.completed` · `checkpoint.created` · `artifact.created` ·
`merge.queued` `merge.verifying` `merge.completed` `merge.rejected` ·
`budget.warning` `budget.exhausted` · `guardrail.tripped` · `emergency.stop`

### 6.3 Realtime Transport

1. Orchestrator writes the event row.
2. Orchestrator calls `pg_notify('events', { seq, workspaceId })` — **id only, never the payload**
   (Postgres NOTIFY has an 8KB limit that a large tool output would exceed).
3. The web SSE route listens, then reads rows where `seq > lastSeq` and streams them.
4. On reconnect, `EventSource` sends `Last-Event-ID`; the route replays from that `seq`.

---

## 7. Provider Adapter

```ts
interface AgentRuntimeAdapter {
  readonly id: ProviderId
  getCapabilities(): ProviderCapabilities
  start(input: StartRunInput): Promise<RunHandle>
  sendInstruction(runId: RunId, message: AgentMessage): Promise<void>
  requestPause(runId: RunId): Promise<void>
  resume(runId: RunId, checkpoint: Checkpoint): Promise<RunHandle>
  cancel(runId: RunId): Promise<void>
  events(runId: RunId): AsyncIterable<RuntimeEvent>
}

interface ProviderCapabilities {
  canPauseMidRun: boolean
  canResumeSession: boolean
  supportsHooks: boolean
  streamsToolCalls: boolean
  reportsTokenUsage: boolean
  supportsCustomSystemPrompt: boolean
  enforcesToolPermissions: boolean
}
```

`getCapabilities()` is central, not decorative. The orchestrator never assumes uniform capability;
it queries and **degrades gracefully**. Example: when `canPauseMidRun` is false, pause means
"finish the current step, then stop cleanly", and the UI says so explicitly. The system never
pretends to a capability it does not have.

`RuntimeEvent` is a **normalized** stream — provider-specific output shapes are translated inside
the adapter and never leak into the domain or the UI.

---

## 8. Pause, Resume, and Checkpoints

An in-flight LLM request cannot be frozen. The checkpoint boundary is therefore the
**tool-call boundary**.

**Pause (Claude Code adapter):**
1. Orchestrator sets a pause flag in the run's control channel.
2. The `PreToolUse` hook reads the flag and blocks the tool call.
3. The run exits cleanly with its session id preserved.
4. A checkpoint is persisted: `{ sessionId, lastCompletedStep, worktreeCommit, filesTouched, ts }`.

**Resume:** `claude --resume <sessionId>` in the same worktree. Any human instructions queued
during the pause are injected as the first message on resume.

**Stop:** the process is killed and the worktree is preserved, so no work is lost.

> **Risk — highest in the project.** The exact hook behaviour, session-resume semantics inside a
> worktree, and token/cost reporting are unverified assumptions. **Milestone 0 is a spike that
> proves this before any other code is written.** If it fails, only the pause semantics change
> (degrading to step-boundary stop) — but discovering that after three weeks of UI work would be
> expensive.

---

## 9. Orchestrator: The Autonomy Engine

A single tick loop (periodic + notification-driven):

1. **Reconcile** — drain active run streams, apply normalized events, update state.
2. **Plan** — for a workspace with a goal and no tasks, start a *planning run* for the AI Manager.
   Its output is not code but a **Zod-validated task graph** (title, role, dependencies).
   Invalid output is rejected and re-requested; free-form text never reaches the database.
3. **Schedule** — select tasks whose dependencies are satisfied, that have no active run and
   remaining attempts; match agent by role and skill; start runs within concurrency and budget limits.
4. **Verify** — on run completion, execute the workspace's verify commands inside the worktree.
5. **Review** — if verification is green, dispatch a QA agent run over the diff.
6. **Advance** — on approval, mark `done`, enqueue for merge, unblock dependents. On rejection,
   move to `rework` **with the rejection reason attached as input to the next run**.

### 9.1 Deterministic Core

The decision half of the loop is a pure function:

```ts
decide(world: WorldState): Command[]
```

Side effects (spawn process, create worktree, run commands) execute in a separate layer. This makes
"five tasks ready, two slots free, budget at 80% — what starts?" testable without spawning a single
process. **This is the second TDD target.**

### 9.2 Guardrails

All limits are stored as workspace configuration; the values below are the seeded defaults.

| Guardrail | Behaviour | Default |
|---|---|---|
| Concurrency limit | Cap on active runs, global and per-workspace | 3 per workspace, 6 global |
| Budget ceiling | Per-workspace cost cap; warning event at 80%, on breach scheduling halts and active runs are paused | $20 per workspace |
| Run timeout | Wall-clock limit and maximum tool calls per run | 30 min, 200 tool calls |
| Attempt cap | Per-task rework limit; exceeding it moves the task to `failed` | 3 attempts |
| Circuit breaker | Consecutive failed runs in a workspace halts that workspace | 3 consecutive |
| Emergency stop | One switch: all scheduling stops, pause is requested on every active run | — |
| Permissions | Each agent's allow/deny list is enforced **at the adapter level** as tool restrictions, never in UI components | per role |

---

## 10. Git Model and Merge Queue

- Worktree per task at `.aiteamos/worktrees/<TASK-KEY>`, branch `aiteamos/<TASK-KEY>-<slug>`.
- Worktrees are preserved on failure or cancellation for inspection; garbage-collected 7 days after
  the task reaches a terminal state, and on demand from the task detail view.

**Verify commands** are workspace configuration: an ordered list of shell commands
(e.g. `["npm run build", "npm test"]`) executed in the worktree. A workspace with an empty list
cannot reach `done` automatically — the orchestrator emits `guardrail.tripped` and escalates to the
human rather than assuming success.

**Auto-merge (D10).** Green tests on a branch do not imply green tests after merging — two agents
can each be green and still break `main` together, with no git conflict to warn anyone. Merges are
therefore serialized through a queue:

1. Task becomes a merge candidate → rebase the branch onto `main`.
2. **Re-run the verify commands on the merged result.** This, not the branch run, is the real gate.
3. If green, merge to `main` with a task-keyed merge commit (revertible in one command).
4. If the rebase conflicts or post-merge verification fails, do not merge: return the task to
   `rework` with the conflict/failure detail as input. Repeated failure escalates to the human.

---

## 11. Data Model

### 11.1 MVP Tables

`Workspace` (repo path, base branch, verify commands, budget config, autoMerge flag) ·
`Team` · `Agent` · `AgentPermission` · `Skill` · `SkillProvider` · `AgentSkill` ·
`ProviderConfiguration` · `Task` · `TaskDependency` · **`AgentRun`** · `Checkpoint` ·
`Artifact` · `AgentMessage` · `ExecutionEvent` · `Approval` (merge gate only)

Enums for every status and category. `ExecutionEvent.payload` is JSONB, validated by Zod at the
write boundary.

### 11.2 Deliberately Excluded (documented, not silently simplified)

| Entity | Decision | Reason |
|---|---|---|
| `Workflow`, `WorkflowNode`, `WorkflowEdge` | Excluded | The workflow builder is post-MVP. Unused tables freeze the wrong abstraction early and complicate schema evolution. |
| `Decision` | Deferred | Agent-made architectural decisions are adequately represented by `Artifact` + `ExecutionEvent` today. |
| Communication-graph tables | Not created | Agent-to-agent communication already happens via task handoffs and messages; `ExecutionEvent` carries actor and target. Graph Mode 5's edges are **derivable** from the log. A table that need not be written need not be maintained. |
| `ProjectAgent` | Renamed | Modelled as `Workspace`↔`Agent`. "Project" was overloaded — it meant both the target repository and the UI container. |

### 11.3 Auth Preparation

No authentication in the MVP, but `ExecutionEvent.actor` and `Task.createdBy` exist from day one so
that introducing users later does not require rewriting history.

---

## 12. UI and Design Direction

### 12.1 Design Principle

**Interest comes from liveness, not decoration.** The screen already moves on its own: real
processes run, logs stream, tasks change columns, agents hand off work. What makes a control room
compelling is real data breathing, not animation.

**Rule: every movement must carry information.** An edge in the org graph illuminates because a
handoff actually occurred. A card's border pulses because a tool call is running right now. Motion
that communicates nothing is cut. This satisfies both "not boring" and "not noisy".

### 12.2 Visual Identity: Mission Control

Dark, dense, instrument-like. Telemetry panels, live gauges, mono typography for identifiers and
logs, a tight sans for UI chrome. A quiet palette where **status colours are the only saturation on
screen** — status pops without gradients. Linear's discipline with a flight-console character.

### 12.3 Signature Elements

- **Live action line** — each agent card streams what it is doing right now:
  `Reading CheckoutService.java` → `Running tests…`
- **Activity sparkline** — tool-call density over the last 10 minutes. A flat line means stuck.
- **Pulsing organization graph** — you watch work flow through the company in real time.
- **⌘K command palette** — Raycast-style, the primary interaction surface: message an agent,
  assign a task, pause, all from the keyboard.
- **Merge queue visualization** — queued branches and post-merge verification state.

### 12.4 Page Map (MVP)

| Screen | Contents |
|---|---|
| **Overview** | Top strip: working/waiting/paused/idle agents, active/blocked tasks, **budget gauge**. Agent cards below with live status, current task, step progress, provider, actions |
| **Tasks** | Board: `backlog / ready / running / verifying / reviewing / blocked / done / failed`. Task detail shows checkpoints, artifacts, run history, rework reasons |
| **Agent detail** | Side panel (not a separate page — intervention must not cost context): live log stream, message input, pause/resume/stop, skills, permissions, tokens/cost |
| **Activity** | Live timeline over SSE, filterable by workspace/agent/task/event type |
| **Graph** | **Two modes only**: Organization and Task Dependency DAG. React Flow + ELK.js, live status colours, node context menus |

**Out of MVP** (architecture supports them, no screens yet): Skills management, Analytics, full
Settings, Execution graph, Skill-execution graph, Communication graph, Team builder, Workflow builder.

Reason: three of the five graph modes deliver less value than one genuinely working runtime. The
organization graph is the product's identity and the dependency DAG is *operationally required* in
autonomous mode — it answers "why is nothing progressing?". The other three will be designed far
better once real event data exists.

### 12.5 Design Skill Usage by Milestone

| Milestone | Skills |
|---|---|
| M4 (shell + Overview) | `frontend-design`, `ui-ux-pro-max` — visual language, tokens, type and colour system |
| M4–M5 (components) | `taste-skill`, `emil-design-eng` — component-level polish |
| M5–M7 (motion) | `animate`, `apple-design` — spring-based, interruptible motion |
| M7+ (audit) | `find-animation-opportunities`, `review-animations` |
| Sparklines / analytics | `dataviz` |

---

## 13. Milestones

Each is a vertical slice and each ends in a verified state.

| # | Milestone | Verification |
|---|---|---|
| **M0** | **Pause/resume spike.** No UI, no DB. A bare script: start a run → pause at a tool boundary → inject a message → resume. | Measured real behaviour; a written answer, not code we keep |
| **M1** | **Domain core (pure TDD).** State machines, event union, `decide()` scheduler. Zero I/O. | Full unit test coverage, all green |
| **M2** | **Persistence + event log.** Prisma schema, migrations, seed data, event writes, LISTEN/NOTIFY. | Seeded DB, notifications observed |
| **M3** | **Orchestrator + ClaudeCodeAdapter.** Real processes, real worktrees, real verify commands. No UI. | A task driven end-to-end from CLI, branch produced |
| **M4** | **App shell + Overview + SSE.** | A real agent's real work visible on screen, live |
| **M5** | **Task board + agent detail + intervention.** Pause/resume/stop/message end-to-end. | Manual interruption of a live run succeeds |
| **M6** | **Activity timeline.** Filtered live stream. | Events appear within one second of occurrence |
| **M7** | **Graph** (organization + dependency DAG), React Flow + ELK. | Live status reflected in nodes |
| **M8** | **Autonomy closure.** Planning run, QA review run, merge queue, guardrails, emergency stop. | A goal → merged branch, unattended |
| **M9** | **Documentation + code review pass.** ADRs written along the way; completeness check here. | All docs present, review clean |

M0–M4 produce a genuinely working skeleton; M5–M8 produce a usable product. The first real
"wow" moment lands at M4.

### 13.1 Seed Data

Company: **Atlas** (AI Manager) · Engineering: **Alex** (Backend), **Emma** (Frontend),
**Daniel** (DevOps), **Maya** (QA) · Security: **Sarah** · Product: **John** (BA) ·
Marketing: **Oliver** (SEO). Project: **Checkout Platform**, with tasks covering every status so
each state is demonstrable.

---

## 14. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Pause/resume mechanics do not behave as assumed | **High** | M0 spike before anything else; fallback is step-boundary stop |
| Autonomous team burns budget going the wrong way | **High** | Budget ceiling, attempt cap, circuit breaker, emergency stop — all in M8, guardrail config from M2 |
| Parallel agents produce semantically conflicting merges | **High** | Serialized merge queue with post-merge re-verification (§10) |
| Planning run emits an unusable task graph | Medium | Zod-validated output, rejection and retry, human-visible plan before execution |
| Provider capability asymmetry leaks into the domain | Medium | `getCapabilities()` + graceful degradation + normalized `RuntimeEvent` |
| Orphaned child processes / worktrees after a crash | Medium | Run registry with pid and worktree path; startup reconciliation sweep |
| Scope regrowth toward the full original brief | Medium | MVP boundary in §12.4 and exclusion table in §11.2 are binding |

---

## 15. Deliberate Simplifications Log

Per the brief's requirement never to silently simplify a requirement:

1. **Cursor adapter is a stub** (D11) — interface conformance only, no real integration in the MVP.
2. **Three of five graph modes deferred** (§12.4) — data model supports them; screens come later.
3. **Workflow tables excluded** (§11.2) — the builder is post-MVP.
4. **Analytics screen deferred** — the event log accumulates the data from M2, so the screen can be
   built later against real numbers rather than fabricated ones.
5. **Team builder deferred** — seed teams and manual agent creation cover the MVP.
6. **No authentication** (D4) — single user, localhost; `actor`/`createdBy` fields preserved.
7. **Human approval gates reduced to the merge gate only** — a consequence of D5 (full autonomy);
   the `Approval` entity remains so that step-level gates can be reintroduced.

---

## 16. Next Step

Produce a detailed implementation plan with the `writing-plans` skill, starting from M0.
