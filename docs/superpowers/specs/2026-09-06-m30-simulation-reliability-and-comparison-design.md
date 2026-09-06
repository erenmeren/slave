# M30 — Simulation reliability and comparison: clone, compare, auto-run, live page, CLI parity

**Status:** Approved in conversation (2026-09-06): auto-run driven by the orchestrator daemon; compare any two runs of the same sector with a warning when their frozen definitions differ; clone = a fresh run from the source's frozen definition with a chosen policy and seed (day 0, no injected events; forking at the current day is out of scope).
**Approach:** one milestone on top of M29. One additive migration (three nullable columns). The engine (`packages/simulation`) does not change except for two deferred M29 items (journal labels, a test). Every new write goes through `packages/control`; the daemon calls one control verb per tick.
**Scope rule:** what a person needs to run the same scenario under two policies without babysitting the page, see the two results side by side, drive every control from the CLI, and trust that a daemon restart loses nothing. Nothing else — no LLM provider, no second sector, no forking mid-run, no scheduling of runs against wall-clock dates.

## 1. Why this milestone

M29 delivered the engine and one policy per click. Its own §12 named what makes the product claim
"compare two policies" real: cloning a scenario, a comparison view, stepping that continues without
a browser tab, a page that follows a run someone else is stepping, and CLI parity. M29's final
review parked three small items into this milestone too.

Facts from the code that shape the design:

- **Stepping is a locked, versioned control verb** (`stepSimulation`: `SELECT … FOR UPDATE`, `version + 1`, one transaction). Auto-run must reuse it, not duplicate it.
- **The daemon is per-workspace** (`daemon.ts` takes `deps.workspaceId`; `tick()` loads one workspace's world). Simulations belong to a `Company`, not a workspace, so auto-run cannot ride `tick()`; it is a separate, global pass the daemon loop calls after `tick()`, and two daemons (two workspaces) may both call it — the verb has to make that harmless.
- **The event log's SSE is bound to `ExecutionEvent`** (`createEventSse` + `pg_notify` from `appendEvent`). The simulation journal is a different table with no notify; the live page needs its own, simpler signal.
- **`clonedFromId` already exists** on `SimulationRun` (M29 §3, `SetNull`).

## 2. Principles (M29 §2 stay binding; these are added)

1. **One step path.** Auto-run, the button, and the CLI all call `stepSimulation`. The daemon adds pacing, never a second engine loop.
2. **A tick that runs twice steps once.** Whether a step is due is decided under the run's row lock from the row's own `lastAutoStepAt`, so two daemons or a daemon and a click cannot double-step.
3. **A clone shares the world, not the history.** A clone copies the frozen `definition` (roster, roles, scenario, initial values, limits, currency), changes only `policy` and `seed`, starts at day 0 and carries no injected event. Comparing a clone with its source is a clean comparison by construction.
4. **Comparison never declares a winner.** Two columns, a delta, and a warning when the two worlds are not the same world.
5. **The live page follows the row.** The signal is the run's `version`; the page refetches its snapshot when it changes. No client-side stepping.
6. **Halt stops auto-run; so does pause, finish and any step error.** An auto-run that fails to step is halted with the error's text, never retried forever.

## 3. Data model (one additive migration `m30_simulation_auto_run`)

```prisma
model SimulationRun {
  // … M29 columns unchanged …
  /// M30 auto-run intent: step one day every `autoRunEveryMs` while `status = running`, until
  /// `simTime ≥ autoRunUntilDay`. Both null = no intent. `lastAutoStepAt` is the pacing watermark
  /// the daemon's verb compares against under the row lock.
  autoRunEveryMs  Int?
  autoRunUntilDay Int?
  lastAutoStepAt  DateTime?
  /// Renamed in the client only: the column stays `decisionCount`, the field is `actionCount`
  /// (M29 final review: it counts actions, not decision points).
  actionCount     Int @default(0) @map("decisionCount")
}
```

- `SimulationSummary` gains `autoRun: { everyMs: number; untilDay: number; lastStepAt: string | null } | null` and `actionCount` (was `decisionCount`; every reader renamed).
- Journal `control` ops added: `cloned { fromId, policy, seed }` (on the clone, seq 0 payload alongside `created`), `auto_run_started { everyMs, untilDay }`, `auto_run_stopped { reason: 'operator' | 'until_day' | 'paused' | 'halted' | 'finished' | 'error' }`.
- Migration: `ALTER TABLE "SimulationRun" ADD COLUMN "autoRunEveryMs" INTEGER, ADD COLUMN "autoRunUntilDay" INTEGER, ADD COLUMN "lastAutoStepAt" TIMESTAMP(3);` — nothing else; no data changes.

## 4. Control verbs (`packages/control/src/simulation.ts`, split as it grows — see §9)

- `cloneSimulation(sourceId, { name, policy, seed? }, principal?)` → `{ id }`. Loads the source (any status), builds `definition = { ...source.definition, policy, seed: seed ?? source.definition.seed }`, `state = tradeInitialEngineState(definition)`, inserts with `clonedFromId = sourceId`, journal seq 0 `control { op: 'created', … , clonedFrom: sourceId }`. Refusals: `simulation_not_found`, `duplicate_name`, `invalid_simulation_input` (empty name, non-integer seed).
- `startAutoRun(id, { everyMs, untilDay }, principal?)`: `everyMs` integer ≥ 250 and ≤ 3_600_000, `untilDay` integer > `simTime` and ≤ `horizonDays`; status must be `ready` or `running` (a `ready` run becomes `running`); writes the three columns (`lastAutoStepAt = null` so the first step is due at once) and journals `auto_run_started`. Refusals: `simulation_not_runnable`, `invalid_simulation_input`.
- `stopAutoRun(id, reason = 'operator', principal?)`: clears the three columns, journals `auto_run_stopped { reason }`; a run with no intent answers ok without a journal row (idempotent).
- `pauseSimulation` / `haltSimulation`: additionally clear the intent and journal `auto_run_stopped` with `reason: 'paused' | 'halted'` when one was set. `resumeSimulation` does not restore it (the operator restarts auto-run explicitly).
- `stepSimulation`: when the step's result is `finished` or `halted` and an intent is set, clear it and journal `auto_run_stopped { reason: 'finished' | 'halted' }` in the same transaction.
- `autoStepDue(id, now)` (the daemon's verb): inside `locked(tx, id)`: if no intent or status ≠ `running` → `{ stepped: false, reason: 'no_intent' | 'not_running' }`; if `lastAutoStepAt !== null && lastAutoStepAt + everyMs > now` → `{ stepped: false, reason: 'not_due' }`; if `simTime ≥ untilDay` → clear the intent, journal `auto_run_stopped { reason: 'until_day' }`, `{ stepped: false, reason: 'until_day' }`; otherwise run ONE day through the same code path `stepSimulation` uses (extract the body into a private `stepLocked(tx, row, loaded, { steps: 1 })`), set `lastAutoStepAt = now`, `{ stepped: true, day }`. A thrown error inside the step is caught by the CALLER (`tickSimulations`), which then calls `haltSimulation(id, \`auto-run step failed: ${message}\`)` — a second transaction, since the first rolled back.
- `tickSimulations({ now })` → `{ candidates, stepped, halted }`: `findMany({ where: { autoRunEveryMs: { not: null }, status: 'running' } })`, then `autoStepDue` for each in `createdAt` order, sequentially (one engine run at a time keeps the daemon's tick bounded; `MAX` per pass = 50 runs, the rest wait for the next tick). Exported for the daemon and for tests.
- `compareSimulations(aId, bId)` (read, `RepeatableRead`): both summaries, both `tradeMetrics`, `deltas` (b − a per numeric metric), `definitionsMatch: boolean` = deep-equal of `{ roster, roles, initial, scenario, currency, horizonDays, limits }` (policy and seed excluded), `differences: string[]` naming the top-level keys that differ, and `injected: { a: n, b: n }` (count of `external_event` rows with `op: 'injected'`). Refuses `simulation_not_found` for either id and `invalid_simulation_input` when the sectors differ or `aId === bId`.

## 5. The daemon (`apps/orchestrator/src/daemon.ts`)

In the coalescer's work function, after `tick(deps)` and before the sweep: `const sims = await tickSimulations({ now: new Date() })`; when `sims.stepped + sims.halted > 0` write one stdout line `simulations: stepped N, halted M`. Not inside `tick()` (ADR 0004: `decide()` stays pure; this is a reaction, and it is not workspace-scoped). The daemon's `--period` (default 1000 ms) is the floor of auto-run cadence; the spec and the UI say "every N ms, at the daemon's pace". A one-shot `npm run orchestrator -- tick` also runs the pass once (so a gate can drive it without a long-lived daemon).

Restart safety follows from the row: intent and watermark are columns, every step is a committed transaction, so a daemon killed mid-pass leaves either a stepped-and-committed day or nothing. A restarted daemon continues from `simTime`.

## 6. The live page (SSE)

- Route `GET /api/sim/[simulationId]/events`: an SSE response that polls `SimulationRun.version` every 1000 ms (`select version, status, simTime`) and emits `data: { version, status, simTime }` when `version` changes (and once on open), a `: heartbeat` comment every 15 s, 404 for an unknown id, closed on client abort. No `pg_notify`: the journal is not the event log, and a 1 s poll on a primary-key read is cheap and honest.
- Hook `useSimulationStream(simulationId, initialVersion)` → `{ version, connection }`; the page calls `router.refresh()` when `version` changes (the page is keyed on `<id>:<version>` in M29, so a refresh remounts the client with a fresh snapshot). The strip shows `● LIVE` / `● RECONNECTING` like the Overview.
- Because every control already calls `router.refresh()`, the stream only matters for steps made elsewhere: auto-run, the CLI, another tab.

## 7. UI

- `/sim/[id]`: **Clone…** (drawer: name, policy, seed; posts `/api/sim/[id]/clone`; navigates to the clone), **Auto-run** (every N ms — a select of 250 / 1000 / 5000 ms — and until day, defaults `1000` and `horizonDays`; **Stop auto-run** when set; the strip shows `auto-run every 1 s → day 30`), **Compare with…** (a select of the same company's other runs of the same sector; navigates to `/sim/compare?a=<id>&b=<other>`). The halted note stays; a halt reason starting with `auto-run step failed` is shown verbatim.
- `/sim`: cards show an `auto-run` chip while intent is set, and `clone of <name>` when `clonedFromId` resolves.
- `/sim/compare?a=&b=`: strip (both names, `SIMULATION · trade · synthetic`), a warning band when `definitionsMatch === false` listing `differences` and when either run has injected events ("external conditions differ: …"), then a table: metric · A · B · Δ (B − A), money via `formatMinor`, `lateDays`/`onTimeQty`/`deliveredQty`/`closingInventory` as counts; a footer "no verdict is computed; the delta is arithmetic". Two runs at different days are compared as they stand, with both days shown.
- Routes: `POST /api/sim/[id]/clone`, `POST /api/sim/[id]/auto-run` (`{ everyMs, untilDay }`), `POST /api/sim/[id]/auto-run/stop`, `GET /api/sim/compare?a=&b=`, `GET /api/sim/[id]/events`. Same gate / 400 / 404 / 409 rules as M29 §7.

## 8. CLI parity (`apps/orchestrator/src/cli.ts`)

`pause-simulation --simulation <id>`, `resume-simulation --simulation <id>`, `halt-simulation --simulation <id> [--reason <text>]`, `inject-simulation-event --simulation <id> --day <d> --event '<json>'`, `clone-simulation --simulation <id> --name <n> --policy A|B [--seed <n>]`, `auto-run-simulation --simulation <id> [--every-ms <n>] [--until-day <d>]`, `stop-auto-run --simulation <id>`, `compare-simulations --a <id> --b <id>` (JSON of `compareSimulations`). `tick` runs `tickSimulations` once after the workspace tick and prints its counts.

## 9. Code shape

`packages/control/src/simulation.ts` is ~330 lines after M29; M30 splits it by responsibility without changing behaviour: `simulation/read.ts` (`readSimulation`, `loadSimulation`, `listSimulations`, `simulationStatus`, `compareSimulations`, `replaySimulation`), `simulation/write.ts` (create, clone, step, `stepLocked`, status verbs, inject, delete), `simulation/auto-run.ts` (`startAutoRun`, `stopAutoRun`, `autoStepDue`, `tickSimulations`), `simulation/shared.ts` (schemas, `summarize`, `parseRow`, `json`, `locked`, `stableStringify`, `comparable`), `simulation.ts` re-exporting. The web read model and `SimulationClient.tsx` (~330 lines) gain `CloneDrawer.tsx`, `AutoRunControls.tsx`, `CompareClient.tsx` rather than growing in place.

## 10. Deferred M29 items closed here

- Trade `applyEvent` `ignored` labels: `unknown_purchase` / `already_delivered` for `delivery`, `unknown_purchase` / `already_paid` for `payment_due`, `unknown_order` for `collection`; tests pin each.
- `decisionCount` → `actionCount` (§3).
- The multi-order hedge test landed in M29's final wave (`rules.test.ts`); nothing to do.

## 11. Security, data and cost (M29 §8 stays binding)

Auto-run makes no model call (the provider is still `rules`); `SimulationModelUsage` stays empty. `tickSimulations` imports only control's own modules. The SSE route reads three columns by primary key and writes nothing. A clone copies the definition only — never journal rows, never injected events, never model usage.

## 12. Testing

- **Pure**: a clone's definition equals the source's except `policy`/`seed` (unit on the pure helper `cloneDefinition`); the `ignored` labels.
- **Control (integration)**: clone starts at day 0 with no injected events even when the source has some; `duplicate_name`; `startAutoRun` validation and `ready → running`; `autoStepDue` not due / due / until_day / not running; `tickSimulations` steps once per due run, honours the 50 cap, halts a run whose step throws (inject a corrupt state row to force it) with the error text; two concurrent `tickSimulations` calls step each run once (row lock + watermark); pause/halt/finish clear the intent with the right `auto_run_stopped` reason; `compareSimulations` deltas, `definitionsMatch` false when the initial cash differs, `invalid_simulation_input` on a different sector or same id.
- **Daemon**: `daemon.test.ts`-style test that the work function calls `tickSimulations` after `tick` and logs the line; `tick` CLI prints the counts.
- **Web**: SSE route emits on version change and heartbeats; `useSimulationStream` refreshes on a new version; clone drawer, auto-run controls, compare page render and post the right bodies; `/w/…` unchanged.
- **Gate `m30-simulation-compare`** (Playwright): create A from the UI, clone to B (policy B) from the run page, start auto-run on both at 250 ms until day 30 with a REAL `daemon` process running; wait for both to finish; open the compare page and check every displayed metric and delta against `compareSimulations` and the DB; kill the daemon mid-run of a third clone and restart it, then assert from the journal that no day was stepped twice (`control { stepped }` rows have strictly increasing `day`) and the run still finishes.
- Acceptance: brief item 10 ("pause and restart cause no lost work or double processing") is proven by the gate's kill-and-restart stage plus the concurrent-tick test.

## 13. Order of work

1. Migration + `actionCount` rename + summary fields; control file split (behaviour-neutral, tests green).
2. Clone (control + route + CLI + drawer) and the `ignored` labels.
3. Auto-run verbs + `autoStepDue` + `tickSimulations` + daemon/CLI `tick` wiring + tests.
4. SSE route + hook + strip; auto-run controls on the page; cards.
5. Compare (control read + route + page + CLI).
6. Remaining CLI parity verbs; gate; README; errata.

## 14. Out of scope, recorded

Forking a run at its current day; wall-clock scheduling ("run at 09:00"); comparing more than two runs; charts; LLM provider and second sector (M31); `pg_notify` for the journal; exporting comparisons.

## 15. Errata — where execution corrected the plan

(filled in during execution)
