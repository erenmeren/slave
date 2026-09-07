# M31b Software Sector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A second simulation sector (a small software company: queue, expertise, review capacity, rework) behind a `SectorPlugin` registry, with control, web and CLI generalised so they never name a sector except through that registry — and the trade sector unchanged to the pixel.

**Architecture:** `packages/simulation/src/core/plugin.ts` defines `SectorPlugin`; `src/trade/plugin.ts` wraps M29's functions; `src/software/*` is the new sector (pure, zod only, deterministic); `src/core/registry.ts` exports `sectors`/`sectorFor`. `packages/control/src/simulation/*` resolves the plugin from `row.sector` and calls it where it called `tradeModel`/`tradeMetrics`/`RulesDecisionProvider`/`tradeExternalEventSchema`/`demoDefinition`/`cloneDefinition`/`tradeInitialEngineState`. `apps/web` renders the headline, metric and inject panels from plugin-provided labels and field lists.

**Tech Stack:** TypeScript (NodeNext, strict), zod 3, Prisma 7 (no migration), Next.js app router, vitest, playwright-core; the fake CLI for any llm test.

**Spec:** `docs/superpowers/specs/2026-09-07-m31b-software-sector-design.md` (M29 §2/§6, M30 §2, M31a §2 stay binding).

## Global Constraints

- No sector name appears in `packages/control/src/simulation/*` or `apps/web/src` except through `sectors` / `sectorFor` / `SectorName` (one allowed literal: the drawer's option list, which is `Object.keys(sectors)`). An unknown sector → `unsupported_simulation`; never a fallback.
- Trade is pixel-identical: every existing trade test passes unchanged (test files may gain the new `role` roster field and the `sector` create input only); `gate:m29-simulation`, `gate:m30-simulation-compare`, `gate:m31a-llm-decisions` pass unchanged.
- The software model is deterministic (no RNG): mismatch = `ceil(sizeDays × 1.5)` days; an unreviewed finished task with `mismatch || sizeDays >= 3` surfaces a defect at `doneDay + 3`; reviewed tasks never do.
- `packages/simulation` stays pure (zod only). Control never imports providers. No real model call in any test or gate (fake CLI / fake decider).
- One vitest at a time; `npm run --silent typecheck` (not `tsc --build`); `npm run web:build` last for web tasks and never while `next dev` runs; vocabulary gate (`slave`).
- Commit trailers: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_015LdvAE5MLjx54f8H1WJvLx`.

## File structure

```
packages/simulation/src/core/plugin.ts                 SectorPlugin, MetricLabel, HeadlineItem, FormField, ExternalEventForm, RosterEntry, AnySectorPlugin
packages/simulation/src/core/registry.ts               sectors, SectorName, sectorFor
packages/simulation/src/trade/plugin.ts                tradePlugin (wraps M29 + M31a TRADE_ACTION_DOCS)
packages/simulation/src/software/{state,actions,events,model,rules,definition,metrics,plugin}.ts
packages/simulation/test/core/plugin-conformance.test.ts
packages/simulation/test/software/{model,rules,policies,definition,metrics}.test.ts
packages/control/src/simulation/{shared,read,write,llm}.ts   plugin lookup; roster role; sector in create
packages/control/test/integration/software.test.ts
apps/web/src/server/simulation.ts, components/sim/{NewSimulationDrawer,SimulationClient,SimulationStrip,SimulationsClient,CompareClient}.tsx, app/api/sim/route.ts
apps/orchestrator/src/cli.ts                           --sector; generic status
scripts/gate-m31b-software-sector.mjs, package.json, ci.yml, README.md, spec §9
```

---

### Task 1: `SectorPlugin`, the trade plugin, the registry, the conformance test

**Files:** create `packages/simulation/src/core/plugin.ts`, `src/core/registry.ts`, `src/trade/plugin.ts`, `test/core/plugin-conformance.test.ts`; modify `src/index.ts` (export the three), `src/trade/definition.ts` (`TradeRosterEntry` gains optional `role?: string` so the shared `RosterEntry` is assignable).

**Interfaces (produces):** exactly spec §2 — copy the `SectorPlugin` block verbatim. `AnySectorPlugin = SectorPlugin<any, any, any, any, any>` (documented as the existential the registry hands to control). `sectors = { trade: tradePlugin }` in this task (software is added in Task 2); `SectorName = keyof typeof sectors`; `sectorFor(name: string): AnySectorPlugin | undefined` (a plain object lookup guarded by `Object.hasOwn`).

`tradePlugin`: `name 'trade'`, `model: tradeModel`, `definitionSchema: tradeSimulationDefinitionSchema`, `stateSchema: tradeStateSchema`, `externalEventSchema: tradeExternalEventSchema`, `rosterRequirement: 'the trade sector needs four slaves for its four roles'` (the text `assignRoles` throws today — make `assignRoles` throw exactly this string), `rosterFits(roster) => roster.length >= 4`, `demoDefinition`, `cloneDefinition`, `initialState: tradeInitialEngineState`, `rulesProvider: (d) => new RulesDecisionProvider(d)`, `metrics: tradeMetrics`, `metricLabels` = the nine labels now hardcoded in `apps/web/src/components/sim/SimulationClient.tsx:19-20` (`deliveredQty: {label:'delivered', kind:'count'}`, … `Minor` keys `kind:'money'`, `lateDays` `kind:'days'`), `headline(state, day)` = the seven items `simulationStatus` computes today in `packages/control/src/simulation/read.ts` (`day`, `cash` money, `inventory`, `open orders`, `pending demand`, `inbound purchases`, `daily ship capacity`), `actionDocs: TRADE_ACTION_DOCS`, `externalEventForms` = `[{ type:'demand', label:'customer demand', fields:[{name:'qty',label:'qty',kind:'int'},{name:'unitPriceMinor',label:'unit price',kind:'money'},{name:'dueInDays',label:'due in days',kind:'int'},{name:'collectInDays',label:'collect in days',kind:'int'}] }, { type:'supplier_delay', label:'supplier delay', fields:[{name:'supplierId',label:'supplier',kind:'select',optionsFrom:'suppliers'},{name:'extraDays',label:'extra days',kind:'int'}] }]` (check the real field names in `src/trade/events.ts` and the form in `SimulationClient.tsx` and use THOSE), `injectOptions(state) => ({ suppliers: state.suppliers.map(s => ({ id: s.id, label: s.name })) })`, `llmRoleCandidates: ['purchasing']`.

- [ ] Tests first (`plugin-conformance.test.ts`, parameterised over `Object.values(sectors)`): the checks listed in spec §2; plus `sectorFor('nonsense')` is `undefined` and `sectorFor('__proto__')` is `undefined`. Run, watch fail (module missing).
- [ ] Implement; `npx vitest run packages/simulation`; `npm run --silent typecheck`.
- [ ] Commit `feat(simulation): m31b t1 — SectorPlugin, the registry, the trade plugin, a conformance suite every sector must pass`.

---

### Task 2: The software sector

**Files:** create `packages/simulation/src/software/{state,actions,events,model,rules,definition,metrics,plugin}.ts`, tests `test/software/{model,rules,policies,definition,metrics}.test.ts`; modify `src/core/registry.ts` (`software: softwarePlugin`), `src/index.ts`.

**Interfaces:** spec §3 verbatim: state/task/engineer schemas (§3.1), roles/actions/validation/apply (§3.2), events (§3.3), policies and rules provider (§3.4), `DEMO_SCENARIO` and `demoDefinition` (§3.5), metrics and headline (§3.6). Definition schema: `{ sector: z.literal('software'), policy, seed, horizonDays (30), currency, roles, roleOrder: ['product','lead','reviewer'], limits: { maxSteps: 365, maxDecisionsPerStep: 8, maxJournalEntries: 20_000 }, llmRoles (default []), engineers: [{ id, expertise }], scenario: { requests: [{ day, area, sizeDays, dueInDays }] }, reviewCapacityPerDay, reviewEverything: boolean, matchWaitDays }` — policy A: `reviewCapacityPerDay 1, reviewEverything false, matchWaitDays 0`; B: `2, true, 2`. `initialState` schedules every scenario request as an `external`-priority `request` event on its day (like trade's demand), so the first day's product decision sees the day-1 requests. Action docs: `accept_request {taskId}`, `assign_task {taskId, engineerId}`, `review_task {taskId}`, `note {text}` with `when` sentences from §3.2. `externalEventForms`: `request` (`area` select from `injectOptions.areas`, `sizeDays` int, `dueInDays` int), `incident` (`area` select), `absence` (`engineerId` select from `injectOptions.engineers`, `days` int). `llmRoleCandidates: ['lead']`. `rosterRequirement` text from §3.2.

- [ ] Tests first: per action validate/apply; each event (request creates `requested`; incident creates a queued incident; absence mid-task shifts `busyUntilDay` and the scheduled `task_finished`); the defect rule three ways; `closeDay` resets `reviewedToday`, counts idle days, clears absences, finishes at the horizon; `assignRoles` on the Checkout Platform roster (`Atlas` Management lead, `John` Product product, `Riley` reviewer, engineers Alex/Emma/Daniel/Maya with expertise backend/frontend/devops/general) and the requirement error on a short roster; policies: run demo A and B to day 30 with `RulesDecisionProvider` — assert the invariants of §3.5 (`B.defectIncidents === 0`, `B.reworkTasks === 0`, `A.defectIncidents >= 4`, `A.reviewBacklogMax <= B.reviewBacklogMax`) AND pin the exact figures of every metric for both policies (first run prints them; the values go into the test and into spec §9 as the first erratum); replay equality for both. Conformance suite now covers both sectors.
- [ ] Implement; `npx vitest run packages/simulation`; typecheck.
- [ ] Commit `feat(simulation): m31b t2 — the software sector: queue, expertise, review capacity, deterministic rework; demo A/B figures pinned`.

---

### Task 3: Control generalisation

**Files:** modify `packages/control/src/simulation/{shared,read,write,llm}.ts`, `packages/control/src/refusal.ts` (`unsupported_simulation` text lists `Object.keys(sectors)`), tests: new `packages/control/test/integration/software.test.ts`; existing trade tests updated only for `sector: 'trade'` in create input (if it was optional, keep a default-free input: the route/CLI pass it).

**Interfaces:** `createSimulation` input `sector: SectorName` (required; a non-member string → `unsupported_simulation`); roster read at write.ts:98 adds `role: slave.role`; `LoadedSimulation` = `{ sector: SectorName; plugin: AnySectorPlugin; summary; definition: EngineDefinition & Record<string, unknown>; state: EngineState<unknown, unknown> }` parsed by `plugin.definitionSchema`/`stateSchema`; `stepLocked` uses `plugin.rulesProvider`; `injectExternalEvent` uses `plugin.externalEventSchema`; clone uses `plugin.cloneDefinition` then `llmRoles: []` (R4); `llm.ts` uses `plugin.model.observe` and `plugin.actionDocs`; `simulationStatus` returns `headline: readonly HeadlineItem[]` INSTEAD of the trade `company` object (the web server and CLI adapt in Task 4 — in this task update their call sites minimally so typecheck stays green, keeping the trade page's rendered text identical); `SimulationComparison.a/b.metrics: Readonly<Record<string, number>>`, `deltas` over `Object.keys(plugin.metricLabels)`, new field `metricLabels`; `loadSideMetrics` via `plugin.metrics`; `replaySimulation` via `plugin.model`/`plugin.initialState`; `listSimulationCompanies`-style filtering needs `rosterFits` exposed: add `companiesForSector(sector)` in control read.ts returning catalog companies whose roster passes.

- [ ] Tests first (`software.test.ts`): create software A on a seeded Checkout-Platform-shaped company (build it in `beforeEach` with the teams/roles from `packages/db/src/seed.ts:41-50`); step 5 days; inject `request`, `incident`, `absence` (and a trade event → rejected by the software schema); clone; compare A vs B (deltas over software labels); an llm `lead` run with a fake decider answering `assign_task`; `sector: 'retail'` → `unsupported_simulation`; a company without a Product slave → `invalid_simulation_input` with the requirement text; `companiesForSector('software')` excludes the trade company and vice-versa. Every trade integration test unchanged and green.
- [ ] Implement; run `software.test.ts`, `simulation.test.ts`, `auto-run.test.ts`, `llm.test.ts`, `refusal-text.test.ts`, the boundary test, one at a time; typecheck.
- [ ] Commit `feat(control): m31b t3 — the run's sector picks its plugin; create takes a sector; roster carries the catalog role; compare over the plugin's labels`.

---

### Task 4: Web and CLI

**Files:** `apps/web/src/server/simulation.ts` (snapshot: `headline`, `metricLabels`, `injectForms`, `injectOptions`), `NewSimulationDrawer.tsx` (`new-simulation-sector` select from `Object.keys(sectors)`, company list from `companiesForSector`), `SimulationClient.tsx` (headline panel from `headline`; metrics panel from `metricLabels` — delete the hardcoded `METRIC_LABELS`/`MONEY`; inject form generated from `injectForms` with test ids `sim-inject-kind`, `sim-inject-day`, and per field `sim-inject-<name>` — the trade fields must keep their existing ids: qty→`sim-inject-qty`, unitPriceMinor→`sim-inject-unit-price`, dueInDays→`sim-inject-due`, collectInDays→`sim-inject-collect`, supplierId→`sim-inject-supplier`, extraDays→`sim-inject-extra-days` — so give `FormField` an optional `testId` the trade plugin fills), `SimulationStrip.tsx` (sector in the strip), `SimulationsClient.tsx` (sector chip), `CompareClient.tsx` (labels from the comparison), `app/api/sim/route.ts` (zod `sector`), `apps/orchestrator/src/cli.ts` (`create-simulation --sector`, `simulation-status` prints headline + metrics generically). Tests: `simulations-page.test.tsx`, `simulation-page.test.tsx` (the trade fixture renders the SAME text as before — keep the existing assertions; add a software fixture), `compare-page.test.tsx`, `sim-routes.test.ts`, `cli.test.ts`.
- [ ] Tests first → implement → each test file once → typecheck → `node scripts/gate-m26-vocabulary.mjs` → `npm run web:build`.
- [ ] Commit `feat(web,cli): m31b t4 — a sector chosen in the drawer; panels and the inject form drawn from the sector's own labels and fields; --sector on the CLI`.

---

### Task 5: Gate, README, errata, full verification

**Files:** `scripts/gate-m31b-software-sector.mjs` (from the m31a gate skeleton; stages per spec §6 — the llm stage needs a fixture whose answer is `assign_task`: add `packages/providers/test/fixtures/decision-software.ndjson` with `[{"type":"assign_task","params":{"taskId":"t-1","engineerId":"Alex"},"rationale":"backend to backend","refs":["t-1"]}]` and expect `action_applied` on day 1 and `action_rejected wrong_status`/`unknown_task` on later days, whichever the code's truth is — print, then assert), `package.json` `gate:m31b-software-sector`, `ci.yml` after m31a, README (a "Try the software company" paragraph and the `--sector` flag), spec §9 (the demo figures from Task 2 plus rulings from the ledger), full verification: typecheck, `npx vitest run`, `web:build`, gates m26, m29, m30, m31a, m31b, m11.
- [ ] Commit `test(gates),docs: m31b t5 — gate:m31b-software-sector; README; errata`.
