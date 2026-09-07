# M31b — The software-company sector: a second SectorModel, and the platform stops assuming trade

**Status:** Approved in conversation (2026-09-07; the user waived the written-spec review and asked for the plan and subagent execution directly). Decisions taken: the software simulation teaches two dynamics at once — review capacity (speed vs. quality) and expertise matching — bundled into the existing two policies (A fast, B careful); one decision role (`lead`, who assigns work) may run on the M31a llm provider; sector support is a registry of plugins in `packages/simulation`, so control and web are generalised once and a third sector is one plugin; no schema migration beyond widening the `SimulationSector` enum (erratum R9, §9).
**Approach:** one milestone. `packages/simulation` gains a `SectorPlugin` contract, a `software` sector implementing it, and a `trade` plugin wrapping what M29 built; `packages/control` and `apps/web` replace every trade symbol with a lookup on the run's sector. The engine, the journal, replay, auto-run, compare and the llm two-phase step are untouched.
**Scope rule:** what a person needs to create a software-company simulation from the catalog's "Checkout Platform", run it under policy A and B, inject a feature request, an incident or an absence, read the metrics, compare the two runs, and put the `lead` role on a model — with the trade sector looking and behaving exactly as before. Nothing else.

## 1. Principles (M29 §2, M30 §2, M31a §2 stay binding; added here)

1. **A sector is a plugin, not a branch.** Everything sector-specific — schemas, model, rules, metrics, demo, forms — lives under one `SectorPlugin` value; control and web never name a sector except through the registry. An unknown sector is `unsupported_simulation`, never a fallback (brief §2).
2. **Trade is pixel-identical.** The trade run page, the compare page, the CLI output and the M29/M30/M31a gates pass unchanged; the trade plugin is a re-export of M29's functions, not a rewrite.
3. **No randomness.** Like the trade demo, the software model is deterministic: mismatch and skipped review have fixed consequences, so replay (M29 §6) stays exact and A/B differences are explainable from rules alone.
4. **Engineers are resources; roles decide.** Three decision roles (`product`, `lead`, `reviewer`) act; engineers are state the lead assigns. That keeps the decision surface small enough for a rules provider and for one llm role.

## 2. The sector plugin (`packages/simulation/src/core/plugin.ts`)

```ts
export interface MetricLabel { readonly label: string; readonly kind: 'count' | 'money' | 'days' }
export interface HeadlineItem { readonly label: string; readonly value: number; readonly kind: 'count' | 'money' | 'days' }
export interface FormField { readonly name: string; readonly label: string; readonly kind: 'int' | 'money' | 'select'; readonly optionsFrom?: string }   // optionsFrom names a key of injectOptions(state)
export interface ExternalEventForm { readonly type: string; readonly label: string; readonly fields: readonly FormField[] }
export interface RosterEntry { readonly slaveName: string; readonly departmentName: string; readonly role: string }

export interface SectorPlugin<S, E, R, D extends EngineDefinition, M extends Record<string, number>> {
  readonly name: string                                    // 'trade' | 'software'
  readonly model: SectorModel<S, E, R>
  readonly definitionSchema: z.ZodType<D>
  readonly stateSchema: z.ZodType<S>
  readonly externalEventSchema: z.ZodType<E>
  readonly rosterRequirement: string                       // the refusal text when the roster cannot fill the roles
  rosterFits(roster: readonly RosterEntry[]): boolean      // the same rule demoDefinition enforces, without building anything
  demoDefinition(input: { policy: 'A' | 'B'; seed: number; roster: readonly RosterEntry[]; currency: string; llmRoles?: readonly string[] }): D   // throws Error(rosterRequirement) on a short roster
  cloneDefinition(definition: D, over: { policy: 'A' | 'B'; seed: number }): D
  initialState(definition: D): EngineState<S, E>
  rulesProvider(definition: D): DecisionProvider
  metrics(entries: readonly JournalEntry[], state: S): M
  readonly metricLabels: Readonly<Record<keyof M & string, MetricLabel>>
  headline(state: S, day: number): readonly HeadlineItem[]  // the "company" panel
  readonly actionDocs: readonly ActionDoc[]
  readonly externalEventForms: readonly ExternalEventForm[]
  injectOptions(state: S): Readonly<Record<string, readonly { id: string; label: string }[]>>
  readonly llmRoleCandidates: readonly string[]            // trade: ['purchasing']; software: ['lead']
}
export const sectors: { readonly trade: SectorPlugin<…>; readonly software: SectorPlugin<…> }
export type SectorName = keyof typeof sectors
export function sectorFor(name: string): AnySectorPlugin | undefined
```
- `RosterEntry.role` is new (M29's roster carried only `slaveName` and `departmentName`): the software sector derives expertise from the catalog role. Control's roster read adds it; trade ignores it.
- `AnySectorPlugin` is the existentially typed union control uses; a plugin's generic parameters never leak past `shared.ts`'s `LoadedSimulation`, which becomes `{ sector: 'trade', definition, state } | { sector: 'software', definition, state }`.
- A **conformance test** (`packages/simulation/test/core/plugin-conformance.test.ts`) runs the same suite against every entry of `sectors`: schema round-trips of `initialState`, every `actionDocs.type` appears in some role's `allowedActions`, every `externalEventForms.type` parses with `externalEventSchema`, `metricLabels` keys equal `Object.keys(metrics([], state))`, `llmRoleCandidates ⊆ roleOrder`, `demoDefinition` A and B run to the horizon under `rulesProvider` and replay exactly.

## 3. The software sector (`packages/simulation/src/software/`)

### 3.1 State (`state.ts`)
```ts
engineer: { id: string (slaveName), expertise: 'backend' | 'frontend' | 'devops' | 'general', busyUntilDay: number | null, taskId: string | null, absentUntilDay: number | null }
task: { id: string, area: 'backend' | 'frontend' | 'devops', sizeDays: 1..5, origin: 'request' | 'incident' | 'defect', priority: 'normal' | 'incident',
        requestedDay, dueDay, queuedDay: number | null, assignedTo: string | null, startedDay: number | null, finishedDay: number | null, doneDay: number | null,
        status: 'requested' | 'queued' | 'in_progress' | 'in_review' | 'done', reviewed: boolean, rework: number, sourceTaskId: string | null }
state: { engineers: Engineer[], tasks: Task[], reviewCapacityPerDay: number, reviewedToday: number, matchWaitDays: number, nextTaskSeq: number, idleEngineerDays: number }
```
Task ids are `t-<seq>`; incidents from defects are `t-<seq>` with `sourceTaskId` set. Everything is integer days.

### 3.2 Roles and actions (`definition.ts`, `actions.ts`)
| role | purpose | observes | allowedActions |
|---|---|---|---|
| `product` | accepts requests into the queue | requested tasks, queue length | `accept_request { taskId }`, `note` |
| `lead` | assigns queued work to engineers | queue (priority, age, area, size), engineers (expertise, free/busy/absent), `matchWaitDays` | `assign_task { taskId, engineerId }`, `note` |
| `reviewer` | reviews finished work within the day's capacity | in-review tasks (oldest first), `reviewCapacityPerDay`, `reviewedToday` | `review_task { taskId }`, `note` |
`roleOrder = ['product', 'lead', 'reviewer']`. Roster assignment (`assignRoles`): `product` ← a slave whose department is `Product`; `lead` ← department `Management`; `reviewer` ← catalog role `reviewer` or `QA` (department `Engineering`); engineers ← every other `Engineering` slave, expertise from the catalog role (`Backend`→backend, `Frontend`→frontend, `DevOps`→devops, anything else→general). Fewer than two engineers, or a missing role slave → `Error(rosterRequirement)` = "the software sector needs a Product slave, a Management slave, a QA or reviewer slave and at least two more Engineering slaves". Constraints: `lead.maxAssignmentsPerStep = 4`.

Validation (`model.validate`): `accept_request` needs `status === 'requested'`; `assign_task` needs `status === 'queued'`, an engineer that exists, is not busy (`busyUntilDay === null`) and not absent today; `review_task` needs `status === 'in_review'` and `reviewedToday < reviewCapacityPerDay` (rejection `review_capacity_exhausted`). Rejection kinds: `unknown_task`, `wrong_status { status }`, `unknown_engineer`, `engineer_busy`, `engineer_absent`, `review_capacity_exhausted`, `unknown_action`, `bad_params`.

Apply: `accept_request` → `queued`, `queuedDay = day`. `assign_task` → `in_progress`, `startedDay = day`, `duration = sizeDays` when `engineer.expertise === task.area`, else `ceil(sizeDays * 1.5)`; engineer `busyUntilDay = day + duration`; schedule `task_finished { taskId }` at `day + duration` (priority `scheduled`). `review_task` → `done`, `reviewed = true`, `doneDay = day`, `reviewedToday += 1`.

### 3.3 Events (`events.ts`)
- External (injectable): `request { area, sizeDays, dueInDays }` → a new `requested` task; `incident { area }` → a new task `sizeDays 1, priority 'incident', origin 'incident'`, already `queued` (incidents skip product) — an incident carries no `dueInDays`, so its `dueDay = day + sizeDays`, the earliest a day of work could land (R5); `absence { engineerId, days }` → `absentUntilDay = day + days`, read **inclusively** as the last day away, so the field is non-null on exactly the absent days and "absent today" needs no day argument (R6); an engineer mid-task keeps the task, its `busyUntilDay` and the scheduled `task_finished` move by `days` (the event is re-scheduled; record lists the shift).
- Scheduled: `task_finished { taskId }` → engineer freed; the task goes to `in_review` when the policy reviews it (§3.4), else straight to `done` with `reviewed = false`, `doneDay = day`, and — if `!reviewed && (mismatch || sizeDays >= 3)` — schedules `defect_surfaced { taskId }` at `day + 3`. `defect_surfaced { taskId }` → the source task's `rework += 1` and a new incident task (`origin 'defect'`, `sourceTaskId`, `area` of the source, `sizeDays 1`, `priority 'incident'`, `queued`).
- `closeDay`: `reviewedToday = 0`; engineers whose `absentUntilDay <= day` are cleared; `idleEngineerDays += count(engineers free and not absent today)`; the run finishes at `day >= horizonDays` (as trade).

### 3.4 Policies (frozen in the definition; `rules.ts` reads them)
| | A — fast | B — careful |
|---|---|---|
| review | only `incident`-priority tasks go to review; requests finish unreviewed | every finished task goes to review |
| `reviewCapacityPerDay` | 1 | 2 |
| assignment | first free engineer, priority then age | a free engineer with matching expertise; if none, wait up to `matchWaitDays = 2` days from `queuedDay`, then any free engineer |
Rules provider: `product` accepts every `requested` task (oldest first, up to `maxDecisionsPerStep`); `lead` as above, up to `maxAssignmentsPerStep`; `reviewer` reviews `in_review` tasks oldest first up to capacity.

### 3.5 Demo scenario (`DEMO_SCENARIO`, `horizonDays 30`)
Engineers from the roster (Checkout Platform: Alex backend, Emma frontend, Daniel devops, Maya general). Requests, all `origin 'request'`, `(day, area, sizeDays, dueInDays)`: (1, backend, 3, 10), (1, frontend, 2, 8), (2, devops, 1, 5), (3, backend, 4, 14), (4, frontend, 3, 12), (6, backend, 2, 8), (8, devops, 3, 12), (9, frontend, 1, 5), (11, backend, 5, 18), (13, frontend, 2, 8), (15, devops, 2, 9), (18, backend, 3, 12). Consequences by construction: under A at least four unreviewed tasks have `sizeDays >= 3` and surface defects (`defectIncidents >= 4`); under B `defectIncidents === 0` and `reworkTasks === 0`; A's `reviewBacklogMax` ≤ B's. The exact metric figures for A and B are fixed by the model's test (Task 2) and recorded in §9 — they are not designed by hand.

### 3.6 Metrics (`metrics.ts`, from the journal like trade)
`deliveredTasks`, `onTimeTasks`, `lateTasks`, `avgLeadDays` (done − requested, delivered tasks), `reworkTasks` (tasks with `rework > 0`), `defectIncidents`, `queueMaxLength`, `reviewBacklogMax`, `idleEngineerDays`, `openTasks` (not done at the end). All `kind: 'count'` except `avgLeadDays` (`days`). Headline: `queued`, `in progress`, `in review`, `done`, `open incidents`.

## 4. Control (`packages/control/src/simulation/*`)
- `SUPPORTED` = `new Set(Object.keys(sectors).map((s) => `${s}:simulation`))`. `createSimulation` takes `sector: SectorName` (no default; the route and the CLI supply it), resolves the plugin, reads the roster with `role`, and turns a `demoDefinition` throw into `invalid_simulation_input { detail: plugin.rosterRequirement }`. `llmRoles` for an llm run = `plugin.llmRoleCandidates`.
- `shared.ts`: `loadSimulation` parses `definition`/`state` with the plugin chosen by `row.sector`; `summarize` reports `sector` from the row; `SimulationSummary.sector: SectorName`. `comparable` is already generic.
- `read.ts`: metrics via `plugin.metrics`; replay via `plugin.model` and `plugin.initialState`; `readSimulationStatus` returns `headline` from `plugin.headline`. The `TradeMetrics` type in `SimulationComparison` becomes `Record<string, number>` plus `metricLabels` from the plugin; `compareSimulations` deltas are computed over the label keys (M30's b−a rule unchanged) and still refuse different sectors.
- `write.ts`: `stepLocked` builds `plugin.rulesProvider(definition)`; `injectExternalEvent` validates with `plugin.externalEventSchema`; clone via `plugin.cloneDefinition` (R4: `llmRoles: []`).
- `llm.ts`: observation via `plugin.model.observe`; `actionDocs` from `plugin.actionDocs`; nothing else changes — the software `lead`'s prompt is built by the same `buildDecisionPrompt`.
- Refusals: none new. `unsupported_simulation`'s text lists the supported set from the registry.

## 5. Web and CLI
- Drawer: `new-simulation-sector` select (`trade`, `software`); the company list is filtered server-side (`listSimulationCompanies(sector)` keeps the catalog companies whose roster passes `plugin.rosterFits`); the body posts `sector`.
- Run page: the strip shows `<sector> · simulation · policy <p>`; the company panel renders `headline`; the metrics panel renders `metricLabels` in the plugin's order with `money` formatted as today; the inject form is generated from `externalEventForms` with select options from `injectOptions` in the snapshot (the trade form keeps its test ids `sim-inject-kind/day/qty/unit-price/due/collect/supplier/extra-days`; software fields get `sim-inject-<name>`). Cards show a sector chip. Compare page renders the plugin's labels.
- CLI: `create-simulation --sector trade|software` (required), `inject-event` passes the JSON through to control unchanged, `simulation-status` prints the headline and metrics generically.

## 6. Tests and gate
- Software model unit tests: validate/apply per action, each event, the defect rule (mismatch, size ≥ 3, reviewed → none), absence mid-task shifting, A and B demo runs to day 30 with exact figures, replay equality, the roster requirement error.
- Plugin conformance test over both sectors (§2).
- Control integration: create software A/B, step, inject the three events, clone, compare, an llm `lead` run with a fake decider, `--sector nonsense` → `unsupported_simulation`, a company without the roster → `invalid_simulation_input` with the requirement text; every existing trade test unchanged.
- Web: drawer sector select and company filtering, generic panels rendering the trade snapshot exactly as before (snapshot tests on the trade fixtures), the software inject form.
- `gate:m31b-software-sector` (browser + real daemon, fake CLI): create software A and B from the UI on Checkout Platform, auto-run both to day 30, assert B has zero defect incidents and A at least four, compare shows deltas with the software labels, inject an incident into A and see it in the journal, create an llm `lead` run with the `decision` fixture adapted (`assign_task`), one usage row per day, `provider 'llm'` on lead decisions; the M29/M30/M31a gates still pass.

## 7. Non-goals
Four-way policies, hiring/salaries/money in the software model, a second llm role, a third sector, a per-sector run page, sector on the `Company` row.

## 8. Order of work
1. `SectorPlugin`, the trade plugin, the registry, the conformance test (trade only passes).
2. The software sector: state, actions, events, model, rules, definition/demo, metrics; conformance passes for both; exact demo figures recorded in §9.
3. Control generalisation (shared/read/write/llm/compare), roster `role`, refusal text; all trade integration tests unchanged.
4. Web and CLI: drawer sector, generic panels and inject form, cards, compare labels, CLI flags.
5. Gate, README, errata, full verification.

## 9. Errata — where execution corrected the plan

### The demo figures (Task 2)
Measured, not designed: the Checkout Platform roster, seed 1, horizon 30, both policies under `rulesProvider`, both runs `finished`. Pinned in `packages/simulation/test/software/policies.test.ts`.

| metric | A — fast | B — careful |
|---|---|---|
| `deliveredTasks` | 21 | 12 |
| `onTimeTasks` | 15 | 12 |
| `lateTasks` | 6 | 0 |
| `avgLeadDays` | 3 | 2.8 |
| `reworkTasks` | 9 | 0 |
| `defectIncidents` | 9 | 0 |
| `queueMaxLength` | 3 | 2 |
| `reviewBacklogMax` | 2 | 2 |
| `idleEngineerDays` | 63 | 89 |
| `openTasks` | 0 | 0 |

§3.5's four invariants hold. A's twelve scenario requests all land; its extra nine deliveries are the incidents its own skipped reviews produced (`A.deliveredTasks − A.defectIncidents === B.deliveredTasks`), and all six of its late tasks are those incidents — not one scenario request is late under either policy.

### Rulings
- **R2 — `ActionDoc` moves to `packages/simulation/src/core/action-docs.ts`**, re-exported from `trade/action-docs.ts` so no importer changes. `core/plugin.ts` names it in the `SectorPlugin` contract and every sector fills it in, so it is not trade's to own.
- **R3 — `queueMaxLength` and `reviewBacklogMax` are running maxima over the journal, not day-close samples.** Sampled at the close they read A = 1 / B = 0 and §3.5's `A.reviewBacklogMax ≤ B.reviewBacklogMax` is false: B reviews a task the same day it finishes, so its close-of-day backlog is always zero and the metric distinguishes nothing. Read as peaks (every arrival and departure is its own journal entry, so the walk is exact) both are 2 and the invariant holds. The scenario was not touched.
- **R4 — `reviewEverything` lives in the state**, beside `reviewCapacityPerDay` and `matchWaitDays`. `SectorModel.applyEvent` is handed `(state, event, day)` and never the definition, and §3.3's `task_finished` has to know whether the policy reviews this task.
- **R5 — an incident's `dueDay = day + sizeDays`** (§3.3, amended above). §3.3 gives an incident no `dueInDays` but a task needs a due day; the earliest date a single day of work could land is the only figure not invented outright. It is what drives A's `lateTasks = 6`.
- **R6 — `absentUntilDay` is inclusive**, the last day away rather than the first day back (§3.3, amended above). Forced, not chosen: `SectorModel.validate` receives `(state, role, action)` with no `day`, so "not absent today" must be answerable from the engineer alone. Both of §3.3's rules stay verbatim and together make the field non-null on exactly the absent days.
- **R7 — `avgLeadDays` is reported in tenths of a day** (`Math.round(mean * 10) / 10`), labelled `average lead time`. Whole days rounded both policies to 3 and erased the one place B is faster; tenths read 3 against 2.8 and still never drift between two runs.
- **R8 — a role's `constraints` are hints to the rules provider, not engine-enforced limits.** `lead.maxAssignmentsPerStep = 4` bounds what `rules.ts` proposes; `validate` cannot count a step's actions from the state. Nothing is lost: the demo has exactly four engineers, so a fifth assignment in a day is rejected `engineer_busy` regardless.

### Two shape facts
- **`reviewEverything` is a state field** (R4), so `softwareStateSchema` carries all three policy knobs and the model needs no access to the definition.
- **`packages/simulation/src/index.ts` aliases the software sector's colliding names.** Trade already exports `demoDefinition`, `assignRoles`, `cloneDefinition`, `DEMO_SCENARIO` and `noteParams`, and a barrel cannot export one name twice; inside `src/software/*` the names stay exactly as this design writes them, and the barrel re-exports them as `softwareDemoDefinition`, `assignSoftwareRoles`, `cloneSoftwareDefinition`, `SOFTWARE_DEMO_SCENARIO`, `SOFTWARE_POLICY_SETTINGS`, `softwareRosterFits` and `softwareNoteParams`. Control and web reach a sector only through `sectors` / `sectorFor` (§1 principle 1), so nothing downstream depends on the unprefixed names.

- **R1 (Task 1):** `FormField` carries an optional `testId`; the trade plugin fills the six ids the run page already used (`sim-inject-qty`, `sim-inject-price`, `sim-inject-due`, `sim-inject-collect`, `sim-inject-supplier`, `sim-inject-extra-days`) so the generic inject form renders the trade form with the same ids.
- **Headline (Task 1):** the seven headline items were copied from the web snapshot's company panel, not from control's status read (which computed four); `TradeMetrics` is an interface and cannot satisfy `Record<string, number>`, so the trade plugin's metric type is a mapped type over its nine labelled keys.
- **R2 (Task 2):** `ActionDoc` lives in `core/action-docs.ts` (re-exported from `trade/action-docs.ts`).
- **R9 (Task 3):** "no schema migration" was wrong: `SimulationSector` was a one-value Postgres enum, so `20260907110000_m31b_software_sector` adds `software` (ADD VALUE only; no table touched).
- **R10 (Task 3):** the generic engine-state wrapper parses queue events with `plugin.model.eventSchema` (the `SectorModel` contract already publishes the full union); a corrupt queue event is still `simulation_corrupt`.
- **R11 (Task 3):** `companiesForSector('trade')` includes any company with at least four slaves — the trade rule is a head count, so the software company qualifies for trade too.
- **R12 (Task 3):** the `roster_too_small` refusal kind is gone: the plugin's `rosterFits`/`rosterRequirement` answer for every sector, so a hard-coded "trade needs 4" guard could only lie.
- **R13 (Task 3):** `SectorName` is an explicit union in `core/plugin.ts` and the registry is checked with `satisfies Record<SectorName, AnySectorPlugin>` — a third sector is two edits in `packages/simulation`, never one in control or web.
- **Create (Task 3):** only a `demoDefinition` throw whose message equals `rosterRequirement` becomes `invalid_simulation_input`; any other throw propagates. `injectExternalEvent` parses the event under the row lock because the schema belongs to the run's sector.
- **Compare (Task 3, backlog):** `COMPARED_KEYS` in control's `read.ts` is a hand-made union of the sectors' world keys; a `comparedKeys` field on the plugin is the honest fix (M31 backlog).
- **R14 (Task 4):** `HeadlineItem.ofHorizon?` marks the item the run page suffixes with `/ horizonDays`; the page never keys on a label string.
- **R15 (Task 5):** the §9 demo figures were measured through `demoDefinition` on `policies.test.ts`'s hand-typed `CHECKOUT_ROSTER` array, whose Engineering order (Alex, Emma, Daniel, Maya) is not alphabetical — but `rosterOf` (the roster read every real `createSimulation` call goes through) orders both teams and slaves by name ascending, giving Engineering order Alex, Daniel, Emma, Maya instead. Policy A's `pick()` breaks a free-engineer tie by array position, so the two orders diverge: a company built and run through `gate:m31b-software-sector` (prisma → `createSimulation` → `stepSimulation`, the same path an operator's browser drives) measures policy A at `deliveredTasks 24, defectIncidents 12, reworkTasks 12, lateTasks 10, onTimeTasks 14`, not the unit test's 21/9/9/6/15 — B is unaffected (matched-first, not array-order) and stays 12/0/0/0/12. Both figures satisfy every invariant §3.5 and `policies.test.ts` actually assert (`B.defectIncidents === 0`, `A.defectIncidents ≥ 4`, `A.deliveredTasks − A.defectIncidents === B.deliveredTasks`, `A.lateTasks > B.lateTasks`); the gate asserts its own measured 24/12 rather than the unit test's 21/12, and prints both before asserting.
- **R16 (Task 5):** an external event injected at day `d` (the run page's own default, `simTime + 1`) is scheduled at engine time `d`, but `step()` processes engine day = the run's simTime *before* that step (§8's `state.day` starts at 0) — so on a fresh run (simTime 0) the event fires on the step that carries simTime from 1 to 2, not the first step. `injectExternalEvent`'s own `external_event` journal row (`payload.op 'injected'`) is written immediately and needs no step at all; the row `step()` itself writes when the event actually pops the queue (`payload.event.type`, e.g. `'incident'`) — and the headline's open-incidents count that follows from it — need that second step. `gate:m31b-software-sector` steps until the queued-event journal row appears rather than assuming one step suffices, and prints the day it actually fired on.
