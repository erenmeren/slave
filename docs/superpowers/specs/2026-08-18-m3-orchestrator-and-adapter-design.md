# M3 — Orchestrator and ClaudeCodeAdapter: Design Specification

**Date:** 2026-08-18
**Status:** Draft for review
**Parent spec:** `docs/superpowers/specs/2026-08-17-ai-team-os-design.md` (binding authority)
**Binding prior decision:** `docs/decisions/0001-pause-semantics.md` (ADR 0001, measured in M0)
**Predecessors:** M1 (domain core), M2 (persistence and events)

---

## 1. What M3 Is

M3 turns the pure decision core into a system that runs real processes. It is the first milestone
that spawns a child process, creates a git worktree, and executes a command whose output it did not
write.

Parent spec §13 defines the gate: *"A task driven end-to-end from CLI, branch produced."* No UI.

### 1.1 In scope

Four phases of the parent spec's §9 tick loop:

- **Reconcile** — drain active run streams, normalize provider output, apply it to state.
- **Schedule** — call the existing `decide()` and execute the commands it returns.
- **Verify** — run the workspace's verify commands inside the worktree.
- **Advance** — on green, mark the task `done`; on red, return it to `rework` with the failure
  detail attached as input to the next run.

Plus the full `AgentRuntimeAdapter` surface for Claude Code, including pause and resume, driven
from the CLI.

### 1.2 Out of scope, and where it goes

| Deferred | Owner | Why not here |
|---|---|---|
| Planning run (goal → Zod-validated task graph) | M8 | §13 assigns it to M8; M3's gate needs a task that already exists |
| QA review run over the diff | M8 | Same |
| Merge queue and auto-merge | M8 | Same; M3's gate is "branch produced", not "branch merged" |
| Any UI, SSE route, or HTTP surface | M4 | §13: M3 is explicitly "No UI" |
| Worktree garbage collection sweep | later | Nothing reaches 7 days inside M3. The **data** it needs is recorded here (§7.4) so it stays a sweep function, never a migration |
| Budget warning/exhausted events | M8 | §9.2 guardrail behaviour beyond `halt` belongs with the guardrail milestone |

M3 emits `guardrail.tripped` when `decide()` halts, because that path already exists in the domain
and a silent halt is indistinguishable from a broken scheduler. Everything else in §9.2 waits.

---

## 2. Package Layout and the Dependency Rule

Two new units, matching parent spec §3.2:

```
apps/
  orchestrator/        Long-lived Node daemon. The only writer.
packages/
  providers/           AgentRuntimeAdapter, ClaudeCodeAdapter, and the fake used in tests
```

Dependency directions, and these are load-bearing:

```
apps/orchestrator  ──>  packages/domain, packages/db, packages/events, packages/providers
packages/providers ──>  packages/domain          ONLY
```

### 2.1 `packages/providers` must not depend on `packages/db`

The adapter never writes to the database. It emits normalized `RuntimeEvent` values; the
orchestrator is what persists them, and it does so through `appendEvent`.

This is not stylistic. ADR 0003 established that `ExecutionEvent` has exactly one write path, and
M2's final review already found that the protection is a reviewable convention rather than an
enforced barrier. A provider package holding a Prisma client would make that convention
unobservable at exactly the moment the system gains its first concurrent writers. The adapter
translates; it does not persist.

A second consequence: the adapter is testable without a database at all. Its entire surface can be
exercised against fixtures in the unit project.

---

## 3. The Tick Loop

One function, two triggers.

```ts
tick(deps: TickDeps): Promise<TickReport>
```

- **Periodic** — a timer, default 1000ms.
- **Notification-driven** — the `events` channel from M2 wakes it.

Both call the same function. This mirrors M2's established rule: *a notification is a wake-up, not
a delivery.* A missed notification costs latency, never correctness, because every tick reloads
the world from the database rather than trusting what it was told.

### 3.1 What one tick does

1. **Load the world** (§4) for each active workspace — one holding at least one task in a
   non-terminal status.
2. **Decide** — call the domain's `decide(world)`, unchanged.
3. **Execute** the returned commands (§3.2).
4. **Sweep** (§3.3).

Reconciliation of run output is *not* in the tick. It runs continuously, per run — see §5.6.

### 3.2 Executing commands

`decide()` returns two command kinds today, and M3 does not widen that union.

- `start_run` → provision the worktree (§7), spawn the run (§5), write the `AgentRun` row. Note
  that `run.started` is **not** emitted here: its payload requires `sessionId`, which does not
  exist until the child's first `system/init` line. It is emitted when that line arrives (§5.4).
- `halt` → emit `guardrail.tripped` and stop scheduling for that workspace this tick.

Everything else M3 does — running verify, writing a checkpoint, moving a task to `rework` — is the
orchestrator *reacting to observed state*, not executing a domain command. This is the boundary
chosen deliberately in brainstorming: putting those in the `Command` union would force `World` to
carry process state, and the pure core's value is that it does not know processes exist.

The cost is real and stated plainly: `decide()`'s tests do not cover M3's reactive behaviour. §12
is how that cost is paid.

### 3.3 The sweep

Each tick, for every non-terminal run:

- **Wall-clock timeout** exceeded (`Workspace.runTimeoutMs`) → request cancel, emit
  `guardrail.tripped`.
- **Tool-call ceiling** exceeded (`Workspace.maxToolCallsPerRun`) → same.
- **Dead pid** → the process is gone but the run is not terminal. Mark it `failed`, preserve the
  worktree, emit `run.failed`.

### 3.4 Startup reconciliation

Before the first tick, the daemon sweeps every non-terminal run left behind by a previous process:
if its pid is absent, the run is `failed` with an explicit reason and its worktree preserved.

Parent spec §14 names orphaned processes and worktrees as a Medium risk whose mitigation is
exactly this. It belongs to M3 because M3 is where real processes first exist; without it, every
daemon restart leaves the database describing runs that are not running.

---

## 4. Loading the World

`loadWorld(workspaceId): Promise<World>` lives in the orchestrator and maps database rows onto the
domain's existing `World` type. Nothing in `World` changes.

| `World` field | Source |
|---|---|
| `tasks[].status` | `Task.status` |
| `tasks[].dependenciesDone` | computed in SQL from `TaskDependency` — true when every dependency is `done` |
| `tasks[].requiredRole`, `priority` | `Task` columns |
| `agents[].busy` | true when the agent has an `AgentRun` in a non-terminal status |
| `limits` | the `Workspace` guardrail columns |
| `stats.activeRuns`, `spentUsd`, `consecutiveFailures` | aggregated from `AgentRun` |
| `stats.emergencyStopped` | false throughout M3 — the emergency stop switch is M8 (§1.2) |

**One type mismatch to resolve, not paper over.** `Task.requiredRole` is nullable in the schema
while the domain's `SchedulableTask.requiredRole` is not. A task with no required role cannot be
matched to an agent, so `loadWorld` **excludes it from the schedulable set** rather than inventing
a default role or widening the domain type. Assigning a role is a precondition for scheduling, and
a task sitting unscheduled because it has none is a state the operator must be able to see — so
the exclusion is counted and surfaced in the `TickReport`, never silent.

Summing `costUsd` across a task's run segments is the correct accounting: ADR 0001 Q3 measured
each segment's `total_cost_usd` as that segment's own total, not a running session total. Summing
does not double-count.

---

## 5. The Adapter

ADR 0001 measured this surface against the real CLI and made its findings binding. The design work
here is mostly fidelity to what was measured.

### 5.1 Interface

Parent spec §7's `AgentRuntimeAdapter`, implemented in full:
`getCapabilities`, `start`, `sendInstruction`, `requestPause`, `resume`, `cancel`, `events`.

`getCapabilities()` returns ADR 0001's measured object verbatim, including
`supportsCustomSystemPrompt: false` — unmeasured, and `false` is the fail-safe direction.

### 5.2 Spawning a run

Every run is spawned with:

- **cwd** = the run's worktree.
- **env** — `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`,
  and `AITEAMOS_PAUSE_FLAG` set to a path unique to this run.
- **a per-run settings file** registering the `PreToolUse` hook by **absolute path**.

Mandatory flags (ADR 0001 §3):

```
--output-format stream-json --verbose
--permission-mode bypassPermissions
--settings <absolute path>
--include-hook-events
```

Two flags are forbidden: `--no-session-persistence` (makes resume impossible) and `--fork-session`
(mints a new session id on resume).

The pause flag path is unique per run and an unset value is a loud configuration error, never a
shared default — a shared default would let pausing one agent freeze an unrelated concurrent one.

### 5.3 Parsing the stream

The child emits NDJSON. Five properties were measured and the parser must respect all five:

1. `hook_response.output` is a **JSON-encoded string**, not a nested object. It needs a second
   parse.
2. `hook_response` carries **no `tool_use_id`**, only `hook_name`. Correlation to a specific call
   goes through the `tool_result` that follows it.
3. The terminal `result` event's `permission_denials` array is accurate but arrives at the end.
   It is checkpoint material, never a live signal.
4. `permission_denials` **cannot distinguish a hook crash from a genuine deny.** A blocking crash
   lands in it with the same `tool_name` / `tool_use_id` / `tool_input` shape as a deny, and a
   fail-open hook failure does not land in it at all. It is checkpoint material and nothing more —
   in particular it is not a health signal for the gate.
5. `hook_response` events **can arrive after the terminal `result` event.** An asynchronous hook
   reports late, so the reader does not stop at `result`, and does not assume that
   `hook_started` / `hook_response` pairs are ordered per tool call. What *is* ordered: the block or
   deny for a pending call always precedes that call's `tool_result`. That ordering, not stream
   position, is what property 2's correlation relies on.

**Four outcome shapes, never conflated. The discriminator is `exit_code`, never `outcome`.**

| Shape | Signal | Tool ran? | Meaning → mapping |
|---|---|---|---|
| Permission-mode denial | `system/permission_denied` | no | The run is misconfigured and will accomplish nothing → `guardrail.tripped` |
| Hook deny | `hook_response` `exit_code === 0`, `output` parses to `permissionDecision: "deny"` | no | The run is pausing as instructed → the pause path in §5.5 → `run.paused` |
| Hook crash, blocking | `hook_response` `exit_code === 2` | no | The gate is broken **and the run stopped** → fail the run loudly. Never `paused`: nothing is waiting to be resumed |
| Hook failure, fails open | `hook_response` `exit_code` non-zero and **not** 2 (measured: 1, 126, 127) | **yes** | The gate is broken **and the tool ran** → fail the run loudly, distinctly from the row above |

The last two must not share a variant. One means the run stopped and cannot be resumed; the other
means the run continued with no gate at all, and a side effect has already landed. An operator told
"the gate broke" needs to know which of those happened, and a resume path must never be offered for
the second.

**`outcome: "error"` does not mean the tool was blocked.** All of `exit_code` 1, 2, 126 and 127
report it, and only 2 blocks. A classifier keyed on `outcome` would label a fail-open failure as a
blocking crash — reporting a run as safely stopped at the moment nothing is stopping it. Key on
`exit_code === 2`, exactly.

An orchestrator that reads the permission-mode denial as a hook deny waits forever to resume a run
that never paused; one that reads either hook failure as a hook deny reports `run.paused` for a run
that is still free to act.

Evidence for all of the above, with captures and file-state checks:
`docs/superpowers/spikes/2026-08-18-m3-hook-failure-modes.md` (§1, §3, §6).

**Run outcome is read from the terminal `result` event** (`is_error`, `terminal_reason`,
`stop_reason`, `permission_denials`), never from the child's exit code. ADR 0001 records a run
that reported clean completion while landing nothing — only `permission_denials` revealed it. An
adapter reading a coarse success/failure signal misclassifies that case in both directions.

**The terminal event is authoritative for outcome but blind to gate health.** A run whose hook
failed open ends `is_error: false`, `terminal_reason: "completed"`, child exit code 0, and
`permission_denials: []` — every terminal field says "healthy" while the run executed ungated. That
verdict comes from §5.5's runtime backstop, which reads the live stream, not from this event. The
rule above decides *whether the work succeeded*; it does not decide *whether the run was
controllable*.

**An unrecognized line does not kill the run.** It is dropped and recorded. M2 established the
pattern for malformed notification payloads; the reason is the same and so is the discipline:
dropping is acceptable, dropping silently is not.

### 5.4 Normalized output

`RuntimeEvent` is the adapter's vocabulary and no provider-specific shape crosses it. The
orchestrator maps `RuntimeEvent` onto the domain event union (§9) and persists via `appendEvent`.

Two mappings are timing-sensitive rather than mechanical:

- **`run.started` is emitted from the first `system/init` line**, not at spawn, because its payload
  carries `sessionId` and no session id exists before that line. `AgentRun.sessionId` is written in
  the same step. A run that dies before emitting `system/init` therefore never produces
  `run.started` — it produces `run.failed`, which is the accurate account of what happened.
- **`run.tool_call` is emitted per tool use**, and its count is what `AgentRun.toolCalls` and the
  tool-call ceiling in §3.3 are read from.

### 5.5 Pause

The two-part protocol from ADR 0001, which exists because a hook deny removes the agent's ability
to act without stopping the agent — in the measured run the model responded to the first deny by
trying a different tool.

1. `requestPause(runId)` writes the run's flag file → emit `run.pause_requested`, status
   `pause_requested`.
2. On the **first hook deny observed in the stream**, send `SIGTERM`; escalate to `SIGKILL` after
   a grace period. Do not wait for the model to stop on its own — the self-stop seen in the spike
   is a property of that model on that prompt, not a contract.
3. On process exit, write the checkpoint (§6) → emit `run.paused`, status `paused`.

**"Pause requested, run finished anyway" is a normal outcome, not an error.** The hook is only
consulted when a tool call is pending; if the pause arrives while the model is producing final
text, no deny will ever come. The run ends `succeeded`/`failed`, the flag is cleared, and the
pause request carries a deadline rather than waiting indefinitely.

**A written settings file is not an armed gate.** A syntactically valid settings file whose
absolute `command` path is wrong, or points at a file without the execute bit, or points at a
script that fails for its own reasons, produces a run that spawns cleanly, executes every tool call
unimpeded, ignores the pause flag entirely, and terminates reporting success with an empty
`permission_denials`. `requestPause` would write the flag, nothing would deny, no `run.paused` would
ever be emitted, and the operator would watch a "pausing" run keep working. M3 generates that
settings file and its hook path per run, so this is reachable from a single path bug. Two checks
guard it, and they are not interchangeable.

**Pre-flight, before a run is considered pausable.** Execute the hook script directly with a flag
file present and assert that it emits deny JSON on stdout and exits 0. It is free, local, and
synchronous, and it catches the whole deployment class at once: a missing path, a missing execute
bit, a script broken badly enough to fail on its own, and a script whose deny payload no longer
parses. **What it does not prove is that Claude Code will actually invoke it** — a correct script
registered under a matcher that never matches, or in a settings file the CLI does not load, passes
this check and gates nothing. It is a cheap necessary condition, not a sufficient one.

**Runtime backstop, and this is the one that matters.** If tool calls are observed in the stream
after the pause flag was written, and no deny or blocking crash accompanied them, the gate is
broken → fail the run loudly. This check keys on behaviour rather than on the shape of any failure,
which is what makes it the durable one: tool calls proceeding after the flag was armed is the same
observation whether the hook was missing, slow, timed out, or exited 1, and it holds for failure
modes nobody has measured yet.

It also fixes a conflation the pause path would otherwise carry. "Pause requested, run finished
anyway" above is benign — the run had no further tool calls. "Tool calls are proceeding and nothing
is stopping them" is not benign, and today both look like the same terminal outcome. The stream
already carries what separates them: the presence of `run.tool_call` events with timestamps after
the flag write, unaccompanied by a deny or an `exit_code === 2` crash. The pause path must tell
those apart before it reports either.

Evidence: `docs/superpowers/spikes/2026-08-18-m3-hook-failure-modes.md` §6.

### 5.6 Consuming the stream

Each active run gets its own concurrent pump that awaits `appendEvent` per event. It is not
drained inside the tick.

Three reasons. M6 requires events visible within one second, and binding delivery to the tick
period forfeits that by construction. `appendEvent` is transactional, so concurrent pumps are safe
— the single-writer rule is about the process, not about a single thread of execution. And
awaiting `appendEvent` per event applies natural backpressure to the child's stdout: if the
database slows, the pump slows, and no event is lost.

### 5.7 Resume

Clear the flag file, **verify it is absent**, then spawn
`claude -p "<queued instruction text>" --resume <sessionId>` in the same worktree with the same
settings and permission posture. Status `resuming` → emit `run.resumed` → `working`.

`Checkpoint.sessionId` is written once at run start and **never rewritten** — a plain `--resume`
reports the same UUID, so rewriting adds a failure mode for no benefit.

### 5.8 `pause-gate.sh` must gain a JSON encoder first

The script interpolates its reason string into JSON with `printf` and no escaping. That is safe
for its two static call sites and unsafe for M3, which will pass reasons containing a task key, an
operator name, and the operator's own message.

**A malformed deny is an allow.** The encoder lands before the adapter uses dynamic reasons. ADR
0001 §7 marks this binding.

---

## 6. Checkpoints

ADR 0001 §5 defines the contents. They go in a new `Checkpoint` model rather than ten more columns
on `AgentRun`: a checkpoint has its own lifecycle, is written at a different moment than the run
row, and `AgentRun` is already wide.

| Field | Purpose |
|---|---|
| `runId` | owner |
| `sessionId` | written once at run start from the first `system/init` line; never rewritten |
| `worktreePath` | resume must spawn with cwd set to the run's original directory |
| `pauseFlagPath` | resume must clear it and verify it absent, or the hook denies everything |
| `lastToolUseId`, `lastToolName`, `numTurns` | the concrete form of "last completed step" |
| `deniedToolUseIds` | from `permission_denials`; the operator's view of what the agent was about to do |
| `headCommit`, `dirtyFiles` | `HEAD` alone is insufficient — the interesting state is usually uncommitted, so `git status --porcelain` is recorded too |
| `cumulativeCostUsd`, `cumulativeTokens` | per-segment figures, summed by the budget guardrail |
| `pauseReason`, `requestedBy`, `ts` | provenance for the audit trail |

---

## 7. Worktrees

### 7.1 Layout

Path `.aiteamos/worktrees/<TASK-KEY>`, branch `aiteamos/<TASK-KEY>-<slug>`, created from
`Workspace.baseBranch`.

### 7.2 Provisioning

`git worktree add`, then the workspace's **setup commands**, then the run.

ADR 0001 is explicit that a fresh worktree is not a ready workspace: in the spike neither worktree
had `node_modules` and `npm test` passed anyway, purely because the fixture repo has zero
dependencies. That must not be generalized. A real repository fails its verify commands without a
setup step.

### 7.3 No run may write to the git common directory

Worktrees isolate refs and files; `.git/config` is repo-wide state they do not isolate. In the
spike both concurrent agents hit the same missing-identity failure there and one wrote git identity
into the shared config persistently. Two such writes with different values would have silently
overwritten each other.

Three layers, in order of reliability:

1. Identity supplied through the spawned process's **environment** (§5.2) — per-process, writes no
   file, and removes the failure that provoked the config write in the first place.
2. Persistent git-config writes **denied in the permission hook**.
3. Where the orchestrator issues git commands itself, `git -c user.name=... -c user.email=...` —
   the same non-persistent guarantee at the command level.

Identity is the instance the spike surfaced. The rule is general.

### 7.4 Retention

Worktrees are **preserved** on failure and on cancellation; they are the inspection surface. The
timestamp at which a task reaches a terminal state is recorded so that the 7-day collection in
parent spec §10 remains a later sweep function rather than a later migration.

---

## 8. Verify

`Workspace.verifyCommands` is an **ordered list** of shell commands, executed in the worktree after
the run reaches a terminal state.

- Each command's exit code and captured output is persisted as an `Artifact`. Without it, the
  reason a task failed is lost, and M4/M5 have nothing to show.
- Per-command timeout comes from the workspace guardrails.
- Task transitions: `task.verifying` → `task.verify_passed` → `task.done`, or
  `task.verify_failed` → `task.rework`.
- On failure, the captured output is **attached as input to the next run** through the existing
  `Task.lastRejectionReason` column — no new field is needed, and M2 already put it there for
  exactly this. A rework that does not tell the agent what broke is a re-roll, not a fix.

**An empty verify list is a refusal, not a pass.** The task cannot reach `done` automatically:
`guardrail.tripped` is emitted and the human is escalated to. Assuming success is the failure this
rule exists to prevent.

---

## 9. Event Types M3 Adds

M1 and M2 implemented ten of the event types in parent spec §6.2's catalogue. M3 needs nine more,
**every one drawn verbatim from that catalogue** — no invented names:

```
task.verifying  task.verify_passed  task.verify_failed  task.failed
run.output  run.pause_requested  run.stopped  run.succeeded  run.failed
```

Widening touches the Zod union in `packages/domain` and the `EventType` enum in `packages/db`
together. M2's enum-parity test already enforces that they match in both directions, so drift
between them is a failing test rather than a runtime surprise.

`run.output` carries the agent's text output with a truncation cap. It is the one type included
ahead of its consumer: M4's gate is *"a real agent's real work visible on screen, live"*, and the
adapter is the only component that can produce it. Adding it later would be a union change plus a
migration; adding it now is a field the stream already carries.

Deliberately not added, though present in the catalogue: `task.assigned`, `checkpoint.created`,
`artifact.created`, `task.blocked`, `task.unblocked`, `budget.warning`, `budget.exhausted`. Each
is either derivable from a row M3 already writes or belongs to a later milestone.

---

## 10. Schema Changes

M3 requires one migration.

| Change | Reason |
|---|---|
| New `Checkpoint` model | §6 — ADR 0001's checkpoint has no home today |
| `AgentRun.pid`, `AgentRun.worktreePath` | §3.4 — parent spec §14's run registry; without them a restart cannot identify orphans |
| `AgentRun.terminalAt` | §7.4 — makes future worktree collection a sweep, not a migration |
| `Workspace.verifyCommand: String` → `verifyCommands: String[]` | Parent spec §10 specifies an ordered list. M2 implemented a single string; this corrects a silent narrowing |
| `Workspace.setupCommands: String[]` | §7.2 — ADR 0001 requires it and nothing carries it today |
| `EventType` enum widened by nine values | §9 |

The seed is updated for the two `Workspace` changes.

---

## 11. CLI Surface

Minimal, because the milestone gate is driven from the CLI and nothing else consumes it yet:

| Command | Purpose |
|---|---|
| `tick` | run exactly one tick and print the report |
| `daemon` | the periodic + notification-driven loop |
| `pause --run <id>` | write the flag, follow the protocol |
| `resume --run <id> [--message <text>]` | clear the flag, resume with an optional queued instruction |
| `cancel --run <id>` | kill and preserve the worktree |
| `status` | active runs, their pids, worktrees, and states |

---

## 12. Testing

### 12.1 Real git, real Postgres, fake `claude`

The primary instrument is a **fake `claude` executable** that replays NDJSON fixtures derived from
M0's real captures. Its modes mirror the error taxonomy of §13 and the four outcome shapes of
§5.3: normal completion, hook deny (pause), permission-mode denial (misconfiguration), **blocking
hook crash (`exit_code === 2`, tool does not run)**, **fail-open hook failure (`exit_code` 1/126/127
with the tool running anyway and `permission_denials` empty)**, crash mid-stream, hang with no
output, and a malformed line. The last two hook modes are what make §12.3's gate mutations
expressible; without them the fail-open path has no fixture and cannot be proved to bite.

This makes the adapter deterministic and mutation-provable, which is the bar M2 set: if you cannot
prove a test bites by mutating the code, you do not have a test. Nothing can be mutation-proved
against a real LLM.

Git is real and Postgres is real. Both are deterministic and free, so worktree creation, branch
production, setup commands and verify commands all run against a real fixture repository. Only the
model is faked.

### 12.2 Real-`claude` tests

A separate vitest project, outside `npm test`, invoked explicitly. It holds the Q7/Q8/Q9 measurements
(§14) and one end-to-end smoke run. These cost money and are not deterministic; they are a gate a
human runs, not a suite CI runs.

### 12.3 What must be mutation-proved

Each of these is a place where a passing test could mean nothing, so each gets an explicit
mutation in its task:

- The four outcome shapes of §5.3 are not conflated — swap any two handlers and a test must fail.
  In particular, reclassifying a fail-open hook failure (`exit_code` 1/126/127) as a blocking crash
  (`exit_code === 2`) must fail a test, because that mutation is the one that reports a run as
  stopped while it is still acting.
- The runtime gate backstop bites — make the hook fail open in the fake `claude` after the flag is
  written and the run must fail loudly rather than report `paused` or a clean finish.
- Pause kills on the first observed deny — remove the kill and a test must fail.
- The pause flag path is per-run — share it and a test must show one run freezing another.
- An empty verify list refuses rather than passes.
- Verify failure attaches its output to the next run's input.
- Startup reconciliation marks orphans failed rather than leaving them non-terminal.

---

## 13. Error Taxonomy

Six classes. The rule they share: **no failure is silent — every one emits a domain event.**

| Class | Behaviour |
|---|---|
| Provisioning failure (worktree, setup command) | The `AgentRun` row exists and goes straight to `failed` with the reason; `run.failed`. The attempt counts, so a repeatedly unprovisionable task reaches the attempt cap instead of looping forever |
| Spawn failure | Same. Both are attempted runs that failed, and recording them as anything else would make a task that never starts indistinguishable from one nobody scheduled |
| Unrecognized stream line | Dropped and recorded; the run continues |
| Run terminal failure | `run.failed`, including the "clean completion with non-empty `permission_denials`" case |
| Verify failure | `task.verify_failed` → `task.rework` with the output attached; attempt cap exceeded → `task.failed` |
| Daemon crash | Startup reconciliation (§3.4) |

---

## 14. Measurements That Come First

Two of ADR 0001's open questions were load-bearing for a milestone that implements pause, and both
were measured **before the adapter was written**. A third was raised by the first one's limit and
measured in the same task. Full evidence:
`docs/superpowers/spikes/2026-08-18-m3-hook-failure-modes.md`; ADR 0001's Open Questions carry the
resolutions.

- **Q7 — does a crashing hook fail closed? Yes, for `exit_code` 2.** A hook that exits 2 blocked
  every tool call and the side effect never reached disk. The pause design in §5.5 therefore stands
  as written: the orchestrator may treat an observed deny as side effects blocked, and the fallback
  to cancel-and-preserve is not needed.
- **Q8 — can a denied `Edit` partially apply? No; it does not apply at all.** A pause triggered
  while an `Edit` was the pending call left the target file byte-identical with an unchanged mtime
  and no `PostToolUse`. A denied `Edit` needs no compensating cleanup, and a checkpoint's dirty-file
  list will not carry a half-applied edit from a denied call.
- **Q9 — do hook failures *other than* exit 2 fail closed? No. They fail open.** A missing hook
  path (127), a hook without the execute bit (126), and a hook that runs and exits 1 each let the
  tool call proceed, with `permission_denials` empty and a terminal event indistinguishable from a
  healthy run. This is what forces the two gate checks in §5.5 and the fourth outcome shape in §5.3.
  A signal-killed hook and a hook that exceeds its timeout are **deliberately not measured**: the
  runtime backstop in §5.5 catches them behaviourally, keying on tool calls proceeding after the
  flag was armed rather than on the shape of the failure, so knowing the shape of a timeout would
  not change a decision here.

Q4 (custom system prompt), Q5 (`--allowedTools` enforcement) and Q6 (pause with no further tool
calls) are **not** measured here. Each is taken on its fail-safe side and recorded as a limitation:
`supportsCustomSystemPrompt` stays `false`, the allow-list flags stay defence-in-depth behind the
hook whose deny *is* measured, and "pause requested, run finished anyway" is already handled as a
normal outcome in §5.5.

---

## 15. Global Constraints

- TypeScript strict. No `any`, in `src` or `test`. Every exported function carries an explicit
  return type.
- `packages/providers` does not depend on `packages/db`.
- `ExecutionEvent` keeps exactly one write path, `appendEvent()`.
- The `EventType` enum and the domain Zod union stay in exact correspondence, enforced by M2's
  parity test.
- Postgres host port is 5433.
- Integration tests run against a real database and never skip silently.
- No run writes to the git common directory.
- Conventional commits with the `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
  trailer.
- `npm test` and `npm run typecheck` both pass before every commit.

---

## 16. Milestone Gate

M3 is done when, from the CLI:

1. A seeded task in `ready` is picked up by a tick.
2. A worktree is provisioned and setup commands run in it.
3. A real `claude` run executes in that worktree and its events land in the log.
4. The run can be paused, and the checkpoint written from it can resume it.
5. Verify commands run on the result.
6. On green the task reaches `done` with a branch produced; on red it reaches `rework` with the
   failure attached.

Steps 1-6 pass in CI against the fake `claude`. Steps 3-4 are additionally run once by hand
against the real CLI, and that run's captures are recorded.

---

## 17. Deliberate Simplifications

Per the parent brief's requirement never to silently simplify:

1. **`decide()` is not widened** (§3.2). M3's reactive behaviour is not covered by the pure core's
   tests; §12.3 pays that cost with explicit mutations instead.
2. **Worktree collection is not implemented** (§7.4), only made possible.
3. **`run.output` is truncated**, so the event log is not a complete transcript. The full stream is
   the child's own capture.
4. **Q4, Q5 and Q6 remain unmeasured** (§14), each taken on its fail-safe side.
5. **One provider only.** `CursorAdapter` stays the stub parent spec §15 already records.
