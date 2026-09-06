# M30 Simulation Reliability and Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clone a simulation's frozen scenario under another policy, let the orchestrator daemon step runs on a pace without a browser tab (restart-safe), follow a run live on its page, compare two runs side by side without a verdict, and drive every simulation control from the CLI.

**Architecture:** Three nullable columns on `SimulationRun` carry the auto-run intent and watermark; one new control verb (`autoStepDue`) decides "due" under the existing row lock and steps through the same private step body the button uses; `tickSimulations` is a global pass the daemon loop calls after `tick()`. Clone copies the frozen definition with a new policy/seed. Compare is a `RepeatableRead` read. The live page polls the row's `version` over SSE. `packages/control/src/simulation.ts` is split into four files, behaviour-neutral, before it grows.

**Tech Stack:** TypeScript (NodeNext, strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 3, Prisma 7 + Postgres, Next.js app router (SSE via `ReadableStream`), vitest (unit / integration), playwright-core for the gate.

**Spec:** `docs/superpowers/specs/2026-09-06-m30-simulation-reliability-and-comparison-design.md` (M29's spec `docs/superpowers/specs/2026-09-06-m29-company-simulation-design.md` §2/§8 stay binding).

## Global Constraints

- One step path: auto-run, the button and the CLI all step through the same locked body; the daemon never runs the engine itself.
- "Due" is decided under `SELECT … FOR UPDATE` from the row's own `lastAutoStepAt`; two ticks (two daemons, or a daemon and a click) never double-step.
- A clone copies `definition` with only `policy` and `seed` changed, starts at day 0, carries no injected event, no journal row, no model usage; `clonedFromId` is set.
- Comparison computes deltas (B − A) and `definitionsMatch` (deep-equal of `{ roster, roles, initial, scenario, currency, horizonDays, limits }`), never a verdict.
- Auto-run stops (intent cleared + `auto_run_stopped { reason }`) on pause, halt, finish, `untilDay`, and on any step error (which halts the run with `auto-run step failed: <message>`).
- `packages/control/src/simulation/*` imports no `@slave-of-ai/providers`, no `node:child_process`, no `process.env` (the M29 boundary test is extended to the directory).
- Migration additive only: `autoRunEveryMs Int?`, `autoRunUntilDay Int?`, `lastAutoStepAt DateTime?`; `decisionCount` column stays, the Prisma field becomes `actionCount @map("decisionCount")`.
- The noun is `slave`; user-facing words: project, department, slave, simulation. Money via `formatMinor`; real model cost `null` when unmeasured, never `0`.
- One vitest run at a time; before any "green" claim: `npm run --silent typecheck` (not `tsc --build`), then `npm run web:build` (never while `next dev` runs).
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_015LdvAE5MLjx54f8H1WJvLx`.

## File structure

```
packages/db/prisma/schema.prisma                         + 3 columns, actionCount @map
packages/db/prisma/migrations/20260906180000_m30_simulation_auto_run/migration.sql
packages/control/src/simulation/shared.ts                schemas, Row, summarize, parseRow, json, locked, namespacedKey, stableStringify, comparable, journalRows, clearAutoRun
packages/control/src/simulation/read.ts                  readSimulation, loadSimulation, listSimulations, simulationStatus, replaySimulation, compareSimulations
packages/control/src/simulation/write.ts                 createSimulation, cloneSimulation, stepSimulation, stepLocked, setStatus + pause/resume/halt, injectExternalEvent, deleteSimulation
packages/control/src/simulation/auto-run.ts              startAutoRun, stopAutoRun, autoStepDue, tickSimulations
packages/control/src/simulation.ts                       re-exports the four
packages/control/src/refusal.ts                          (no new kinds; invalid_simulation_input carries the detail)
packages/simulation/src/trade/definition.ts              + cloneDefinition(definition, { policy, seed })
packages/simulation/src/trade/model.ts                   ignored labels split
apps/orchestrator/src/daemon.ts                          tickSimulations after tick()
apps/orchestrator/src/cli.ts                             tick prints simulation counts; 8 new verbs
apps/web/src/server/simulation.ts                        snapshot gains autoRun/clonedFrom/actionCount; buildComparison
apps/web/src/server/simulationEvents.ts                  createSimulationSse (version poll)
apps/web/src/app/api/sim/[simulationId]/{clone,auto-run,auto-run/stop,events}/route.ts
apps/web/src/app/api/sim/compare/route.ts
apps/web/src/app/sim/compare/page.tsx
apps/web/src/hooks/useSimulationStream.ts
apps/web/src/components/sim/{CloneDrawer,AutoRunControls,CompareClient}.tsx, SimulationStrip.tsx (+live/auto-run), SimulationClient.tsx (+wiring), SimulationsClient.tsx (+chips)
scripts/gate-m30-simulation-compare.mjs, package.json, .github/workflows/ci.yml, README.md, spec §15
```

---

### Task 1: Migration, `actionCount`, summary fields, and the behaviour-neutral split of `control/simulation.ts`

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (model `SimulationRun`)
- Create: `packages/db/prisma/migrations/20260906180000_m30_simulation_auto_run/migration.sql`
- Create: `packages/control/src/simulation/shared.ts`, `read.ts`, `write.ts` (`auto-run.ts` arrives in Task 3; `clearAutoRun` lives in `shared.ts` so `write.ts` and `auto-run.ts` never import each other in a cycle)
- Modify: `packages/control/src/simulation.ts` (becomes a barrel), every reader of `decisionCount` (`packages/control`, `apps/web/src/server/simulation.ts`, `apps/web/test/simulation-page.test.tsx`, `apps/web/test/simulations-page.test.tsx`)
- Modify: `packages/control/test/simulation-boundary.test.ts` (scan the directory)
- Test: existing `packages/control/test/integration/simulation.test.ts` must stay green unchanged except the `actionCount` rename; `packages/control/test/simulation-boundary.test.ts`

**Interfaces:**
- Produces: `SimulationSummary` gains `readonly actionCount: number` (replacing `decisionCount`), `readonly autoRun: { readonly everyMs: number; readonly untilDay: number; readonly lastStepAt: string | null } | null`, `readonly clonedFromId: string | null`. `shared.ts` exports `Row`, `summarize`, `parseRow`, `json`, `locked`, `namespacedKey`, `journalRows`, `stableStringify`, `comparable`, `engineStateSchema`, `SUPPORTED`, `MAX_STEPS_PER_REQUEST`, `SimulationSummary`, `LoadedSimulation`. `write.ts` exports `stepLocked(tx, row, loaded, input: { untilDay: number; idempotencyKey?: string; lastAutoStepAt?: Date }): Promise<{ day; status; version; entries }>` — the body of `stepSimulation` from "run the engine" to "update the row", reused by Task 3. `shared.ts` exports `clearAutoRun(tx, row, loaded, reason, seq): Promise<number>` (writes `auto_run_stopped` when an intent was set; returns `seq` when it wrote, `seq - 1` when it did not — i.e. the last used journal seq).

- [ ] **Step 1: Schema + migration + rename**

In `schema.prisma`, inside `model SimulationRun` after `decisionCount`, replace `decisionCount    Int                  @default(0)` with:
```prisma
  /// M29 named this `decisionCount`; it counts actions, not decision points (M29 final review).
  /// The column keeps its name, the field says what it holds.
  actionCount      Int                  @default(0) @map("decisionCount")
  /// M30 auto-run intent (spec §3): step one day every `autoRunEveryMs` while running, until
  /// `simTime >= autoRunUntilDay`; `lastAutoStepAt` is the pacing watermark the daemon's verb
  /// compares under the row lock. All three null = no intent.
  autoRunEveryMs   Int?
  autoRunUntilDay  Int?
  lastAutoStepAt   DateTime?
```
`migration.sql`:
```sql
-- M30: auto-run intent and watermark on a simulation run. Additive only; `decisionCount` keeps
-- its column name and is exposed as `actionCount` by the client (@map), no data change.
ALTER TABLE "SimulationRun" ADD COLUMN "autoRunEveryMs" INTEGER;
ALTER TABLE "SimulationRun" ADD COLUMN "autoRunUntilDay" INTEGER;
ALTER TABLE "SimulationRun" ADD COLUMN "lastAutoStepAt" TIMESTAMP(3);
```
Run `npm run db:generate && npm run db:migrate && npm run db:migrate:test`. Rename every `decisionCount` in `packages/control/src`, `apps/web/src`, and the two web test fixtures to `actionCount` (the engine's `EngineState.decisionCount` stays — map it at the write site: `actionCount: result.state.decisionCount`).

- [ ] **Step 2: Split the control file (no behaviour change)**

Move code into the four files exactly as the file-structure block lists; `packages/control/src/simulation.ts` becomes:
```ts
export * from './simulation/shared.js'
export * from './simulation/read.js'
export * from './simulation/write.js'
export * from './simulation/auto-run.js'
```
(`shared.ts` exports the types and helpers; keep `MAX_STEPS_PER_REQUEST` exported from `shared.ts`.) In `write.ts`, extract from `stepSimulation`:
```ts
/** The one step body (spec M30 §2.1): the button, the CLI and the daemon's auto-run all come
 *  through here, inside the caller's row lock. Runs the engine from `loaded.state` to `untilDay`
 *  (bounded by the horizon and MAX_STEPS_PER_REQUEST), writes the journal rows, the `stepped`
 *  control row and the run row, and clears an auto-run intent when the run finished or halted. */
export async function stepLocked(
  tx: Prisma.TransactionClient,
  row: Row,
  loaded: LoadedSimulation,
  input: { readonly untilDay: number; readonly idempotencyKey?: string; readonly lastAutoStepAt?: Date },
): Promise<{ readonly day: number; readonly status: string; readonly version: number; readonly entries: number }> {
  const provider = new RulesDecisionProvider(loaded.definition)
  const result = runUntil(tradeModel, loaded.definition, loaded.state, provider, Math.min(input.untilDay, loaded.definition.horizonDays), MAX_STEPS_PER_REQUEST)
  const version = row.version + 1
  const status = result.state.status
  const controlSeq = result.state.journalSeq + 1
  const outcome = { day: result.state.day, status, version, entries: result.entries.length }
  await tx.simulationJournalEntry.createMany({ data: journalRows(row.id, result.entries) })
  await tx.simulationJournalEntry.create({
    data: { simulationId: row.id, seq: controlSeq, simTime: result.state.day, kind: 'control', actorRole: null, idempotencyKey: input.idempotencyKey !== undefined ? namespacedKey('step', input.idempotencyKey) : null, payload: { op: 'stepped', ...outcome } },
  })
  // Spec §4: a run that finished or halted drops its auto-run intent in the same transaction.
  const stopped = status === 'finished' || status === 'halted'
  const seqAfter = stopped ? await clearAutoRun(tx, row, { ...loaded, state: { ...result.state, journalSeq: controlSeq } }, status, controlSeq + 1) : controlSeq
  await tx.simulationRun.update({
    where: { id: row.id },
    data: {
      state: json({ ...result.state, journalSeq: seqAfter }), version, status, simTime: result.state.day, stepCount: result.state.stepCount, actionCount: result.state.decisionCount, haltedReason: result.state.haltedReason,
      ...(input.lastAutoStepAt !== undefined ? { lastAutoStepAt: input.lastAutoStepAt } : {}),
      ...(stopped ? { autoRunEveryMs: null, autoRunUntilDay: null, lastAutoStepAt: null } : {}),
    },
  })
  return outcome
}
```
and `stepSimulation` keeps its validation, lock, idempotency replay, `stale_version`, `simulation_not_runnable`, the no-op refusal, then `const outcome = await stepLocked(tx, row, loaded, { untilDay, ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}) }); return ok({ ...outcome, replayed: false })`.

`shared.ts` (Task 1 part):
```ts

/** Clears an auto-run intent (spec §4) and journals `auto_run_stopped { reason }` when one was
 *  set. Returns the journal seq the caller should store as `state.journalSeq` (unchanged when
 *  nothing was written). The row update itself is the caller's — this only writes the journal
 *  row, so one `simulationRun.update` per verb keeps `version`/`state` writes in one place. */
export async function clearAutoRun(
  tx: Prisma.TransactionClient,
  row: Row,
  loaded: LoadedSimulation,
  reason: 'operator' | 'until_day' | 'paused' | 'halted' | 'finished' | 'error',
  seq: number,
): Promise<number> {
  if (row.autoRunEveryMs === null) return seq - 1
  await tx.simulationJournalEntry.create({ data: { simulationId: row.id, seq, simTime: loaded.state.day, kind: 'control', actorRole: null, payload: { op: 'auto_run_stopped', reason } } })
  return seq
}
```
`summarize` in `shared.ts` adds:
```ts
    actionCount: row.actionCount,
    clonedFromId: row.clonedFromId,
    autoRun: row.autoRunEveryMs !== null && row.autoRunUntilDay !== null ? { everyMs: row.autoRunEveryMs, untilDay: row.autoRunUntilDay, lastStepAt: row.lastAutoStepAt?.toISOString() ?? null } : null,
```
`setStatus` (pause/halt) in `write.ts`: after journaling its own control row at `seq`, call `const seqAfter = to === 'running' ? seq : await clearAutoRun(tx, row, loaded, to === 'paused' ? 'paused' : 'halted', seq + 1)` and write `journalSeq: seqAfter` plus `...(to !== 'running' ? { autoRunEveryMs: null, autoRunUntilDay: null, lastAutoStepAt: null } : {})` in the row update.

Boundary test: change the second case to walk every `.ts` under `packages/control/src/simulation/` plus `packages/control/src/simulation.ts` and assert each has no `@slave-of-ai/providers`, `child_process`, `process.env`, `spawn(`.

- [ ] **Step 3: Tests green, typecheck, commit**

Run: `npx vitest run packages/control` → all green (the M29 tests exercise every moved verb); `npx vitest run apps/web/test/simulation-page.test.tsx apps/web/test/simulations-page.test.tsx apps/web/test/integration/simulation-snapshot.test.ts` → green; `npm run --silent typecheck` → 0.
```bash
git add packages/db packages/control apps/web
git commit -m "refactor(control),feat(db): m30 t1 — auto-run columns, actionCount, and the behaviour-neutral split of simulation.ts into shared/read/write/auto-run"
```

---

### Task 2: Clone (pure helper, verb, route, drawer) and the `ignored` label split

**Files:**
- Modify: `packages/simulation/src/trade/definition.ts` (+ `cloneDefinition`), `packages/simulation/src/trade/model.ts` (labels), `packages/simulation/src/index.ts` (no change needed if `definition.ts` is already re-exported)
- Modify: `packages/control/src/simulation/write.ts` (+ `cloneSimulation`)
- Create: `apps/web/src/app/api/sim/[simulationId]/clone/route.ts`, `apps/web/src/components/sim/CloneDrawer.tsx`
- Modify: `apps/web/src/components/sim/SimulationClient.tsx` (Clone… button + drawer), `apps/web/src/components/sim/SimulationsClient.tsx` (`clone of <name>` line), `apps/web/src/server/simulation.ts` (`clonedFrom: { id, name } | null` on the snapshot and on cards via a name lookup)
- Test: `packages/simulation/test/trade/definition.test.ts` (new), `packages/simulation/test/trade/model.test.ts` (+labels), `packages/control/test/integration/simulation.test.ts` (+clone cases), `apps/web/test/integration/sim-routes.test.ts` (+clone), `apps/web/test/simulation-page.test.tsx` (+drawer), `apps/web/test/simulations-page.test.tsx` (+clone line)

**Interfaces:**
- Produces: `cloneDefinition(definition: TradeSimulationDefinition, over: { policy: TradePolicy; seed: number }): TradeSimulationDefinition`; `cloneSimulation(sourceId, { name, policy, seed? }, principal?) → Result<{ id }, ControlRefusal>`; `POST /api/sim/[id]/clone` body `{ name, policy, seed? }` → `{ ok: true, id }`; testids `sim-clone-open`, `sim-clone-drawer`, `sim-clone-name`, `sim-clone-policy`, `sim-clone-seed`, `sim-clone-submit`, `sim-clone-error`, `sim-clone-close`; card text `clone of <name>`.

- [ ] **Step 1: Failing tests**

`packages/simulation/test/trade/definition.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { cloneDefinition, demoDefinition } from '../../src/trade/definition.js'

const roster = [{ slaveName: 'Sonia', departmentName: 'Sales' }, { slaveName: 'Pete', departmentName: 'Purchasing' }, { slaveName: 'Olga', departmentName: 'Operations' }, { slaveName: 'Fin', departmentName: 'Finance' }]

describe('cloneDefinition', () => {
  it('copies everything but policy and seed, and never aliases the source', () => {
    const source = demoDefinition({ policy: 'A', seed: 3, roster, currency: 'USD' })
    const clone = cloneDefinition(source, { policy: 'B', seed: 9 })
    expect(clone.policy).toBe('B')
    expect(clone.seed).toBe(9)
    const strip = (d: typeof source) => ({ ...d, policy: undefined, seed: undefined })
    expect(strip(clone)).toEqual(strip(source))
    expect(clone.roles).not.toBe(source.roles)
    expect(clone.scenario).not.toBe(source.scenario)
  })
})
```
`model.test.ts` additions (in the events describe):
```ts
  it('names why an event was ignored: unknown purchase, already delivered, already paid, unknown order', () => {
    const p = tradeModel.apply(base(), purchasing, act('place_purchase', { supplierId: 'fast', qty: 5 }), 1)
    expect(tradeModel.applyEvent(p.state, { type: 'delivery', purchaseId: 'nope' }, 3).record).toMatchObject({ ignored: 'unknown_purchase' })
    const delivered = tradeModel.applyEvent(p.state, { type: 'delivery', purchaseId: 'purchase-1' }, 3)
    expect(tradeModel.applyEvent(delivered.state, { type: 'delivery', purchaseId: 'purchase-1' }, 4).record).toMatchObject({ ignored: 'already_delivered' })
    expect(tradeModel.applyEvent(p.state, { type: 'payment_due', purchaseId: 'nope' }, 1).record).toMatchObject({ ignored: 'unknown_purchase' })
    const paid = tradeModel.applyEvent(p.state, { type: 'payment_due', purchaseId: 'purchase-1' }, 1)
    expect(tradeModel.applyEvent(paid.state, { type: 'payment_due', purchaseId: 'purchase-1' }, 2).record).toMatchObject({ ignored: 'already_paid' })
    expect(tradeModel.applyEvent(base(), { type: 'collection', orderId: 'nope', qty: 1 }, 1).record).toMatchObject({ ignored: 'unknown_order' })
  })
```
`packages/control/test/integration/simulation.test.ts` — new describe:
```ts
describe('cloneSimulation', () => {
  it('starts at day 0 from the frozen definition with the new policy and seed, carrying no injected event and no journal', async () => {
    const source = await create('src', 'A')
    await stepSimulation(source, { steps: 2 })
    await injectExternalEvent(source, { day: 5, event: { type: 'demand', qty: 10, unitPriceMinor: 1_000, dueInDays: 3, collectInDays: 0 } })
    const cloned = await cloneSimulation(source, { name: 'src (B)', policy: 'B', seed: 11 })
    expect(cloned.ok).toBe(true)
    const id = cloned.ok ? cloned.value.id : ''
    const loaded = await loadSimulation(id)
    expect(loaded.ok && loaded.value.summary).toMatchObject({ policy: 'B', status: 'ready', simTime: 0, clonedFromId: source, autoRun: null })
    expect(loaded.ok && loaded.value.definition.seed).toBe(11)
    expect(loaded.ok && loaded.value.definition.roster).toEqual((await loadSimulation(source)).ok ? ((await loadSimulation(source)) as { ok: true; value: LoadedSimulation }).value.definition.roster : null)
    expect(loaded.ok && loaded.value.state.queue.items.filter((i) => i.time === 5)).toHaveLength(0)
    const rows = await prisma.simulationJournalEntry.findMany({ where: { simulationId: id } })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload).toMatchObject({ op: 'created', clonedFrom: source, policy: 'B', seed: 11 })
  })
  it('refuses an unknown source, a duplicate name, an empty name and a non-integer seed', async () => {
    const source = await create('src')
    expect((await cloneSimulation('00000000-0000-4000-8000-00000000dead', { name: 'x', policy: 'A' })).ok).toBe(false)
    const dup = await cloneSimulation(source, { name: 'src', policy: 'B' })
    expect(dup.ok === false && dup.error).toEqual({ kind: 'duplicate_name', name: 'src' })
    expect((await cloneSimulation(source, { name: '  ', policy: 'B' })).ok).toBe(false)
    expect((await cloneSimulation(source, { name: 'y', policy: 'B', seed: 1.5 })).ok).toBe(false)
  })
})
```
Route test (`sim-routes.test.ts`): `POST clone` with `{ name: 'demo (B)', policy: 'B' }` → 200 `{ ok: true, id }` and the new row's `clonedFromId` equals the source; a bad body → 400; unknown id → 404.
Page test (`simulation-page.test.tsx`): clicking `sim-clone-open` shows `sim-clone-drawer` with name prefilled `${name} (B)` when the source policy is A (else `(A)`), policy select defaulting to the OTHER policy, seed prefilled with the source seed... the snapshot does not carry the seed — prefill `1`; submitting posts `/api/sim/s1/clone` with `{ name, policy, seed }` and `router.push('/sim/<id>')` on `{ ok: true, id }`; a 409 shows `sim-clone-error`.
Cards test (`simulations-page.test.tsx`): a card whose summary has `clonedFromId: 's0'` and `clonedFromName: 'Q3 plan'` shows `clone of Q3 plan`.

- [ ] **Step 2: Run to verify they fail** — `npx vitest run packages/simulation/test/trade` then `packages/control/test/integration/simulation.test.ts` (one at a time) → FAIL on the new cases.

- [ ] **Step 3: Implement**

`definition.ts`:
```ts
/** A clone shares the world, not the history (M30 §2.3): every frozen field copied, only the
 *  policy and the seed replaced. Deep-copied through JSON so a clone never aliases its source. */
export function cloneDefinition(definition: TradeSimulationDefinition, over: { readonly policy: TradePolicy; readonly seed: number }): TradeSimulationDefinition {
  const copy = JSON.parse(JSON.stringify(definition)) as TradeSimulationDefinition
  return tradeSimulationDefinitionSchema.parse({ ...copy, policy: over.policy, seed: over.seed }) as TradeSimulationDefinition
}
```
`model.ts` labels: `delivery` → `purchase === undefined ? 'unknown_purchase' : 'already_delivered'` (keep `before_expected_day`); `payment_due` → `purchase === undefined ? 'unknown_purchase' : 'already_paid'`; `collection` stays `unknown_order`.
`write.ts`:
```ts
export async function cloneSimulation(
  sourceId: string,
  input: { readonly name: string; readonly policy: 'A' | 'B'; readonly seed?: number },
  principal?: Principal,
): Promise<Result<{ readonly id: string }, ControlRefusal>> {
  if (input.name.trim() === '') return err({ kind: 'invalid_simulation_input', detail: 'name must not be empty' })
  if (input.seed !== undefined && !Number.isInteger(input.seed)) return err({ kind: 'invalid_simulation_input', detail: 'seed must be an integer' })
  const source = await loadSimulation(sourceId)
  if (!source.ok) return source
  const seed = input.seed ?? source.value.definition.seed
  const definition = cloneDefinition(source.value.definition, { policy: input.policy, seed })
  const state = tradeInitialEngineState(definition)
  try {
    const row = await prisma.simulationRun.create({
      data: {
        companyId: source.value.summary.companyId, name: input.name.trim(), sector: 'trade', mode: 'simulation', decisionProvider: 'rules', seed,
        definition: json(definition), state: json(state), clonedFromId: sourceId, createdByUserId: principal?.userId ?? null,
        journal: { create: { seq: 0, simTime: 0, kind: 'control', actorRole: null, payload: { op: 'created', policy: input.policy, seed, synthetic: true, clonedFrom: sourceId } } },
      },
    })
    return ok({ id: row.id })
  } catch (error) {
    if (isUniqueConstraintViolation(error)) return err({ kind: 'duplicate_name', name: input.name.trim() })
    throw error
  }
}
```
Route `clone/route.ts`: zod `{ name: z.string().min(1), policy: z.enum(['A','B']), seed: z.number().int().optional() }`, `requirePrincipal`, `simControlResponse(() => cloneSimulation(simulationId, { name, policy, ...(seed !== undefined ? { seed } : {}) }, gate.principal ?? undefined))`.
Snapshot/cards: `SimulationSummary` already carries `clonedFromId`; `listSimulations` and `readSimulation` resolve `clonedFromName` by including `clonedFrom: { select: { name: true } }` on the row query (add to `Row`'s include and `summarize`: `clonedFromName: row.clonedFrom?.name ?? null`).
`CloneDrawer.tsx`: the `NewSimulationDrawer` shell (scrim, `aside role="dialog" aria-label="Clone simulation"`, Escape when not pending) with name/policy/seed fields and the copy "same scenario, same roster, same start — a different policy or seed; nothing that happened in the source is carried over"; on success `onClose()` then `router.push(`/sim/${id}`)`. `SimulationClient`: `<GhostButton data-testid="sim-clone-open">Clone…</GhostButton>` in the control bar, drawer mounted with `sourceName`, `sourcePolicy`. `SimulationsClient` card: `{card.clonedFromName !== null && <div className="text-xs text-text-3">clone of {card.clonedFromName}</div>}`.

- [ ] **Step 4: Green, typecheck, build, commit**

Run the four test files one at a time, `npm run --silent typecheck`, `npm run web:build` (no dev server), `node scripts/gate-m26-vocabulary.mjs`.
```bash
git add packages/simulation packages/control apps/web
git commit -m "feat(simulation,control,web): m30 t2 — clone a run from its frozen definition (policy/seed only), the clone drawer, honest ignored labels"
```

---

### Task 3: Auto-run — `startAutoRun`, `stopAutoRun`, `autoStepDue`, `tickSimulations`, the daemon and CLI `tick`

**Files:**
- Modify: `packages/control/src/simulation/auto-run.ts`
- Modify: `apps/orchestrator/src/daemon.ts` (coalescer work function), `apps/orchestrator/src/cli.ts` (`case 'tick'`)
- Create: `apps/web/src/app/api/sim/[simulationId]/auto-run/route.ts`, `apps/web/src/app/api/sim/[simulationId]/auto-run/stop/route.ts`
- Test: `packages/control/test/integration/auto-run.test.ts` (new), `apps/orchestrator/test/integration/cli.test.ts` (`tick` prints the counts), `apps/web/test/integration/sim-routes.test.ts` (+2 routes)

**Interfaces:**
- Consumes: Task 1's `locked`, `stepLocked`, `clearAutoRun`, `Row`, `LoadedSimulation`.
- Produces:
```ts
export const AUTO_RUN_MIN_MS = 250; export const AUTO_RUN_MAX_MS = 3_600_000; export const TICK_SIMULATIONS_CAP = 50
export function startAutoRun(id: string, input: { everyMs: number; untilDay: number }, principal?): Promise<Result<void, ControlRefusal>>
export function stopAutoRun(id: string, reason?: 'operator', principal?): Promise<Result<void, ControlRefusal>>
export type AutoStepOutcome = { stepped: true; day: number } | { stepped: false; reason: 'no_intent' | 'not_running' | 'not_due' | 'until_day' }
export function autoStepDue(id: string, now: Date): Promise<Result<AutoStepOutcome, ControlRefusal>>
export function tickSimulations(input: { now: Date }): Promise<{ candidates: number; stepped: number; halted: number }>
```
Routes: `POST /api/sim/[id]/auto-run` `{ everyMs, untilDay }`, `POST /api/sim/[id]/auto-run/stop`.

- [ ] **Step 1: Failing tests**

`packages/control/test/integration/auto-run.test.ts` (same `seedTradingCompany`/`beforeEach`/`afterAll`/`create` helpers as `simulation.test.ts` — copy them; TRUNCATE list identical):
```ts
import { autoStepDue, haltSimulation, loadSimulation, pauseSimulation, startAutoRun, stepSimulation, stopAutoRun, tickSimulations } from '../../src/simulation.js'

const T0 = new Date('2026-09-06T10:00:00Z')
const plus = (ms: number): Date => new Date(T0.getTime() + ms)
async function controlOps(id: string): Promise<readonly string[]> {
  const rows = await prisma.simulationJournalEntry.findMany({ where: { simulationId: id, kind: 'control' }, orderBy: { seq: 'asc' } })
  return rows.map((r) => String((r.payload as { op: string }).op))
}

describe('startAutoRun / stopAutoRun', () => {
  it('validates, flips ready → running, writes the intent, journals; stop clears and journals; stop is idempotent', async () => {
    const id = await create()
    expect((await startAutoRun(id, { everyMs: 100, untilDay: 10 })).ok).toBe(false)
    expect((await startAutoRun(id, { everyMs: 1000, untilDay: 0 })).ok).toBe(false)
    expect((await startAutoRun(id, { everyMs: 1000, untilDay: 31 })).ok).toBe(false)
    expect((await startAutoRun(id, { everyMs: 1000, untilDay: 10 })).ok).toBe(true)
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ status: 'running', autoRunEveryMs: 1000, autoRunUntilDay: 10, lastAutoStepAt: null })
    expect((await loadSimulation(id)).ok && (await loadSimulation(id) as { ok: true; value: { summary: { autoRun: unknown } } }).value.summary.autoRun).toEqual({ everyMs: 1000, untilDay: 10, lastStepAt: null })
    expect((await stopAutoRun(id)).ok).toBe(true)
    expect((await stopAutoRun(id)).ok).toBe(true)
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).autoRunEveryMs).toBeNull()
    expect(await controlOps(id)).toEqual(['created', 'auto_run_started', 'auto_run_stopped'])
  })
  it('pause and halt clear the intent with their reason; a finished run clears it with finished', async () => {
    const a = await create('a')
    await startAutoRun(a, { everyMs: 1000, untilDay: 10 })
    await pauseSimulation(a)
    expect((await controlOps(a)).at(-1)).toBe('auto_run_stopped')
    expect((await prisma.simulationJournalEntry.findFirst({ where: { simulationId: a, kind: 'control' }, orderBy: { seq: 'desc' } }))?.payload).toMatchObject({ reason: 'paused' })
    const b = await create('b')
    await startAutoRun(b, { everyMs: 1000, untilDay: 10 })
    await haltSimulation(b, 'op')
    expect((await prisma.simulationJournalEntry.findFirst({ where: { simulationId: b, kind: 'control' }, orderBy: { seq: 'desc' } }))?.payload).toMatchObject({ op: 'auto_run_stopped', reason: 'halted' })
    const c = await create('c')
    await startAutoRun(c, { everyMs: 1000, untilDay: 30 })
    await stepSimulation(c, { untilDay: 30 })
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id: c } })).autoRunEveryMs).toBeNull()
    expect((await prisma.simulationJournalEntry.findFirst({ where: { simulationId: c, kind: 'control' }, orderBy: { seq: 'desc' } }))?.payload).toMatchObject({ op: 'auto_run_stopped', reason: 'finished' })
  })
})

describe('autoStepDue', () => {
  it('steps once when due, refuses when not due, stops at untilDay', async () => {
    const id = await create()
    expect((await autoStepDue(id, T0)).ok && (await autoStepDue(id, T0) as { ok: true; value: { reason?: string } }).value.reason).toBe('no_intent')
    await startAutoRun(id, { everyMs: 1000, untilDay: 2 })
    const first = await autoStepDue(id, T0)
    expect(first.ok && first.value).toEqual({ stepped: true, day: 1 })
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).lastAutoStepAt?.toISOString()).toBe(T0.toISOString())
    const early = await autoStepDue(id, plus(500))
    expect(early.ok && early.value).toEqual({ stepped: false, reason: 'not_due' })
    const second = await autoStepDue(id, plus(1000))
    expect(second.ok && second.value).toEqual({ stepped: true, day: 2 })
    const done = await autoStepDue(id, plus(2000))
    expect(done.ok && done.value).toEqual({ stepped: false, reason: 'until_day' })
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ simTime: 2, status: 'running', autoRunEveryMs: null })
    expect((await controlOps(id)).at(-1)).toBe('auto_run_stopped')
    await pauseSimulation(id)
    await startAutoRun(id, { everyMs: 1000, untilDay: 5 }).catch(() => undefined)
    expect((await autoStepDue(id, plus(3000))).ok && (await autoStepDue(id, plus(3000)) as { ok: true; value: { reason?: string } }).value.reason).toBe('not_running')
  })
})

describe('tickSimulations', () => {
  it('steps every due run once, skips the rest, and never double-steps under two concurrent passes', async () => {
    const a = await create('a')
    const b = await create('b')
    const c = await create('c')
    await startAutoRun(a, { everyMs: 250, untilDay: 30 })
    await startAutoRun(b, { everyMs: 250, untilDay: 30 })
    await startAutoRun(c, { everyMs: 250, untilDay: 30 })
    await pauseSimulation(c)
    const first = await tickSimulations({ now: T0 })
    expect(first).toEqual({ candidates: 2, stepped: 2, halted: 0 })
    const [x, y] = await Promise.all([tickSimulations({ now: plus(250) }), tickSimulations({ now: plus(250) })])
    expect(x.stepped + y.stepped).toBe(2)
    for (const id of [a, b]) {
      const days = (await prisma.simulationJournalEntry.findMany({ where: { simulationId: id, kind: 'control' }, orderBy: { seq: 'asc' } }))
        .map((r) => r.payload as { op: string; day?: number }).filter((p) => p.op === 'stepped').map((p) => p.day)
      expect(days).toEqual([1, 2])
    }
  })
  it('halts a run whose step throws, with the error in the reason, and keeps ticking the others', async () => {
    const good = await create('good')
    const bad = await create('bad')
    await startAutoRun(good, { everyMs: 250, untilDay: 30 })
    await startAutoRun(bad, { everyMs: 250, untilDay: 30 })
    // Force a step failure without touching the engine: a state row `engineStateSchema` rejects
    // (`simulation_corrupt` from `autoStepDue`), which `tickSimulations` treats exactly like a
    // thrown step -- halt the run with the refusal text and move on to the next run.
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id: bad } })
    const state = row.state as { sector: { suppliers: { unitPriceMinor: unknown }[] } }
    state.sector.suppliers[0]!.unitPriceMinor = 'x'
    await prisma.simulationRun.update({ where: { id: bad }, data: { state: state as object } })
    const report = await tickSimulations({ now: T0 })
    expect(report.stepped).toBe(1)
    expect(report.halted).toBe(1)
    const halted = await prisma.simulationRun.findUniqueOrThrow({ where: { id: bad } })
    expect(halted.status).toBe('halted')
    expect(halted.haltedReason).toMatch(/^auto-run step failed: /)
    expect(halted.autoRunEveryMs).toBeNull()
  })
})
```
The contract under test: `tickSimulations` halts a run when `autoStepDue` throws OR returns a refusal other than `simulation_not_found`, and continues with the next run. Note `haltSimulation` on the corrupt row also goes through `locked()` → `parseRow`, which refuses `simulation_corrupt` again — so `tickSimulations`'s halt path must NOT depend on parsing the state: write the halt with a direct `prisma.simulationRun.update({ where: { id }, data: { status: 'halted', haltedReason, autoRunEveryMs: null, autoRunUntilDay: null, lastAutoStepAt: null } })` plus a journal `control { op: 'halted', reason }` row whose `seq` is `max(seq) + 1` from a `findFirst({ orderBy: { seq: 'desc' } })`, in one transaction (a private `haltUnparsed(id, reason)` in `auto-run.ts`). Use it for both the refusal and the throw path.

CLI test (`cli.test.ts`, inside the `simulations (M29)` describe): after creating and `auto-run-simulation --simulation <id> --every-ms 250 --until-day 3`, run `tick --workspace <fixture.workspaceId>` twice with a 300 ms gap and assert the second output contains `"simulations": { "candidates": 1, "stepped": 1, "halted": 0 }` and the run's `simTime` is 2 — the `auto-run-simulation` verb itself is Task 6; for THIS task call `startAutoRun` directly through prisma-free control import in the test file (the CLI test already imports control verbs? If not, import `startAutoRun` from `@slave-of-ai/control`).

Route tests: `POST auto-run` `{ everyMs: 1000, untilDay: 10 }` → 200 and the row has the intent; `{ everyMs: 10 }` → 400 (schema) ; `POST auto-run/stop` → 200.

- [ ] **Step 2: Run to verify they fail** (one file at a time).

- [ ] **Step 3: Implement**

`auto-run.ts` additions:
```ts
import { prisma } from '@slave-of-ai/db/client'
import { err, ok, type Result } from '@slave-of-ai/domain'
import type { Principal } from '../principal.js'
import type { ControlRefusal } from '../refusal.js'
import { refusalText } from '../refusal.js'
import { clearAutoRun, json, locked } from './shared.js'
import { haltSimulation, stepLocked } from './write.js'

export const AUTO_RUN_MIN_MS = 250
export const AUTO_RUN_MAX_MS = 3_600_000
/** One daemon pass steps at most this many runs; the rest wait for the next tick. */
export const TICK_SIMULATIONS_CAP = 50

export async function startAutoRun(simulationId: string, input: { readonly everyMs: number; readonly untilDay: number }, _principal?: Principal): Promise<Result<void, ControlRefusal>> {
  if (!Number.isInteger(input.everyMs) || input.everyMs < AUTO_RUN_MIN_MS || input.everyMs > AUTO_RUN_MAX_MS) return err({ kind: 'invalid_simulation_input', detail: `everyMs must be an integer between ${AUTO_RUN_MIN_MS} and ${AUTO_RUN_MAX_MS}` })
  return prisma.$transaction(async (tx) => {
    const got = await locked(tx, simulationId)
    if (!got.ok) return got
    const { row, loaded } = got.value
    if (row.status !== 'ready' && row.status !== 'running') return err({ kind: 'simulation_not_runnable', simulationId, status: row.status })
    if (!Number.isInteger(input.untilDay) || input.untilDay <= row.simTime || input.untilDay > loaded.definition.horizonDays) return err({ kind: 'invalid_simulation_input', detail: `untilDay must be an integer greater than the current day (${row.simTime}) and at most the horizon (${loaded.definition.horizonDays})` })
    const seq = loaded.state.journalSeq + 1
    await tx.simulationJournalEntry.create({ data: { simulationId, seq, simTime: row.simTime, kind: 'control', actorRole: null, payload: { op: 'auto_run_started', everyMs: input.everyMs, untilDay: input.untilDay } } })
    await tx.simulationRun.update({ where: { id: simulationId }, data: { status: 'running', autoRunEveryMs: input.everyMs, autoRunUntilDay: input.untilDay, lastAutoStepAt: null, state: json({ ...loaded.state, journalSeq: seq, status: 'running' }) } })
    return ok(undefined)
  })
}

export async function stopAutoRun(simulationId: string, reason: 'operator' | 'until_day' = 'operator', _principal?: Principal): Promise<Result<void, ControlRefusal>> {
  return prisma.$transaction(async (tx) => {
    const got = await locked(tx, simulationId)
    if (!got.ok) return got
    const { row, loaded } = got.value
    if (row.autoRunEveryMs === null) return ok(undefined)
    const seq = await clearAutoRun(tx, row, loaded, reason, loaded.state.journalSeq + 1)
    await tx.simulationRun.update({ where: { id: simulationId }, data: { autoRunEveryMs: null, autoRunUntilDay: null, lastAutoStepAt: null, state: json({ ...loaded.state, journalSeq: seq }) } })
    return ok(undefined)
  })
}

export type AutoStepOutcome = { readonly stepped: true; readonly day: number } | { readonly stepped: false; readonly reason: 'no_intent' | 'not_running' | 'not_due' | 'until_day' }

/** The daemon's verb (spec §2.2): "due" is decided under the row lock from the row's own
 *  watermark, so a second daemon or a click racing this pass finds either the new watermark or
 *  the lock — never a second step for the same tick. */
export async function autoStepDue(simulationId: string, now: Date): Promise<Result<AutoStepOutcome, ControlRefusal>> {
  return prisma.$transaction(async (tx) => {
    const got = await locked(tx, simulationId)
    if (!got.ok) return got
    const { row, loaded } = got.value
    if (row.autoRunEveryMs === null || row.autoRunUntilDay === null) return ok({ stepped: false, reason: 'no_intent' } as const)
    if (row.status !== 'running') return ok({ stepped: false, reason: 'not_running' } as const)
    if (row.lastAutoStepAt !== null && row.lastAutoStepAt.getTime() + row.autoRunEveryMs > now.getTime()) return ok({ stepped: false, reason: 'not_due' } as const)
    if (row.simTime >= row.autoRunUntilDay) {
      const seq = await clearAutoRun(tx, row, loaded, 'until_day', loaded.state.journalSeq + 1)
      await tx.simulationRun.update({ where: { id: simulationId }, data: { autoRunEveryMs: null, autoRunUntilDay: null, lastAutoStepAt: null, state: json({ ...loaded.state, journalSeq: seq }) } })
      return ok({ stepped: false, reason: 'until_day' } as const)
    }
    const outcome = await stepLocked(tx, row, loaded, { untilDay: row.simTime + 1, lastAutoStepAt: now })
    return ok({ stepped: true, day: outcome.day } as const)
  }, { timeout: 60_000, maxWait: 10_000 })
}

/** One global pass (spec §5): every running run with an intent, in creation order, capped. A
 *  step that throws or refuses (anything but not-found) halts that run with the message and the
 *  pass moves on — an auto-run never retries forever. */
export async function tickSimulations(input: { readonly now: Date }): Promise<{ readonly candidates: number; readonly stepped: number; readonly halted: number }> {
  const rows = await prisma.simulationRun.findMany({ where: { autoRunEveryMs: { not: null }, status: 'running' }, select: { id: true }, orderBy: { createdAt: 'asc' }, take: TICK_SIMULATIONS_CAP })
  let stepped = 0
  let halted = 0
  for (const { id } of rows) {
    try {
      const result = await autoStepDue(id, input.now)
      if (result.ok) {
        if (result.value.stepped) stepped += 1
        continue
      }
      if (result.error.kind === 'simulation_not_found') continue
      await haltSimulation(id, `auto-run step failed: ${refusalText(result.error)}`)
      halted += 1
    } catch (error) {
      await haltSimulation(id, `auto-run step failed: ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined)
      halted += 1
    }
  }
  return { candidates: rows.length, stepped, halted }
}
```
(note `haltSimulation` for a `halted`/`finished` row refuses — `.catch` covers the throw path and the refusal is ignored: a run that is no longer running needs no halt.)

`daemon.ts` — in the coalescer's work function, after the `tick` report block and before `sweep`:
```ts
      // M30 §5: auto-run stepping is a global pass, not part of `tick()` -- simulations belong to
      // a company, not to this daemon's workspace, and `decide()` stays pure (ADR 0004). Two
      // daemons both running this pass is safe: `autoStepDue` decides "due" under the row lock.
      const sims = await tickSimulations({ now: new Date() })
      if (sims.stepped > 0 || sims.halted > 0) process.stdout.write(`${JSON.stringify({ simulations: sims })}\n`)
```
`cli.ts` `case 'tick'`: after the workspace `tick`, `const simulations = await tickSimulations({ now: new Date() })` and print `{ ...report, simulations }`.

Routes: `auto-run/route.ts` zod `{ everyMs: z.number().int().min(250).max(3_600_000), untilDay: z.number().int().positive() }` → `startAutoRun`; `auto-run/stop/route.ts` no body → `stopAutoRun(id)`.

- [ ] **Step 4: Green, typecheck, commit**

Run the three test files one at a time, `npm run --silent typecheck`.
```bash
git add packages/control apps/orchestrator apps/web
git commit -m "feat(control,orchestrator,web): m30 t3 — auto-run intent, autoStepDue under the row lock, tickSimulations in the daemon and the CLI tick"
```

---

### Task 4: The live page — SSE on `version`, the stream hook, auto-run controls, strip and cards

**Files:**
- Create: `apps/web/src/server/simulationEvents.ts`, `apps/web/src/app/api/sim/[simulationId]/events/route.ts`, `apps/web/src/hooks/useSimulationStream.ts`, `apps/web/src/components/sim/AutoRunControls.tsx`
- Modify: `apps/web/src/components/sim/SimulationStrip.tsx` (connection + auto-run chip), `SimulationClient.tsx` (hook + controls), `SimulationsClient.tsx` (`auto-run` chip)
- Test: `apps/web/test/integration/sim-events.test.ts` (new), `apps/web/test/use-simulation-stream.test.tsx` (new), `apps/web/test/simulation-page.test.tsx` (+auto-run controls, live badge), `apps/web/test/simulations-page.test.tsx` (+chip)

**Interfaces:**
- Produces: `createSimulationSse({ simulationId, pollMs = 1000, heartbeatMs = 15_000 }): Promise<Response>` (404 when the run does not exist at open); `useSimulationStream(simulationId, initialVersion): { version: number; connection: 'connected' | 'reconnecting' }`; `AutoRunControls({ summary, onStart(everyMs, untilDay), onStop, pending })` with testids `sim-auto-run-every`, `sim-auto-run-until`, `sim-auto-run-start`, `sim-auto-run-stop`; strip testids `sim-live`, `sim-auto-run-chip`.

- [ ] **Step 1: Failing tests**

`apps/web/test/integration/sim-events.test.ts` (DB; seed a run; read the SSE body with a `ReadableStreamDefaultReader` and a `TextDecoder`):
```ts
it('emits the version on open, again when a step bumps it, heartbeats, and 404s an unknown id', async () => {
  const id = await create()
  const response = await createSimulationSse({ simulationId: id, pollMs: 50, heartbeatMs: 120 })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const reader = response.body!.getReader()
  const read = async (): Promise<string> => new TextDecoder().decode((await reader.read()).value)
  expect(await read()).toContain('"version":0')
  await stepSimulation(id, { steps: 1 })
  let seen = ''
  for (let i = 0; i < 10 && !seen.includes('"version":1'); i++) seen += await read()
  expect(seen).toContain('"version":1')
  expect(seen).toContain('"simTime":1')
  let beat = ''
  for (let i = 0; i < 10 && !beat.includes(': heartbeat'); i++) beat += await read()
  expect(beat).toContain(': heartbeat')
  await reader.cancel()
  expect((await createSimulationSse({ simulationId: '00000000-0000-4000-8000-00000000dead' })).status).toBe(404)
})
```
`use-simulation-stream.test.tsx` (jsdom; stub `EventSource` with a class that records instances and lets the test fire `onopen`/`onmessage`/`onerror`): the hook returns `{ version: 3, connection: 'connected' }` initially; a message `{ version: 4, status: 'running', simTime: 4 }` → `version 4`; `onerror` → `reconnecting`, `onopen` → `connected`; unmount closes the source.
`simulation-page.test.tsx`: mock `../src/hooks/useSimulationStream` to return a controllable `{ version, connection }`; when the mock's version differs from `initial.summary.version`, `router.refresh` is called once; `sim-live` shows `● LIVE` / `● RECONNECTING`; `sim-auto-run-start` posts `/api/sim/s1/auto-run` `{ everyMs: 1000, untilDay: 30 }`; with `summary.autoRun` set, `sim-auto-run-stop` is shown and posts `/api/sim/s1/auto-run/stop`, the strip's `sim-auto-run-chip` reads `auto-run every 1 s → day 30`, and `sim-step` is disabled (a manual step during auto-run is refused by the UI, not the verb).
`simulations-page.test.tsx`: a card with `autoRun` set shows the `auto-run` chip.

- [ ] **Step 2: Run to verify they fail** (one file at a time).

- [ ] **Step 3: Implement**

`simulationEvents.ts`:
```ts
import { prisma } from '@slave-of-ai/db/client'

/** The simulation page's live signal (M30 §6): a poll of the run's own `version` by primary key,
 *  emitted over SSE when it changes. Not the event log's stream -- the journal is a different
 *  table with no `pg_notify`, and a one-row read a second is honest and cheap. */
export async function createSimulationSse(options: { readonly simulationId: string; readonly pollMs?: number; readonly heartbeatMs?: number }): Promise<Response> {
  const pollMs = options.pollMs ?? 1000
  const heartbeatMs = options.heartbeatMs ?? 15_000
  const select = { version: true, status: true, simTime: true } as const
  const first = await prisma.simulationRun.findUnique({ where: { id: options.simulationId }, select })
  if (first === null) return new Response('no such simulation', { status: 404 })
  const encoder = new TextEncoder()
  let lastVersion = -1
  let poll: ReturnType<typeof setInterval> | null = null
  let beat: ReturnType<typeof setInterval> | null = null
  let closed = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (row: { version: number; status: string; simTime: number }): void => {
        if (closed || row.version === lastVersion) return
        lastVersion = row.version
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(row)}\n\n`))
      }
      emit(first)
      poll = setInterval((): void => {
        void prisma.simulationRun.findUnique({ where: { id: options.simulationId }, select }).then((row) => { if (row !== null) emit(row) }).catch(() => undefined)
      }, pollMs)
      beat = setInterval((): void => { if (!closed) controller.enqueue(encoder.encode(': heartbeat\n\n')) }, heartbeatMs)
    },
    cancel() {
      closed = true
      if (poll !== null) clearInterval(poll)
      if (beat !== null) clearInterval(beat)
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' } })
}
```
`events/route.ts`: `export const dynamic = 'force-dynamic'`; `GET` → params → `createSimulationSse({ simulationId })` (no principal gate: the M29 GET snapshot route has one — mirror it: `requirePrincipal` first, return its response on failure).
`useSimulationStream.ts`:
```ts
'use client'
import { useEffect, useState } from 'react'

/** Follows a run's `version` over `/api/sim/<id>/events`; the page refreshes when it moves. */
export function useSimulationStream(simulationId: string, initialVersion: number): { readonly version: number; readonly connection: 'connected' | 'reconnecting' } {
  const [version, setVersion] = useState(initialVersion)
  const [connection, setConnection] = useState<'connected' | 'reconnecting'>('connected')
  useEffect((): (() => void) => {
    const source = new EventSource(`/api/sim/${simulationId}/events`)
    source.onopen = (): void => setConnection('connected')
    source.onerror = (): void => setConnection('reconnecting')
    source.onmessage = (message: { data: string }): void => {
      try {
        const parsed = JSON.parse(message.data) as { version?: unknown }
        if (typeof parsed.version === 'number') setVersion(parsed.version)
      } catch { /* not ours to crash over */ }
    }
    return () => source.close()
  }, [simulationId])
  return { version, connection }
}
```
`SimulationClient.tsx`: `const stream = useSimulationStream(summary.id, summary.version); useEffect(() => { if (stream.version !== summary.version) router.refresh() }, [stream.version, summary.version, router])`; pass `connection={stream.connection}` to the strip; render `<AutoRunControls summary={summary} pending={pending} onStart={(everyMs, untilDay) => void call('auto-run', { everyMs, untilDay })} onStop={() => void call('auto-run/stop')} />`; `runnable` additionally requires `summary.autoRun === null` for Step / Run-to-day.
`AutoRunControls.tsx`: when `summary.autoRun === null` and status ∈ {ready, running}: a `SelectField` (`250`, `1000`, `5000`; default `1000`; testid `sim-auto-run-every`), a `TextField` until day (default `horizonDays`; testid `sim-auto-run-until`), `PrimaryButton` `Auto-run` (`sim-auto-run-start`); when set: `GhostButton` `Stop auto-run` (`sim-auto-run-stop`). Copy: "steps one day every N at the daemon's pace; needs `npm run orchestrator -- daemon` running".
`SimulationStrip.tsx`: props `connection?: 'connected' | 'reconnecting'` → `<span data-testid="sim-live" className={connection === 'connected' ? 'text-[#4ade80]' : 'text-[#f5b34a]'}>{connection === 'connected' ? '● LIVE' : '● RECONNECTING'}</span>` (only when the prop is given); `summary.autoRun !== null` → `<Chip tone="working"><span data-testid="sim-auto-run-chip">auto-run every {ms} → day {untilDay}</span></Chip>` with `ms` formatted `250 ms` / `1 s` / `5 s`.
Cards: `card.autoRun !== null && <Chip tone="working">auto-run</Chip>`.

- [ ] **Step 4: Green, typecheck, build, commit**

Run the four test files one at a time; `npm run --silent typecheck`; `npm run web:build`.
```bash
git add apps/web
git commit -m "feat(web): m30 t4 — the live simulation page: version SSE, the stream hook, auto-run controls, strip and card chips"
```

---

### Task 5: Compare — control read, route, page, CLI

**Files:**
- Modify: `packages/control/src/simulation/read.ts` (+ `compareSimulations`)
- Modify: `apps/web/src/server/simulation.ts` (+ `buildComparison`, + `listCompareCandidates(simulationId)`)
- Create: `apps/web/src/app/api/sim/compare/route.ts`, `apps/web/src/app/sim/compare/page.tsx`, `apps/web/src/components/sim/CompareClient.tsx`
- Modify: `apps/web/src/components/sim/SimulationClient.tsx` (**Compare with…** select → navigates), `apps/orchestrator/src/cli.ts` (`compare-simulations`)
- Test: `packages/control/test/integration/simulation.test.ts` (+compare describe), `apps/web/test/integration/sim-routes.test.ts` (+GET compare), `apps/web/test/compare-page.test.tsx` (new), `apps/orchestrator/test/integration/cli.test.ts` (+compare)

**Interfaces:**
- Produces:
```ts
export interface SimulationComparison {
  readonly a: { summary: SimulationSummary; metrics: TradeMetrics; injected: number }
  readonly b: { summary: SimulationSummary; metrics: TradeMetrics; injected: number }
  readonly deltas: Readonly<Record<'deliveredQty' | 'onTimeQty' | 'lateDays' | 'purchaseCostMinor' | 'closingInventory' | 'closingCashMinor' | 'minCashMinor' | 'collectedMinor' | 'unpaidCommitmentsMinor', number>>  // b − a
  readonly definitionsMatch: boolean
  readonly differences: readonly string[]   // top-level keys among roster, roles, initial, scenario, currency, horizonDays, limits that differ
  readonly currency: string
}
export function compareSimulations(aId: string, bId: string): Promise<Result<SimulationComparison, ControlRefusal>>
```
`GET /api/sim/compare?a=&b=` → the comparison JSON (400 missing params, 404 unknown, 409 same id / different sector). Page `/sim/compare?a=&b=` with testids `sim-compare-strip`, `sim-compare-warning`, `sim-compare-row-<metric>`, `sim-compare-delta-<metric>`, `sim-compare-footer`. `SimulationClient` testid `sim-compare-with` (a `<select>` of the same company's other trade runs; choosing one navigates). CLI `compare-simulations --a <id> --b <id>` prints the JSON.

- [ ] **Step 1: Failing tests**

Control (`simulation.test.ts`):
```ts
describe('compareSimulations', () => {
  it('reports both metric sets, b − a deltas, definitionsMatch for a clone pair, and injected counts', async () => {
    const a = await create('a', 'A')
    const cloned = await cloneSimulation(a, { name: 'b', policy: 'B' })
    const b = cloned.ok ? cloned.value.id : ''
    await stepSimulation(a, { untilDay: 30 })
    await stepSimulation(b, { untilDay: 30 })
    const result = await compareSimulations(a, b)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.definitionsMatch).toBe(true)
    expect(result.value.differences).toEqual([])
    expect(result.value.deltas.purchaseCostMinor).toBe(725_000 - 300_000)
    expect(result.value.deltas.lateDays).toBe(0 - 4)
    expect(result.value.deltas.closingInventory).toBe(50)
    expect(result.value.a.injected).toBe(0)
    expect(result.value.currency).toBe('USD')
  })
  it('flags a differing world and counts injected events; refuses the same id', async () => {
    const a = await create('a', 'A')
    const b = await create('b', 'B')
    await injectExternalEvent(b, { day: 2, event: { type: 'supplier_delay', supplierId: 'fast', extraDays: 1 } })
    await prisma.simulationRun.update({ where: { id: b }, data: { definition: { ...((await prisma.simulationRun.findUniqueOrThrow({ where: { id: b } })).definition as object), initial: { cashMinor: 1, inventory: 100, dailyShipCapacity: 30, suppliers: [{ id: 'normal', name: 'Normal Supply', unitPriceMinor: 6_000, leadDays: 7, paymentTermDays: 30 }, { id: 'fast', name: 'Fast Supply', unitPriceMinor: 8_500, leadDays: 2, paymentTermDays: 0 }] } } as object } })
    const result = await compareSimulations(a, b)
    expect(result.ok && result.value.definitionsMatch).toBe(false)
    expect(result.ok && result.value.differences).toEqual(['initial'])
    expect(result.ok && result.value.b.injected).toBe(1)
    const same = await compareSimulations(a, a)
    expect(same.ok === false && same.error.kind).toBe('invalid_simulation_input')
    expect((await compareSimulations(a, '00000000-0000-4000-8000-00000000dead')).ok).toBe(false)
  })
})
```
Route: `GET /api/sim/compare?a=<a>&b=<b>` → 200 with `definitionsMatch`; missing `b` → 400; unknown → 404; `a === b` → 409.
Page (`compare-page.test.tsx`, jsdom, renders `CompareClient` with a fixture comparison): strip names both runs and says `SIMULATION`; no warning when `definitionsMatch` and both `injected === 0`; warning lists `differences` and "b has 1 injected event" otherwise; each metric row shows A, B, Δ with money via `formatMinor` and a sign (`+$4,250.00`, `−4` for late days); the footer text contains "no verdict".
CLI: `compare-simulations --a --b` → exit 0, JSON parses, `deltas.purchaseCostMinor === 425000` for an A/B clone pair stepped to 30 (create both through `create-simulation` + `clone-simulation`? `clone-simulation` is Task 6 — create B with `create-simulation --policy B`; the demo definitions are identical so `definitionsMatch` is true).

- [ ] **Step 2: Run to verify they fail** (one file at a time).

- [ ] **Step 3: Implement**

`read.ts`:
```ts
const COMPARED_KEYS = ['roster', 'roles', 'initial', 'scenario', 'currency', 'horizonDays', 'limits'] as const
const METRIC_KEYS = ['deliveredQty', 'onTimeQty', 'lateDays', 'purchaseCostMinor', 'closingInventory', 'closingCashMinor', 'minCashMinor', 'collectedMinor', 'unpaidCommitmentsMinor'] as const

/** Two runs side by side (spec §4): metrics, b − a deltas, and whether they lived in the same
 *  world (frozen definition minus policy and seed). Never a verdict. */
export async function compareSimulations(aId: string, bId: string): Promise<Result<SimulationComparison, ControlRefusal>> {
  if (aId === bId) return err({ kind: 'invalid_simulation_input', detail: 'compare two different runs' })
  return prisma.$transaction(async (tx) => {
    const sideOf = async (id: string) => {
      const loaded = await readSimulation(tx, id)
      if (!loaded.ok) return loaded
      const rows = await tx.simulationJournalEntry.findMany({ where: { simulationId: id }, orderBy: { seq: 'asc' } })
      const entries: JournalEntry[] = rows.map((r) => ({ seq: r.seq, simTime: r.simTime, kind: r.kind, actorRole: r.actorRole, payload: r.payload as Record<string, unknown> }))
      const injected = rows.filter((r) => r.kind === 'external_event' && (r.payload as { op?: string }).op === 'injected').length
      return ok({ loaded: loaded.value, metrics: tradeMetrics(entries, loaded.value.state.sector), injected })
    }
    const a = await sideOf(aId)
    if (!a.ok) return a
    const b = await sideOf(bId)
    if (!b.ok) return b
    if (a.value.loaded.summary.sector !== b.value.loaded.summary.sector) return err({ kind: 'invalid_simulation_input', detail: 'runs of different sectors cannot be compared' })
    const differences = COMPARED_KEYS.filter((key) => stableStringify(a.value.loaded.definition[key]) !== stableStringify(b.value.loaded.definition[key]))
    const deltas = Object.fromEntries(METRIC_KEYS.map((key) => [key, b.value.metrics[key] - a.value.metrics[key]])) as SimulationComparison['deltas']
    return ok({
      a: { summary: a.value.loaded.summary, metrics: a.value.metrics, injected: a.value.injected },
      b: { summary: b.value.loaded.summary, metrics: b.value.metrics, injected: b.value.injected },
      deltas, definitionsMatch: differences.length === 0, differences, currency: a.value.loaded.definition.currency,
    })
  }, { isolationLevel: 'RepeatableRead' })
}
```
(`stableStringify` moves to `shared.ts` in Task 1 and is exported there.) Web: `buildComparison(a, b)` wraps the verb and returns `null` on not-found, throws nothing; `listCompareCandidates(simulationId)` → other runs of the same company and sector `{ id, name, policy, status, simTime }`; the snapshot gains `compareCandidates`. Route `compare/route.ts`: `requirePrincipal`; `a`/`b` from `searchParams` (400 when missing); `simControlResponse` semantics but returning the comparison object on success (`Response.json(result.value)`); 404/409 via `refusalText`. Page `compare/page.tsx`: reads `searchParams`, `notFound()` when either is missing or unknown; renders `<CompareClient comparison={…} />`. `CompareClient.tsx`: the strip, the warning band, a `DataTable` with columns `metric · A · B · Δ`, money rows through `formatMinor` with an explicit sign on the delta, count rows with `+`/`−`, both `day n / horizon` lines, the footer "no verdict is computed; the delta is arithmetic". `SimulationClient`: `<SelectField label="compare with" selectProps={{ 'data-testid': 'sim-compare-with', onChange: (e) => { if (e.target.value !== '') router.push(`/sim/compare?a=${summary.id}&b=${e.target.value}`) } }}>` over `initial.compareCandidates`. CLI `compare-simulations`: `requireFlag(flags, 'a')`, `'b'`, `compareSimulations`, print JSON.

- [ ] **Step 4: Green, typecheck, build, commit**

```bash
git add packages/control apps/web apps/orchestrator
git commit -m "feat(control,web,cli): m30 t5 — compare two runs: metrics, b − a deltas, a same-world check, no verdict"
```

---

### Task 6: CLI parity, the gate, README, errata, full verification

**Files:**
- Modify: `apps/orchestrator/src/cli.ts` (help + `pause-simulation`, `resume-simulation`, `halt-simulation`, `inject-simulation-event`, `clone-simulation`, `auto-run-simulation`, `stop-auto-run`), `apps/orchestrator/test/integration/cli.test.ts`
- Create: `scripts/gate-m30-simulation-compare.mjs`
- Modify: `package.json` (`gate:m30-simulation-compare`), `.github/workflows/ci.yml` (after `gate:m29-simulation`), `README.md`, the spec's §15

- [ ] **Step 1: CLI verbs (test first)**

Help entries after `simulation-status`:
```
  pause-simulation --simulation <id>   pause: refuse every next step (clears auto-run)
  resume-simulation --simulation <id>  resume a paused simulation (auto-run is not restored)
  halt-simulation --simulation <id> [--reason <text>]
                                       the emergency stop for a simulation
  inject-simulation-event --simulation <id> --day <d> --event '<json>'
                                       add customer demand or a supplier delay on a future day
  clone-simulation --simulation <id> --name <n> --policy A|B [--seed <n>]
                                       a new run from this run's frozen scenario: same world,
                                       different policy or seed, day 0, nothing carried over
  auto-run-simulation --simulation <id> [--every-ms <n>] [--until-day <d>]
                                       let the daemon step it (default every 1000 ms to the horizon)
  stop-auto-run --simulation <id>
  compare-simulations --a <id> --b <id>
                                       both runs' metrics, b − a deltas and whether they share a
                                       world, as JSON — no verdict
```
Cases follow the M29 verbs' shape (`requireFlag`, `flagText`, `refusalText`, one stdout line). `inject-simulation-event` parses `--event` with `JSON.parse` in a try/catch → `--event must be JSON`; `--day` integer. `auto-run-simulation` defaults `everyMs 1000`, `untilDay = summary.horizonDays` (load the run first). Tests: one case per verb in the `simulations (M29)` describe (rename it `simulations`): pause → `simulation <id> paused`, resume, halt with reason, inject a `supplier_delay` (row's queue gains one item), clone (new row `clonedFromId`), auto-run (row has the intent) + stop (cleared), and `tick` prints the counts (moved here from Task 3 if it was not done there).

- [ ] **Step 2: The gate**

`scripts/gate-m30-simulation-compare.mjs`, borrowing `gate-m29-simulation.mjs`'s skeleton verbatim (dist imports, free port, `next dev`, Chromium, scratch dir, FK-ordered `finally`). Additionally spawn a REAL daemon: `node apps/orchestrator/dist/cli.js daemon --workspace <seed workspace> --period 250` with `loopbackChildEnv` + `DATABASE_URL`; keep its pid; kill it in `finally`. Stages:
1. Company `M30 Gate Trading` (four departments) via prisma.
2. `/sim` → create `gate A` (policy A, seed 5) through the drawer; on its page click `sim-clone-open`, name `gate B`, policy B → lands on B's page; prisma: `clonedFromId === A`, `simTime 0`.
3. On B: `sim-auto-run-every` = 250, `sim-auto-run-until` = 30, `sim-auto-run-start`; back to A's page, same; prisma: both rows have the intent.
4. Wait (poll prisma, ≤ 90 s) until both `status === 'finished'`; while waiting, at least once assert the page's `sim-company-day` advanced WITHOUT any click (the live stream); assert `sim-auto-run-chip` disappeared at the end.
5. Open `/sim/compare?a=<A>&b=<B>`: read every `sim-compare-delta-<metric>` and compare to `compareSimulations(A, B)` from `packages/control/dist` formatted through the same `Intl.NumberFormat`; assert no `sim-compare-warning`; assert the footer contains "no verdict".
6. Restart safety: clone A again as `gate C`, auto-run at 250 ms to day 30; after prisma shows `simTime ≥ 5`, `SIGTERM` the daemon, wait for exit, assert `simTime` stops moving for 1 s, start a new daemon, wait for `finished`; then from the journal assert the `stepped` control rows' `day` values are strictly increasing with no gap and no repeat (`[1..30]`).
7. `/w/<seed workspace>` renders its Overview with the slave-card count equal to prisma (the software flow untouched).
Teardown: kill daemons and next, delete the three runs, the company, close the browser.

- [ ] **Step 3: README and errata**

README: the Simulations table row gains "clone a run under another policy, let the daemon auto-run it, compare two runs side by side (no verdict)"; the CLI cheat sheet gains the eight verbs; the "Try a company simulation" section gains two sentences: with `npm run orchestrator -- daemon` running, **Auto-run** steps a run for you; **Clone…** then **Compare with…** puts the two policies side by side. Spec §15: R-entries from the ledger's `Ruling:` lines (in order, spec voice) and the M31 backlog.

- [ ] **Step 4: Full verification**

One at a time: `npm run --silent typecheck`; `npm test` (10-minute budget); `npm run web:build`; `npm run gate:m26-vocabulary`; `npm run gate:m11-shell`; `npm run gate:m29-simulation`; `npm run gate:m30-simulation-compare`. Paste each tail into the report.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator scripts package.json .github README.md docs
git commit -m "feat(cli),test(gates),docs: m30 t6 — CLI parity for every simulation control, gate:m30-simulation-compare with a real daemon and a kill-and-restart stage, README, errata"
```
