# M13: Runtime Hardening — A Pause That Stops, and an Operator Who Can Choose — Design

**Date:** 2026-08-29
**Status:** Approved
**Predecessor:** M12 (provider adapters). M12 made the provider seam real and proved it with a
second runtime. Its measured gate also found — and, by its own freeze, could not fix — a
window in which a paused run is not yet stopped, and left the second runtime reachable only
through seed scripts. This milestone closes both.
**Structural reference:** `apps/orchestrator/src/pump.ts` (the gate-deny pause branch),
`packages/control/src/resume.ts` and `pause.ts`, `packages/providers/src/{claude,cursor}/`,
`apps/web/src/components/GoalCard.tsx` and its route `apps/web/src/app/api/w/[workspaceId]/goal`.

M12's Series A froze Claude's behavior so a refactor could be judged against an unmoving
baseline. That freeze is lifted here, deliberately and only for the things this document
names: the pause ordering, the shared runtime helpers, and the hook scripts' shared logic.
Everything else Claude does stays byte-identical on disk.

## 1. Scope

In scope, in order:

- **Series A — a pause is a stop.** The pump publishes `paused` only once the child is dead;
  `requestResume` refuses a run that is still stopping; a failed resume counts against the
  task's attempts; an emergency stop that cannot signal a run releases its claim.
- **Series B — one runtime module.** The six-plus verbatim-copied blocks between the Claude
  and Cursor adapters, and the third copy of the kill primitive, collapse into
  `packages/providers/src/runtime/`. The two bash gates share `scripts/lib/pause-flag.sh`,
  which closes `pause-gate.sh`'s argv hole where it is shared, not where it was found.
- **Series C — Cursor's gate is proven, not assumed.** Two measured runs in a real worktree
  root settle whether the registered `preToolUse` hook gates writes, and the capability is
  raised or kept with committed evidence.
- **Series D — the operator chooses.** A Runtime card on the workspace page sets the
  workspace's provider and its budget (including "not budgeted"), through control-layer
  functions and routes shaped like Goal's.
- **Series E — the record and the gate.** The M12 spec's two falsified claims are superseded
  here, and `gate-m13-runtime.mjs` proves the milestone live on both runtimes.

Out of scope (deliberate): API-based adapters, failover chains, pricing tables, a third
provider, multi-row provider configuration per workspace, un-assigning a company, and any
authentication story for the web routes (M11's localhost-only posture stands).

## 2. Decisions of Record

1. **A run is `paused` when its process is dead.** Not when the checkpoint is written, not
   when the kill is sent. The status and the `run.paused` event are the last things the pause
   path does. Every consumer of `paused` may rely on the pid being gone.
2. **The checkpoint is still written before the kill.** Killing first risks losing the
   resume point if the checkpoint write fails partway. Ordering is: checkpoint → kill →
   `paused` → `run.paused`. During the kill's grace window the row reads `pause_requested`.
3. **Two locks, not one.** The pump's ordering closes the window; `requestResume` checks pid
   liveness anyway and refuses with `run_still_stopping`. The second lock is cheap and turns a
   future ordering regression into a refusal instead of a lost run.
4. **Every failed run start or resume costs an attempt.** `concludeFailedResume` and
   `failToStart` share one helper that increments `attempt` and, at `maxAttempts`, parks the
   task exactly as `failToStart` already does (`failed` when exhausted). No path re-dispatches a paid run without counting it.
5. **A claim that cannot be signalled is released.** `pauseActiveRuns` claims
   `pause_requested`, signals, and on a throw restores the prior status and reports the run
   as `refused`. A run never parks in `pause_requested` with nothing coming.
6. **Shared code has one home, below `control`.** `packages/control` depends on
   `packages/providers`, so the kill primitive and every other vendor-neutral helper live in
   `packages/providers/src/runtime/`; `control/src/kill.ts` re-exports. Bash shares
   `scripts/lib/pause-flag.sh`.
7. **Refactors are behavior-preserving and prove it.** Series B changes no on-disk mechanism
   and no test outside those Series A already re-ordered; the suite passes untouched before
   and after each extraction.
8. **A capability is raised only by committed evidence.** Cursor's `gate` moves to
   `'all-tools'` only if a recorded run shows a file write refused while paused; the recording
   lives in `packages/providers/test/fixtures/cursor/`, not in a scratch directory.
9. **One workspace, one provider row.** `setWorkspaceProvider` replaces any existing
   `ProviderConfiguration` row in one transaction; `null` deletes it. The
   `workspaceDefaultProvider` rule ("exactly one row or nothing") stays and is now writable.
10. **The budget rule lives in one place.** Writing a cost-blind provider onto a budgeted
    workspace is allowed; dispatch refuses it with `unmeasurable_budget` as today, and the
    card shows the consequence before the operator hits it. The refusal is not duplicated
    at write time.
11. **Halted workspaces stay editable.** Changing the runtime or the budget is a legitimate
    way to make a halt clearable.
12. **Money-spending gates say so.** Every gate script that runs vendor CLIs is marked in the
    README, kills the vendor children it started in `finally`, and rehearses against fake
    CLIs before the first paid execution.

## 3. Series A — A Pause Is a Stop

### 3.1 The pump's gate-deny branch (`apps/orchestrator/src/pump.ts`)

Today: write `paused` + `pausedAtStep` → write checkpoint → `killWithEscalation` → emit
`run.paused`. New order:

1. `writeCheckpoint` (unchanged content; still before the kill — Decision 2).
2. `killWithEscalation(pid)`; on return the pid is gone (it already SIGKILLs at the grace
   deadline).
3. `updateMany({ where: { id, endedAt: null }, data: { status: 'paused', pausedAtStep } })`
   — the same condition as today, deliberately not narrowed to `pause_requested`: a deny
   that arrives on a `working` run (no operator asked; the domain machine does not admit it
   as `paused`) is still reported as what the runtime did, exactly as today. Only the
   ordering moves.
4. `emit('run.paused', { atStep })`.

The `paused` once-only guard keeps its meaning (a second deny during the grace window is a
no-op).

The Cursor path (`recordCursorPauseIfRequested`) runs after the stream ends, i.e. after the
child is dead, so it already satisfies Decision 1 and does not change.

### 3.2 `requestResume` liveness (`packages/control/src/resume.ts`)

After the status and checkpoint checks and before the claim: if `run.pid !== null` and
`process.kill(pid, 0)` does not throw `ESRCH`, refuse with a new refusal
`run_still_stopping` → text `the run is still stopping; retry in a moment`. `EPERM` counts as
alive. A `null` pid is not a refusal (pre-M12 rows, and rows the pump already cleared).

### 3.3 Attempts on a failed resume (`apps/orchestrator/src/tick.ts`)

`failToStart`'s increment-then-park logic is extracted to `releaseTaskAfterFailure(task,
runId)` and called from both `failToStart` and `concludeFailedResume`. Behavior of
`failToStart` is unchanged; `concludeFailedResume` gains the increment and the
`maxAttempts → failed` transition `failToStart` already performs. `lastRejectionReason` stays
untouched on both.

### 3.4 Claim, signal, release (`packages/control/src/pause.ts`)

`requestPause`: claim `pause_requested` (conditional on the prior status, as today) →
`signalPause` → if it throws, restore the prior status with a conditional write
(`where: { id, status: 'pause_requested' }`) and return `err({ kind: 'pause_unsignalled',
runId, reason })`. `pauseActiveRuns` keeps its per-run try/catch and puts such runs in
`refused`. `signalPause('cursor')` with a `null` pid keeps throwing — that is the case this
exists for. If the domain state machine lacks the `pause_requested → <prior>` edge, it
gains it, named `pause_unsignalled`.

### 3.5 Tests

- Existing Claude pause tests that assert the old ordering are re-pointed at the new one;
  every such edit is listed in the task report. This is the one place the M12 freeze is
  lifted on tests.
- New: pump — during the grace window the row reads `pause_requested` and no `run.paused`
  exists; after the pid is dead, `paused` and the event. `requestResume` — a live pid (real
  `/bin/sleep`) is refused with the verbatim text; a dead pid proceeds. `concludeFailedResume`
  — `attempt` increments; `failed` at `maxAttempts` (`failToStart`'s existing rule); no new run
  dispatched by the next tick.
  `pauseActiveRuns` — a throwing signal restores the prior status and lands in `refused`.

## 4. Series B — One Runtime Module

### 4.1 `packages/providers/src/runtime/`

| File | Contents | Replaces copies in |
|---|---|---|
| `event-queue.ts` | `AsyncEventQueue` | `claude/adapter.ts`, `cursor/adapter.ts` |
| `process.ts` | `killWithEscalation`, `terminateChild` (child-object wrapper), `buildChildEnv` | `control/src/kill.ts`, `pause-signal.ts`, both adapters |
| `pause-flag.ts` | `clearAndVerifyPauseFlagAbsent` | both adapters |
| `gate-preflight.ts` | `runGateScript` + `preflightGate({ hookPath, expectAllow: 'silent' \| 'explicit' })` | `claude/flags.ts`, `cursor/flags.ts` |
| `summary.ts` | `summaryFor`, `SUMMARY_ARG_KEYS`, `isRecord` | both adapters |

`control/src/kill.ts` becomes a re-export so its importers do not move. Grace timing stays
2 000 ms in the one remaining copy. `terminateChild` and `killWithEscalation` share the
escalation body.

### 4.2 `scripts/lib/pause-flag.sh`

Sourced by `scripts/pause-gate.sh` and `scripts/cursor-shell-gate.sh`. Provides:

- `json_string` — node `JSON.stringify` fed on **stdin** (the argv hole closed once, for
  both), with the guard that the output begins with `"`.
- `read_pause_reason` — fail-closed contract shared by both gates: `AITEAMOS_PAUSE_FLAG`
  unset/empty → the deny payload each gate emits today (exit 0, fail-closed, operator-readable —
  unchanged); path absent → "no pause"; path present but not a
  regular file or unreadable → exit 2. (M12 deferred "a directory is an allow"; this closes
  it for both gates.)

Each gate keeps its own output contract in its own file: Claude's allow is silence, Cursor's
is `{"permission":"allow"}`; Cursor's deny key is `user_message`. Both gate tests gain the
`--version` / `-e x` reason rows.

### 4.3 Proof of behavior preservation

Each extraction task runs the full suite before and after and reports the deleted line
count. No adapter test changes in Series B; the two gate tests change only in the
`scripts/lib/pause-flag.sh` task, and only for the argv rows and the directory case §4.2 names.
Claude's settings shape, flag path and
hook contract are diffed byte-for-byte against `main` at the series' end.

## 5. Series C — Cursor's Gate, Proven

Two runs of `cursor-agent`, each in a fresh `git worktree add` root (the shape
`writeCursorHooksFile` actually targets, since `cursor-agent` resolves `.cursor/hooks.json`
against the git root — M12 Task 12's finding), with the adapter's real hooks file:

1. Flag absent: a shell command and a file write both succeed.
2. Flag present: the shell command lands as `tool_call/completed` with
   `result.rejected.reason` starting `Command execution was blocked by a hook`, and a file
   write is refused through the `preToolUse` registration.

Artifacts — stream NDJSON, hook stdin/stdout logs, the hooks.json as written — are committed
under `packages/providers/test/fixtures/cursor/gate/`. Outcomes:

- Both refusals observed → `capabilitiesOf('cursor').gate = 'all-tools'`, capability test
  updated, `RosterTable`/`ShellOnlyMark` stop marking Cursor.
- Only the shell refusal → `'shell-only'` stays; the report says why the write was not gated.
- Neither → BLOCKED; the hooks file the adapter writes is wrong and this series fixes it.

The recorded deny line becomes a parser fixture for `observeRawLine` → `deniedToolUseIds`.
Spend: two Cursor runs, one spare.

## 6. Series D — The Operator Chooses

### 6.1 Control (`packages/control/src/workspace.ts`)

- `setWorkspaceProvider(workspaceId, kind: ProviderKind | null)` — one transaction: delete
  any existing rows for the workspace, insert `{ kind, settings: {} }` when `kind !== null`.
  Refusals: `workspace_not_found`, `invalid_provider` (existing text).
- `setWorkspaceBudget(workspaceId, usd: number | null)` — refusals: `workspace_not_found`,
  new `invalid_budget` → `a budget must be a non-negative amount or absent`. `null` writes
  `budgetUsd = null`.
- Both append `workspace.settings_changed` with `payload: { field: 'provider' | 'budgetUsd',
  from, to }`, actor `human`.
- Neither refuses a halted workspace (Decision 11) and neither enforces the budget/provider
  compatibility rule (Decision 10).

### 6.2 Routes

`PUT /api/w/[workspaceId]/provider` body `{ provider: ProviderKind | null }`;
`PUT /api/w/[workspaceId]/budget` body `{ budgetUsd: number | null }`. Both through
`workspaceControlResponse` (409 + verbatim refusal, 404 for an unknown workspace), the shell
`goal/route.ts` actually uses.

### 6.3 UI (`apps/web/src/components/RuntimeCard.tsx`)

Beside `GoalCard` on `/w/[workspaceId]`. Contents: `ProviderSelect` (M12's shared component)
with a "(none)" option; a budget number input; a "this workspace is not budgeted" checkbox
that disables the input and submits `null`. Idioms: `router.refresh()` after each mutation,
no optimistic state, a 409 keeps the operator's input and shows the refusal verbatim, new
controls carry `aria-label`s (`workspace provider`, `workspace budget`, `not budgeted`).

The card shows a derived warning when the selected provider has `reportsCost === false` and
the budget is non-null: *"this provider reports no cost; a budgeted workspace will refuse it
at dispatch"*. The derivation uses `capabilitiesOf` server-side (`server/overview.ts`) and
reaches the client as a plain boolean; the overview DTO gains `provider: ProviderKind | null`.

### 6.4 Tests

Control: integration against the real DB — replace-in-one-transaction, `null` deletes,
refusal texts, the event payload. Routes: `org-routes.test.ts` idiom, all three bodies
(valid, invalid kind, `null`). Component: submits `{ provider }` / `{ budgetUsd: null }`;
409 keeps input; warning shown only for the cost-blind + budgeted combination.

## 7. Series E — The Record and the Gate

### 7.1 Supersedes (M12 spec, left intact as history)

- **M12 §4 "Pause dispatches on capability"** — true since M12's final fix wave
  (`signalPause` selects on `canPauseMidRun`). Its description of Claude's pause gains the
  ordering of Decision 2: *checkpoint → process dead → `paused`*.
- **M12 §7 "Cursor fires only the shell hooks"** — false. `preToolUse` fires for `Read`,
  `Write` and `Shell`; the gate value is whatever Series C proves.
- **New limitation, stated:** Cursor's gate configuration lives inside the worktree it gates
  (`.cursor/hooks.json`; the CLI has no out-of-tree settings path), so a run can delete its
  own gate. Claude's settings live outside the worktree. Emergency stop (cancellation) is
  unaffected on both.

### 7.2 `scripts/gate-m13-runtime.mjs`

Skeleton from `gate-m12-providers.mjs`: dist imports, all-in-`try`, bounded waits that name
what they waited for, preflight cleanup of prior `M13 Gate` rows, FK-ordered cleanup and
**both daemon and vendor children killed** in `finally`, `process.exit(exitCode)`. Fails fast
on a missing `cursor-agent`, `claude`, `.env`, or DB. Stages, each asserted against the DB:

1. Through the Runtime card in a real browser, the workspace's provider becomes `cursor` and
   its budget `null`; the `ProviderConfiguration` row and `budgetUsd` column agree.
2. On both runtimes: pause requested while `working`; an immediate `requestResume` (issued
   on seeing `run.pause_requested`) returns `run_still_stopping`; after `run.paused` a resume
   is accepted and the run reaches `succeeded`; `Task.attempt` is unchanged.
3. On Cursor, while paused, a shell command is refused (`rejected.reason` on the stream).
4. A budgeted workspace refuses `cursor` with `a budget needs a provider that reports cost`;
   after the card sets the budget to `null`, the same task dispatches.
5. A deliberately failing resume (checkpoint pointed at a dead session) increments
   `attempt`, parks the task `failed` at `maxAttempts: 1` (`failToStart`'s rule), and the next
   tick starts no run.

PASS line: `a pause is a stop and a stop is resumable`, exit 0. Spend: at most three
two-runtime executions, preceded by zero-spend rehearsals against fake CLIs.

## 8. Testing

- **Ordering.** The pause window is tested with a child that ignores SIGTERM for longer than
  the grace period, so the `pause_requested` interval is observable.
- **Liveness.** `requestResume` against a real live pid and a real dead one.
- **Attempts.** Every failed-start and failed-resume path counts, and exhaustion is reached.
- **Preservation.** Series B: suite green untouched before and after each extraction;
  byte-diff of Claude's on-disk mechanism at the end.
- **Evidence.** Series C's recordings are committed fixtures, exercised by the parser test.
- **Surfaces.** Control, route and component layers each tested through the real path
  (DB, `workspaceControlResponse`, rendered component), no mocks of the layer below.

## 9. Milestone Gate

`npm run gate:m13-runtime` (§7.2), plus `npm test && npm run typecheck && npm run
web:build` on every task, one vitest run at a time, named files staged only. The gate
requires `cursor-agent` and `claude` installed and authenticated; it never skips.
