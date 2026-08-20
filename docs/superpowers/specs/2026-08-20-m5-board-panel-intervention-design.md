# M5: Task Board, Agent Detail, and Intervention — Design

**Date:** 2026-08-20
**Status:** Approved for planning
**Parent:** `2026-08-17-ai-team-os-design.md` §8, §12.4 (Tasks, Agent detail rows), §13 (M5 row)
**Depends on:** M3 (CLI pause/resume/cancel, checkpoints, pause gate), M4 (shell, SSE, hybrid
liveness rule), ADR 0002 (derived agent status), ADR 0003 (single write gate), ADR 0004 (command
boundary)

---

## 1. What M5 Is

The operator stops being a spectator. M4 put a real agent's real work on screen; M5 puts hands on
it: **pause a live run from the browser, queue an instruction, resume it, stop it** — the parent
spec's verification criterion is "manual interruption of a live run succeeds". Alongside the
controls, the two screens the parent page map assigns here: the **Tasks board** and the **Agent
detail side panel**.

Scope, decided during brainstorming:

- **Control plane** — a new `packages/control` package holding the pause/resume/cancel claim
  semantics the M3 CLI proved, called by both the CLI and new web API routes. The web **records
  intents; the daemon executes anything that owns a process.**
- **Tasks page** — read-only board (`backlog → failed` columns, live) plus a task detail view:
  run history, checkpoints, rework reasons, branch. No drag-and-drop, no task creation.
- **Agent detail side panel** — opens from an Overview card, never a separate page (intervention
  must not cost context): live event feed for that agent, pause/resume/stop buttons that finally
  work, a message box active only while paused, cost/tool-call counters.
- **Messages** — parent spec §8 verbatim: an instruction can be queued **only against a paused
  run** and is injected as the first message on resume. Messaging a working agent means pressing
  pause first.
- **M4's deferred motion** — the action-line cross-fade and the status-coloured card border land
  in this milestone's UI pass.

Out of M5: Activity timeline (M6), Graph (M7), planning/QA/merge-queue autonomy (M8), task
mutation from the UI, messaging a running agent in one click, any auth.

**M4's read-only rule changes here, deliberately.** The web app gains a write path — but only
through `packages/control`, and only the transitions the CLI already performs. Direct Prisma
writes from `apps/web` remain forbidden; the dependency rule in `docs/architecture.md` is updated
to say exactly that.

---

## 2. Package Layout

```
packages/
  control/        NEW — intervention semantics: claims, intents, flag files, kill
apps/
  web/            + Tasks page, agent panel, POST routes; may now import packages/control
  orchestrator/   CLI delegates claim logic to packages/control; daemon executes resume intents
```

`packages/control` imports `db`, `domain`, `events`. It **never spawns an agent process** — the
adapter (`packages/providers`) stays out of it, so the web never transitively links process
management. What moves into it:

- `runFilePaths` (from `apps/orchestrator/src/tick.ts`) — the pause-flag path derivation. One
  derivation, three consumers (tick, CLI, web) — re-deriving it as a second literal is how a gate
  ends up reading a path nobody writes.
- The kill-with-escalation helpers (`signalRun`, `isAlive`, grace period) from the CLI.
- New functions: `requestPause(runId, requestedBy)`, `requestStop(runId, requestedBy)`,
  `requestResume(runId, message | null, requestedBy)`, `updateQueuedMessage(runId, message)`.

`apps/orchestrator` may import `packages/control` (apps import packages). The CLI's `pause` and
`cancel` cases become thin callers of the same functions the web routes call. The CLI's `resume`
keeps its synchronous spawn-and-pump path (an operator at a terminal wants to watch the run), but
the claim inside it comes from `packages/control`.

---

## 3. The Control Plane

Three operations, two execution models. The dividing line: **whoever executes must be able to own
a child process.** The web server cannot (HMR restarts and request lifecycles kill children), so
anything that spawns is the daemon's job.

### 3.1 Pause — synchronous

Exactly the CLI's proven sequence, extracted:

1. Claim: `updateMany` where status ∈ {starting, working, resuming} → `pause_requested`,
   `pauseReason: 'human'`. Zero rows claimed → the run already concluded → reject (409 at the
   route).
2. Write the pause flag file at `runFilePaths(workspace.repoPath, runId).pauseFlagPath`. The
   single-machine MVP makes this legal from the web server process: web, daemon and agent share
   one host and one filesystem (§10 records the simplification).
3. Append `run.pause_requested` (actor `human`, payload `{ requestedBy }`).

The gate denies the run's next tool call; the daemon's pump observes the deny and records
`run.paused` plus the checkpoint — unchanged from M3.

### 3.2 Stop — synchronous

The CLI `cancel` sequence, extracted: SIGTERM → grace → SIGKILL if alive; conclude the run
(`stopped`, terminal timestamps) with the `endedAt: null` guard; move the task to `blocked` and
clear `activeRunId`; append the stop event. Cross-process kill by pid is exactly what the CLI does
today from a separate process — no new mechanics.

### 3.3 Resume — an intent the daemon executes

The web **must not** claim `paused → resuming`: the orphan sweep treats every non-terminal status
except `paused` with a dead pid as an orphan and fails it. A `resuming` row with no process yet is
precisely that shape — a daemon restart between claim and spawn would destroy the run the operator
just tried to continue. So:

1. **Web:** `requestResume` validates the run is `paused`, has a checkpoint, and its workspace is
   not halted (same refusal as the CLI, same wording). It then sets the intent — two new columns
   on `AgentRun`: `resumeRequestedAt DateTime?` and `queuedMessage String?` — and appends a new
   event type `run.resume_requested` (actor `human`). The run **stays `paused`**, which the sweep
   ignores.
2. **Daemon:** each tick, after the existing start pass: find runs where `status = paused` and
   `resumeRequestedAt != null` in non-halted workspaces. For each: claim `paused → resuming`
   (clearing `resumeRequestedAt`), then run the CLI's resume body — `adapter.resume` from the
   checkpoint with the queued message, emit `run.resumed`, pump, verify on conclusion. The claim
   and the spawn now live in the same process, closing the orphan window to the same width the
   CLI's always had.
3. The queued message is cleared when consumed. While the run is paused, `updateQueuedMessage`
   may overwrite it (last write wins — one instruction slot, not a mailbox; §10).

A resume intent against a workspace that halts before the tick executes it is simply never picked
up (the tick's world load already excludes halted workspaces) — the intent stays visible in the
panel with the halt banner explaining why nothing moves.

### 3.4 Event catalogue additions

`run.resume_requested` joins the union: domain event schema, DB enum (`run_resume_requested
@map("run.resume_requested")`), migration. `run.pause_requested`, `run.resumed`, `run.stopped`
already exist from M3.

---

## 4. API Routes

All POST, all thin shells over `packages/control`, all JSON:

- `POST /api/w/[workspaceId]/runs/[runId]/pause`
- `POST /api/w/[workspaceId]/runs/[runId]/resume` — body `{ message?: string }`
- `POST /api/w/[workspaceId]/runs/[runId]/stop`
- `POST /api/w/[workspaceId]/runs/[runId]/message` — body `{ message: string }` (update the
  queued instruction while paused)

Route-level checks: the run belongs to the workspace in the URL (404 otherwise). Control-level
refusals (already concluded, not paused, no checkpoint, workspace halted) map to **409** with the
refusal text as the body; the panel surfaces it verbatim. No auth (§11.3 preparation only, as in
M4). No CSRF token: same-origin POSTs with JSON bodies, and the app serves one operator on
localhost (§10).

The UI never trusts its own click: after any 2xx or 409 the panel lets the normal event-driven
refetch reconcile — the button's outcome is whatever the next snapshot says, not what the client
assumed.

---

## 5. Tasks Page

- `/w/[workspaceId]/tasks` — the board. Columns exactly the eight task statuses
  (`backlog / ready / running / verifying / reviewing / blocked / done / failed`); cards show
  title, assignee agent (when a live run exists), attempt counter (`2/3`), priority. Live via the
  M4 hybrid rule: server-rendered snapshot + SSE wake-up refetch.
- Task detail: a side panel on the board (consistent with the agent panel; a separate page would
  cost the board context the same way it would cost the Overview's). Contents: description,
  status, branch, rework/rejection reasons, and the run history — each run's status, cost, tool
  calls, and its checkpoint summary when paused (paused-at step, session id, dirty file count).
- Read model: `buildTasksSnapshot(workspaceId)` in `apps/web/src/server`, same shape of module as
  `buildOverviewSnapshot`; `GET /api/w/[workspaceId]/tasks` serves it. Task detail loads through
  the same snapshot (the board is small at MVP scale; one payload, no per-task endpoint — §10).
- Sidebar's "Tasks" item goes live (it exists in the M4 shell, inert).

---

## 6. Agent Detail Panel

Opens from an Overview agent card; closes back to the grid; the Overview keeps rendering behind
it. URL state `?agent=<id>` so a refresh restores it (shallow routing, no server round-trip on
open/close).

Contents, top to bottom:

- **Header:** name, role, provider chip, derived status with the same dot/pulse language.
- **Current run block:** task title, cost so far, tool calls, paused-at step when paused.
- **Controls:** pause (enabled while starting/working/resuming), resume (enabled while paused,
  disabled with the halt reason when the workspace is halted), stop (enabled while any live run
  exists). Every button disables itself while its POST is in flight; refusals (409 text) render
  in the panel's error band, M4 taxonomy.
- **Message box:** visible always, writable only while paused ("pause to instruct" hint
  otherwise). Shows the currently queued instruction; saving overwrites it; consumed on resume.
- **Live feed:** this agent's events from the **existing** workspace SSE stream, filtered
  client-side by `agentId` — no new transport, no second EventSource. Rendered from a small
  rolling buffer (last 50 events) fed by the same `onmessage` the hook already has; the feed is
  display-only ephemera like the action line, never state. A snapshot field
  (`recentEvents` per agent, last 20 from the DB) seeds the buffer so a freshly opened panel is
  not blank.

The M4 card's disabled pause/stop buttons become real and move their behaviour here: the card's
buttons open the panel with the control focused rather than firing blind POSTs from the grid —
one place to watch the outcome, which is the point of the panel.

---

## 7. Client Data Flow

`useOverview`'s pattern generalizes rather than duplicates: extract the SSE + debounce + guarded
refetch core into `useWorkspaceStream(workspaceId, { onEvent })`, and build both `useOverview`
(snapshot: overview) and `useTasks` (snapshot: tasks board) on it. The M4 behaviours carry over
verbatim: 250ms debounce, refetch on open, monotonic sequence guard, stale-snapshot + error band
on refetch failure, live-line eviction. The panel's rolling feed hangs off the same `onEvent`.

Mutations use plain `fetch` POSTs; no optimistic state anywhere — the event-driven refetch is the
single source of truth for what a button did (§4).

---

## 8. UI and Motion

The Mission Control language extends; no new tokens expected. The board columns and both side
panels reuse the card/border/status vocabulary from M4.

M4's deferred motion lands here as spec, not afterthought:

- The action line cross-fades on change (fast opacity swap, ~120ms, no layout shift).
- An agent card's border takes the status colour on status change and decays back to the line
  colour (~800ms) — the peripheral-vision cue that something changed.
- The panel slides in/out with a short transform (no springs library; CSS transitions).
- All three respect `prefers-reduced-motion` (instant swap, no decay, no slide).

---

## 9. Error Taxonomy

M4's rules continue: never a blank screen, stale-and-labelled beats empty, malformed events are
not ours to crash over. New cases:

- **Refused command (409):** the refusal text renders in the panel's error band; state stays
  whatever the snapshot says. A double-click's second POST refusing with "already pause_requested"
  is correct behaviour, not an error to hide.
- **Race with reality:** every control claim is an `updateMany` conditioned on the status it
  requires — the run that concluded between paint and click refuses cleanly, exactly like the CLI
  invoked against a finished run.
- **Halted workspace:** resume refuses with the CLI's wording; the panel shows it next to the
  disabled button; the halt banner already explains the workspace state.

---

## 10. Deliberate Simplifications

- **One instruction slot, not a mailbox.** `queuedMessage` is a single overwritable text; no
  message history, no threading. The event log records each `run.resume_requested` payload, which
  is history enough for MVP.
- **Same-host assumption.** The web server writes the pause flag file and sends signals because
  web, daemon and agents share one machine. The day these split across hosts, pause and stop
  become intents like resume — the intent mechanism built here is the migration path, and this
  paragraph is the marker.
- **No optimistic UI.** Buttons wait for the refetch. At MVP event rates the loop closes in well
  under a second, and it removes an entire class of client-state bugs.
- **Task detail rides the board snapshot.** No per-task endpoint until a workspace has enough
  tasks for the payload to hurt.
- **No auth, no CSRF, localhost single-operator** — unchanged from M4, §11.3 preparation only.
- **Board is read-only.** Task creation, editing, prioritization: M8's planning run is the writer
  of tasks; humans get task mutation only if a real need appears before then.

---

## 11. Testing

- **`packages/control` integration tests** (real Postgres, like M3's): every claim's success and
  refusal (concluded run, non-paused resume, halted workspace, missing checkpoint), flag file
  written where the gate reads, kill escalation against a real child process, intent set/clear/
  overwrite semantics.
- **Daemon resume-execution integration tests:** a paused run with an intent resumes on tick with
  the message injected (fake adapter records it); intent in a halted workspace is not picked up;
  claim-then-spawn survives a sweep between them (the orphan-window regression pinned).
- **Route tests:** 404 wrong-workspace, 409 mapping, happy paths.
- **Component/hook tests:** `useWorkspaceStream` extraction keeps every M4 `useOverview` test
  green unchanged (the refactor's acceptance bar); board renders all eight columns; panel
  enable/disable matrix per status; message box writability; reduced-motion variants.
- **CLI equivalence:** the CLI's pause/cancel tests keep passing with the extracted control
  package underneath — same observable transcript.

---

## 12. Milestone Gate

M3/M4 tradition: the fake adapter proves the plumbing in CI; the gate runs against the **real
`claude` CLI** and real money, by eyes:

1. `npm run demo` + `npm run web`; open the Overview.
2. Pause the live run from the panel mid-work; watch the gate deny, status walk
   `working → pausing → paused`, checkpoint appear in the task detail.
3. Queue an instruction ("also create a file named EXTRA.md") while paused.
4. Resume from the panel; verify the injected instruction's effect appears in the run's work and
   the message slot clears.
5. Stop a second run mid-work; verify the process dies, the task goes `blocked`, the worktree
   survives for inspection.
6. Watch the board's columns move through the whole cycle live.

The verification criterion — manual interruption of a live run succeeds — is steps 2–4 performed
by a human against a real agent.
