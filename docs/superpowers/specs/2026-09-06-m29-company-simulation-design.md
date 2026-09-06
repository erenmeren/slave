# M29 — Company simulation: a trade company run by rules, next to the real software projects

**Status:** Approved in conversation (2026-09-06). The operator's brief: "AI organizations I can build, try in simulations, and run on real work where authorized" — decisions taken: a separate `SimulationRun` bound to `Company` (Workspace untouched), stepping inside the request in one transaction, web + a minimal CLI, one pure package holding the engine and the first sector model, rules-based decisions only (LLM is M31).
**Approach:** one milestone, the first of three (M29 engine + trade model + rules provider + persistence + control + UI; M30 pause/resume across restarts, clone, compare; M31 LLM decision provider + a software-company simulation). One additive migration. No change to the software workflow.
**Scope rule:** everything a person needs to create a trade-company simulation from a company in the catalog, step it day by day or to a horizon, read every decision and every rule outcome, and see the metrics computed from the journal — with no Git, no live model call, and no way for the simulated world to touch a real project, a real tool or a real dollar. Nothing else.

## 1. Why this milestone

Slave of AI runs real engineering teams against real repositories (M1–M28). The operator wants the
same organizations — companies, departments, roles — to also be tried *before* they are trusted:
a company that is not a software company, in a world whose state changes only by rules, where a
decision's effect on delivery, stock, cost and cash can be measured and two policies compared.

What the repository already has, verified in code (not in prose):

- **The organization is a catalog with frozen copies.** `Company → CompanyTeam → CompanySlave`
  (templates) is the reusable structure; `assignCompany` materializes `Team`/`Slave` rows per
  project, and later catalog edits do not reach a project (`schema.prisma`, `org.ts`). A
  simulation follows the same rule: it takes a snapshot at creation.
- **`Workspace` is Git.** `repoPath`, `baseBranch`, `verifyCommands` (NOT NULL by ruling), the
  worktree/verify/review/merge flow in `apps/orchestrator`, `decide()`'s `World`. Generalizing it
  would spread nullable Git fields through the scheduler, the tick and every page (§10 of the brief
  forbids exactly that).
- **The event log is an audit trail, not event sourcing.** `Task.status` and `SlaveRun.status`
  are the state; `ExecutionEvent` rows are validated (Zod) records of what happened, appended
  through one gate (ADR 0003), never replayed into state. The simulation needs its own journal
  with its own ordering and its own replay contract; the software log is not the place for it.
- **Model access is a CLI child process, not an SDK.** `packages/providers` spawns `claude` /
  `cursor-agent` with a settings file and a permission hook; there is no Messages API path. A
  simulation "LLM provider" therefore needs a text-only, zero-tool spawn whose isolation must be
  proven separately — M31, not now. M29 makes no model call at all.
- **Layering is already the right shape.** `packages/domain` pure; `apps/web` mutates only via
  `packages/control`; refusals are a typed union with one `refusalText`. The engine becomes a
  second pure package beside `domain`; control gets a `simulation.ts`; web gets a page.
- **Cost is already honest.** `SlaveRun.costUsd` keeps unknown as `null` (M12 R). Simulated money
  never lives in a column that means real money.

## 2. Principles

1. **The agent proposes, the engine decides.** An action changes the world only after schema,
   role-authorization and sector-rule validation against the *current* state. "500 units produced"
   is a claim; stock moves only on a delivery event the rules scheduled.
2. **Same inputs, same world.** The engine is a pure function `step(state, definition, provider)
   → { state, entries }`. One seeded RNG, used only for scenario/external-event generation, never by
   a decision provider. Same-day events are ordered by `(priority class, enqueue seq)`.
3. **Replay reads the journal, never a model.** `replay(definition, journal)` feeds recorded
   decisions to the same engine and must reproduce the stored state. Re-calling a decision
   provider is not replay.
4. **Two kinds of money, two tables.** The simulated company's cash is an integer in
   `SimulationRun.state`; the real model spend is `SimulationModelUsage` rows with `null` for
   unknown. They are never summed, never shown in one figure.
5. **Scope of every read and write is the run.** Every verb and route resolves `simulationId`
   under its `companyId`; ids inside actions resolve only against that run's own state.
6. **Refuse, do not fall back.** An unsupported `sector × mode` is a typed refusal at `create`;
   nothing is shown as available and then silently run another way.
7. **Nothing real is reachable.** The simulation package has no I/O; control's simulation verbs
   import no provider, spawn nothing, read no `.env` credential. The software CLI, its hooks and
   the host tools are not wired to a simulation in any form.

## 3. Data model (one additive migration `m29_company_simulation`)

```prisma
enum SimulationSector { trade }              // `software` arrives in M31
enum SimulationMode { simulation }          // `real` stays the Workspace flow; not a value here
enum DecisionProviderKind { rules }         // `llm` arrives in M31
enum SimulationStatus { ready running paused finished halted }
enum SimulationJournalKind { decision action_applied action_rejected event external_event control }

model SimulationRun {
  id               String  @id @default(uuid())
  companyId        String
  name             String
  sector           SimulationSector
  mode             SimulationMode @default(simulation)
  decisionProvider DecisionProviderKind @default(rules)
  seed             Int
  /// Frozen at creation: roster snapshot, role definitions, policy, scenario, currency, limits.
  definition       Json
  /// The engine's current state (sector-shaped; `TradeState` for `trade`).
  state            Json
  version          Int @default(0)
  status           SimulationStatus @default(ready)
  simTime          Int @default(0)
  stepCount        Int @default(0)
  decisionCount    Int @default(0)
  haltedReason     String?
  clonedFromId     String?
  createdByUserId  String?
  createdAt        DateTime @default(now())

  company     Company        @relation(fields: [companyId], references: [id], onDelete: Restrict)
  clonedFrom  SimulationRun? @relation("SimulationClone", fields: [clonedFromId], references: [id], onDelete: SetNull)
  clones      SimulationRun[] @relation("SimulationClone")
  createdBy   User?          @relation(fields: [createdByUserId], references: [id], onDelete: SetNull)
  journal     SimulationJournalEntry[]
  modelUsage  SimulationModelUsage[]

  @@unique([companyId, name])
  @@index([companyId])
}

model SimulationJournalEntry {
  id             String @id @default(uuid())
  simulationId   String
  seq            Int
  simTime        Int
  kind           SimulationJournalKind
  actorRole      String?
  payload        Json
  idempotencyKey String?
  createdAt      DateTime @default(now())

  simulation SimulationRun @relation(fields: [simulationId], references: [id], onDelete: Cascade)

  @@unique([simulationId, seq])
  @@unique([simulationId, idempotencyKey])
  @@index([simulationId, simTime])
}

model SimulationModelUsage {
  id           String @id @default(uuid())
  simulationId String
  seq          Int
  provider     ProviderKind
  costUsd      Float?   // null = unmeasured, never 0
  tokensIn     Int?
  tokensOut    Int?
  createdAt    DateTime @default(now())

  simulation SimulationRun @relation(fields: [simulationId], references: [id], onDelete: Cascade)

  @@index([simulationId])
}
```

- `Company.simulations SimulationRun[]` and `User.simulations SimulationRun[]` back-relations.
  `deleteCompany` (M27) gains a `live_simulations { companyId, simulations }` refusal: a company
  with any simulation run is not deletable until they are deleted (the runs are the operator's
  experiments; cascading them away with the company would destroy results silently).
- `definition` and `state` are validated by Zod schemas in `packages/simulation` on every read;
  a row that fails to parse is surfaced as `simulation_corrupt` (refusal) rather than coerced.
- Money is `…Minor` integers (cents). `definition.currency` is an ISO code string, default `USD`;
  rounding is half-up to the minor unit wherever a unit price meets a quantity.
- `ExecutionEvent` is not written by anything in this milestone.

## 4. The engine (`packages/simulation`)

New package `@slave-of-ai/simulation`, pure (no I/O, depends on `zod` only, like `domain`).
Layout:

```
src/core/clock.ts        SimClock: integer day; runUntil arithmetic
src/core/queue.ts        ScheduledEvent { time, priority, seq, event }; deterministic pop order
src/core/rng.ts          mulberry32(seed) → () => number  (the only randomness)
src/core/journal.ts      JournalEntry union + Zod; seq assignment within a step
src/core/engine.ts       step(), runUntil(), replay(), limits, halting
src/core/action.ts       ActionEnvelope { type, params, rationale, refs } + validation pipeline
src/core/sector.ts       SectorModel<TState, TAction, TExternal> contract
src/decide/provider.ts   DecisionProvider interface; Observation type
src/decide/rules.ts      RulesDecisionProvider (policy-parameterized)
src/decide/recorded.ts   RecordedDecisionProvider (journal-fed; replay only)
src/trade/*              state, actions, rules, scenario, metrics for the trade sector
src/index.ts
```

### 4.1 Clock, queue, ordering

`simTime` is a whole day. The queue key is `(time, priorityClass, seq)`, priority classes in
order: `external` (injected/scenario events) → `scheduled` (deliveries, collections, payments due)
→ `decision` (role decision points, in `definition.roleOrder`) → `close` (end-of-day rules). Two
events with the same class pop in enqueue order. Nothing reads the wall clock.

### 4.2 One step

`step(state, definition, provider, journalSeqStart)`:

1. Pop and apply every `external` and `scheduled` event for `state.day` through the sector's
   `applyEvent` (pure; returns new state + follow-up events + journal entries).
2. For each role in `roleOrder`: build `observation = sector.observe(state, role)` (only the
   fields `role.observes` lists), call `provider.decide({ role, observation, day })` → action
   envelopes (bounded by `limits.maxDecisionsPerStep`), then for each action in order:
   `validate` = envelope schema → `role.allowedActions` includes `type` → `sector.validate(state,
   role, action)` (rules against the state *as it is now*, after earlier actions this step). Valid
   → `sector.apply` (new state + scheduled follow-ups) + `action_applied`; invalid →
   `action_rejected { reason }` and no state change. The `decision` entry records the observation
   digest, the provider kind, the policy and the raw envelope.
3. `sector.closeDay` (ship within capacity, mark late orders, running minimum cash).
4. Return `{ state: { ...state, day: day + 1 }, entries }`.

`runUntil(day)` loops `step`; it stops early with `status: halted` and a reason when any limit
(`maxSteps`, `maxDecisionsPerStep`, `maxJournalEntries`) trips, or with `status: finished` at
`definition.horizonDays`.

### 4.3 Determinism and replay

The engine never calls `Math.random`; `rng(seed)` is created once per run and consumed only by
`scenario.materialize` (M29's scenarios are fully explicit lists, so the RNG is present, seeded,
and unused by the demo — recorded so M30/M31 scenario generators inherit the rule). Decision
providers get no RNG handle. `replay(definition, journalEntries)` runs the same engine with
`RecordedDecisionProvider`, which answers each decision point with the envelope recorded for
`(day, role, index)` and throws `replay_divergence` if the journal runs out or names a different
role. The replayed final state must deep-equal the stored state — that equality is the test.

### 4.4 Actions

```ts
interface ActionEnvelope { type: string; params: Record<string, unknown>; rationale: string; refs: string[] }
```
`refs` names journal seqs or state ids the actor claims to have used; they are recorded, not
trusted. Rejection reasons are a typed union per sector plus the engine's own:
`schema_invalid`, `role_not_allowed`, `unknown_reference`, `limit_exceeded`.

## 5. The trade sector (`packages/simulation/src/trade`)

### 5.1 State

`TradeState`: `day`, `cashMinor`, `inventory`, `orders[]` (`id, qty, unitPriceMinor, dueDay,
shippedQty, collectInDays, status: open | partially_shipped | shipped | collected`, plus `lateDays`
computed at close), `purchases[]` (`id, supplierId, qty, unitPriceMinor, orderedDay, expectedDay,
deliveredDay | null, payDay, status: ordered | delivered | paid`), `suppliers[]` (`id, name,
unitPriceMinor, leadDays, paymentTermDays`), `dailyShipCapacity`, `shippedToday`,
`minCashMinor`, `minCashDay`.

### 5.2 Actions and rules

| action | role | rule (rejection reason) |
|---|---|---|
| `accept_order { orderId }` | sales | order exists in `pendingDemand` (`unknown_reference`) |
| `place_purchase { supplierId, qty }` | purchasing | supplier known; `qty ≥ 1`; `qty ≤ role.constraints.maxPurchaseQty`; `cashMinor − unpaidCommitmentsMinor ≥ qty × unitPriceMinor` (`insufficient_cash`) |
| `ship_order { orderId, qty }` | operations | order open; `qty ≤ min(inventory, dailyShipCapacity − shippedToday, remaining)` (`insufficient_stock` / `capacity_exhausted` / `over_shipment`) |
| `note { text }` | any | none; recorded only |

Events (scheduled by rules, never by actors): `demand` (scenario/external → pending demand),
`supplier_delay { purchaseId | supplierId, extraDays }` (pushes `expectedDay`), `delivery`
(`purchase.deliveredDay = day; inventory += qty`; scheduled at `orderedDay + leadDays`),
`payment_due` (`cash −= qty × price` at `payDay`), `collection` (`cash += shipped × price` at
`shipment day + collectInDays`). Stock rises only on `delivery`; cash moves only on
`payment_due` / `collection`. Finance observes and may `note`; it has no action that moves money.

### 5.3 Roles

`definition.roles[]`: `{ name, purpose, observes: string[], allowedActions: string[],
constraints: { maxPurchaseQty? }, slaveName }`. `roleOrder = [sales, purchasing, operations,
finance]`; no coordinator in M29. Roster snapshot: `definition.roster` copies
`CompanyTeam`/`CompanySlave` names at creation; `roleAssignment` maps each of the four roles to
a snapshot slave (the create drawer offers the company's slaves; the seed's demo company maps by
department name).

### 5.4 Demo scenario and policies (all in `definition`, labelled synthetic)

```
currency USD, horizonDays 30, inventory 100, cashMinor 5_000_000
dailyShipCapacity 30
suppliers: normal { unitPriceMinor 6_000, leadDays 7, paymentTermDays 30 }
           fast   { unitPriceMinor 8_500, leadDays 2, paymentTermDays 0 }
scenario events: day 1 demand { qty 150, unitPriceMinor 12_000, dueInDays 10, collectInDays 15 }
                 day 3 supplier_delay { supplierId normal, extraDays 6 }
limits: maxSteps 365, maxDecisionsPerStep 8 per role, maxJournalEntries 20_000
```

`RulesDecisionProvider` policies (`definition.policy`):

- **A `wait_normal`** — sales accepts any demand; purchasing, on the day a shortfall appears
  (`open demand − inventory − inbound > 0`), places the shortfall with `normal`; operations
  ships every open order up to capacity each day; finance notes cash.
- **B `hedge_when_at_risk`** — as A, plus each day purchasing checks every open order: if
  `expectedDay of the covering purchase + ceil(remaining / capacity) > dueDay` and cash allows,
  it places the uncovered remainder with `fast`.

The spec fixes no winner. B is expected to deliver on time at a higher purchase cost and lower
minimum cash; A is expected to be late and cheaper. The page shows both figures, not a verdict.

### 5.5 Metrics (computed from the journal by `trade/metrics.ts`)

`deliveredQty`, `lateDays` (sum over orders of `max(0, lastShipDay − dueDay)`), `onTimeQty`,
`purchaseCostMinor`, `closingInventory`, `closingCashMinor`, `minCashMinor` + `minCashDay`,
`collectedMinor`, `unpaidCommitmentsMinor`. Each metric names the journal kinds it reads.
No profit, no margin — not reliably computable in M29 (opening stock has no recorded cost).

## 6. Control verbs (`packages/control/src/simulation.ts`)

All return `Result<…, ControlRefusal>`; new refusal kinds: `simulation_not_found`,
`unsupported_simulation { sector, mode }`, `simulation_not_runnable { status }`,
`stale_version { expected, actual }`, `simulation_corrupt { reason }`, `live_simulations`,
`duplicate_name` (reused).

- `createSimulation({ companyId, name, sector: 'trade', policy: 'A' | 'B', seed?, scenario?:
  'demo', roleAssignment?, principal })` — loads the company and roster, freezes `definition`,
  computes `initialState` via the sector, inserts with `version 0`, journal `control { created }`.
- `stepSimulation(id, { steps?: number, untilDay?: number, idempotencyKey?, expectedVersion? })`
  — `SELECT … FOR UPDATE` on the run; refuses unless `status ∈ { ready, running }`; if
  `idempotencyKey` already exists in the journal, returns the stored outcome without running;
  otherwise runs the engine (bounded by `limits` and by a control-level `maxStepsPerRequest 365`),
  writes state, counters, `version + 1`, entries, and a `control { stepped, idempotencyKey }`
  entry, all in one transaction. The LLM path (M31) will not use this verb's synchronous shape.
- `pauseSimulation` / `resumeSimulation` — status only (`running|ready → paused`, `paused →
  running`); a paused run refuses `step`.
- `injectExternalEvent(id, event, idempotencyKey)` — validates against the sector's external
  event schema, enqueues for a future day (`day ≥ state.day`), journals `external_event`.
- `haltSimulation(id, reason)` — the emergency stop: `status halted`, further steps refused;
  honest note in the UI: with in-request stepping nothing is in flight to stop.
- `deleteSimulation(id)` — cascade journal/usage. `listSimulations(companyId?)`,
  `simulationStatus(id)` for the CLI.

## 7. Reads, API, CLI, UI

- **Read model** `apps/web/src/server/simulation.ts`: `buildSimulationSnapshot(id)` → `{
  run, definitionSummary, state, metrics, journal: last 200 entries, modelUsage: { rows, costUsd
  | null, unmeasured } }`; `listSimulationCards()`.
- **Routes** (`requirePrincipal`, Zod body, `orgControlResponse`): `POST /api/sim`, `GET|DELETE
  /api/sim/[id]`, `POST /api/sim/[id]/{step,pause,resume,inject,halt}`. Unknown id → 404.
- **CLI** (`apps/orchestrator/src/cli.ts`): `create-simulation --company <id> --name <n>
  --policy A|B [--seed <n>]`, `step-simulation --simulation <id> [--steps N | --until-day D]`,
  `simulation-status --simulation <id>` (JSON). Pause/inject/halt CLI parity is M30 (recorded).
- **UI**: Sidebar row `Simulations` → `/sim` (cards: `SIMULATION` chip, sector, policy, day,
  status; **+ New simulation** drawer: company, name, policy, seed — no repo, no verify, no
  branch). `/sim/[id]`: persistent strip `SIMULATION · trade · rules provider · synthetic data`;
  controls Step, Run to day, Pause/Resume, Halt, Add external event (demand / supplier delay);
  two separate panels **Simulated company** and **Model usage** (M29: "rules provider — no model
  calls; cost: no record"); tabs Overview / Decisions / Journal. Testids `sim-*`. Nothing under
  `/w/…` changes.
- **Seed** gains `Demo Trading Co.` (departments Sales, Purchasing, Operations, Finance; one
  slave each) so the demo drawer has a company to pick; the software demo company is untouched.

## 8. Security, data and cost boundaries

- `packages/simulation` has no dependency but `zod`; `control/simulation.ts` imports `db`,
  `domain`, `simulation` — never `providers`; no `spawn`, no `process.env`.
- The simulation drawer, routes and verbs never accept or return a repo path, a branch or a
  command. `Workspace`, `Task`, `SlaveRun` are not referenced by any simulation code path.
- Cross-run ids: an action naming an order/supplier/purchase id absent from *this* run's state is
  `unknown_reference`; a route with a run id under the wrong company is 404.
- Idempotency: `(simulationId, idempotencyKey)` unique; the same key returns the first outcome.
- Simulated money vs real cost: two tables, two panels, never one figure; `SimulationModelUsage`
  has no rows in M29 and the UI says so instead of showing `$0.00`.
- Emergency stop: `haltSimulation` blocks every further step and (M31) every model call; the UI
  states that in-request stepping leaves nothing in flight.
- Generated outcomes are labelled `synthetic` in the definition and on every page.

## 9. Testing

- **Pure engine (unit, `packages/simulation/test`)**: queue ordering; step/runUntil; limits halt;
  action pipeline (schema → role → rule); every trade rule in §5.2; stock only on delivery;
  cash only on payment/collection; capacity; policies A and B over the demo scenario produce
  the expected *shapes* (B ships on time, A is late; B's purchase cost higher) without pinning
  a verdict; `replay` equals stored state; two engines with the same seed and inputs produce
  equal journals; metrics equal a hand computation on a three-day fixture.
- **Control (integration, `packages/control/test/integration/simulation.test.ts`)**: create
  freezes the roster (catalog rename afterwards does not change `definition`); two runs from one
  company never share state; unsupported sector/mode refused; step persists state/version/
  journal atomically; idempotency key returns the first outcome; `stale_version`; pause refuses
  step; halt refuses step; `deleteCompany` refuses with `live_simulations`.
- **Web (unit + integration)**: routes 404/409/200 shapes; the page renders the strip, the two
  money panels and the controls; create drawer has no Git fields; `/w/…` pages unchanged
  (existing tests).
- **Gate `gate:m29-simulation`** (Playwright, like m11): from the UI create a demo simulation,
  run to day 30, read the metrics off the page and compare them to the control-layer replay;
  repeat with policy B; both under the rules provider with `SimulationModelUsage` empty.
- Acceptance map (brief §12): 1 existing suites + gates; 2 create test; 3 two-runs test; 4
  cross-run/role tests; 5 `insufficient_stock`; 6 stock-on-delivery; 7 capacity/cash; 8
  idempotency; 9 replay; 10 pause/halt refuse (full restart-resume is M30); 11 package
  dependency test (`simulation` and `control/simulation.ts` import no provider/spawn — asserted
  by a test that reads the import graph); 12 `schema_invalid` leaves state unchanged; 13
  metrics fixture; 14 two-table assertion; 15 gate.

## 10. Global constraints

- One vitest run at a time; `npm run --silent typecheck` (not `tsc --build`) and `npm run
  web:build` before any "green" claim; vocabulary gate stays green (the noun is `slave`).
- No `if (simulation)` in the software flow: the two worlds meet only in `Company` (FK) and the
  sidebar.
- The demo and every test make no model call; there is no provider wiring to make one.
- Additive migration only; no existing row changes; `db:migrate:test` updated.

## 11. Order of work

1. Package skeleton + core (clock, queue, rng, journal, action pipeline, engine) with tests.
2. Trade sector: state, rules, events, scenario, metrics, rules provider with policies A/B; tests.
3. Migration + Prisma models + seed company; `control/simulation.ts` + refusals + integration tests.
4. Read model + API routes + CLI verbs; tests.
5. UI: sidebar, list, drawer, run page; unit tests; `web:build`.
6. Gate `m29-simulation`; README section; errata.

## 12. Out of scope, recorded

Clone and compare (M30); pause/resume across process restarts and CLI parity for pause/inject/
halt (M30); LLM decision provider, a software-company simulation, `sector: software`,
`mode: real` for anything but the existing Workspace flow (M31); SSE for simulation pages;
profit/margin metrics; multi-product; coordinator role; a `SimulationRun` under a `Workspace`.

## 13. Errata — where execution corrected the plan

Every controller ruling made while executing Tasks 1–11, in order, one line each:

- **R1** — §5.1's `Purchase.status` (`ordered | delivered | paid`) conflated two independent events: policy B's fast supplier pays on the same day it orders (`payDay = day`), so `payment_due` marked the purchase `paid` before its own `delivery` event ever fired, and `delivery` (which only applied to a purchase `status === 'ordered'`) silently dropped the shipment as `not_ordered` forever — stock never arrived and the hedge repeated daily. `Purchase.status` narrows to `ordered | delivered`; a separate `paid: boolean` tracks payment, set by `payment_due` alone; `unpaidCommitmentsMinor` and the rules provider's hedge threshold read `!paid`. §5.2's own rule (stock moves on delivery, cash moves on payment) already implied two fields; the plan's single linear status did not carry it.
- **R2** — the hedge policy (B) could not see a normal purchase placed earlier in the SAME decision step: the role's observation is a snapshot taken before that step's own actions land, so B "hedged" with the fast supplier on day 1 against a normal purchase it had not yet been told existed, before that purchase could possibly be late. §5.4's "hedges with the fast supplier when a delivery is at risk" only makes sense once a normal purchase is on order and overdue — the hedge's inbound-purchases view now includes the just-placed normal purchase (`expectedDay = day + normal.leadDays`) so there is a delivery to be at risk of missing before B reaches for the fast one.
- **R3** — control's per-run idempotency keys are namespaced by verb (`step:<key>`, `inject:<key>`) rather than shared: the schema's uniqueness is per run, not per (run, verb), so a caller who reused one key across `stepSimulation` and `injectExternalEvent` would otherwise have the second call silently replay the first's outcome as if it were its own.
- **R4** — `stepSimulation`'s transaction runs with an explicit `{ timeout: 60_000, maxWait: 10_000 }`: a full-horizon run (up to §6's `MAX_STEPS_PER_REQUEST`) writing thousands of journal rows in one `createMany` can outrun Prisma's 5-second interactive-transaction default; a pathological request still fails, just with room to actually finish a normal one first.
- **R5** — `replaySimulation` and `simulationStatus` read a run's row and its journal inside one `RepeatableRead` transaction, not two unlocked queries: under the default Read Committed isolation a concurrent `stepSimulation` commit landing between the two reads could make the journal newer than the state it is compared against, reporting a spurious replay mismatch that was never real.
- **R6** — the state-vs-journal comparison inside `replaySimulation` sorts object keys at every level before stringifying (`stableStringify`), rather than comparing raw `JSON.stringify` output: Postgres reorders a stored `jsonb` object's keys by length then alphabetically, so a live engine state and the same state round-tripped through storage could disagree by key order alone with zero difference in content.
- **R7** — the halt route treats an empty request body as `{}` (no reason given) but answers 400 on a non-empty, unparsable one: pause and resume take no body at all, and a bodiless halt from a script is a legitimate call the same way; a syntactically broken body is never legitimate and should not silently become "no reason."
- **R8** — `create-simulation --seed <n>` is validated at both the CLI and the `createSimulation` verb: an unparsed seed would otherwise persist as `null` and make every later verb on that run fail with `simulation_corrupt`. The verb is the boundary every caller (CLI today, routes and any future caller) shares, so the refusal lives there; the CLI additionally throws its own message before ever calling it, since a friendlier error at the command line beats a generic one from the verb.
- **R9** — the Simulations page's card keeps its click handler on the real `<button>` `Card` itself renders, not on an outer wrapper `<div>`: a first pass moved it to the wrapper to satisfy a draft test that clicked there, which would have cost the card its keyboard/focus path (the house convention `Card.tsx` already gives every card for free). Review restored the handler on the inner button and pointed the test at it instead; the drawer's "no repository" copy was also reworded to "no source checkout" so it stopped tripping a test's own ban on git-specific words, while still saying the true thing — a simulation names no repository at all.
- **R10** — the run page's three sections (`overview` / `decisions` / `journal`) carry `role="tablist"` / `role="tab"` / `aria-selected`, the same pattern `SlavesClient` and `ProjectTabs` already use; and a decision's action outcomes are matched to their `action_applied` / `action_rejected` journal rows by the payload's own `actionIndex`, not by position in the actions array — a later action's rejection can be journalled before an earlier action's own applied row, which a positional zip would have mislabeled.
- **R11** — execution ran on an in-place feature branch (`feature/m29-company-simulation`) rather than a separate git worktree: the repo's shared Postgres, `.env`, and installed `node_modules` are all assumed at the repo root by the pre-push hook and every gate, and a worktree would need its own copy of all three while buying no isolation for a database every milestone already shares.

M30 backlog (already named in §12, restated here as what comes next): clone and compare a run
against another; pause/resume that survives a process restart; CLI parity for `pause` / `inject` /
`halt` (today's CLI has `create-simulation`, `step-simulation` and `simulation-status` only); SSE
for simulation pages, so a run's own page updates itself the way every workspace page already does
instead of relying on `router.refresh()` after each control.
