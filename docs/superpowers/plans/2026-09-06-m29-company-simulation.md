# M29 Company Simulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person can create a trade-company simulation from a company in the catalog, step it day by day under a rules-based decision provider, read every decision and rule outcome, and see metrics computed from the journal — with no Git, no model call, and no path from the simulated world to a real project, tool or dollar.

**Architecture:** A new pure package `@slave-of-ai/simulation` holds the engine (integer-day clock, deterministic priority queue, seeded RNG, action pipeline, journal, replay) and the first sector model (`trade`) plus the rules decision provider. `packages/control/src/simulation.ts` persists runs in three new tables (`SimulationRun`, `SimulationJournalEntry`, `SimulationModelUsage`) bound to `Company`, stepping inside one transaction with an optimistic version. `apps/web` gets `/sim` and `/sim/[id]`; the CLI gets three verbs. `Workspace` and the software flow are untouched.

**Tech Stack:** TypeScript (NodeNext, strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 3, Prisma 7 + Postgres, Next.js app router, vitest (unit / integration projects), playwright-core for the gate.

**Spec:** `docs/superpowers/specs/2026-09-06-m29-company-simulation-design.md`

## Global Constraints

- Node ≥ 26; every package is `"type": "module"`; imports inside a package use `.js` extensions.
- `packages/simulation` depends on `zod` only — never on `db`, `events`, `providers`, `control`, and never on `node:` modules.
- `packages/control/src/simulation.ts` imports `@slave-of-ai/db/client`, `@slave-of-ai/domain`, `@slave-of-ai/simulation`, its own refusal/principal modules — never `@slave-of-ai/providers`, never `node:child_process`, never `process.env`.
- `apps/web` writes only through `@slave-of-ai/control`; the software flow gains no `if (simulation)` anywhere; `/w/…` pages do not change.
- The noun is `slave` (vocabulary gate `npm run gate:m26-vocabulary` must stay green); user-facing words: project, department, slave, simulation.
- Money is integer minor units (`…Minor`), currency `USD` by default, rounding half-up at the minor unit; unknown real model cost is `null`, never `0`.
- One vitest run at a time; before claiming green run `npm run --silent typecheck` (not `tsc --build`) and `npm run web:build` (never while `next dev` is up).
- Migration is additive; `npm run db:migrate` and `npm run db:migrate:test` both apply it.
- Every commit ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_015LdvAE5MLjx54f8H1WJvLx`.
- No model call anywhere in this milestone: the demo, the tests and the gate run the `rules` provider only.

## File structure

```
packages/simulation/
  package.json, tsconfig.json, tsconfig.test.json
  src/index.ts                      barrel
  src/core/rng.ts                   nextRandom(state) — the only randomness, pure
  src/core/queue.ts                 EventQueue: enqueue / popDue with (time, priority, seq) order
  src/core/journal.ts               JournalEntry + kinds
  src/core/action.ts                ActionEnvelope schema + EngineRejection
  src/core/sector.ts                SectorModel<S, E, R> contract + RoleDefinition
  src/core/engine.ts                EngineState, initialEngineState, step, runUntil, replay
  src/decide/provider.ts            DecisionProvider + DecisionRequest
  src/decide/recorded.ts            RecordedDecisionProvider (replay)
  src/trade/state.ts                TradeState + Zod, initialTradeState
  src/trade/events.ts               TradeEvent union + Zod (external subset)
  src/trade/actions.ts              TradeAction union + Zod + TradeRejection
  src/trade/model.ts                the SectorModel for trade (observe/validate/apply/applyEvent/closeDay)
  src/trade/definition.ts           TradeSimulationDefinition + Zod + DEMO_SCENARIO + demoDefinition()
  src/trade/rules.ts                RulesDecisionProvider with policies A / B
  src/trade/metrics.ts              tradeMetrics(entries, state)
  test/core/*.test.ts, test/trade/*.test.ts
packages/db/prisma/schema.prisma                        + enums, 3 models, 2 back-relations
packages/db/prisma/migrations/20260906120000_m29_company_simulation/migration.sql
packages/db/src/seed.ts                                 + Demo Trading Co.
packages/control/src/refusal.ts                         + 8 refusal kinds + texts
packages/control/src/simulation.ts                      verbs
packages/control/src/org.ts                             deleteCompany refuses live_simulations
packages/control/src/index.ts, package.json, tsconfig.json
packages/control/test/integration/simulation.test.ts
apps/web/src/server/simulation.ts                       read model
apps/web/src/server/simControlRoute.ts                  simControlResponse (404 / 409 / 200)
apps/web/src/app/api/sim/route.ts                       POST create
apps/web/src/app/api/sim/[simulationId]/route.ts        DELETE
apps/web/src/app/api/sim/[simulationId]/{step,pause,resume,inject,halt}/route.ts
apps/web/src/app/sim/page.tsx, apps/web/src/app/sim/[simulationId]/page.tsx
apps/web/src/components/Sidebar.tsx                     + Simulations row
apps/web/src/components/sim/SimulationsClient.tsx       list + drawer
apps/web/src/components/sim/NewSimulationDrawer.tsx
apps/web/src/components/sim/SimulationClient.tsx        run page
apps/web/src/lib/money.ts                               formatMinor
apps/web/test/sim-*.test.tsx, apps/web/test/integration/sim-routes.test.ts
apps/orchestrator/src/cli.ts                            3 verbs + help
apps/orchestrator/test/integration/cli.test.ts          + 3 cases
scripts/gate-m29-simulation.mjs, package.json (`gate:m29-simulation`, typecheck), tsconfig.json
README.md, spec §13
```

---

### Task 1: Package skeleton and the pure core primitives (rng, queue, journal, action)

**Files:**
- Create: `packages/simulation/package.json`, `packages/simulation/tsconfig.json`, `packages/simulation/tsconfig.test.json`
- Create: `packages/simulation/src/core/rng.ts`, `packages/simulation/src/core/queue.ts`, `packages/simulation/src/core/journal.ts`, `packages/simulation/src/core/action.ts`, `packages/simulation/src/index.ts`
- Modify: `tsconfig.json` (root references), `package.json` (`typecheck` script)
- Test: `packages/simulation/test/core/rng.test.ts`, `packages/simulation/test/core/queue.test.ts`, `packages/simulation/test/core/action.test.ts`

**Interfaces:**
- Produces: `nextRandom(state: number): { value: number; state: number }`, `seedState(seed: number): number`; `PriorityClass`, `EventQueue<E>`, `emptyQueue`, `enqueue`, `popDue`; `JournalKind`, `JournalEntry`; `actionEnvelopeSchema`, `ActionEnvelope`, `EngineRejection`.

- [ ] **Step 1: Scaffold the package (copy `packages/domain`'s shape)**

`packages/simulation/package.json`:
```json
{
  "name": "@slave-of-ai/simulation",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "dependencies": {
    "zod": "^3.24.0"
  }
}
```
`packages/simulation/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*.ts"]
}
```
`packages/simulation/tsconfig.test.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "composite": false, "declaration": false },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```
Root `tsconfig.json`: add `{ "path": "packages/simulation" }` after `packages/domain`. Root `package.json` `typecheck`: insert `tsc -p packages/simulation/tsconfig.test.json && ` right after `tsc -p packages/domain/tsconfig.test.json && `. Run `npm install` once so the workspace symlink exists.

- [ ] **Step 2: Write the failing tests**

`packages/simulation/test/core/rng.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { nextRandom, seedState } from '../../src/core/rng.js'

describe('nextRandom', () => {
  it('is a pure function of its state: the same state yields the same value and next state', () => {
    const a = nextRandom(seedState(42))
    const b = nextRandom(seedState(42))
    expect(a).toEqual(b)
    expect(a.value).toBeGreaterThanOrEqual(0)
    expect(a.value).toBeLessThan(1)
  })
  it('two seeds diverge and a sequence does not repeat within 1000 draws', () => {
    expect(nextRandom(seedState(1)).value).not.toBe(nextRandom(seedState(2)).value)
    const seen = new Set<number>()
    let state = seedState(7)
    for (let i = 0; i < 1000; i++) {
      const out = nextRandom(state)
      seen.add(out.value)
      state = out.state
    }
    expect(seen.size).toBe(1000)
  })
})
```
`packages/simulation/test/core/queue.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { emptyQueue, enqueue, popDue } from '../../src/core/queue.js'

describe('EventQueue', () => {
  it('pops same-day events by priority class then enqueue order, and leaves later days', () => {
    let q = emptyQueue<string>()
    q = enqueue(q, 3, 'close', 'c')
    q = enqueue(q, 3, 'decision', 'd')
    q = enqueue(q, 3, 'external', 'x1')
    q = enqueue(q, 4, 'external', 'later')
    q = enqueue(q, 3, 'scheduled', 's')
    q = enqueue(q, 3, 'external', 'x2')
    const { due, rest } = popDue(q, 3)
    expect(due.map((e) => e.event)).toEqual(['x1', 'x2', 's', 'd', 'c'])
    expect(rest.items.map((e) => e.event)).toEqual(['later'])
  })
  it('also pops anything overdue (time before the asked day), never anything after it', () => {
    let q = emptyQueue<string>()
    q = enqueue(q, 1, 'scheduled', 'old')
    q = enqueue(q, 2, 'scheduled', 'now')
    q = enqueue(q, 3, 'scheduled', 'next')
    const { due } = popDue(q, 2)
    expect(due.map((e) => e.event)).toEqual(['old', 'now'])
  })
  it('never mutates its input', () => {
    const q0 = emptyQueue<string>()
    const q1 = enqueue(q0, 1, 'scheduled', 'a')
    expect(q0.items).toHaveLength(0)
    expect(q1.items).toHaveLength(1)
  })
})
```
`packages/simulation/test/core/action.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { actionEnvelopeSchema } from '../../src/core/action.js'

describe('actionEnvelopeSchema', () => {
  it('accepts a typed envelope and rejects free text', () => {
    expect(actionEnvelopeSchema.safeParse({ type: 'note', params: { text: 'hi' }, rationale: 'because', refs: [] }).success).toBe(true)
    expect(actionEnvelopeSchema.safeParse('I produced 500 units').success).toBe(false)
    expect(actionEnvelopeSchema.safeParse({ type: '', params: {}, rationale: '', refs: [] }).success).toBe(false)
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run packages/simulation/test/core`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the primitives**

`packages/simulation/src/core/rng.ts`:
```ts
/** mulberry32, written as a pure step: the state is a 32-bit integer the caller carries. The
 *  engine keeps it in `EngineState.rngState` so a persisted run resumes its sequence exactly. */
export function seedState(seed: number): number {
  return seed >>> 0
}

export function nextRandom(state: number): { readonly value: number; readonly state: number } {
  let a = (state + 0x6d2b79f5) >>> 0
  let t = a
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296
  return { value, state: a }
}
```
`packages/simulation/src/core/queue.ts`:
```ts
export type PriorityClass = 'external' | 'scheduled' | 'decision' | 'close'

export const PRIORITY_ORDER: Readonly<Record<PriorityClass, number>> = { external: 0, scheduled: 1, decision: 2, close: 3 }

export interface Scheduled<E> {
  readonly time: number
  readonly priority: PriorityClass
  readonly seq: number
  readonly event: E
}

export interface EventQueue<E> {
  readonly items: readonly Scheduled<E>[]
  readonly nextSeq: number
}

export function emptyQueue<E>(): EventQueue<E> {
  return { items: [], nextSeq: 1 }
}

export function enqueue<E>(queue: EventQueue<E>, time: number, priority: PriorityClass, event: E): EventQueue<E> {
  return { items: [...queue.items, { time, priority, seq: queue.nextSeq, event }], nextSeq: queue.nextSeq + 1 }
}

function compare<E>(a: Scheduled<E>, b: Scheduled<E>): number {
  return a.time - b.time || PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.seq - b.seq
}

/** Everything due at `time` or earlier, in `(time, priority, seq)` order; the rest untouched. */
export function popDue<E>(queue: EventQueue<E>, time: number): { readonly due: readonly Scheduled<E>[]; readonly rest: EventQueue<E> } {
  const due = queue.items.filter((item) => item.time <= time).sort(compare)
  const rest = queue.items.filter((item) => item.time > time)
  return { due, rest: { items: rest, nextSeq: queue.nextSeq } }
}
```
`packages/simulation/src/core/journal.ts`:
```ts
export type JournalKind = 'decision' | 'action_applied' | 'action_rejected' | 'event' | 'external_event' | 'control'

export interface JournalEntry {
  readonly seq: number
  readonly simTime: number
  readonly kind: JournalKind
  readonly actorRole: string | null
  readonly payload: Readonly<Record<string, unknown>>
}
```
`packages/simulation/src/core/action.ts`:
```ts
import { z } from 'zod'

/** What an actor may say. Free text is not an action; a claim ("500 produced") is not an effect. */
export const actionEnvelopeSchema = z.object({
  type: z.string().min(1),
  params: z.record(z.unknown()),
  rationale: z.string(),
  refs: z.array(z.string()),
})
export type ActionEnvelope = z.infer<typeof actionEnvelopeSchema>

/** The engine's own rejections; a sector adds its own union (`R` in `SectorModel`). */
export type EngineRejection =
  | { readonly kind: 'schema_invalid'; readonly detail: string }
  | { readonly kind: 'role_not_allowed'; readonly role: string; readonly type: string }
  | { readonly kind: 'limit_exceeded'; readonly limit: string }
```
`packages/simulation/src/index.ts`:
```ts
export * from './core/rng.js'
export * from './core/queue.js'
export * from './core/journal.js'
export * from './core/action.js'
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run packages/simulation/test/core` → PASS. Run: `npm run --silent typecheck` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/simulation tsconfig.json package.json package-lock.json
git commit -m "feat(simulation): m29 t1 — the pure package: seeded rng, deterministic event queue, journal and action envelope"
```

---

### Task 2: The engine — sector contract, decision provider, step / runUntil / replay

**Files:**
- Create: `packages/simulation/src/core/sector.ts`, `packages/simulation/src/core/engine.ts`, `packages/simulation/src/decide/provider.ts`, `packages/simulation/src/decide/recorded.ts`
- Modify: `packages/simulation/src/index.ts`
- Test: `packages/simulation/test/core/engine.test.ts` (uses a tiny "counter" sector defined in the test)

**Interfaces:**
- Consumes: Task 1's queue, rng, journal, action types.
- Produces: `RoleDefinition`, `SectorModel<S, E, R>`, `ScheduleRequest<E>`, `EngineLimits`, `EngineDefinition`, `EngineState<S, E>`, `initialEngineState`, `step`, `runUntil`, `replay`, `DecisionProvider`, `DecisionRequest`, `RecordedDecisionProvider`, `ReplayDivergence` error.

- [ ] **Step 1: Write the failing test with a throwaway counter sector**

`packages/simulation/test/core/engine.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ActionEnvelope } from '../../src/core/action.js'
import { initialEngineState, replay, runUntil, step, type EngineDefinition } from '../../src/core/engine.js'
import type { RoleDefinition, SectorModel } from '../../src/core/sector.js'
import type { DecisionProvider } from '../../src/decide/provider.js'
import { RecordedDecisionProvider } from '../../src/decide/recorded.js'

interface CounterState { readonly count: number; readonly deliveries: number }
type CounterEvent = { readonly type: 'deliver'; readonly qty: number }
type CounterRejection = { readonly kind: 'too_big'; readonly max: number }

const eventSchema = z.object({ type: z.literal('deliver'), qty: z.number().int() })

const counter: SectorModel<CounterState, CounterEvent, CounterRejection> = {
  name: 'counter',
  eventSchema,
  externalEventSchema: eventSchema,
  observe: (state, role) => (role.observes.includes('count') ? { count: state.count } : {}),
  validate: (_state, _role, action) => (action.type === 'add' && Number(action.params['qty']) > 10 ? { ok: false, reason: { kind: 'too_big', max: 10 } } : { ok: true }),
  apply: (state, _role, action, day) => {
    const qty = Number(action.params['qty'])
    if (action.type === 'order') return { state, schedule: [{ time: day + 2, priority: 'scheduled', event: { type: 'deliver', qty } }] }
    return { state: { ...state, count: state.count + qty }, schedule: [] }
  },
  applyEvent: (state, event) => ({ state: { ...state, count: state.count + event.qty, deliveries: state.deliveries + 1 }, schedule: [], record: { qty: event.qty } }),
  closeDay: (state) => ({ state, schedule: [], record: { count: state.count } }),
}

const clerk: RoleDefinition = { name: 'clerk', purpose: 'counts', observes: ['count'], allowedActions: ['add', 'order'], constraints: {}, slaveName: 'Sam' }
const guest: RoleDefinition = { name: 'guest', purpose: 'watches', observes: [], allowedActions: [], constraints: {}, slaveName: 'Guest' }

const definition: EngineDefinition = { roles: [clerk, guest], roleOrder: ['clerk', 'guest'], horizonDays: 10, seed: 1, limits: { maxSteps: 100, maxDecisionsPerStep: 4, maxJournalEntries: 1000 } }

function provider(script: (day: number, role: string) => ActionEnvelope[]): DecisionProvider {
  return { kind: 'rules', decide: (request) => script(request.day, request.role.name) }
}
const add = (qty: number): ActionEnvelope => ({ type: 'add', params: { qty }, rationale: 'test', refs: [] })

describe('engine.step', () => {
  it('applies a valid action through the sector, rejects an unauthorized one and a rule-breaking one, journaling each', () => {
    const initial = initialEngineState<CounterState, CounterEvent>({ count: 0, deliveries: 0 }, [], 1)
    const p = provider((_day, role) => (role === 'clerk' ? [add(3), add(50)] : [add(1)]))
    const { state, entries } = step(counter, definition, initial, p)
    expect(state.sector.count).toBe(3)
    expect(state.day).toBe(1)
    expect(entries.map((e) => e.kind)).toEqual(['decision', 'action_applied', 'action_rejected', 'decision', 'action_rejected', 'event'])
    expect(entries[2]?.payload['reason']).toEqual({ kind: 'too_big', max: 10 })
    expect(entries[4]?.payload['reason']).toEqual({ kind: 'role_not_allowed', role: 'guest', type: 'add' })
    expect(entries.at(-1)?.payload).toEqual({ kind: 'close', count: 3 })
  })
  it('an ordered delivery lands only when its scheduled day comes', () => {
    const initial = initialEngineState<CounterState, CounterEvent>({ count: 0, deliveries: 0 }, [], 1)
    const p = provider((day, role) => (day === 0 && role === 'clerk' ? [{ type: 'order', params: { qty: 5 }, rationale: 'x', refs: [] }] : []))
    const s1 = step(counter, definition, initial, p).state
    expect(s1.sector.count).toBe(0)
    const s2 = step(counter, definition, s1, p).state
    expect(s2.sector.count).toBe(0)
    const s3 = step(counter, definition, s2, p).state
    expect(s3.sector.count).toBe(5)
    expect(s3.sector.deliveries).toBe(1)
  })
  it('a malformed envelope is schema_invalid and changes nothing', () => {
    const initial = initialEngineState<CounterState, CounterEvent>({ count: 0, deliveries: 0 }, [], 1)
    const p: DecisionProvider = { kind: 'rules', decide: () => [{ type: 'add', params: 'not an object', rationale: '', refs: [] } as unknown as ActionEnvelope] }
    const { state, entries } = step(counter, definition, initial, p)
    expect(state.sector.count).toBe(0)
    expect(entries.filter((e) => e.kind === 'action_rejected')[0]?.payload['reason']).toMatchObject({ kind: 'schema_invalid' })
  })
  it('caps decisions per step with limit_exceeded and halts on maxJournalEntries', () => {
    const initial = initialEngineState<CounterState, CounterEvent>({ count: 0, deliveries: 0 }, [], 1)
    const p = provider((_day, role) => (role === 'clerk' ? [add(1), add(1), add(1), add(1), add(1), add(1)] : []))
    const { state, entries } = step(counter, definition, initial, p)
    expect(state.sector.count).toBe(4)
    expect(entries.filter((e) => e.kind === 'action_rejected').map((e) => e.payload['reason'])).toEqual([{ kind: 'limit_exceeded', limit: 'maxDecisionsPerStep' }])
    const tiny = { ...definition, limits: { ...definition.limits, maxJournalEntries: 3 } }
    const halted = step(counter, tiny, initial, p).state
    expect(halted.status).toBe('halted')
    expect(halted.haltedReason).toBe('maxJournalEntries')
  })
})

describe('runUntil and replay', () => {
  it('runs to the horizon and finishes; stops early at the per-call cap', () => {
    const initial = initialEngineState<CounterState, CounterEvent>({ count: 0, deliveries: 0 }, [{ time: 4, priority: 'external', event: { type: 'deliver', qty: 7 } }], 1)
    const p = provider(() => [])
    const partial = runUntil(counter, definition, initial, p, 10, 3)
    expect(partial.state.day).toBe(3)
    expect(partial.state.status).toBe('running')
    const done = runUntil(counter, definition, partial.state, p, 10, 100)
    expect(done.state.day).toBe(10)
    expect(done.state.status).toBe('finished')
    expect(done.state.sector.count).toBe(7)
    expect(done.entries.some((e) => e.kind === 'external_event')).toBe(true)
  })
  it('replaying the journal with the recorded provider reproduces the state exactly, and diverging journals throw', () => {
    const initial = initialEngineState<CounterState, CounterEvent>({ count: 0, deliveries: 0 }, [], 1)
    const p = provider((day, role) => (role === 'clerk' ? [add(day), add(50)] : []))
    const live = runUntil(counter, definition, initial, p, 5, 100)
    const replayed = replay(counter, definition, initial, live.entries)
    expect(replayed).toEqual(live.state)
    expect(() => replay(counter, definition, initial, live.entries.slice(0, 2))).toThrow(/replay_divergence/)
  })
  it('the same seed, inputs and decisions produce identical journals', () => {
    const p = provider((day) => [add(day % 3)])
    const a = runUntil(counter, definition, initialEngineState<CounterState, CounterEvent>({ count: 0, deliveries: 0 }, [], 9), p, 6, 100)
    const b = runUntil(counter, definition, initialEngineState<CounterState, CounterEvent>({ count: 0, deliveries: 0 }, [], 9), p, 6, 100)
    expect(a.entries).toEqual(b.entries)
    expect(a.state).toEqual(b.state)
  })
  it('the recorded provider refuses to answer a decision point it has no record for', () => {
    const recorded = new RecordedDecisionProvider([])
    expect(() => recorded.decide({ day: 0, role: clerk, observation: {}, index: 0 })).toThrow(/replay_divergence/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/simulation/test/core/engine.test.ts` → FAIL, modules missing.

- [ ] **Step 3: Implement the contract, provider and engine**

`packages/simulation/src/core/sector.ts`:
```ts
import type { z } from 'zod'
import type { ActionEnvelope } from './action.js'
import type { PriorityClass } from './queue.js'

/** A role is more than a name: what it is for, what it may see, what it may do, its limits, and
 *  which roster slave holds it (frozen at creation). */
export interface RoleDefinition {
  readonly name: string
  readonly purpose: string
  readonly observes: readonly string[]
  readonly allowedActions: readonly string[]
  readonly constraints: Readonly<Record<string, number>>
  readonly slaveName: string
}

export interface ScheduleRequest<E> {
  readonly time: number
  readonly priority: PriorityClass
  readonly event: E
}

export interface Applied<S, E> {
  readonly state: S
  readonly schedule: readonly ScheduleRequest<E>[]
  readonly record?: Readonly<Record<string, unknown>>
}

/** What a sector must provide. Every function is pure; the engine owns time, the queue and the
 *  journal, the sector owns the meaning of state, actions and events. */
export interface SectorModel<S, E, R> {
  readonly name: string
  readonly eventSchema: z.ZodType<E>
  /** The subset of events a person may inject from outside (demand, a delay) — never a delivery. */
  readonly externalEventSchema: z.ZodType<E>
  observe(state: S, role: RoleDefinition): Readonly<Record<string, unknown>>
  validate(state: S, role: RoleDefinition, action: ActionEnvelope): { readonly ok: true } | { readonly ok: false; readonly reason: R }
  apply(state: S, role: RoleDefinition, action: ActionEnvelope, day: number): Applied<S, E>
  applyEvent(state: S, event: E, day: number): Applied<S, E> & { readonly record: Readonly<Record<string, unknown>> }
  closeDay(state: S, day: number): Applied<S, E> & { readonly record: Readonly<Record<string, unknown>> }
}
```
`packages/simulation/src/decide/provider.ts`:
```ts
import type { ActionEnvelope } from '../core/action.js'
import type { RoleDefinition } from '../core/sector.js'

export interface DecisionRequest {
  readonly day: number
  readonly role: RoleDefinition
  /** Only what `role.observes` allows — the sector filters; the provider never sees the world. */
  readonly observation: Readonly<Record<string, unknown>>
  /** The decision point's index within the day (one per role in `roleOrder`). */
  readonly index: number
}

/** `rules` decides from the observation by policy; `recorded` answers from a journal (replay). An
 *  `llm` kind arrives in M31 with an asynchronous shape — this synchronous one is the M29 contract. */
export interface DecisionProvider {
  readonly kind: 'rules' | 'recorded'
  decide(request: DecisionRequest): readonly ActionEnvelope[]
}
```
`packages/simulation/src/decide/recorded.ts`:
```ts
import { actionEnvelopeSchema, type ActionEnvelope } from '../core/action.js'
import type { JournalEntry } from '../core/journal.js'
import type { DecisionProvider, DecisionRequest } from './provider.js'

export class ReplayDivergence extends Error {
  constructor(detail: string) {
    super(`replay_divergence: ${detail}`)
  }
}

/** Answers each decision point with the envelopes the journal recorded for `(day, role, index)`.
 *  It never invents one: a missing record is a divergence, not an empty decision. */
export class RecordedDecisionProvider implements DecisionProvider {
  readonly kind = 'recorded' as const
  private readonly byPoint = new Map<string, readonly ActionEnvelope[]>()

  constructor(entries: readonly JournalEntry[]) {
    for (const entry of entries) {
      if (entry.kind !== 'decision') continue
      const raw = entry.payload['actions']
      const actions = Array.isArray(raw) ? raw.map((a) => actionEnvelopeSchema.parse(a)) : []
      this.byPoint.set(`${entry.simTime}:${String(entry.actorRole)}:${String(entry.payload['index'])}`, actions)
    }
  }

  decide(request: DecisionRequest): readonly ActionEnvelope[] {
    const key = `${request.day}:${request.role.name}:${request.index}`
    const actions = this.byPoint.get(key)
    if (actions === undefined) throw new ReplayDivergence(`no recorded decision for ${key}`)
    return actions
  }
}
```
`packages/simulation/src/core/engine.ts`:
```ts
import { actionEnvelopeSchema, type ActionEnvelope, type EngineRejection } from './action.js'
import type { JournalEntry } from './journal.js'
import { emptyQueue, enqueue, popDue, type EventQueue } from './queue.js'
import { seedState } from './rng.js'
import type { RoleDefinition, ScheduleRequest, SectorModel } from './sector.js'
import { RecordedDecisionProvider } from '../decide/recorded.js'
import type { DecisionProvider } from '../decide/provider.js'

export interface EngineLimits {
  readonly maxSteps: number
  readonly maxDecisionsPerStep: number
  readonly maxJournalEntries: number
}

export interface EngineDefinition {
  readonly roles: readonly RoleDefinition[]
  readonly roleOrder: readonly string[]
  readonly horizonDays: number
  readonly seed: number
  readonly limits: EngineLimits
}

export type EngineStatus = 'ready' | 'running' | 'finished' | 'halted'

export interface EngineState<S, E> {
  readonly day: number
  readonly sector: S
  readonly queue: EventQueue<E>
  readonly rngState: number
  readonly journalSeq: number
  readonly stepCount: number
  readonly decisionCount: number
  readonly status: EngineStatus
  readonly haltedReason: string | null
}

export interface StepResult<S, E> {
  readonly state: EngineState<S, E>
  readonly entries: readonly JournalEntry[]
}

export function initialEngineState<S, E>(sector: S, scenario: readonly ScheduleRequest<E>[], seed: number): EngineState<S, E> {
  let queue = emptyQueue<E>()
  for (const request of scenario) queue = enqueue(queue, request.time, request.priority, request.event)
  return { day: 0, sector, queue, rngState: seedState(seed), journalSeq: 0, stepCount: 0, decisionCount: 0, status: 'ready', haltedReason: null }
}

function scheduleAll<E>(queue: EventQueue<E>, requests: readonly ScheduleRequest<E>[]): EventQueue<E> {
  let next = queue
  for (const request of requests) next = enqueue(next, request.time, request.priority, request.event)
  return next
}

/** One simulation day: due events → each role's decision point → the sector's day close. */
export function step<S, E, R>(model: SectorModel<S, E, R>, definition: EngineDefinition, state: EngineState<S, E>, provider: DecisionProvider): StepResult<S, E> {
  if (state.status === 'finished' || state.status === 'halted') return { state, entries: [] }
  const day = state.day
  const entries: JournalEntry[] = []
  let seq = state.journalSeq
  let sector = state.sector
  let decisionCount = state.decisionCount
  const record = (kind: JournalEntry['kind'], actorRole: string | null, payload: Record<string, unknown>): void => {
    seq += 1
    entries.push({ seq, simTime: day, kind, actorRole, payload })
  }

  // 1. Everything due today, in (priority, enqueue) order. External events journal as such.
  const popped = popDue(state.queue, day)
  let queue = popped.rest
  for (const item of popped.due) {
    const applied = model.applyEvent(sector, item.event, day)
    sector = applied.state
    queue = scheduleAll(queue, applied.schedule)
    record(item.priority === 'external' ? 'external_event' : 'event', null, { event: item.event, ...applied.record })
  }

  // 2. Decision points, one per role in order; every action validated against the state as it is
  //    NOW (after earlier actions this day), never against the observation the actor was shown.
  definition.roleOrder.forEach((roleName, index) => {
    const role = definition.roles.find((r) => r.name === roleName)
    if (role === undefined) return
    const observation = model.observe(sector, role)
    const proposed = provider.decide({ day, role, observation, index })
    record('decision', role.name, { index, provider: provider.kind, observation, actions: proposed })
    for (let actionIndex = 0; actionIndex < proposed.length; actionIndex++) {
      const raw = proposed[actionIndex]
      const outcome = validateAndApply(model, definition, sector, role, raw, actionIndex, day)
      decisionCount += 1
      if (outcome.ok) {
        sector = outcome.state
        queue = scheduleAll(queue, outcome.schedule)
        record('action_applied', role.name, { index, actionIndex, action: outcome.action, ...(outcome.record ?? {}) })
      } else {
        record('action_rejected', role.name, { index, actionIndex, action: raw, reason: outcome.reason })
        // One `limit_exceeded` per decision point: everything past the cap is dropped, not listed.
        if ('kind' in outcome.reason && outcome.reason.kind === 'limit_exceeded') break
      }
    }
  })

  // 3. Day close.
  const closed = model.closeDay(sector, day)
  sector = closed.state
  queue = scheduleAll(queue, closed.schedule)
  record('event', null, { kind: 'close', ...closed.record })

  const stepCount = state.stepCount + 1
  const nextDay = day + 1
  let status: EngineState<S, E>['status'] = nextDay >= definition.horizonDays ? 'finished' : 'running'
  let haltedReason: string | null = null
  if (seq > definition.limits.maxJournalEntries) {
    status = 'halted'
    haltedReason = 'maxJournalEntries'
  } else if (stepCount >= definition.limits.maxSteps && status !== 'finished') {
    status = 'halted'
    haltedReason = 'maxSteps'
  }
  return { state: { day: nextDay, sector, queue, rngState: state.rngState, journalSeq: seq, stepCount, decisionCount, status, haltedReason }, entries }
}

type Outcome<S, E, R> =
  | { readonly ok: true; readonly state: S; readonly schedule: readonly ScheduleRequest<E>[]; readonly action: ActionEnvelope; readonly record?: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: EngineRejection | R }

function validateAndApply<S, E, R>(model: SectorModel<S, E, R>, definition: EngineDefinition, sector: S, role: RoleDefinition, raw: unknown, actionIndex: number, day: number): Outcome<S, E, R> {
  if (actionIndex >= definition.limits.maxDecisionsPerStep) return { ok: false, reason: { kind: 'limit_exceeded', limit: 'maxDecisionsPerStep' } }
  const parsed = actionEnvelopeSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, reason: { kind: 'schema_invalid', detail: parsed.error.issues.map((i) => i.message).join('; ') } }
  const action = parsed.data
  if (!role.allowedActions.includes(action.type)) return { ok: false, reason: { kind: 'role_not_allowed', role: role.name, type: action.type } }
  const verdict = model.validate(sector, role, action)
  if (!verdict.ok) return { ok: false, reason: verdict.reason }
  const applied = model.apply(sector, role, action, day)
  return { ok: true, state: applied.state, schedule: applied.schedule, action, ...(applied.record !== undefined ? { record: applied.record } : {}) }
}

/** Steps until `untilDay` (exclusive of nothing: the state's `day` reaches it), the horizon, a
 *  halt, or `maxStepsPerCall` — the control layer's own bound on one request. */
export function runUntil<S, E, R>(model: SectorModel<S, E, R>, definition: EngineDefinition, state: EngineState<S, E>, provider: DecisionProvider, untilDay: number, maxStepsPerCall: number): StepResult<S, E> {
  let current: EngineState<S, E> = state.status === 'ready' ? { ...state, status: 'running' } : state
  const entries: JournalEntry[] = []
  let steps = 0
  while (current.day < untilDay && current.status === 'running' && steps < maxStepsPerCall) {
    const result = step(model, definition, current, provider)
    current = result.state
    entries.push(...result.entries)
    steps += 1
  }
  return { state: current, entries }
}

/** The same engine, fed the journal's own decisions. Equality with the stored state is the test. */
export function replay<S, E, R>(model: SectorModel<S, E, R>, definition: EngineDefinition, initial: EngineState<S, E>, journal: readonly JournalEntry[]): EngineState<S, E> {
  const provider = new RecordedDecisionProvider(journal)
  const lastDay = journal.reduce((max, entry) => Math.max(max, entry.simTime), -1)
  const stepsToReplay = lastDay + 1
  let current: EngineState<S, E> = { ...initial, status: 'running' }
  for (let i = 0; i < stepsToReplay; i++) current = step(model, definition, current, provider).state
  return current
}
```
Add to `src/index.ts`:
```ts
export * from './core/sector.js'
export * from './core/engine.js'
export * from './decide/provider.js'
export * from './decide/recorded.js'
```
Note for the implementer: in `step`, `record('event', null, { kind: 'close', … })` writes `kind: 'close'` into the payload while the journal kind is `event` — the test asserts `{ kind: 'close', count: 3 }`. `replay` counts `stepsToReplay` from the journal's last `simTime`, so a partial journal replays to the same day as the live run that produced it; the live `runUntil` result's `status` for a finished run is `finished`, and replay reaches the same status because `step` derives it from `day` and limits alone.

- [ ] **Step 4: Run the tests; fix until green**

Run: `npx vitest run packages/simulation/test/core` → PASS. `npm run --silent typecheck` → 0.

- [ ] **Step 5: Commit**

```bash
git add packages/simulation
git commit -m "feat(simulation): m29 t2 — the engine: sector contract, decision provider, step / runUntil / replay"
```

---

### Task 3: The trade sector — state, events, actions, rules

**Files:**
- Create: `packages/simulation/src/trade/state.ts`, `packages/simulation/src/trade/events.ts`, `packages/simulation/src/trade/actions.ts`, `packages/simulation/src/trade/model.ts`
- Modify: `packages/simulation/src/index.ts`
- Test: `packages/simulation/test/trade/model.test.ts`

**Interfaces:**
- Consumes: Task 2's `SectorModel`, `RoleDefinition`, `ActionEnvelope`, `ScheduleRequest`.
- Produces: `TradeState`, `tradeStateSchema`, `Supplier`, `Order`, `Purchase`, `PendingDemand`; `TradeEvent`, `tradeEventSchema`, `tradeExternalEventSchema`; `TradeRejection`; `tradeModel: SectorModel<TradeState, TradeEvent, TradeRejection>`; `unpaidCommitmentsMinor(state)`; `roundHalfUp(n)`.

- [ ] **Step 1: Write the failing tests**

`packages/simulation/test/trade/model.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import type { ActionEnvelope } from '../../src/core/action.js'
import type { RoleDefinition } from '../../src/core/sector.js'
import { tradeModel } from '../../src/trade/model.js'
import type { TradeState } from '../../src/trade/state.js'

const suppliers = [
  { id: 'normal', name: 'Normal Supply', unitPriceMinor: 6_000, leadDays: 7, paymentTermDays: 30 },
  { id: 'fast', name: 'Fast Supply', unitPriceMinor: 8_500, leadDays: 2, paymentTermDays: 0 },
]
function base(over: Partial<TradeState> = {}): TradeState {
  return { cashMinor: 5_000_000, inventory: 100, dailyShipCapacity: 30, shippedToday: 0, minCashMinor: 5_000_000, minCashDay: 0, nextId: 1, pendingDemand: [], orders: [], purchases: [], suppliers, ...over }
}
const role = (name: string, allowed: string[], constraints: Record<string, number> = {}): RoleDefinition => ({ name, purpose: 't', observes: ['inventory', 'cashMinor', 'orders', 'purchases', 'suppliers', 'pendingDemand', 'dailyShipCapacity'], allowedActions: allowed, constraints, slaveName: 'x' })
const sales = role('sales', ['accept_order'])
const purchasing = role('purchasing', ['place_purchase'], { maxPurchaseQty: 500 })
const operations = role('operations', ['ship_order'])
const act = (type: string, params: Record<string, unknown>): ActionEnvelope => ({ type, params, rationale: 't', refs: [] })

describe('trade events', () => {
  it('demand becomes a pending order; accept_order turns it into an open order', () => {
    const d = tradeModel.applyEvent(base(), { type: 'demand', qty: 150, unitPriceMinor: 12_000, dueInDays: 10, collectInDays: 15 }, 1)
    expect(d.state.pendingDemand).toEqual([{ id: 'demand-1', qty: 150, unitPriceMinor: 12_000, dueDay: 11, collectInDays: 15 }])
    expect(tradeModel.validate(d.state, sales, act('accept_order', { orderId: 'demand-9' }))).toEqual({ ok: false, reason: { kind: 'unknown_reference', id: 'demand-9' } })
    const a = tradeModel.apply(d.state, sales, act('accept_order', { orderId: 'demand-1' }), 1)
    expect(a.state.pendingDemand).toEqual([])
    expect(a.state.orders[0]).toMatchObject({ id: 'order-2', qty: 150, remaining: 150, dueDay: 11, status: 'open' })
  })
  it('a purchase raises stock only on its delivery event, and cash only on payment_due', () => {
    const p = tradeModel.apply(base(), purchasing, act('place_purchase', { supplierId: 'normal', qty: 50 }), 1)
    expect(p.state.inventory).toBe(100)
    expect(p.state.cashMinor).toBe(5_000_000)
    expect(p.state.purchases[0]).toMatchObject({ id: 'purchase-1', supplierId: 'normal', qty: 50, unitPriceMinor: 6_000, expectedDay: 8, payDay: 31, status: 'ordered' })
    expect(p.schedule).toEqual([
      { time: 8, priority: 'scheduled', event: { type: 'delivery', purchaseId: 'purchase-1' } },
      { time: 31, priority: 'scheduled', event: { type: 'payment_due', purchaseId: 'purchase-1' } },
    ])
    const delivered = tradeModel.applyEvent(p.state, { type: 'delivery', purchaseId: 'purchase-1' }, 8)
    expect(delivered.state.inventory).toBe(150)
    expect(delivered.state.purchases[0]?.status).toBe('delivered')
    const paid = tradeModel.applyEvent(delivered.state, { type: 'payment_due', purchaseId: 'purchase-1' }, 31)
    expect(paid.state.cashMinor).toBe(5_000_000 - 300_000)
    expect(paid.state.purchases[0]?.status).toBe('paid')
  })
  it('a supplier delay pushes every undelivered purchase of that supplier and reschedules its delivery', () => {
    const p = tradeModel.apply(base(), purchasing, act('place_purchase', { supplierId: 'normal', qty: 50 }), 1)
    const delayed = tradeModel.applyEvent(p.state, { type: 'supplier_delay', supplierId: 'normal', extraDays: 6 }, 3)
    expect(delayed.state.purchases[0]?.expectedDay).toBe(14)
    expect(delayed.schedule).toEqual([{ time: 14, priority: 'scheduled', event: { type: 'delivery', purchaseId: 'purchase-1' } }])
    // The old day-8 delivery still fires; a delivery before `expectedDay` is ignored, not applied twice.
    const early = tradeModel.applyEvent(delayed.state, { type: 'delivery', purchaseId: 'purchase-1' }, 8)
    expect(early.state.inventory).toBe(100)
    expect(early.record).toMatchObject({ ignored: 'before_expected_day' })
  })
})

describe('trade rules', () => {
  it('refuses a purchase the cash minus unpaid commitments cannot cover', () => {
    const state = base({ cashMinor: 400_000, purchases: [{ id: 'purchase-1', supplierId: 'fast', qty: 20, unitPriceMinor: 8_500, orderedDay: 0, expectedDay: 2, deliveredDay: null, payDay: 0, status: 'ordered' }] })
    // 400_000 - 170_000 unpaid = 230_000 available; 50 × 6_000 = 300_000
    expect(tradeModel.validate(state, purchasing, act('place_purchase', { supplierId: 'normal', qty: 50 }))).toEqual({ ok: false, reason: { kind: 'insufficient_cash', availableMinor: 230_000, costMinor: 300_000 } })
    expect(tradeModel.validate(state, purchasing, act('place_purchase', { supplierId: 'normal', qty: 30 })).ok).toBe(true)
    expect(tradeModel.validate(state, purchasing, act('place_purchase', { supplierId: 'nobody', qty: 1 }))).toEqual({ ok: false, reason: { kind: 'unknown_reference', id: 'nobody' } })
    expect(tradeModel.validate(state, purchasing, act('place_purchase', { supplierId: 'normal', qty: 501 }))).toEqual({ ok: false, reason: { kind: 'over_constraint', constraint: 'maxPurchaseQty', max: 500 } })
    expect(tradeModel.validate(state, purchasing, act('place_purchase', { supplierId: 'normal', qty: 0 }))).toMatchObject({ ok: false, reason: { kind: 'schema_invalid' } })
  })
  it('ships only what stock, capacity and the order allow', () => {
    const order = { id: 'order-1', qty: 150, remaining: 150, unitPriceMinor: 12_000, dueDay: 11, collectInDays: 15, shippedQty: 0, lastShipDay: null, status: 'open' as const }
    const state = base({ inventory: 40, orders: [order] })
    expect(tradeModel.validate(state, operations, act('ship_order', { orderId: 'order-1', qty: 41 }))).toEqual({ ok: false, reason: { kind: 'insufficient_stock', inventory: 40 } })
    expect(tradeModel.validate(state, operations, act('ship_order', { orderId: 'order-1', qty: 31 }))).toEqual({ ok: false, reason: { kind: 'capacity_exhausted', remainingCapacity: 30 } })
    const small = base({ inventory: 100, orders: [{ ...order, qty: 20, remaining: 20 }] })
    expect(tradeModel.validate(small, operations, act('ship_order', { orderId: 'order-1', qty: 21 }))).toEqual({ ok: false, reason: { kind: 'over_shipment', remaining: 20 } })
    const shipped = tradeModel.apply(state, operations, act('ship_order', { orderId: 'order-1', qty: 30 }), 5)
    expect(shipped.state.inventory).toBe(10)
    expect(shipped.state.shippedToday).toBe(30)
    expect(shipped.state.orders[0]).toMatchObject({ remaining: 120, shippedQty: 30, lastShipDay: 5, status: 'partially_shipped' })
    expect(shipped.schedule).toEqual([{ time: 20, priority: 'scheduled', event: { type: 'collection', orderId: 'order-1', qty: 30 } }])
    const collected = tradeModel.applyEvent(shipped.state, { type: 'collection', orderId: 'order-1', qty: 30 }, 20)
    expect(collected.state.cashMinor).toBe(5_000_000 + 360_000)
  })
  it('the close resets capacity, tracks minimum cash and marks the order late past its due day', () => {
    const order = { id: 'order-1', qty: 10, remaining: 10, unitPriceMinor: 12_000, dueDay: 4, collectInDays: 15, shippedQty: 0, lastShipDay: null, status: 'open' as const }
    const closed = tradeModel.closeDay(base({ shippedToday: 30, cashMinor: 100, orders: [order] }), 5)
    expect(closed.state.shippedToday).toBe(0)
    expect(closed.state.minCashMinor).toBe(100)
    expect(closed.state.minCashDay).toBe(5)
    expect(closed.record).toEqual({ inventory: 100, cashMinor: 100, openOrders: 1, lateOrders: 1 })
  })
  it('observe hands a role only the fields it may see', () => {
    const narrow: RoleDefinition = { ...sales, observes: ['inventory'] }
    expect(Object.keys(tradeModel.observe(base(), narrow))).toEqual(['inventory'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/simulation/test/trade` → FAIL, modules missing.

- [ ] **Step 3: Implement state, events, actions, model**

`packages/simulation/src/trade/state.ts`:
```ts
import { z } from 'zod'

export const supplierSchema = z.object({ id: z.string(), name: z.string(), unitPriceMinor: z.number().int().nonnegative(), leadDays: z.number().int().nonnegative(), paymentTermDays: z.number().int().nonnegative() })
export const pendingDemandSchema = z.object({ id: z.string(), qty: z.number().int().positive(), unitPriceMinor: z.number().int().nonnegative(), dueDay: z.number().int(), collectInDays: z.number().int().nonnegative() })
export const orderSchema = z.object({
  id: z.string(), qty: z.number().int().positive(), remaining: z.number().int().nonnegative(), unitPriceMinor: z.number().int().nonnegative(),
  dueDay: z.number().int(), collectInDays: z.number().int().nonnegative(), shippedQty: z.number().int().nonnegative(), lastShipDay: z.number().int().nullable(),
  status: z.enum(['open', 'partially_shipped', 'shipped']),
})
export const purchaseSchema = z.object({
  id: z.string(), supplierId: z.string(), qty: z.number().int().positive(), unitPriceMinor: z.number().int().nonnegative(), orderedDay: z.number().int(),
  expectedDay: z.number().int(), deliveredDay: z.number().int().nullable(), payDay: z.number().int(), status: z.enum(['ordered', 'delivered', 'paid']),
})
export const tradeStateSchema = z.object({
  cashMinor: z.number().int(), inventory: z.number().int().nonnegative(), dailyShipCapacity: z.number().int().nonnegative(), shippedToday: z.number().int().nonnegative(),
  minCashMinor: z.number().int(), minCashDay: z.number().int(), nextId: z.number().int().positive(),
  pendingDemand: z.array(pendingDemandSchema), orders: z.array(orderSchema), purchases: z.array(purchaseSchema), suppliers: z.array(supplierSchema),
})
export type Supplier = z.infer<typeof supplierSchema>
export type PendingDemand = z.infer<typeof pendingDemandSchema>
export type Order = z.infer<typeof orderSchema>
export type Purchase = z.infer<typeof purchaseSchema>
export type TradeState = z.infer<typeof tradeStateSchema>

/** Half-up to the minor unit: 12.5 → 13, −12.5 → −12 (Math.round's own rule). */
export function roundHalfUp(n: number): number {
  return Math.round(n)
}

export function unpaidCommitmentsMinor(state: TradeState): number {
  return state.purchases.filter((p) => p.status !== 'paid').reduce((sum, p) => sum + p.qty * p.unitPriceMinor, 0)
}

export function initialTradeState(input: { readonly cashMinor: number; readonly inventory: number; readonly dailyShipCapacity: number; readonly suppliers: readonly Supplier[] }): TradeState {
  return { cashMinor: input.cashMinor, inventory: input.inventory, dailyShipCapacity: input.dailyShipCapacity, shippedToday: 0, minCashMinor: input.cashMinor, minCashDay: 0, nextId: 1, pendingDemand: [], orders: [], purchases: [], suppliers: [...input.suppliers] }
}
```
`packages/simulation/src/trade/events.ts`:
```ts
import { z } from 'zod'

const demand = z.object({ type: z.literal('demand'), qty: z.number().int().positive(), unitPriceMinor: z.number().int().nonnegative(), dueInDays: z.number().int().positive(), collectInDays: z.number().int().nonnegative() })
const supplierDelay = z.object({ type: z.literal('supplier_delay'), supplierId: z.string(), extraDays: z.number().int().positive() })
const delivery = z.object({ type: z.literal('delivery'), purchaseId: z.string() })
const paymentDue = z.object({ type: z.literal('payment_due'), purchaseId: z.string() })
const collection = z.object({ type: z.literal('collection'), orderId: z.string(), qty: z.number().int().positive() })

/** What the world can do. Only `demand` and `supplier_delay` may come from outside. */
export const tradeEventSchema = z.discriminatedUnion('type', [demand, supplierDelay, delivery, paymentDue, collection])
export const tradeExternalEventSchema = z.discriminatedUnion('type', [demand, supplierDelay])
export type TradeEvent = z.infer<typeof tradeEventSchema>
export type TradeExternalEvent = z.infer<typeof tradeExternalEventSchema>
```
`packages/simulation/src/trade/actions.ts`:
```ts
import { z } from 'zod'

export const acceptOrderParams = z.object({ orderId: z.string() })
export const placePurchaseParams = z.object({ supplierId: z.string(), qty: z.number().int().positive() })
export const shipOrderParams = z.object({ orderId: z.string(), qty: z.number().int().positive() })
export const noteParams = z.object({ text: z.string() })

export const TRADE_ACTION_TYPES = ['accept_order', 'place_purchase', 'ship_order', 'note'] as const
export type TradeActionType = (typeof TRADE_ACTION_TYPES)[number]

export type TradeRejection =
  | { readonly kind: 'schema_invalid'; readonly detail: string }
  | { readonly kind: 'unknown_action'; readonly type: string }
  | { readonly kind: 'unknown_reference'; readonly id: string }
  | { readonly kind: 'over_constraint'; readonly constraint: string; readonly max: number }
  | { readonly kind: 'insufficient_cash'; readonly availableMinor: number; readonly costMinor: number }
  | { readonly kind: 'insufficient_stock'; readonly inventory: number }
  | { readonly kind: 'capacity_exhausted'; readonly remainingCapacity: number }
  | { readonly kind: 'over_shipment'; readonly remaining: number }
  | { readonly kind: 'order_not_open'; readonly orderId: string }
```
`packages/simulation/src/trade/model.ts`:
```ts
import type { ActionEnvelope } from '../core/action.js'
import type { Applied, RoleDefinition, SectorModel } from '../core/sector.js'
import { acceptOrderParams, noteParams, placePurchaseParams, shipOrderParams, type TradeRejection } from './actions.js'
import { tradeEventSchema, tradeExternalEventSchema, type TradeEvent } from './events.js'
import { unpaidCommitmentsMinor, type Order, type TradeState } from './state.js'

type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: TradeRejection }
const ok: Verdict = { ok: true }
const no = (reason: TradeRejection): Verdict => ({ ok: false, reason })

function nextId(state: TradeState, prefix: string): { readonly id: string; readonly state: TradeState } {
  return { id: `${prefix}-${state.nextId}`, state: { ...state, nextId: state.nextId + 1 } }
}

function validate(state: TradeState, role: RoleDefinition, action: ActionEnvelope): Verdict {
  switch (action.type) {
    case 'note':
      return noteParams.safeParse(action.params).success ? ok : no({ kind: 'schema_invalid', detail: 'note needs { text }' })
    case 'accept_order': {
      const p = acceptOrderParams.safeParse(action.params)
      if (!p.success) return no({ kind: 'schema_invalid', detail: 'accept_order needs { orderId }' })
      return state.pendingDemand.some((d) => d.id === p.data.orderId) ? ok : no({ kind: 'unknown_reference', id: p.data.orderId })
    }
    case 'place_purchase': {
      const p = placePurchaseParams.safeParse(action.params)
      if (!p.success) return no({ kind: 'schema_invalid', detail: 'place_purchase needs { supplierId, qty ≥ 1 }' })
      const supplier = state.suppliers.find((s) => s.id === p.data.supplierId)
      if (supplier === undefined) return no({ kind: 'unknown_reference', id: p.data.supplierId })
      const max = role.constraints['maxPurchaseQty']
      if (max !== undefined && p.data.qty > max) return no({ kind: 'over_constraint', constraint: 'maxPurchaseQty', max })
      const costMinor = p.data.qty * supplier.unitPriceMinor
      const availableMinor = state.cashMinor - unpaidCommitmentsMinor(state)
      return availableMinor >= costMinor ? ok : no({ kind: 'insufficient_cash', availableMinor, costMinor })
    }
    case 'ship_order': {
      const p = shipOrderParams.safeParse(action.params)
      if (!p.success) return no({ kind: 'schema_invalid', detail: 'ship_order needs { orderId, qty ≥ 1 }' })
      const order = state.orders.find((o) => o.id === p.data.orderId)
      if (order === undefined) return no({ kind: 'unknown_reference', id: p.data.orderId })
      if (order.status === 'shipped') return no({ kind: 'order_not_open', orderId: order.id })
      if (p.data.qty > order.remaining) return no({ kind: 'over_shipment', remaining: order.remaining })
      if (p.data.qty > state.inventory) return no({ kind: 'insufficient_stock', inventory: state.inventory })
      const remainingCapacity = state.dailyShipCapacity - state.shippedToday
      if (p.data.qty > remainingCapacity) return no({ kind: 'capacity_exhausted', remainingCapacity })
      return ok
    }
    default:
      return no({ kind: 'unknown_action', type: action.type })
  }
}

function apply(state: TradeState, _role: RoleDefinition, action: ActionEnvelope, day: number): Applied<TradeState, TradeEvent> {
  switch (action.type) {
    case 'accept_order': {
      const { orderId } = acceptOrderParams.parse(action.params)
      const demand = state.pendingDemand.find((d) => d.id === orderId)
      if (demand === undefined) return { state, schedule: [] }
      const next = nextId(state, 'order')
      const order: Order = { id: next.id, qty: demand.qty, remaining: demand.qty, unitPriceMinor: demand.unitPriceMinor, dueDay: demand.dueDay, collectInDays: demand.collectInDays, shippedQty: 0, lastShipDay: null, status: 'open' }
      return { state: { ...next.state, pendingDemand: state.pendingDemand.filter((d) => d.id !== orderId), orders: [...state.orders, order] }, schedule: [], record: { orderId: order.id, qty: order.qty } }
    }
    case 'place_purchase': {
      const { supplierId, qty } = placePurchaseParams.parse(action.params)
      const supplier = state.suppliers.find((s) => s.id === supplierId)
      if (supplier === undefined) return { state, schedule: [] }
      const next = nextId(state, 'purchase')
      const expectedDay = day + supplier.leadDays
      const payDay = day + supplier.paymentTermDays
      const purchase = { id: next.id, supplierId, qty, unitPriceMinor: supplier.unitPriceMinor, orderedDay: day, expectedDay, deliveredDay: null, payDay, status: 'ordered' as const }
      return {
        state: { ...next.state, purchases: [...state.purchases, purchase] },
        schedule: [
          { time: expectedDay, priority: 'scheduled', event: { type: 'delivery', purchaseId: purchase.id } },
          { time: payDay, priority: 'scheduled', event: { type: 'payment_due', purchaseId: purchase.id } },
        ],
        record: { purchaseId: purchase.id, costMinor: qty * supplier.unitPriceMinor, expectedDay },
      }
    }
    case 'ship_order': {
      const { orderId, qty } = shipOrderParams.parse(action.params)
      const orders = state.orders.map((o) => {
        if (o.id !== orderId) return o
        const remaining = o.remaining - qty
        return { ...o, remaining, shippedQty: o.shippedQty + qty, lastShipDay: day, status: remaining === 0 ? ('shipped' as const) : ('partially_shipped' as const) }
      })
      const order = state.orders.find((o) => o.id === orderId)
      const collectDay = day + (order?.collectInDays ?? 0)
      return { state: { ...state, inventory: state.inventory - qty, shippedToday: state.shippedToday + qty, orders }, schedule: [{ time: collectDay, priority: 'scheduled', event: { type: 'collection', orderId, qty } }], record: { shipped: qty, collectDay } }
    }
    default:
      return { state, schedule: [], record: { text: String(action.params['text'] ?? '') } }
  }
}

function applyEvent(state: TradeState, event: TradeEvent, day: number): Applied<TradeState, TradeEvent> & { readonly record: Readonly<Record<string, unknown>> } {
  switch (event.type) {
    case 'demand': {
      const next = nextId(state, 'demand')
      const demand = { id: next.id, qty: event.qty, unitPriceMinor: event.unitPriceMinor, dueDay: day + event.dueInDays, collectInDays: event.collectInDays }
      return { state: { ...next.state, pendingDemand: [...state.pendingDemand, demand] }, schedule: [], record: { demandId: demand.id, dueDay: demand.dueDay } }
    }
    case 'supplier_delay': {
      const affected = state.purchases.filter((p) => p.supplierId === event.supplierId && p.status === 'ordered' && p.expectedDay >= day)
      const purchases = state.purchases.map((p) => (affected.includes(p) ? { ...p, expectedDay: p.expectedDay + event.extraDays } : p))
      return { state: { ...state, purchases }, schedule: affected.map((p) => ({ time: p.expectedDay + event.extraDays, priority: 'scheduled' as const, event: { type: 'delivery' as const, purchaseId: p.id } })), record: { delayed: affected.map((p) => p.id), extraDays: event.extraDays } }
    }
    case 'delivery': {
      const purchase = state.purchases.find((p) => p.id === event.purchaseId)
      if (purchase === undefined || purchase.status !== 'ordered') return { state, schedule: [], record: { ignored: 'not_ordered', purchaseId: event.purchaseId } }
      if (day < purchase.expectedDay) return { state, schedule: [], record: { ignored: 'before_expected_day', purchaseId: purchase.id, expectedDay: purchase.expectedDay } }
      const purchases = state.purchases.map((p) => (p.id === purchase.id ? { ...p, deliveredDay: day, status: 'delivered' as const } : p))
      return { state: { ...state, inventory: state.inventory + purchase.qty, purchases }, schedule: [], record: { purchaseId: purchase.id, qty: purchase.qty } }
    }
    case 'payment_due': {
      const purchase = state.purchases.find((p) => p.id === event.purchaseId)
      if (purchase === undefined || purchase.status === 'paid') return { state, schedule: [], record: { ignored: 'already_paid', purchaseId: event.purchaseId } }
      const amount = purchase.qty * purchase.unitPriceMinor
      const purchases = state.purchases.map((p) => (p.id === purchase.id ? { ...p, status: 'paid' as const } : p))
      return { state: { ...state, cashMinor: state.cashMinor - amount, purchases }, schedule: [], record: { purchaseId: purchase.id, paidMinor: amount } }
    }
    case 'collection': {
      const order = state.orders.find((o) => o.id === event.orderId)
      if (order === undefined) return { state, schedule: [], record: { ignored: 'unknown_order', orderId: event.orderId } }
      const amount = event.qty * order.unitPriceMinor
      return { state: { ...state, cashMinor: state.cashMinor + amount }, schedule: [], record: { orderId: order.id, collectedMinor: amount } }
    }
  }
}

function closeDay(state: TradeState, day: number): Applied<TradeState, TradeEvent> & { readonly record: Readonly<Record<string, unknown>> } {
  const minCash = state.cashMinor < state.minCashMinor ? { minCashMinor: state.cashMinor, minCashDay: day } : {}
  const openOrders = state.orders.filter((o) => o.status !== 'shipped').length
  const lateOrders = state.orders.filter((o) => o.status !== 'shipped' && day > o.dueDay).length
  return { state: { ...state, shippedToday: 0, ...minCash }, schedule: [], record: { inventory: state.inventory, cashMinor: state.cashMinor, openOrders, lateOrders } }
}

function observe(state: TradeState, role: RoleDefinition): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const key of role.observes) if (key in state) out[key] = (state as unknown as Record<string, unknown>)[key]
  return out
}

/** The trade sector (spec §5): one product, cash, orders, purchases, two suppliers, capacity. */
export const tradeModel: SectorModel<TradeState, TradeEvent, TradeRejection> = {
  name: 'trade',
  eventSchema: tradeEventSchema,
  externalEventSchema: tradeExternalEventSchema as unknown as SectorModel<TradeState, TradeEvent, TradeRejection>['externalEventSchema'],
  observe,
  validate,
  apply,
  applyEvent,
  closeDay,
}
```
Add to `src/index.ts`: `export * from './trade/state.js'`, `'./trade/events.js'`, `'./trade/actions.js'`, `'./trade/model.js'`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run packages/simulation/test/trade` → PASS; `npm run --silent typecheck` → 0.

- [ ] **Step 5: Commit**

```bash
git add packages/simulation
git commit -m "feat(simulation): m29 t3 — the trade sector: state, events, actions, rules; stock moves on delivery, cash on payment and collection"
```

---

### Task 4: Trade definition, demo scenario, rules provider (policies A / B), metrics

**Files:**
- Create: `packages/simulation/src/trade/definition.ts`, `packages/simulation/src/trade/rules.ts`, `packages/simulation/src/trade/metrics.ts`
- Modify: `packages/simulation/src/index.ts`
- Test: `packages/simulation/test/trade/policies.test.ts`, `packages/simulation/test/trade/metrics.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `TradePolicy = 'A' | 'B'`, `TradeSimulationDefinition`, `tradeSimulationDefinitionSchema`, `DEMO_SCENARIO`, `demoDefinition(input)`, `TRADE_ROLE_NAMES`, `TradeRosterEntry`; `RulesDecisionProvider`; `tradeMetrics(entries, state): TradeMetrics`; `TradeMetrics`; `tradeInitialEngineState(definition)`.

- [ ] **Step 1: Write the failing tests**

`packages/simulation/test/trade/policies.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { replay, runUntil } from '../../src/core/engine.js'
import { demoDefinition, tradeInitialEngineState } from '../../src/trade/definition.js'
import { tradeMetrics } from '../../src/trade/metrics.js'
import { tradeModel } from '../../src/trade/model.js'
import { RulesDecisionProvider } from '../../src/trade/rules.js'

const roster = [
  { slaveName: 'Sonia', departmentName: 'Sales' },
  { slaveName: 'Pete', departmentName: 'Purchasing' },
  { slaveName: 'Olga', departmentName: 'Operations' },
  { slaveName: 'Fin', departmentName: 'Finance' },
]

function run(policy: 'A' | 'B') {
  const definition = demoDefinition({ policy, seed: 1, roster, currency: 'USD' })
  const initial = tradeInitialEngineState(definition)
  const provider = new RulesDecisionProvider(definition)
  const result = runUntil(tradeModel, definition, initial, provider, definition.horizonDays, 1000)
  return { definition, initial, ...result, metrics: tradeMetrics(result.entries, result.state.sector) }
}

describe('the demo scenario under the two policies', () => {
  it('policy A waits for the normal supplier: cheaper, late; policy B hedges with the fast one: on time, dearer — no verdict', () => {
    const a = run('A')
    const b = run('B')
    expect(a.state.status).toBe('finished')
    expect(b.state.status).toBe('finished')
    expect(a.metrics.deliveredQty).toBe(150)
    expect(b.metrics.deliveredQty).toBe(150)
    expect(a.metrics.lateDays).toBeGreaterThan(0)
    expect(b.metrics.lateDays).toBe(0)
    expect(b.metrics.purchaseCostMinor).toBeGreaterThan(a.metrics.purchaseCostMinor)
    expect(b.metrics.minCashMinor).toBeLessThan(a.metrics.minCashMinor)
    expect(a.metrics.closingInventory).toBe(0)
    expect(b.metrics.closingInventory).toBe(50)
    // The normal purchase's payment day (31) lies past the horizon (30): a commitment, not spend.
    expect(a.metrics.unpaidCommitmentsMinor).toBe(50 * 6_000)
  })
  it('nothing happens without the rules: stock is 100 and no order is late before demand is accepted', () => {
    const a = run('A')
    const firstDecision = a.entries.find((e) => e.kind === 'decision')
    expect(firstDecision?.simTime).toBe(0)
    expect(a.entries.filter((e) => e.kind === 'action_rejected')).toHaveLength(0)
  })
  it('replay of either journal reproduces its state; two runs of one policy are identical', () => {
    const a = run('A')
    expect(replay(tradeModel, a.definition, a.initial, a.entries)).toEqual(a.state)
    const b1 = run('B')
    const b2 = run('B')
    expect(b1.entries).toEqual(b2.entries)
    expect(replay(tradeModel, b1.definition, b1.initial, b1.entries)).toEqual(b1.state)
  })
  it('the definition validates and freezes the roster it was given', () => {
    const definition = demoDefinition({ policy: 'A', seed: 3, roster, currency: 'USD' })
    expect(definition.synthetic).toBe(true)
    expect(definition.roles.map((r) => [r.name, r.slaveName])).toEqual([['sales', 'Sonia'], ['purchasing', 'Pete'], ['operations', 'Olga'], ['finance', 'Fin']])
    expect(() => demoDefinition({ policy: 'A', seed: 3, roster: roster.slice(0, 3), currency: 'USD' })).toThrow(/four/)
  })
})
```
`packages/simulation/test/trade/metrics.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import type { JournalEntry } from '../../src/core/journal.js'
import { tradeMetrics } from '../../src/trade/metrics.js'
import { initialTradeState } from '../../src/trade/state.js'

const e = (seq: number, simTime: number, kind: JournalEntry['kind'], payload: Record<string, unknown>): JournalEntry => ({ seq, simTime, kind, actorRole: null, payload })

describe('tradeMetrics', () => {
  it('computes each figure from the journal kinds it names, on a hand-checked three-day fixture', () => {
    const state = { ...initialTradeState({ cashMinor: 1_000, inventory: 5, dailyShipCapacity: 10, suppliers: [] }), cashMinor: 700, minCashMinor: 400, minCashDay: 2, orders: [{ id: 'order-1', qty: 12, remaining: 0, unitPriceMinor: 100, dueDay: 1, collectInDays: 0, shippedQty: 12, lastShipDay: 3, status: 'shipped' as const }], purchases: [{ id: 'purchase-1', supplierId: 's', qty: 7, unitPriceMinor: 50, orderedDay: 0, expectedDay: 1, deliveredDay: 1, payDay: 9, status: 'delivered' as const }] }
    const entries = [
      e(1, 0, 'action_applied', { action: { type: 'place_purchase' }, costMinor: 350 }),
      e(2, 1, 'action_applied', { action: { type: 'ship_order' }, shipped: 5 }),
      e(3, 3, 'action_applied', { action: { type: 'ship_order' }, shipped: 7 }),
      e(4, 3, 'event', { event: { type: 'collection' }, collectedMinor: 1_200 }),
    ]
    expect(tradeMetrics(entries, state)).toEqual({
      deliveredQty: 12, onTimeQty: 5, lateDays: 2, purchaseCostMinor: 350, closingInventory: 5, closingCashMinor: 700,
      minCashMinor: 400, minCashDay: 2, collectedMinor: 1_200, unpaidCommitmentsMinor: 350,
      sources: { deliveredQty: ['action_applied:ship_order'], lateDays: ['state.orders'], purchaseCostMinor: ['action_applied:place_purchase'], collectedMinor: ['event:collection'], unpaidCommitmentsMinor: ['state.purchases'] },
    })
  })
})
```
Note `onTimeQty`: units shipped on or before the order's due day — from `action_applied:ship_order` entries whose `simTime ≤ dueDay` of the order named in `action.params.orderId`; in the fixture the day-1 shipment (5) is on time for due day 1, the day-3 shipment (7) is late. The implementer needs `action.params.orderId` in the fixture: add `params: { orderId: 'order-1' }` to both `ship_order` actions in the fixture above.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/simulation/test/trade` → FAIL.

- [ ] **Step 3: Implement definition, rules, metrics**

`packages/simulation/src/trade/definition.ts`:
```ts
import { z } from 'zod'
import { initialEngineState, type EngineDefinition, type EngineState } from '../core/engine.js'
import type { RoleDefinition, ScheduleRequest } from '../core/sector.js'
import { tradeExternalEventSchema, type TradeEvent } from './events.js'
import { initialTradeState, supplierSchema, type TradeState } from './state.js'

export const TRADE_ROLE_NAMES = ['sales', 'purchasing', 'operations', 'finance'] as const
export type TradeRoleName = (typeof TRADE_ROLE_NAMES)[number]
export type TradePolicy = 'A' | 'B'

const roleSchema = z.object({ name: z.string(), purpose: z.string(), observes: z.array(z.string()), allowedActions: z.array(z.string()), constraints: z.record(z.number()), slaveName: z.string() })
const scenarioEventSchema = z.object({ day: z.number().int().nonnegative(), event: tradeExternalEventSchema })

export const tradeSimulationDefinitionSchema = z.object({
  sector: z.literal('trade'),
  synthetic: z.literal(true),
  currency: z.string().min(3).max(3),
  policy: z.enum(['A', 'B']),
  seed: z.number().int(),
  horizonDays: z.number().int().positive(),
  limits: z.object({ maxSteps: z.number().int().positive(), maxDecisionsPerStep: z.number().int().positive(), maxJournalEntries: z.number().int().positive() }),
  roles: z.array(roleSchema),
  roleOrder: z.array(z.string()),
  roster: z.array(z.object({ slaveName: z.string(), departmentName: z.string() })),
  initial: z.object({ cashMinor: z.number().int(), inventory: z.number().int().nonnegative(), dailyShipCapacity: z.number().int().positive(), suppliers: z.array(supplierSchema) }),
  scenario: z.array(scenarioEventSchema),
})
export type TradeSimulationDefinition = z.infer<typeof tradeSimulationDefinitionSchema> & EngineDefinition
export type TradeRosterEntry = { readonly slaveName: string; readonly departmentName: string }

/** The synthetic demo (spec §5.4). Not a real company; every number is an assumption. */
export const DEMO_SCENARIO = {
  currency: 'USD',
  horizonDays: 30,
  initial: {
    cashMinor: 5_000_000,
    inventory: 100,
    dailyShipCapacity: 30,
    suppliers: [
      { id: 'normal', name: 'Normal Supply', unitPriceMinor: 6_000, leadDays: 7, paymentTermDays: 30 },
      { id: 'fast', name: 'Fast Supply', unitPriceMinor: 8_500, leadDays: 2, paymentTermDays: 0 },
    ],
  },
  scenario: [
    { day: 1, event: { type: 'demand' as const, qty: 150, unitPriceMinor: 12_000, dueInDays: 10, collectInDays: 15 } },
    { day: 3, event: { type: 'supplier_delay' as const, supplierId: 'normal', extraDays: 6 } },
  ],
  limits: { maxSteps: 365, maxDecisionsPerStep: 8, maxJournalEntries: 20_000 },
} as const

const OBSERVES: Readonly<Record<TradeRoleName, readonly string[]>> = {
  sales: ['pendingDemand', 'orders', 'inventory'],
  purchasing: ['inventory', 'cashMinor', 'orders', 'purchases', 'suppliers', 'dailyShipCapacity'],
  operations: ['inventory', 'orders', 'dailyShipCapacity', 'shippedToday'],
  finance: ['cashMinor', 'purchases', 'orders', 'minCashMinor'],
}
const ALLOWED: Readonly<Record<TradeRoleName, readonly string[]>> = {
  sales: ['accept_order', 'note'],
  purchasing: ['place_purchase', 'note'],
  operations: ['ship_order', 'note'],
  finance: ['note'],
}
const PURPOSE: Readonly<Record<TradeRoleName, string>> = {
  sales: 'accepts customer demand into orders',
  purchasing: 'keeps stock able to cover open orders within cash',
  operations: 'ships open orders within the daily capacity',
  finance: 'watches cash and commitments',
}

/** Maps the four roles onto the frozen roster: by department name first, then by position. */
export function assignRoles(roster: readonly TradeRosterEntry[]): RoleDefinition[] {
  if (roster.length < TRADE_ROLE_NAMES.length) throw new Error(`the trade sector needs four slaves for its four roles; the roster has ${roster.length}`)
  const taken = new Set<string>()
  const pick = (role: TradeRoleName): string => {
    const byDepartment = roster.find((r) => r.departmentName.toLowerCase() === role && !taken.has(r.slaveName))
    const chosen = byDepartment ?? roster.find((r) => !taken.has(r.slaveName))
    if (chosen === undefined) throw new Error('roster exhausted')
    taken.add(chosen.slaveName)
    return chosen.slaveName
  }
  return TRADE_ROLE_NAMES.map((name) => ({ name, purpose: PURPOSE[name], observes: [...OBSERVES[name]], allowedActions: [...ALLOWED[name]], constraints: name === 'purchasing' ? { maxPurchaseQty: 500 } : {}, slaveName: pick(name) }))
}

export function demoDefinition(input: { readonly policy: TradePolicy; readonly seed: number; readonly roster: readonly TradeRosterEntry[]; readonly currency: string }): TradeSimulationDefinition {
  const roles = assignRoles(input.roster)
  return tradeSimulationDefinitionSchema.parse({
    sector: 'trade', synthetic: true, currency: input.currency, policy: input.policy, seed: input.seed,
    horizonDays: DEMO_SCENARIO.horizonDays, limits: DEMO_SCENARIO.limits, roles, roleOrder: [...TRADE_ROLE_NAMES],
    roster: input.roster, initial: DEMO_SCENARIO.initial, scenario: DEMO_SCENARIO.scenario,
  }) as TradeSimulationDefinition
}

export function tradeInitialEngineState(definition: TradeSimulationDefinition): EngineState<TradeState, TradeEvent> {
  const scenario: ScheduleRequest<TradeEvent>[] = definition.scenario.map((s) => ({ time: s.day, priority: 'external', event: s.event }))
  return initialEngineState(initialTradeState(definition.initial), scenario, definition.seed)
}
```
`packages/simulation/src/trade/rules.ts`:
```ts
import type { ActionEnvelope } from '../core/action.js'
import type { DecisionProvider, DecisionRequest } from '../decide/provider.js'
import type { TradeSimulationDefinition } from './definition.js'
import type { Order, PendingDemand, Purchase, Supplier } from './state.js'

const envelope = (type: string, params: Record<string, unknown>, rationale: string, refs: string[] = []): ActionEnvelope => ({ type, params, rationale, refs })

/**
 * The rules provider (spec §5.4). Deterministic, policy-parameterized, reads only the
 * observation it is handed. Policy A: buy the shortfall from `normal` and wait. Policy B: as A,
 * plus hedge the at-risk remainder from `fast` when cash allows. Neither is "the AI"; the UI
 * says `rules provider`.
 */
export class RulesDecisionProvider implements DecisionProvider {
  readonly kind = 'rules' as const
  constructor(private readonly definition: TradeSimulationDefinition) {}

  decide(request: DecisionRequest): readonly ActionEnvelope[] {
    const o = request.observation
    switch (request.role.name) {
      case 'sales':
        return ((o['pendingDemand'] as PendingDemand[] | undefined) ?? []).map((d) => envelope('accept_order', { orderId: d.id }, `demand ${d.id} for ${d.qty} due day ${d.dueDay}`, [d.id]))
      case 'purchasing':
        return this.purchasing(request.day, o)
      case 'operations':
        return this.operations(o)
      case 'finance': {
        const cash = Number(o['cashMinor'] ?? 0)
        const unpaid = ((o['purchases'] as Purchase[] | undefined) ?? []).filter((p) => p.status !== 'paid').reduce((s, p) => s + p.qty * p.unitPriceMinor, 0)
        return [envelope('note', { text: `cash ${cash} minor, unpaid commitments ${unpaid} minor` }, 'daily cash watch')]
      }
      default:
        return []
    }
  }

  private purchasing(day: number, o: Readonly<Record<string, unknown>>): ActionEnvelope[] {
    const inventory = Number(o['inventory'] ?? 0)
    const cash = Number(o['cashMinor'] ?? 0)
    const capacity = Math.max(1, Number(o['dailyShipCapacity'] ?? 1))
    const orders = ((o['orders'] as Order[] | undefined) ?? []).filter((x) => x.status !== 'shipped')
    const purchases = (o['purchases'] as Purchase[] | undefined) ?? []
    const suppliers = (o['suppliers'] as Supplier[] | undefined) ?? []
    const normal = suppliers.find((s) => s.id === 'normal')
    const fast = suppliers.find((s) => s.id === 'fast')
    const inbound = purchases.filter((p) => p.status === 'ordered')
    const unpaid = purchases.filter((p) => p.status !== 'paid').reduce((s, p) => s + p.qty * p.unitPriceMinor, 0)
    let available = cash - unpaid
    const actions: ActionEnvelope[] = []
    const remaining = orders.reduce((s, x) => s + x.remaining, 0)
    const inboundQty = inbound.reduce((s, p) => s + p.qty, 0)
    const shortfall = remaining - inventory - inboundQty
    if (shortfall > 0 && normal !== undefined && available >= shortfall * normal.unitPriceMinor) {
      actions.push(envelope('place_purchase', { supplierId: 'normal', qty: shortfall }, `shortfall ${shortfall} against open orders`, orders.map((x) => x.id)))
      available -= shortfall * normal.unitPriceMinor
    }
    if (this.definition.policy === 'B' && fast !== undefined) {
      let stock = inventory
      let inboundAfterHedge = [...inbound]
      for (const order of orders) {
        const fromStock = Math.min(stock, order.remaining)
        stock -= fromStock
        let uncovered = order.remaining - fromStock
        if (uncovered <= 0) continue
        const safe = inboundAfterHedge.filter((p) => p.expectedDay + Math.ceil(uncovered / capacity) <= order.dueDay)
        for (const p of safe) {
          const take = Math.min(p.qty, uncovered)
          uncovered -= take
          inboundAfterHedge = inboundAfterHedge.map((q) => (q.id === p.id ? { ...q, qty: q.qty - take } : q)).filter((q) => q.qty > 0)
          if (uncovered === 0) break
        }
        if (uncovered > 0 && day + fast.leadDays <= order.dueDay && available >= uncovered * fast.unitPriceMinor) {
          actions.push(envelope('place_purchase', { supplierId: 'fast', qty: uncovered }, `order ${order.id} at risk: ${uncovered} uncovered by day ${order.dueDay}`, [order.id]))
          available -= uncovered * fast.unitPriceMinor
        }
      }
    }
    return actions
  }

  private operations(o: Readonly<Record<string, unknown>>): ActionEnvelope[] {
    let inventory = Number(o['inventory'] ?? 0)
    let capacity = Number(o['dailyShipCapacity'] ?? 0) - Number(o['shippedToday'] ?? 0)
    const orders = ((o['orders'] as Order[] | undefined) ?? []).filter((x) => x.status !== 'shipped').sort((a, b) => a.dueDay - b.dueDay || a.id.localeCompare(b.id))
    const actions: ActionEnvelope[] = []
    for (const order of orders) {
      const qty = Math.min(order.remaining, inventory, capacity)
      if (qty <= 0) continue
      actions.push(envelope('ship_order', { orderId: order.id, qty }, `ship ${qty} of ${order.remaining} due day ${order.dueDay}`, [order.id]))
      inventory -= qty
      capacity -= qty
    }
    return actions
  }
}
```
`packages/simulation/src/trade/metrics.ts`:
```ts
import type { JournalEntry } from '../core/journal.js'
import { unpaidCommitmentsMinor, type TradeState } from './state.js'

export interface TradeMetrics {
  readonly deliveredQty: number
  readonly onTimeQty: number
  readonly lateDays: number
  readonly purchaseCostMinor: number
  readonly closingInventory: number
  readonly closingCashMinor: number
  readonly minCashMinor: number
  readonly minCashDay: number
  readonly collectedMinor: number
  readonly unpaidCommitmentsMinor: number
  /** Which journal kinds / state fields each derived figure reads — shown beside the number. */
  readonly sources: Readonly<Record<'deliveredQty' | 'lateDays' | 'purchaseCostMinor' | 'collectedMinor' | 'unpaidCommitmentsMinor', readonly string[]>>
}

function actionType(entry: JournalEntry): string | null {
  const action = entry.payload['action']
  return typeof action === 'object' && action !== null && 'type' in action ? String((action as { type: unknown }).type) : null
}
function eventType(entry: JournalEntry): string | null {
  const event = entry.payload['event']
  return typeof event === 'object' && event !== null && 'type' in event ? String((event as { type: unknown }).type) : null
}

/** Every figure comes from the journal or the closing state; nothing is estimated. */
export function tradeMetrics(entries: readonly JournalEntry[], state: TradeState): TradeMetrics {
  const dueByOrder = new Map(state.orders.map((o) => [o.id, o.dueDay]))
  let deliveredQty = 0
  let onTimeQty = 0
  let purchaseCostMinor = 0
  let collectedMinor = 0
  for (const entry of entries) {
    if (entry.kind === 'action_applied' && actionType(entry) === 'ship_order') {
      const qty = Number(entry.payload['shipped'] ?? 0)
      deliveredQty += qty
      const orderId = String((entry.payload['action'] as { params?: { orderId?: unknown } }).params?.orderId ?? '')
      const due = dueByOrder.get(orderId)
      if (due !== undefined && entry.simTime <= due) onTimeQty += qty
    }
    if (entry.kind === 'action_applied' && actionType(entry) === 'place_purchase') purchaseCostMinor += Number(entry.payload['costMinor'] ?? 0)
    if (entry.kind === 'event' && eventType(entry) === 'collection') collectedMinor += Number(entry.payload['collectedMinor'] ?? 0)
  }
  const lateDays = state.orders.reduce((sum, o) => sum + (o.lastShipDay !== null && o.status === 'shipped' ? Math.max(0, o.lastShipDay - o.dueDay) : 0), 0)
  return {
    deliveredQty, onTimeQty, lateDays, purchaseCostMinor, closingInventory: state.inventory, closingCashMinor: state.cashMinor,
    minCashMinor: state.minCashMinor, minCashDay: state.minCashDay, collectedMinor, unpaidCommitmentsMinor: unpaidCommitmentsMinor(state),
    sources: { deliveredQty: ['action_applied:ship_order'], lateDays: ['state.orders'], purchaseCostMinor: ['action_applied:place_purchase'], collectedMinor: ['event:collection'], unpaidCommitmentsMinor: ['state.purchases'] },
  }
}
```
Add to `src/index.ts`: `export * from './trade/definition.js'`, `'./trade/rules.js'`, `'./trade/metrics.js'`.

`lateDays` counts only orders that finished shipping late (an order still open at the horizon has no `lastShipDay` to measure). The policy test expects A's 150 units to finish on day 15 against due day 11 → `lateDays 4`; if the implementer's trace disagrees, check the day the order's remaining 50 lands (normal delivery day 14 → 30 shipped day 14, 20 shipped day 15).

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run packages/simulation` → PASS; `npm run --silent typecheck` → 0.

- [ ] **Step 5: Commit**

```bash
git add packages/simulation
git commit -m "feat(simulation): m29 t4 — the demo trade scenario, the rules provider with policies A and B, metrics from the journal"
```

---

### Task 5: Persistence — migration, Prisma models, seed company, refusal kinds

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (enums + 3 models + back-relations on `Company` and `User`)
- Create: `packages/db/prisma/migrations/20260906120000_m29_company_simulation/migration.sql`
- Modify: `packages/db/src/seed.ts` (Demo Trading Co.), `packages/control/src/refusal.ts`
- Test: `packages/control/test/refusal-text.test.ts` (+ cases), `packages/db/test/integration/seed.test.ts` (if it exists — otherwise assert in Task 6's fixture)

**Interfaces:**
- Produces: Prisma models `SimulationRun`, `SimulationJournalEntry`, `SimulationModelUsage`; enums `SimulationSector`, `SimulationMode`, `DecisionProviderKind`, `SimulationStatus`, `SimulationJournalKind`; refusal kinds `simulation_not_found`, `unsupported_simulation`, `simulation_not_runnable`, `stale_version`, `simulation_corrupt`, `live_simulations`, `roster_too_small`, `invalid_simulation_input`; seed constant `DEMO_TRADING_COMPANY_NAME = 'Demo Trading Co.'`.

- [ ] **Step 1: Write the failing refusal-text tests**

Append to `packages/control/test/refusal-text.test.ts`:
```ts
describe('refusalText for the simulation kinds (M29)', () => {
  it('names the run, the version, the company and the verb', () => {
    expect(refusalText({ kind: 'simulation_not_found', simulationId: 's1' })).toBe('no simulation with id s1')
    expect(refusalText({ kind: 'unsupported_simulation', sector: 'software', mode: 'simulation' })).toBe('a software company cannot run in simulation mode yet; supported: trade + simulation')
    expect(refusalText({ kind: 'simulation_not_runnable', simulationId: 's1', status: 'halted' })).toBe('simulation s1 is halted; it cannot be stepped')
    expect(refusalText({ kind: 'stale_version', simulationId: 's1', expected: 3, actual: 4 })).toBe('simulation s1 moved on (version 4, you saw 3): reload and retry')
    expect(refusalText({ kind: 'simulation_corrupt', simulationId: 's1', reason: 'state: bad' })).toBe('simulation s1 cannot be read: state: bad')
    expect(refusalText({ kind: 'live_simulations', companyId: 'c1', simulations: 2 })).toBe('company c1 has 2 simulations; delete them first')
    expect(refusalText({ kind: 'roster_too_small', companyId: 'c1', needed: 4, have: 1 })).toBe('company c1 has 1 slave; the trade sector needs 4 for its roles')
    expect(refusalText({ kind: 'invalid_simulation_input', detail: 'qty must be positive' })).toBe('invalid simulation input: qty must be positive')
  })
})
```
Run: `npx vitest run packages/control/test/refusal-text.test.ts` → FAIL (type error / wrong text).

- [ ] **Step 2: Add the refusal kinds and texts**

In `packages/control/src/refusal.ts`, extend `ControlRefusal`:
```ts
  /** M29: the simulation verbs (`simulation.ts`). */
  | { readonly kind: 'simulation_not_found'; readonly simulationId: string }
  | { readonly kind: 'unsupported_simulation'; readonly sector: string; readonly mode: string }
  | { readonly kind: 'simulation_not_runnable'; readonly simulationId: string; readonly status: string }
  | { readonly kind: 'stale_version'; readonly simulationId: string; readonly expected: number; readonly actual: number }
  | { readonly kind: 'simulation_corrupt'; readonly simulationId: string; readonly reason: string }
  /** `deleteCompany` while simulation runs still reference the company (M29 §3). */
  | { readonly kind: 'live_simulations'; readonly companyId: string; readonly simulations: number }
  | { readonly kind: 'roster_too_small'; readonly companyId: string; readonly needed: number; readonly have: number }
  | { readonly kind: 'invalid_simulation_input'; readonly detail: string }
```
and in `refusalText`:
```ts
    case 'simulation_not_found':
      return `no simulation with id ${refusal.simulationId}`
    case 'unsupported_simulation':
      return `a ${refusal.sector} company cannot run in ${refusal.mode} mode yet; supported: trade + simulation`
    case 'simulation_not_runnable':
      return `simulation ${refusal.simulationId} is ${refusal.status}; it cannot be stepped`
    case 'stale_version':
      return `simulation ${refusal.simulationId} moved on (version ${refusal.actual}, you saw ${refusal.expected}): reload and retry`
    case 'simulation_corrupt':
      return `simulation ${refusal.simulationId} cannot be read: ${refusal.reason}`
    case 'live_simulations':
      return `company ${refusal.companyId} has ${plural(refusal.simulations, 'simulation')}; delete them first`
    case 'roster_too_small':
      return `company ${refusal.companyId} has ${plural(refusal.have, 'slave')}; the trade sector needs ${refusal.needed} for its roles`
    case 'invalid_simulation_input':
      return `invalid simulation input: ${refusal.detail}`
```
Run the test → PASS.

- [ ] **Step 3: Schema and migration**

Append to `packages/db/prisma/schema.prisma` (after `model User`), and add `simulations SimulationRun[]` to `Company` and `User`:
```prisma
/// M29: a company simulation run (spec §3). Bound to the CATALOG company, never to a workspace:
/// the software flow is Git and stays so. `definition` is frozen at creation (roster snapshot,
/// roles, policy, scenario); `state` is the engine's current world; `version` is the optimistic
/// lock every step takes. Simulated money lives inside `state` as integer minor units — never in
/// a column that could be mistaken for real spend.
enum SimulationSector {
  trade
}

enum SimulationMode {
  simulation
}

enum DecisionProviderKind {
  rules
}

enum SimulationStatus {
  ready
  running
  paused
  finished
  halted
}

enum SimulationJournalKind {
  decision
  action_applied
  action_rejected
  event
  external_event
  control
}

model SimulationRun {
  id               String               @id @default(uuid())
  companyId        String
  name             String
  sector           SimulationSector
  mode             SimulationMode       @default(simulation)
  decisionProvider DecisionProviderKind @default(rules)
  seed             Int
  definition       Json
  state            Json
  version          Int                  @default(0)
  status           SimulationStatus     @default(ready)
  simTime          Int                  @default(0)
  stepCount        Int                  @default(0)
  decisionCount    Int                  @default(0)
  haltedReason     String?
  clonedFromId     String?
  createdByUserId  String?
  createdAt        DateTime             @default(now())

  company    Company         @relation(fields: [companyId], references: [id], onDelete: Restrict)
  clonedFrom SimulationRun?  @relation("SimulationClone", fields: [clonedFromId], references: [id], onDelete: SetNull)
  clones     SimulationRun[] @relation("SimulationClone")
  createdBy  User?           @relation(fields: [createdByUserId], references: [id], onDelete: SetNull)
  journal    SimulationJournalEntry[]
  modelUsage SimulationModelUsage[]

  @@unique([companyId, name])
  @@index([companyId])
}

/// The run's own ordered record: decisions, applied/rejected actions, rule events, injected
/// events, control operations. `seq` is per run; `idempotencyKey` makes a repeated control
/// request return its first outcome instead of stepping twice.
model SimulationJournalEntry {
  id             String                @id @default(uuid())
  simulationId   String
  seq            Int
  simTime        Int
  kind           SimulationJournalKind
  actorRole      String?
  payload        Json
  idempotencyKey String?
  createdAt      DateTime              @default(now())

  simulation SimulationRun @relation(fields: [simulationId], references: [id], onDelete: Cascade)

  @@unique([simulationId, seq])
  @@unique([simulationId, idempotencyKey])
  @@index([simulationId, simTime])
}

/// Real model spend attributable to a simulation (M31 writes it; M29 writes nothing). `costUsd`
/// null is UNMEASURED, the same rule as `SlaveRun.costUsd` — never 0 for an unknown figure.
model SimulationModelUsage {
  id           String       @id @default(uuid())
  simulationId String
  seq          Int
  provider     ProviderKind
  costUsd      Float?
  tokensIn     Int?
  tokensOut    Int?
  createdAt    DateTime     @default(now())

  simulation SimulationRun @relation(fields: [simulationId], references: [id], onDelete: Cascade)

  @@index([simulationId])
}
```
`packages/db/prisma/migrations/20260906120000_m29_company_simulation/migration.sql`:
```sql
-- M29: company simulation runs beside the software workspaces. Additive only: three tables,
-- five enums, no change to any existing row or column.
CREATE TYPE "SimulationSector" AS ENUM ('trade');
CREATE TYPE "SimulationMode" AS ENUM ('simulation');
CREATE TYPE "DecisionProviderKind" AS ENUM ('rules');
CREATE TYPE "SimulationStatus" AS ENUM ('ready', 'running', 'paused', 'finished', 'halted');
CREATE TYPE "SimulationJournalKind" AS ENUM ('decision', 'action_applied', 'action_rejected', 'event', 'external_event', 'control');

CREATE TABLE "SimulationRun" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sector" "SimulationSector" NOT NULL,
  "mode" "SimulationMode" NOT NULL DEFAULT 'simulation',
  "decisionProvider" "DecisionProviderKind" NOT NULL DEFAULT 'rules',
  "seed" INTEGER NOT NULL,
  "definition" JSONB NOT NULL,
  "state" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "status" "SimulationStatus" NOT NULL DEFAULT 'ready',
  "simTime" INTEGER NOT NULL DEFAULT 0,
  "stepCount" INTEGER NOT NULL DEFAULT 0,
  "decisionCount" INTEGER NOT NULL DEFAULT 0,
  "haltedReason" TEXT,
  "clonedFromId" TEXT,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SimulationRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SimulationRun_companyId_name_key" ON "SimulationRun"("companyId", "name");
CREATE INDEX "SimulationRun_companyId_idx" ON "SimulationRun"("companyId");
ALTER TABLE "SimulationRun" ADD CONSTRAINT "SimulationRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SimulationRun" ADD CONSTRAINT "SimulationRun_clonedFromId_fkey" FOREIGN KEY ("clonedFromId") REFERENCES "SimulationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SimulationRun" ADD CONSTRAINT "SimulationRun_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "SimulationJournalEntry" (
  "id" TEXT NOT NULL,
  "simulationId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "simTime" INTEGER NOT NULL,
  "kind" "SimulationJournalKind" NOT NULL,
  "actorRole" TEXT,
  "payload" JSONB NOT NULL,
  "idempotencyKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SimulationJournalEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SimulationJournalEntry_simulationId_seq_key" ON "SimulationJournalEntry"("simulationId", "seq");
CREATE UNIQUE INDEX "SimulationJournalEntry_simulationId_idempotencyKey_key" ON "SimulationJournalEntry"("simulationId", "idempotencyKey");
CREATE INDEX "SimulationJournalEntry_simulationId_simTime_idx" ON "SimulationJournalEntry"("simulationId", "simTime");
ALTER TABLE "SimulationJournalEntry" ADD CONSTRAINT "SimulationJournalEntry_simulationId_fkey" FOREIGN KEY ("simulationId") REFERENCES "SimulationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SimulationModelUsage" (
  "id" TEXT NOT NULL,
  "simulationId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "provider" "ProviderKind" NOT NULL,
  "costUsd" DOUBLE PRECISION,
  "tokensIn" INTEGER,
  "tokensOut" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SimulationModelUsage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SimulationModelUsage_simulationId_idx" ON "SimulationModelUsage"("simulationId");
ALTER TABLE "SimulationModelUsage" ADD CONSTRAINT "SimulationModelUsage_simulationId_fkey" FOREIGN KEY ("simulationId") REFERENCES "SimulationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```
Run: `npm run db:generate && npm run db:migrate && npm run db:migrate:test`. Then `npx prisma migrate diff --from-migrations packages/db/prisma/migrations --to-schema-datamodel packages/db/prisma/schema.prisma --shadow-database-url "$TEST_DATABASE_URL" --script` should print an empty script (the migration matches the schema); if it prints DDL, adjust the SQL to match what it prints rather than the other way round.

- [ ] **Step 4: Seed the demo trading company**

In `packages/db/src/seed.ts`, add after the Atlas roster loop:
```ts
  // M29: a second, non-software company so the Simulations page has a roster to freeze. Four
  // departments named for the trade sector's four roles, one catalog slave each, from one
  // generic template. Synthetic like everything else here; never assigned to a workspace.
  const tradeTemplate = await prisma.slaveTemplate.create({ data: { name: 'Trade Clerk', role: 'clerk', defaultModel: null } })
  const trading = await prisma.company.create({ data: { name: DEMO_TRADING_COMPANY_NAME } })
  for (const [department, slave] of TRADE_ROSTER) {
    const team = await prisma.companyTeam.create({ data: { companyId: trading.id, name: department } })
    await prisma.companySlave.create({ data: { companyTeamId: team.id, templateId: tradeTemplate.id, name: slave } })
  }
```
with, near the other constants:
```ts
export const DEMO_TRADING_COMPANY_NAME = 'Demo Trading Co.'
const TRADE_ROSTER: readonly (readonly [string, string])[] = [['Sales', 'Sonia'], ['Purchasing', 'Pete'], ['Operations', 'Olga'], ['Finance', 'Fin']]
```
Add `"SimulationModelUsage", "SimulationJournalEntry", "SimulationRun"` at the FRONT of the seed's `TRUNCATE` list (FK order: children first). Run `npm run db:seed`; then `npx vitest run packages/db` (whatever seed test exists) → PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run --silent typecheck` → 0.
```bash
git add packages/db packages/control
git commit -m "feat(db,control): m29 t5 — SimulationRun / journal / model-usage tables, the demo trading company, the simulation refusals"
```

---

### Task 6: Control verbs — create, step, pause/resume, inject, halt, delete; `deleteCompany` refuses

**Files:**
- Create: `packages/control/src/simulation.ts`
- Modify: `packages/control/src/index.ts` (`export * from './simulation.js'`), `packages/control/package.json` (`"@slave-of-ai/simulation": "*"`), `packages/control/tsconfig.json` (reference `../simulation`), `packages/control/src/org.ts` (`deleteCompany`)
- Test: `packages/control/test/integration/simulation.test.ts`, `packages/control/test/integration/delete-company-simulations.test.ts` (or a case inside the existing org delete test file)

**Interfaces:**
- Consumes: Task 4's `demoDefinition`, `tradeInitialEngineState`, `tradeModel`, `RulesDecisionProvider`, `runUntil`, `replay`, `tradeSimulationDefinitionSchema`, `tradeStateSchema`, `tradeExternalEventSchema`; Task 5's models and refusals.
- Produces:
```ts
export interface SimulationSummary { id, companyId, companyName, name, sector, mode, decisionProvider, policy, status, simTime, horizonDays, stepCount, decisionCount, version, haltedReason, createdAt, synthetic: true }
export function createSimulation(input: { companyId: string; name: string; sector: 'trade'; mode?: 'simulation'; policy: 'A' | 'B'; seed?: number; scenario?: 'demo' }, principal?: Principal): Promise<Result<{ id: string }, ControlRefusal>>
export function stepSimulation(simulationId: string, input: { steps?: number; untilDay?: number; idempotencyKey?: string; expectedVersion?: number }, principal?: Principal): Promise<Result<{ day: number; status: string; version: number; entries: number; replayed: boolean }, ControlRefusal>>
export function pauseSimulation(simulationId, principal?) / resumeSimulation / haltSimulation(simulationId, reason, principal?) / deleteSimulation(simulationId, principal?): Promise<Result<void, ControlRefusal>>
export function injectExternalEvent(simulationId: string, input: { day: number; event: unknown; idempotencyKey?: string }, principal?): Promise<Result<void, ControlRefusal>>
export function listSimulations(companyId?: string): Promise<readonly SimulationSummary[]>
export function loadSimulation(simulationId: string): Promise<Result<LoadedSimulation, ControlRefusal>>   // parsed definition + engine state + summary
export function replaySimulation(simulationId: string): Promise<Result<{ matches: boolean }, ControlRefusal>>
export const MAX_STEPS_PER_REQUEST = 365
```

- [ ] **Step 1: Write the failing integration tests**

`packages/control/test/integration/simulation.test.ts`:
```ts
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deleteCompany, renameCompanyTeam } from '../../src/org.js'
import { createSimulation, deleteSimulation, haltSimulation, injectExternalEvent, listSimulations, loadSimulation, pauseSimulation, replaySimulation, resumeSimulation, stepSimulation } from '../../src/simulation.js'

async function seedTradingCompany(name = 'Demo Trading Co.'): Promise<string> {
  const template = await prisma.slaveTemplate.upsert({ where: { name: 'Trade Clerk' }, create: { name: 'Trade Clerk', role: 'clerk' }, update: {} })
  const company = await prisma.company.create({ data: { name } })
  for (const [department, slave] of [['Sales', 'Sonia'], ['Purchasing', 'Pete'], ['Operations', 'Olga'], ['Finance', 'Fin']] as const) {
    const team = await prisma.companyTeam.create({ data: { companyId: company.id, name: department } })
    await prisma.companySlave.create({ data: { companyTeamId: team.id, templateId: template.id, name: slave } })
  }
  return company.id
}

let companyId: string
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "SimulationModelUsage", "SimulationJournalEntry", "SimulationRun", "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE')
  companyId = await seedTradingCompany()
})
afterAll(async () => { await prisma.$disconnect() })

async function create(name = 'Q3 plan', policy: 'A' | 'B' = 'A'): Promise<string> {
  const result = await createSimulation({ companyId, name, sector: 'trade', policy, seed: 7 })
  expect(result.ok).toBe(true)
  return result.ok ? result.value.id : ''
}

describe('createSimulation', () => {
  it('freezes the roster: a catalog rename afterwards does not reach the definition', async () => {
    const id = await create()
    const team = await prisma.companyTeam.findFirstOrThrow({ where: { companyId, name: 'Sales' } })
    await renameCompanyTeam(team.id, 'Revenue')
    await prisma.companySlave.updateMany({ where: { companyTeamId: team.id }, data: { name: 'Someone Else' } })
    const loaded = await loadSimulation(id)
    expect(loaded.ok && loaded.value.definition.roles[0]).toMatchObject({ name: 'sales', slaveName: 'Sonia' })
    expect(loaded.ok && loaded.value.definition.roster.map((r) => r.departmentName)).toContain('Sales')
  })
  it('refuses an unsupported sector/mode, a small roster, a duplicate name, an unknown company', async () => {
    const unsupported = await createSimulation({ companyId, name: 'x', sector: 'software' as unknown as 'trade', policy: 'A' })
    expect(unsupported.ok === false && unsupported.error).toEqual({ kind: 'unsupported_simulation', sector: 'software', mode: 'simulation' })
    const small = await prisma.company.create({ data: { name: 'Tiny' } })
    const tooSmall = await createSimulation({ companyId: small.id, name: 'x', sector: 'trade', policy: 'A' })
    expect(tooSmall.ok === false && tooSmall.error).toEqual({ kind: 'roster_too_small', companyId: small.id, needed: 4, have: 0 })
    await create('dup')
    const dup = await createSimulation({ companyId, name: 'dup', sector: 'trade', policy: 'A' })
    expect(dup.ok === false && dup.error).toEqual({ kind: 'duplicate_name', name: 'dup' })
    const unknown = await createSimulation({ companyId: '00000000-0000-4000-8000-00000000dead', name: 'x', sector: 'trade', policy: 'A' })
    expect(unknown.ok === false && unknown.error.kind).toBe('company_not_found')
  })
  it('two runs from one company never share state', async () => {
    const a = await create('a', 'A')
    const b = await create('b', 'B')
    await stepSimulation(a, { untilDay: 30 })
    const la = await loadSimulation(a)
    const lb = await loadSimulation(b)
    expect(la.ok && la.value.state.day).toBe(30)
    expect(lb.ok && lb.value.state.day).toBe(0)
    expect(lb.ok && lb.value.state.sector.inventory).toBe(100)
    expect(await prisma.simulationJournalEntry.count({ where: { simulationId: b } })).toBe(1) // the create record only
  })
})

describe('stepSimulation', () => {
  it('persists state, counters, version and the journal atomically; the same idempotency key returns the first outcome without stepping', async () => {
    const id = await create()
    const first = await stepSimulation(id, { steps: 3, idempotencyKey: 'k1' })
    expect(first.ok && first.value).toMatchObject({ day: 3, status: 'running', version: 1, replayed: false })
    const again = await stepSimulation(id, { steps: 3, idempotencyKey: 'k1' })
    expect(again.ok && again.value).toMatchObject({ day: 3, version: 1, replayed: true })
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ simTime: 3, stepCount: 3, version: 1, status: 'running' })
    const entries = await prisma.simulationJournalEntry.findMany({ where: { simulationId: id }, orderBy: { seq: 'asc' } })
    expect(entries.at(-1)).toMatchObject({ kind: 'control', idempotencyKey: 'k1' })
    expect(new Set(entries.map((e) => e.seq)).size).toBe(entries.length)
  })
  it('refuses a stale version and a paused, halted or finished run', async () => {
    const id = await create()
    await stepSimulation(id, { steps: 1 })
    const stale = await stepSimulation(id, { steps: 1, expectedVersion: 0 })
    expect(stale.ok === false && stale.error).toEqual({ kind: 'stale_version', simulationId: id, expected: 0, actual: 1 })
    expect((await pauseSimulation(id)).ok).toBe(true)
    const paused = await stepSimulation(id, { steps: 1 })
    expect(paused.ok === false && paused.error).toEqual({ kind: 'simulation_not_runnable', simulationId: id, status: 'paused' })
    expect((await resumeSimulation(id)).ok).toBe(true)
    expect((await stepSimulation(id, { untilDay: 30 })).ok).toBe(true)
    const finished = await stepSimulation(id, { steps: 1 })
    expect(finished.ok === false && finished.error).toEqual({ kind: 'simulation_not_runnable', simulationId: id, status: 'finished' })
    const other = await create('other')
    expect((await haltSimulation(other, 'operator')).ok).toBe(true)
    const halted = await stepSimulation(other, { steps: 1 })
    expect(halted.ok === false && halted.error).toEqual({ kind: 'simulation_not_runnable', simulationId: other, status: 'halted' })
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id: other } })).haltedReason).toBe('operator')
  })
  it('a stored run replays to the same state from its journal, and writes no model usage', async () => {
    const id = await create('r', 'B')
    await stepSimulation(id, { untilDay: 30 })
    const verdict = await replaySimulation(id)
    expect(verdict.ok && verdict.value.matches).toBe(true)
    expect(await prisma.simulationModelUsage.count({ where: { simulationId: id } })).toBe(0)
  })
  it('two concurrent steps: one wins, the other sees stale_version, and the journal has no duplicate seq', async () => {
    const id = await create()
    const [a, b] = await Promise.all([stepSimulation(id, { steps: 2, expectedVersion: 0 }), stepSimulation(id, { steps: 2, expectedVersion: 0 })])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(row.simTime).toBe(2)
  })
})

describe('injectExternalEvent', () => {
  it('validates against the sector, refuses a past day and a non-external event, and is idempotent', async () => {
    const id = await create()
    await stepSimulation(id, { steps: 2 })
    const past = await injectExternalEvent(id, { day: 1, event: { type: 'demand', qty: 10, unitPriceMinor: 1, dueInDays: 3, collectInDays: 0 } })
    expect(past.ok === false && past.error.kind).toBe('invalid_simulation_input')
    const delivery = await injectExternalEvent(id, { day: 5, event: { type: 'delivery', purchaseId: 'purchase-1' } })
    expect(delivery.ok === false && delivery.error.kind).toBe('invalid_simulation_input')
    const ok1 = await injectExternalEvent(id, { day: 5, event: { type: 'demand', qty: 10, unitPriceMinor: 1_000, dueInDays: 3, collectInDays: 0 }, idempotencyKey: 'ev1' })
    const ok2 = await injectExternalEvent(id, { day: 5, event: { type: 'demand', qty: 10, unitPriceMinor: 1_000, dueInDays: 3, collectInDays: 0 }, idempotencyKey: 'ev1' })
    expect(ok1.ok && ok2.ok).toBe(true)
    const loaded = await loadSimulation(id)
    expect(loaded.ok && loaded.value.state.queue.items.filter((i) => i.time === 5)).toHaveLength(1)
    // The scenario's day-1 demand is journaled as `external_event` too; the injected one is the row with the key.
    expect(await prisma.simulationJournalEntry.count({ where: { simulationId: id, kind: 'external_event', idempotencyKey: 'ev1' } })).toBe(1)
  })
})

describe('delete', () => {
  it('deleteSimulation cascades the journal; deleteCompany refuses while runs exist and works after', async () => {
    const id = await create()
    await stepSimulation(id, { steps: 1 })
    const refused = await deleteCompany(companyId)
    expect(refused.ok === false && refused.error).toEqual({ kind: 'live_simulations', companyId, simulations: 1 })
    expect((await deleteSimulation(id)).ok).toBe(true)
    expect(await prisma.simulationJournalEntry.count()).toBe(0)
    expect((await deleteCompany(companyId)).ok).toBe(true)
    expect(await listSimulations()).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/control/test/integration/simulation.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement the verbs**

Wire the package first: `packages/control/package.json` dependencies add `"@slave-of-ai/simulation": "*"`; `packages/control/tsconfig.json` references add `{ "path": "../simulation" }`; `npm install`.

`packages/control/src/simulation.ts`:
```ts
import { Prisma, prisma } from '@slave-of-ai/db/client'
import { err, ok, type Result } from '@slave-of-ai/domain'
import {
  RulesDecisionProvider, demoDefinition, replay, runUntil, tradeExternalEventSchema, tradeInitialEngineState, tradeModel,
  tradeSimulationDefinitionSchema, tradeStateSchema, type EngineState, type JournalEntry, type TradeEvent, type TradeSimulationDefinition, type TradeState,
} from '@slave-of-ai/simulation'
import { z } from 'zod'
import { isUniqueConstraintViolation } from './prisma-errors.js'
import type { Principal } from './principal.js'
import type { ControlRefusal } from './refusal.js'

/** One request steps at most this many days, whatever `untilDay` asks (spec §6). */
export const MAX_STEPS_PER_REQUEST = 365

const SUPPORTED: ReadonlySet<string> = new Set(['trade:simulation'])

export interface SimulationSummary {
  readonly id: string
  readonly companyId: string
  readonly companyName: string
  readonly name: string
  readonly sector: 'trade'
  readonly mode: 'simulation'
  readonly decisionProvider: 'rules'
  readonly policy: 'A' | 'B'
  readonly status: 'ready' | 'running' | 'paused' | 'finished' | 'halted'
  readonly simTime: number
  readonly horizonDays: number
  readonly stepCount: number
  readonly decisionCount: number
  readonly version: number
  readonly haltedReason: string | null
  readonly createdAt: string
  readonly synthetic: true
}

export interface LoadedSimulation {
  readonly summary: SimulationSummary
  readonly definition: TradeSimulationDefinition
  readonly state: EngineState<TradeState, TradeEvent>
}

const queueItemSchema = z.object({ time: z.number().int(), priority: z.enum(['external', 'scheduled', 'decision', 'close']), seq: z.number().int(), event: z.unknown() })
const engineStateSchema = z.object({
  day: z.number().int(), sector: tradeStateSchema, queue: z.object({ items: z.array(queueItemSchema), nextSeq: z.number().int() }), rngState: z.number(),
  journalSeq: z.number().int(), stepCount: z.number().int(), decisionCount: z.number().int(), status: z.enum(['ready', 'running', 'finished', 'halted']), haltedReason: z.string().nullable(),
})

type Row = Prisma.SimulationRunGetPayload<{ include: { company: { select: { name: true } } } }>

function summarize(row: Row, definition: TradeSimulationDefinition): SimulationSummary {
  return {
    id: row.id, companyId: row.companyId, companyName: row.company.name, name: row.name, sector: 'trade', mode: 'simulation', decisionProvider: 'rules',
    policy: definition.policy, status: row.status, simTime: row.simTime, horizonDays: definition.horizonDays, stepCount: row.stepCount, decisionCount: row.decisionCount,
    version: row.version, haltedReason: row.haltedReason, createdAt: row.createdAt.toISOString(), synthetic: true,
  }
}

function parseRow(row: Row): Result<LoadedSimulation, ControlRefusal> {
  const definition = tradeSimulationDefinitionSchema.safeParse(row.definition)
  if (!definition.success) return err({ kind: 'simulation_corrupt', simulationId: row.id, reason: `definition: ${definition.error.issues[0]?.message ?? 'invalid'}` })
  const state = engineStateSchema.safeParse(row.state)
  if (!state.success) return err({ kind: 'simulation_corrupt', simulationId: row.id, reason: `state: ${state.error.issues[0]?.message ?? 'invalid'}` })
  const typed = definition.data as TradeSimulationDefinition
  return ok({ summary: summarize(row, typed), definition: typed, state: state.data as EngineState<TradeState, TradeEvent> })
}

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

function journalRows(simulationId: string, entries: readonly JournalEntry[]): Prisma.SimulationJournalEntryCreateManyInput[] {
  return entries.map((e) => ({ simulationId, seq: e.seq, simTime: e.simTime, kind: e.kind, actorRole: e.actorRole, payload: json(e.payload) }))
}

export async function createSimulation(
  input: { readonly companyId: string; readonly name: string; readonly sector: 'trade'; readonly mode?: 'simulation'; readonly policy: 'A' | 'B'; readonly seed?: number; readonly scenario?: 'demo' },
  principal?: Principal,
): Promise<Result<{ readonly id: string }, ControlRefusal>> {
  const mode = input.mode ?? 'simulation'
  if (!SUPPORTED.has(`${input.sector}:${mode}`)) return err({ kind: 'unsupported_simulation', sector: input.sector, mode })
  if (input.name.trim() === '') return err({ kind: 'invalid_simulation_input', detail: 'name must not be empty' })
  const company = await prisma.company.findUnique({ where: { id: input.companyId }, include: { teams: { orderBy: { name: 'asc' }, include: { slaves: { orderBy: { name: 'asc' } } } } } })
  if (company === null) return err({ kind: 'company_not_found', companyId: input.companyId })
  const roster = company.teams.flatMap((team) => team.slaves.map((slave) => ({ slaveName: slave.name, departmentName: team.name })))
  if (roster.length < 4) return err({ kind: 'roster_too_small', companyId: company.id, needed: 4, have: roster.length })
  const seed = input.seed ?? 1
  const definition = demoDefinition({ policy: input.policy, seed, roster, currency: 'USD' })
  const state = tradeInitialEngineState(definition)
  try {
    const row = await prisma.simulationRun.create({
      data: {
        companyId: company.id, name: input.name.trim(), sector: 'trade', mode: 'simulation', decisionProvider: 'rules', seed,
        definition: json(definition), state: json(state), createdByUserId: principal?.userId ?? null,
        journal: { create: { seq: 0, simTime: 0, kind: 'control', actorRole: null, payload: { op: 'created', policy: input.policy, seed, synthetic: true } } },
      },
    })
    return ok({ id: row.id })
  } catch (error) {
    if (isUniqueConstraintViolation(error)) return err({ kind: 'duplicate_name', name: input.name.trim() })
    throw error
  }
}

async function locked(tx: Prisma.TransactionClient, simulationId: string): Promise<Result<{ row: Row; loaded: LoadedSimulation }, ControlRefusal>> {
  await tx.$queryRaw`SELECT id FROM "SimulationRun" WHERE id = ${simulationId} FOR UPDATE`
  const row = await tx.simulationRun.findUnique({ where: { id: simulationId }, include: { company: { select: { name: true } } } })
  if (row === null) return err({ kind: 'simulation_not_found', simulationId })
  const loaded = parseRow(row)
  return loaded.ok ? ok({ row, loaded: loaded.value }) : loaded
}

export async function stepSimulation(
  simulationId: string,
  input: { readonly steps?: number; readonly untilDay?: number; readonly idempotencyKey?: string; readonly expectedVersion?: number },
  _principal?: Principal,
): Promise<Result<{ readonly day: number; readonly status: string; readonly version: number; readonly entries: number; readonly replayed: boolean }, ControlRefusal>> {
  if (input.steps !== undefined && (!Number.isInteger(input.steps) || input.steps < 1)) return err({ kind: 'invalid_simulation_input', detail: 'steps must be a positive integer' })
  if (input.untilDay !== undefined && (!Number.isInteger(input.untilDay) || input.untilDay < 0)) return err({ kind: 'invalid_simulation_input', detail: 'untilDay must be a non-negative integer' })
  return prisma.$transaction(async (tx) => {
    const got = await locked(tx, simulationId)
    if (!got.ok) return got
    const { row, loaded } = got.value
    if (input.idempotencyKey !== undefined) {
      const seen = await tx.simulationJournalEntry.findUnique({ where: { simulationId_idempotencyKey: { simulationId, idempotencyKey: input.idempotencyKey } } })
      if (seen !== null) {
        const p = seen.payload as { day?: number; status?: string; version?: number; entries?: number }
        return ok({ day: p.day ?? row.simTime, status: p.status ?? row.status, version: p.version ?? row.version, entries: p.entries ?? 0, replayed: true })
      }
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) return err({ kind: 'stale_version', simulationId, expected: input.expectedVersion, actual: row.version })
    if (row.status !== 'ready' && row.status !== 'running') return err({ kind: 'simulation_not_runnable', simulationId, status: row.status })
    const untilDay = input.untilDay ?? loaded.state.day + (input.steps ?? 1)
    const provider = new RulesDecisionProvider(loaded.definition)
    const result = runUntil(tradeModel, loaded.definition, loaded.state, provider, Math.min(untilDay, loaded.definition.horizonDays), MAX_STEPS_PER_REQUEST)
    const version = row.version + 1
    const status = result.state.status
    const controlSeq = result.state.journalSeq + 1
    const outcome = { day: result.state.day, status, version, entries: result.entries.length }
    await tx.simulationJournalEntry.createMany({ data: journalRows(simulationId, result.entries) })
    await tx.simulationJournalEntry.create({
      data: { simulationId, seq: controlSeq, simTime: result.state.day, kind: 'control', actorRole: null, idempotencyKey: input.idempotencyKey ?? null, payload: { op: 'stepped', ...outcome } },
    })
    await tx.simulationRun.update({
      where: { id: simulationId },
      data: { state: json({ ...result.state, journalSeq: controlSeq }), version, status, simTime: result.state.day, stepCount: result.state.stepCount, decisionCount: result.state.decisionCount, haltedReason: result.state.haltedReason },
    })
    return ok({ ...outcome, replayed: false })
  })
}

async function setStatus(simulationId: string, from: readonly string[], to: 'paused' | 'running' | 'halted', op: string, haltedReason: string | null): Promise<Result<void, ControlRefusal>> {
  return prisma.$transaction(async (tx) => {
    const got = await locked(tx, simulationId)
    if (!got.ok) return got
    const { row, loaded } = got.value
    if (!from.includes(row.status)) return err({ kind: 'simulation_not_runnable', simulationId, status: row.status })
    const seq = loaded.state.journalSeq + 1
    await tx.simulationJournalEntry.create({ data: { simulationId, seq, simTime: row.simTime, kind: 'control', actorRole: null, payload: { op, reason: haltedReason } } })
    await tx.simulationRun.update({ where: { id: simulationId }, data: { status: to, haltedReason, state: json({ ...loaded.state, journalSeq: seq, status: to === 'paused' ? loaded.state.status : to }) } })
    return ok(undefined)
  })
}

export const pauseSimulation = (id: string, _principal?: Principal): Promise<Result<void, ControlRefusal>> => setStatus(id, ['ready', 'running'], 'paused', 'paused', null)
export const resumeSimulation = (id: string, _principal?: Principal): Promise<Result<void, ControlRefusal>> => setStatus(id, ['paused'], 'running', 'resumed', null)
/** The emergency stop. Stepping is in-request, so nothing is in flight to kill: this blocks every
 *  next step (and, in M31, every model call). */
export const haltSimulation = (id: string, reason: string, _principal?: Principal): Promise<Result<void, ControlRefusal>> => setStatus(id, ['ready', 'running', 'paused'], 'halted', 'halted', reason)

export async function injectExternalEvent(
  simulationId: string,
  input: { readonly day: number; readonly event: unknown; readonly idempotencyKey?: string },
  _principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  const parsed = tradeExternalEventSchema.safeParse(input.event)
  if (!parsed.success) return err({ kind: 'invalid_simulation_input', detail: `event: ${parsed.error.issues[0]?.message ?? 'not an external event'}` })
  return prisma.$transaction(async (tx) => {
    const got = await locked(tx, simulationId)
    if (!got.ok) return got
    const { row, loaded } = got.value
    if (!Number.isInteger(input.day) || input.day < loaded.state.day) return err({ kind: 'invalid_simulation_input', detail: `day must be an integer ≥ the current day (${loaded.state.day})` })
    if (input.idempotencyKey !== undefined) {
      const seen = await tx.simulationJournalEntry.findUnique({ where: { simulationId_idempotencyKey: { simulationId, idempotencyKey: input.idempotencyKey } } })
      if (seen !== null) return ok(undefined)
    }
    const queue = loaded.state.queue
    const item = { time: input.day, priority: 'external' as const, seq: queue.nextSeq, event: parsed.data }
    const seq = loaded.state.journalSeq + 1
    await tx.simulationJournalEntry.create({ data: { simulationId, seq, simTime: row.simTime, kind: 'external_event', actorRole: null, idempotencyKey: input.idempotencyKey ?? null, payload: { op: 'injected', day: input.day, event: json(parsed.data) } } })
    await tx.simulationRun.update({ where: { id: simulationId }, data: { state: json({ ...loaded.state, journalSeq: seq, queue: { items: [...queue.items, item], nextSeq: queue.nextSeq + 1 } }) } })
    return ok(undefined)
  })
}

export async function deleteSimulation(simulationId: string, _principal?: Principal): Promise<Result<void, ControlRefusal>> {
  const { count } = await prisma.simulationRun.deleteMany({ where: { id: simulationId } })
  return count === 0 ? err({ kind: 'simulation_not_found', simulationId }) : ok(undefined)
}

export async function loadSimulation(simulationId: string): Promise<Result<LoadedSimulation, ControlRefusal>> {
  const row = await prisma.simulationRun.findUnique({ where: { id: simulationId }, include: { company: { select: { name: true } } } })
  if (row === null) return err({ kind: 'simulation_not_found', simulationId })
  return parseRow(row)
}

export async function listSimulations(companyId?: string): Promise<readonly SimulationSummary[]> {
  const rows = await prisma.simulationRun.findMany({ where: companyId === undefined ? {} : { companyId }, include: { company: { select: { name: true } } }, orderBy: [{ createdAt: 'desc' }] })
  return rows.flatMap((row) => { const p = parseRow(row); return p.ok ? [p.value.summary] : [] })
}

/** Re-runs the engine from the frozen definition with the journal's own decisions and compares. */
export async function replaySimulation(simulationId: string): Promise<Result<{ readonly matches: boolean }, ControlRefusal>> {
  const loaded = await loadSimulation(simulationId)
  if (!loaded.ok) return loaded
  const rows = await prisma.simulationJournalEntry.findMany({ where: { simulationId, kind: { in: ['decision', 'action_applied', 'action_rejected', 'event', 'external_event'] } }, orderBy: { seq: 'asc' } })
  const entries: JournalEntry[] = rows.map((r) => ({ seq: r.seq, simTime: r.simTime, kind: r.kind, actorRole: r.actorRole, payload: r.payload as Record<string, unknown> }))
  const initial = tradeInitialEngineState(loaded.value.definition)
  const injected = rows.filter((r) => r.kind === 'external_event' && (r.payload as { op?: string }).op === 'injected')
  let seeded = initial
  for (const r of injected) {
    const p = r.payload as { day: number; event: TradeEvent }
    seeded = { ...seeded, queue: { items: [...seeded.queue.items, { time: p.day, priority: 'external', seq: seeded.queue.nextSeq, event: p.event }], nextSeq: seeded.queue.nextSeq + 1 } }
  }
  const replayed = replay(tradeModel, loaded.value.definition, seeded, entries.filter((e) => !(e.kind === 'external_event' && e.payload['op'] === 'injected')))
  const stored = loaded.value.state
  return ok({ matches: comparable(replayed) === comparable(stored) })
}

/** What replay must reproduce: the day, the sector state, the counters and the PENDING events as a
 *  `(time, priority, event)` list. Not compared: `journalSeq` (the stored state counts the control
 *  entries too), `status` (a paused row keeps its engine status), and the queue's own `seq`/`nextSeq`
 *  (an event injected mid-run was enqueued after the rules' own schedules; replay enqueues it up
 *  front, so the tie-break numbers differ while the pending events do not). */
function comparable(state: EngineState<TradeState, TradeEvent>): string {
  const pending = [...state.queue.items].map((i) => ({ time: i.time, priority: i.priority, event: i.event })).sort((a, b) => a.time - b.time || a.priority.localeCompare(b.priority) || JSON.stringify(a.event).localeCompare(JSON.stringify(b.event)))
  return JSON.stringify({ day: state.day, sector: state.sector, stepCount: state.stepCount, decisionCount: state.decisionCount, pending })
}
```
Notes for the implementer: (1) `comparable` above is the replay contract; do not widen it to the raw `state` object (see its docstring). (2) Prisma names the compound unique `simulationId_idempotencyKey`; if the generated client names it differently, use the generated name. (3) Do not import anything from `@slave-of-ai/providers` in this file — a test in Task 6 Step 5 greps for it.

`deleteCompany` in `org.ts`: inside the transaction, right after the `row === null` check, add
```ts
    const simulations = await tx.simulationRun.count({ where: { companyId } })
    if (simulations > 0) return { ok: false as const, error: { kind: 'live_simulations', companyId, simulations } as ControlRefusal }
```
and update the docstring: "Refuses while any simulation run references the company (M29): the runs are the operator's experiments and a cascade would erase their results silently."

Add `export * from './simulation.js'` to `packages/control/src/index.ts`.

- [ ] **Step 4: Run the integration test until green**

Run: `npx vitest run packages/control/test/integration/simulation.test.ts` → PASS; also `npx vitest run packages/control/test/integration/delete-routes.test.ts apps/web/test/integration/delete-routes.test.ts` (existing company-delete cases still pass since their fixtures have no simulations).

- [ ] **Step 5: The dependency-boundary test (acceptance 11)**

`packages/control/test/simulation-boundary.test.ts`:
```ts
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]))
}

describe('the simulation never reaches a real tool (spec §8)', () => {
  it('packages/simulation imports only zod and itself', () => {
    const files = walk(new URL('../../simulation/src', import.meta.url).pathname).filter((f) => f.endsWith('.ts'))
    for (const file of files) {
      const imports = [...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1] ?? '')
      for (const spec of imports) expect(spec === 'zod' || spec.startsWith('.'), `${file} imports ${spec}`).toBe(true)
    }
  })
  it('control/simulation.ts imports no provider, spawns nothing and reads no environment', () => {
    const source = readFileSync(new URL('../src/simulation.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/@slave-of-ai\/providers/)
    expect(source).not.toMatch(/child_process|process\.env|spawn\(/)
  })
})
```
Run: `npx vitest run packages/control/test/simulation-boundary.test.ts` → PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run --silent typecheck` → 0.
```bash
git add packages/control packages/simulation package-lock.json
git commit -m "feat(control): m29 t6 — simulation verbs: create freezes the roster, step runs the engine in one locked transaction, pause/resume/halt/inject/delete; deleteCompany refuses live simulations"
```

---

### Task 7: Web read model and API routes

**Files:**
- Create: `apps/web/src/server/simulation.ts`, `apps/web/src/server/simControlRoute.ts`
- Create: `apps/web/src/app/api/sim/route.ts`, `apps/web/src/app/api/sim/[simulationId]/route.ts`, `apps/web/src/app/api/sim/[simulationId]/step/route.ts`, `.../pause/route.ts`, `.../resume/route.ts`, `.../inject/route.ts`, `.../halt/route.ts`
- Modify: `apps/web/package.json` (`"@slave-of-ai/simulation": "*"`), `apps/web/tsconfig.json` if it lists package paths (mirror how `@slave-of-ai/control` is referenced)
- Test: `apps/web/test/integration/sim-routes.test.ts`, `apps/web/test/integration/simulation-snapshot.test.ts`

**Interfaces:**
- Consumes: Task 6 verbs, Task 4 `tradeMetrics`.
- Produces:
```ts
export interface SimulationSnapshot {
  readonly summary: SimulationSummary
  readonly currency: string
  readonly company: { readonly day: number; readonly cashMinor: number; readonly inventory: number; readonly openOrders: number; readonly pendingDemand: number; readonly inboundPurchases: number; readonly dailyShipCapacity: number }
  readonly roles: readonly { readonly name: string; readonly slaveName: string; readonly purpose: string; readonly allowedActions: readonly string[] }[]
  readonly metrics: TradeMetrics
  readonly journal: readonly JournalRow[]        // last 200, newest last
  readonly modelUsage: { readonly rows: number; readonly costUsd: number | null; readonly unmeasured: number }
  readonly scenario: readonly { readonly day: number; readonly event: unknown }[]
}
export interface JournalRow { readonly seq: number; readonly simTime: number; readonly kind: string; readonly actorRole: string | null; readonly payload: Record<string, unknown> }
export function buildSimulationSnapshot(simulationId: string): Promise<SimulationSnapshot | null>
export function listSimulationCards(): Promise<readonly SimulationSummary[]>
export function listSimulationCompanies(): Promise<readonly { id: string; name: string; slaves: number }[]>
export function simControlResponse(operate: () => Promise<Result<unknown, ControlRefusal>>): Promise<Response>  // 404 for *_not_found, 409 otherwise, 200 { ok: true, ...value }
```

- [ ] **Step 1: Write the failing tests**

`apps/web/test/integration/simulation-snapshot.test.ts`:
```ts
import { prisma } from '@slave-of-ai/db/client'
import { createSimulation, stepSimulation } from '@slave-of-ai/control'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildSimulationSnapshot, listSimulationCards, listSimulationCompanies } from '../../src/server/simulation.js'

async function seedTradingCompany(): Promise<string> {
  const template = await prisma.slaveTemplate.create({ data: { name: 'Trade Clerk', role: 'clerk' } })
  const company = await prisma.company.create({ data: { name: 'Demo Trading Co.' } })
  for (const [department, slave] of [['Sales', 'Sonia'], ['Purchasing', 'Pete'], ['Operations', 'Olga'], ['Finance', 'Fin']] as const) {
    const team = await prisma.companyTeam.create({ data: { companyId: company.id, name: department } })
    await prisma.companySlave.create({ data: { companyTeamId: team.id, templateId: template.id, name: slave } })
  }
  return company.id
}
let companyId: string
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "SimulationModelUsage", "SimulationJournalEntry", "SimulationRun", "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE')
  companyId = await seedTradingCompany()
})
afterAll(async () => { await prisma.$disconnect() })

describe('buildSimulationSnapshot', () => {
  it('reads the company panel, the metrics, the last journal rows and an empty model-usage panel', async () => {
    const created = await createSimulation({ companyId, name: 'demo', sector: 'trade', policy: 'B' })
    const id = created.ok ? created.value.id : ''
    await stepSimulation(id, { untilDay: 30 })
    const snapshot = await buildSimulationSnapshot(id)
    expect(snapshot?.summary).toMatchObject({ name: 'demo', policy: 'B', status: 'finished', simTime: 30, synthetic: true, decisionProvider: 'rules' })
    expect(snapshot?.currency).toBe('USD')
    expect(snapshot?.company).toMatchObject({ day: 30, inventory: 50, openOrders: 0 })
    expect(snapshot?.metrics.deliveredQty).toBe(150)
    expect(snapshot?.modelUsage).toEqual({ rows: 0, costUsd: null, unmeasured: 0 })
    expect(snapshot?.journal.length).toBeLessThanOrEqual(200)
    expect(snapshot?.journal.at(-1)?.kind).toBe('control')
    expect(snapshot?.roles.map((r) => r.slaveName)).toEqual(['Sonia', 'Pete', 'Olga', 'Fin'])
    expect(snapshot?.scenario).toHaveLength(2)
  })
  it('is null for an unknown id; the cards list and the company list read the catalog', async () => {
    expect(await buildSimulationSnapshot('00000000-0000-4000-8000-00000000dead')).toBeNull()
    await createSimulation({ companyId, name: 'one', sector: 'trade', policy: 'A' })
    expect((await listSimulationCards()).map((c) => c.name)).toEqual(['one'])
    expect(await listSimulationCompanies()).toEqual([{ id: companyId, name: 'Demo Trading Co.', slaves: 4 }])
  })
})
```
`apps/web/test/integration/sim-routes.test.ts`:
```ts
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { POST as createPOST } from '../../src/app/api/sim/route.js'
import { DELETE as simDELETE } from '../../src/app/api/sim/[simulationId]/route.js'
import { POST as stepPOST } from '../../src/app/api/sim/[simulationId]/step/route.js'
import { POST as pausePOST } from '../../src/app/api/sim/[simulationId]/pause/route.js'
import { POST as resumePOST } from '../../src/app/api/sim/[simulationId]/resume/route.js'
import { POST as injectPOST } from '../../src/app/api/sim/[simulationId]/inject/route.js'
import { POST as haltPOST } from '../../src/app/api/sim/[simulationId]/halt/route.js'

// same seedTradingCompany / beforeEach / afterAll as simulation-snapshot.test.ts (copy them)

const json = (body: unknown, method = 'POST'): Request => new Request('http://x', { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const params = (simulationId: string) => ({ params: Promise.resolve({ simulationId }) })

describe('the simulation routes', () => {
  it('create → 200 with the id; a bad body → 400; an unsupported sector → 409 with the refusal text', async () => {
    const created = await createPOST(json({ companyId, name: 'demo', policy: 'A' }))
    expect(created.status).toBe(200)
    const { id } = (await created.json()) as { id: string }
    expect(typeof id).toBe('string')
    expect((await createPOST(json({ companyId }))).status).toBe(400)
    const unsupported = await createPOST(json({ companyId, name: 'x', policy: 'A', sector: 'software' }))
    expect(unsupported.status).toBe(409)
    expect((await unsupported.json()).error).toContain('cannot run in simulation mode yet')
  })
  it('step / pause / resume / halt / inject answer 200 / 409 / 404 by the verb', async () => {
    const { id } = (await (await createPOST(json({ companyId, name: 'demo', policy: 'A' }))).json()) as { id: string }
    const stepped = await stepPOST(json({ steps: 2, idempotencyKey: 'r1' }), params(id))
    expect(stepped.status).toBe(200)
    expect(await stepped.json()).toMatchObject({ ok: true, day: 2, version: 1 })
    expect((await pausePOST(new Request('http://x', { method: 'POST' }), params(id))).status).toBe(200)
    const paused = await stepPOST(json({ steps: 1 }), params(id))
    expect(paused.status).toBe(409)
    expect((await paused.json()).error).toContain('is paused')
    expect((await resumePOST(new Request('http://x', { method: 'POST' }), params(id))).status).toBe(200)
    expect((await injectPOST(json({ day: 5, event: { type: 'supplier_delay', supplierId: 'normal', extraDays: 2 } }), params(id))).status).toBe(200)
    expect((await injectPOST(json({ day: 5, event: { type: 'delivery', purchaseId: 'p' } }), params(id))).status).toBe(409)
    expect((await haltPOST(json({ reason: 'test' }), params(id))).status).toBe(200)
    expect((await stepPOST(json({ steps: 1 }), params('00000000-0000-4000-8000-00000000dead'))).status).toBe(404)
    expect((await simDELETE(new Request('http://x', { method: 'DELETE' }), params(id))).status).toBe(200)
    expect((await simDELETE(new Request('http://x', { method: 'DELETE' }), params(id))).status).toBe(404)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run apps/web/test/integration/simulation-snapshot.test.ts apps/web/test/integration/sim-routes.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Implement the read model, the response helper and the routes**

`apps/web/package.json`: add `"@slave-of-ai/simulation": "*"` to dependencies; `npm install`.

`apps/web/src/server/simControlRoute.ts`:
```ts
import { refusalText, type ControlRefusal } from '@slave-of-ai/control'
import type { Result } from '@slave-of-ai/domain'

const NOT_FOUND: ReadonlySet<ControlRefusal['kind']> = new Set(['simulation_not_found', 'company_not_found'])

/** The simulation routes' one answer shape: a value spread into `{ ok: true, ... }`, a not-found
 *  refusal as 404, every other refusal as 409 with `refusalText`. */
export async function simControlResponse(operate: () => Promise<Result<unknown, ControlRefusal>>): Promise<Response> {
  const result = await operate()
  if (result.ok) return Response.json({ ok: true, ...(typeof result.value === 'object' && result.value !== null ? (result.value as Record<string, unknown>) : {}) })
  return Response.json({ error: refusalText(result.error) }, { status: NOT_FOUND.has(result.error.kind) ? 404 : 409 })
}
```
`apps/web/src/server/simulation.ts`:
```ts
import { prisma } from '@slave-of-ai/db/client'
import { listSimulations, loadSimulation, type SimulationSummary } from '@slave-of-ai/control'
import { tradeMetrics, type JournalEntry, type TradeMetrics } from '@slave-of-ai/simulation'

export interface JournalRow { readonly seq: number; readonly simTime: number; readonly kind: string; readonly actorRole: string | null; readonly payload: Record<string, unknown> }
export interface SimulationSnapshot {
  readonly summary: SimulationSummary
  readonly currency: string
  readonly company: { readonly day: number; readonly cashMinor: number; readonly inventory: number; readonly openOrders: number; readonly pendingDemand: number; readonly inboundPurchases: number; readonly dailyShipCapacity: number }
  readonly roles: readonly { readonly name: string; readonly slaveName: string; readonly purpose: string; readonly allowedActions: readonly string[] }[]
  readonly metrics: TradeMetrics
  readonly journal: readonly JournalRow[]
  /** Real model spend (M31 writes it). `costUsd` null means no measured figure — never shown as $0. */
  readonly modelUsage: { readonly rows: number; readonly costUsd: number | null; readonly unmeasured: number }
  readonly scenario: readonly { readonly day: number; readonly event: unknown }[]
}

const JOURNAL_PAGE = 200

export async function buildSimulationSnapshot(simulationId: string): Promise<SimulationSnapshot | null> {
  const loaded = await loadSimulation(simulationId)
  if (!loaded.ok) return null
  const { summary, definition, state } = loaded.value
  const [rows, usage, latest] = await Promise.all([
    prisma.simulationJournalEntry.findMany({ where: { simulationId }, orderBy: { seq: 'asc' } }),
    prisma.simulationModelUsage.aggregate({ where: { simulationId }, _count: { _all: true }, _sum: { costUsd: true } }),
    prisma.simulationJournalEntry.findMany({ where: { simulationId }, orderBy: { seq: 'desc' }, take: JOURNAL_PAGE }),
  ])
  const unmeasured = await prisma.simulationModelUsage.count({ where: { simulationId, costUsd: null } })
  const entries: JournalEntry[] = rows.map((r) => ({ seq: r.seq, simTime: r.simTime, kind: r.kind, actorRole: r.actorRole, payload: r.payload as Record<string, unknown> }))
  const sector = state.sector
  return {
    summary,
    currency: definition.currency,
    company: {
      day: state.day, cashMinor: sector.cashMinor, inventory: sector.inventory,
      openOrders: sector.orders.filter((o) => o.status !== 'shipped').length, pendingDemand: sector.pendingDemand.length,
      inboundPurchases: sector.purchases.filter((p) => p.status === 'ordered').length, dailyShipCapacity: sector.dailyShipCapacity,
    },
    roles: definition.roles.map((r) => ({ name: r.name, slaveName: r.slaveName, purpose: r.purpose, allowedActions: r.allowedActions })),
    metrics: tradeMetrics(entries, sector),
    journal: latest.reverse().map((r) => ({ seq: r.seq, simTime: r.simTime, kind: r.kind, actorRole: r.actorRole, payload: r.payload as Record<string, unknown> })),
    modelUsage: { rows: usage._count._all, costUsd: usage._count._all === 0 || usage._sum.costUsd === null ? null : usage._sum.costUsd, unmeasured },
    scenario: definition.scenario.map((s) => ({ day: s.day, event: s.event })),
  }
}

export function listSimulationCards(): Promise<readonly SimulationSummary[]> {
  return listSimulations()
}

export async function listSimulationCompanies(): Promise<readonly { id: string; name: string; slaves: number }[]> {
  const companies = await prisma.company.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, teams: { select: { _count: { select: { slaves: true } } } } } })
  return companies.map((c) => ({ id: c.id, name: c.name, slaves: c.teams.reduce((n, t) => n + t._count.slaves, 0) }))
}
```
Routes (each `export const dynamic = 'force-dynamic'`, `requirePrincipal` first — copy `api/org/companies/route.ts`'s shape):

`apps/web/src/app/api/sim/route.ts`:
```ts
import { createSimulation } from '@slave-of-ai/control'
import { z } from 'zod'
import { simControlResponse } from '../../../server/simControlRoute'
import { requirePrincipal } from '../../../server/principal'

export const dynamic = 'force-dynamic'
const body = z.object({ companyId: z.string().min(1), name: z.string().min(1), policy: z.enum(['A', 'B']), sector: z.string().default('trade'), seed: z.number().int().optional() })

export async function POST(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const parsed = body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'the body must be { companyId, name, policy: "A" | "B", sector?, seed? }' }, { status: 400 })
  const { companyId, name, policy, sector, seed } = parsed.data
  return simControlResponse(() => createSimulation({ companyId, name, sector: sector as 'trade', policy, ...(seed !== undefined ? { seed } : {}) }, gate.principal ?? undefined))
}
```
`apps/web/src/app/api/sim/[simulationId]/route.ts`:
```ts
import { deleteSimulation } from '@slave-of-ai/control'
import { simControlResponse } from '../../../../server/simControlRoute'
import { requirePrincipal } from '../../../../server/principal'
export const dynamic = 'force-dynamic'
export async function DELETE(_request: Request, context: { params: Promise<{ simulationId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { simulationId } = await context.params
  return simControlResponse(() => deleteSimulation(simulationId, gate.principal ?? undefined))
}
```
`.../step/route.ts` (body `{ steps?, untilDay?, idempotencyKey?, expectedVersion? }` via zod, all optional ints ≥ 0 / non-empty string; 400 on a malformed body), `.../pause/route.ts` and `.../resume/route.ts` (no body), `.../halt/route.ts` (body `{ reason?: string }`, default `'operator'`), `.../inject/route.ts` (body `{ day: int ≥ 0, event: unknown, idempotencyKey?: string }`) — each: gate → params → `simControlResponse(() => verb(...))`.

If `apps/web/tsconfig.json` has a `paths`/`references` block naming `@slave-of-ai/control`, add the simulation package there the same way.

- [ ] **Step 4: Run the tests, the typecheck and the build**

Run: `npx vitest run apps/web/test/integration/simulation-snapshot.test.ts apps/web/test/integration/sim-routes.test.ts` → PASS; `npm run --silent typecheck` → 0; `npm run web:build` (no `next dev` running) → exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web package-lock.json
git commit -m "feat(web): m29 t7 — the simulation read model and the /api/sim routes"
```

---

### Task 8: CLI — `create-simulation`, `step-simulation`, `simulation-status`

**Files:**
- Modify: `apps/orchestrator/src/cli.ts` (help text + three cases), `apps/orchestrator/package.json` only if the CLI needs `@slave-of-ai/simulation` directly (it should not — everything comes through `@slave-of-ai/control`)
- Test: `apps/orchestrator/test/integration/cli.test.ts` (+ one `describe`)

**Interfaces:**
- Consumes: `createSimulation`, `stepSimulation`, `loadSimulation`, `refusalText` from `@slave-of-ai/control`.

- [ ] **Step 1: Write the failing test**

Append to `apps/orchestrator/test/integration/cli.test.ts` (inside the file's outer `describe`, using its `runCli`, `fixture`/`prisma`):
```ts
  describe('simulations (M29)', () => {
    async function tradingCompany(): Promise<string> {
      const template = await prisma.slaveTemplate.create({ data: { name: 'Trade Clerk', role: 'clerk' } })
      const company = await prisma.company.create({ data: { name: 'Demo Trading Co.' } })
      for (const [department, slave] of [['Sales', 'Sonia'], ['Purchasing', 'Pete'], ['Operations', 'Olga'], ['Finance', 'Fin']] as const) {
        const team = await prisma.companyTeam.create({ data: { companyId: company.id, name: department } })
        await prisma.companySlave.create({ data: { companyTeamId: team.id, templateId: template.id, name: slave } })
      }
      return company.id
    }
    it('creates, steps and reports a simulation; the status is JSON with the two money figures apart', async () => {
      const companyId = await tradingCompany()
      const created = await runCli(['create-simulation', '--company', companyId, '--name', 'cli demo', '--policy', 'B'])
      expect(created.code).toBe(0)
      const id = /simulation (\S+) created/.exec(created.stdout)?.[1] ?? ''
      expect(id).not.toBe('')
      const stepped = await runCli(['step-simulation', '--simulation', id, '--until-day', '30'])
      expect(stepped.code).toBe(0)
      expect(stepped.stdout).toContain(`simulation ${id} at day 30 (finished), version 1`)
      const status = await runCli(['simulation-status', '--simulation', id])
      expect(status.code).toBe(0)
      const parsed = JSON.parse(status.stdout) as { summary: { status: string; synthetic: boolean; decisionProvider: string }; company: { cashMinor: number }; modelUsage: { costUsd: number | null } }
      expect(parsed.summary).toMatchObject({ status: 'finished', synthetic: true, decisionProvider: 'rules' })
      expect(typeof parsed.company.cashMinor).toBe('number')
      expect(parsed.modelUsage.costUsd).toBeNull()
      const again = await runCli(['step-simulation', '--simulation', id, '--steps', '1'])
      expect(again.code).toBe(1)
      expect(again.stderr).toContain('is finished; it cannot be stepped')
    }, 30_000)
    it('refuses an unsupported sector without creating anything', async () => {
      const companyId = await tradingCompany()
      const result = await runCli(['create-simulation', '--company', companyId, '--name', 'x', '--policy', 'A', '--sector', 'software'])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('cannot run in simulation mode yet')
      expect(await prisma.simulationRun.count()).toBe(0)
    }, 30_000)
  })
```
Add `"SimulationModelUsage", "SimulationJournalEntry", "SimulationRun", ` to the front of this file's `TRUNCATE` list.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/orchestrator/test/integration/cli.test.ts -t simulations` → FAIL (`unknown command`).

- [ ] **Step 3: Implement the verbs**

Help text (after `delete-template`):
```
  create-simulation --company <id> --name <n> --policy A|B [--seed <n>] [--sector trade]
                                       create a company SIMULATION from a catalog company's
                                       roster (frozen at creation). No repository, no model
                                       call: the rules provider decides. Synthetic data.
  step-simulation --simulation <id> [--steps <n> | --until-day <d>]
                                       advance the simulation clock (one day per step)
  simulation-status --simulation <id>  the run's summary, company panel, metrics and model
                                       usage as JSON — simulated money and real cost apart
```
Cases:
```ts
    case 'create-simulation': {
      const companyId = requireFlag(flags, 'company')
      const name = requireFlag(flags, 'name')
      const policy = requireFlag(flags, 'policy')
      if (policy !== 'A' && policy !== 'B') throw new Error('--policy must be A or B')
      const sector = flagText(flags, 'sector') ?? 'trade'
      const seedText = flagText(flags, 'seed')
      const result = await createSimulation({ companyId, name, sector: sector as 'trade', policy, ...(seedText !== undefined ? { seed: Number(seedText) } : {}) })
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`simulation ${result.value.id} created (trade, policy ${policy}, rules provider, synthetic)\n`)
      return 0
    }
    case 'step-simulation': {
      const simulationId = requireFlag(flags, 'simulation')
      const steps = flagText(flags, 'steps')
      const untilDay = flagText(flags, 'until-day')
      const result = await stepSimulation(simulationId, { ...(steps !== undefined ? { steps: Number(steps) } : {}), ...(untilDay !== undefined ? { untilDay: Number(untilDay) } : {}) })
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`simulation ${simulationId} at day ${result.value.day} (${result.value.status}), version ${result.value.version}, ${plural(result.value.entries, 'journal entry').replace('entrys', 'entries')}\n`)
      return 0
    }
    case 'simulation-status': {
      const simulationId = requireFlag(flags, 'simulation')
      const snapshot = await simulationStatus(simulationId)
      if (!snapshot.ok) throw new Error(refusalText(snapshot.error))
      process.stdout.write(`${JSON.stringify(snapshot.value, null, 2)}\n`)
      return 0
    }
```
`simulationStatus` is added to `packages/control/src/simulation.ts` (exported):
```ts
export async function simulationStatus(simulationId: string): Promise<Result<{ summary: SimulationSummary; company: { day: number; cashMinor: number; inventory: number; openOrders: number }; metrics: TradeMetrics; modelUsage: { rows: number; costUsd: number | null; unmeasured: number } }, ControlRefusal>> {
  const loaded = await loadSimulation(simulationId)
  if (!loaded.ok) return loaded
  const rows = await prisma.simulationJournalEntry.findMany({ where: { simulationId }, orderBy: { seq: 'asc' } })
  const entries: JournalEntry[] = rows.map((r) => ({ seq: r.seq, simTime: r.simTime, kind: r.kind, actorRole: r.actorRole, payload: r.payload as Record<string, unknown> }))
  const usage = await prisma.simulationModelUsage.aggregate({ where: { simulationId }, _count: { _all: true }, _sum: { costUsd: true } })
  const unmeasured = await prisma.simulationModelUsage.count({ where: { simulationId, costUsd: null } })
  const sector = loaded.value.state.sector
  return ok({
    summary: loaded.value.summary,
    company: { day: loaded.value.state.day, cashMinor: sector.cashMinor, inventory: sector.inventory, openOrders: sector.orders.filter((o) => o.status !== 'shipped').length },
    metrics: tradeMetrics(entries, sector),
    modelUsage: { rows: usage._count._all, costUsd: usage._count._all === 0 || usage._sum.costUsd === null ? null : usage._sum.costUsd, unmeasured },
  })
}
```
(import `tradeMetrics` and `TradeMetrics` from `@slave-of-ai/simulation`). The web read model's `buildSimulationSnapshot` computes the same figures the same way and adds roles, the journal page and the scenario. For the `entries` word, write it plainly instead of the `.replace` trick: ``${result.value.entries} journal ${result.value.entries === 1 ? 'entry' : 'entries'}``.

Import `createSimulation`, `stepSimulation`, `simulationStatus` from `@slave-of-ai/control` in `cli.ts`.

- [ ] **Step 4: Run the CLI test, then typecheck**

Run: `npx vitest run apps/orchestrator/test/integration/cli.test.ts -t simulations` → PASS; `npm run --silent typecheck` → 0.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator packages/control
git commit -m "feat(cli): m29 t8 — create-simulation, step-simulation, simulation-status"
```

---

### Task 9: UI — the Simulations list, the New simulation drawer, the sidebar row

**Files:**
- Create: `apps/web/src/app/sim/page.tsx`, `apps/web/src/components/sim/SimulationsClient.tsx`, `apps/web/src/components/sim/NewSimulationDrawer.tsx`, `apps/web/src/lib/money.ts`
- Modify: `apps/web/src/components/Sidebar.tsx` (row `{ label: 'Simulations', href: '/sim' }` after Slaves; `isCurrent` for `/sim` matches `pathname === '/sim' || pathname.startsWith('/sim/')`)
- Test: `apps/web/test/simulations-page.test.tsx`, `apps/web/test/money.test.ts`, `apps/web/test/sidebar.test.tsx` (extend if it exists)

**Interfaces:**
- Consumes: Task 7's `listSimulationCards`, `listSimulationCompanies`, `SimulationSummary`.
- Produces: `formatMinor(minor: number, currency: string): string` (`formatMinor(123456, 'USD') === '$1,234.56'`, negative as `-$…`, via `Intl.NumberFormat('en-US', { style: 'currency', currency })`); `SimulationsClient({ cards, companies })`; `NewSimulationDrawer({ open, onClose, companies })`; testids `sim-card`, `sim-card-<id>`, `sim-chip`, `new-simulation`, `new-simulation-drawer`, `new-simulation-close`, `new-simulation-scrim`, `new-simulation-company`, `new-simulation-name`, `new-simulation-policy`, `new-simulation-seed`, `new-simulation-submit`, `new-simulation-error`.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/money.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { formatMinor } from '../src/lib/money.js'
describe('formatMinor', () => {
  it('renders integer minor units as currency, negative included', () => {
    expect(formatMinor(123456, 'USD')).toBe('$1,234.56')
    expect(formatMinor(0, 'USD')).toBe('$0.00')
    expect(formatMinor(-5, 'USD')).toBe('-$0.05')
  })
})
```
`apps/web/test/simulations-page.test.tsx`:
```tsx
// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimulationsClient } from '../src/components/sim/SimulationsClient.js'
import type { SimulationSummary } from '@slave-of-ai/control'

const routerPush = vi.fn()
const routerRefresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: routerPush, refresh: routerRefresh }), usePathname: () => '/sim' }))

const card = (over: Partial<SimulationSummary> = {}): SimulationSummary => ({
  id: 's1', companyId: 'c1', companyName: 'Demo Trading Co.', name: 'Q3 plan', sector: 'trade', mode: 'simulation', decisionProvider: 'rules', policy: 'A',
  status: 'running', simTime: 4, horizonDays: 30, stepCount: 4, decisionCount: 16, version: 2, haltedReason: null, createdAt: '2026-09-06T00:00:00.000Z', synthetic: true, ...over,
})
const companies = [{ id: 'c1', name: 'Demo Trading Co.', slaves: 4 }, { id: 'c2', name: 'Tiny', slaves: 1 }]

beforeEach(() => { routerPush.mockClear(); routerRefresh.mockClear() })
afterEach(() => vi.unstubAllGlobals())

describe('SimulationsClient', () => {
  it('lists every run as a card with the SIMULATION chip, sector, policy, day and status, and opens it on click', () => {
    render(<SimulationsClient cards={[card(), card({ id: 's2', name: 'hedged', policy: 'B', status: 'finished', simTime: 30 })]} companies={companies} />)
    const first = screen.getByTestId('sim-card-s1')
    expect(first.textContent).toContain('SIMULATION')
    expect(first.textContent).toContain('trade')
    expect(first.textContent).toContain('policy A')
    expect(first.textContent).toContain('day 4 / 30')
    expect(first.textContent).toContain('running')
    expect(first.textContent).toContain('rules provider')
    fireEvent.click(first)
    expect(routerPush).toHaveBeenCalledWith('/sim/s1')
    expect(screen.getAllByTestId('sim-card')).toHaveLength(2)
  })
  it('the drawer has company, name, policy and seed — no repository, branch or verify field — and posts to /api/sim', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, id: 's9' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<SimulationsClient cards={[]} companies={companies} />)
    fireEvent.click(screen.getByTestId('new-simulation'))
    const drawer = screen.getByTestId('new-simulation-drawer')
    expect(drawer.textContent).not.toMatch(/repo|branch|verify/i)
    expect(drawer.textContent).toContain('synthetic')
    fireEvent.change(screen.getByTestId('new-simulation-company'), { target: { value: 'c1' } })
    fireEvent.change(screen.getByTestId('new-simulation-name'), { target: { value: 'Q4' } })
    fireEvent.change(screen.getByTestId('new-simulation-policy'), { target: { value: 'B' } })
    fireEvent.change(screen.getByTestId('new-simulation-seed'), { target: { value: '7' } })
    await act(async () => { fireEvent.click(screen.getByTestId('new-simulation-submit')) })
    expect(fetchMock).toHaveBeenCalledWith('/api/sim', expect.objectContaining({ method: 'POST', body: JSON.stringify({ companyId: 'c1', name: 'Q4', policy: 'B', seed: 7 }) }))
    expect(routerPush).toHaveBeenCalledWith('/sim/s9')
  })
  it('a company with fewer than four slaves is offered but marked, and a refusal stays in the drawer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'company c2 has 1 slave; the trade sector needs 4 for its roles' }), { status: 409 })))
    render(<SimulationsClient cards={[]} companies={companies} />)
    fireEvent.click(screen.getByTestId('new-simulation'))
    const option = screen.getByTestId('new-simulation-company').querySelector('option[value="c2"]')
    expect(option?.textContent).toContain('1 slave')
    fireEvent.change(screen.getByTestId('new-simulation-company'), { target: { value: 'c2' } })
    fireEvent.change(screen.getByTestId('new-simulation-name'), { target: { value: 'x' } })
    await act(async () => { fireEvent.click(screen.getByTestId('new-simulation-submit')) })
    expect(screen.getByTestId('new-simulation-error').textContent).toContain('needs 4')
    expect(screen.getByTestId('new-simulation-drawer')).toBeTruthy()
  })
  it('an empty list says so and names the demo company', () => {
    render(<SimulationsClient cards={[]} companies={companies} />)
    expect(screen.getByTestId('sim-empty').textContent).toContain('No simulations yet')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run apps/web/test/money.test.ts apps/web/test/simulations-page.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

`apps/web/src/lib/money.ts`:
```ts
/** Integer minor units → a currency string. The simulated company's money only; real model
 *  spend is a separate figure with its own null-means-unmeasured rule. */
export function formatMinor(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100)
}
```
`apps/web/src/app/sim/page.tsx`:
```tsx
import { listSimulationCards, listSimulationCompanies } from '../../server/simulation'
import { SimulationsClient } from '../../components/sim/SimulationsClient'

export const dynamic = 'force-dynamic'

/** M29: every simulation run, and the drawer that creates one from a catalog company. */
export default async function SimulationsPage(): Promise<React.JSX.Element> {
  const [cards, companies] = await Promise.all([listSimulationCards(), listSimulationCompanies()])
  return <SimulationsClient cards={cards} companies={companies} />
}
```
`apps/web/src/components/sim/NewSimulationDrawer.tsx` (the `NewProjectDrawer` shell — scrim, `aside role="dialog"`, Escape handler — with this form):
```tsx
'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { errorMessage } from '../../lib/postControl'
import { PrimaryButton, SelectField, TextField } from '../ui/FormControls'

export interface SimulationCompanyOption { readonly id: string; readonly name: string; readonly slaves: number }

/** Create a simulation from a catalog company (M29 §7). No repository, no branch, no verify
 *  command: the trade sector runs on simulated resources, and this form says so. */
export function NewSimulationDrawer({ open, onClose, companies }: { readonly open: boolean; readonly onClose: () => void; readonly companies: readonly SimulationCompanyOption[] }): React.JSX.Element | null {
  const router = useRouter()
  const [companyId, setCompanyId] = useState('')
  const [name, setName] = useState('')
  const [policy, setPolicy] = useState<'A' | 'B'>('A')
  const [seed, setSeed] = useState('1')
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !pending) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, pending])

  if (!open) return null
  const submit = async (): Promise<void> => {
    if (pending) return
    setPending(true)
    setErrorText(null)
    const body: Record<string, unknown> = { companyId, name, policy }
    const seedNumber = Number.parseInt(seed, 10)
    if (Number.isInteger(seedNumber)) body['seed'] = seedNumber
    try {
      const response = await fetch('/api/sim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data: unknown = await response.json().catch(() => null)
      if (!response.ok) { setErrorText(errorMessage(data, response.status)); setPending(false); return }
      const id = typeof data === 'object' && data !== null && 'id' in data ? String((data as { id: unknown }).id) : ''
      setPending(false)
      onClose()
      router.push(`/sim/${id}`)
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error))
      setPending(false)
    }
  }
  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <button type="button" aria-label="close" data-testid="new-simulation-scrim" onClick={() => { if (!pending) onClose() }} className="flex-1 bg-black/50" />
      <aside role="dialog" aria-modal="true" aria-label="New simulation" data-testid="new-simulation-drawer" className="flex w-[520px] max-w-full flex-col gap-4 overflow-y-auto border-l border-line bg-bg-1 p-5 shadow-[0_6px_22px_rgba(0,0,0,.45)]">
        <div className="flex items-center justify-between">
          <h2 className="text-[14.5px] font-semibold tracking-[-.2px] text-text-1">New simulation</h2>
          <button type="button" data-testid="new-simulation-close" onClick={() => { if (!pending) onClose() }} className="text-text-3 hover:text-text-1">✕</button>
        </div>
        <p className="text-xs text-text-3">a trade company on synthetic data, decided by the rules provider — no repository, no model call; the roster is frozen at creation</p>
        <SelectField label="company" selectProps={{ 'aria-label': 'company', 'data-testid': 'new-simulation-company', value: companyId, disabled: pending, onChange: (event) => setCompanyId(event.target.value) } as React.SelectHTMLAttributes<HTMLSelectElement>}>
          <option value="">select a company</option>
          {companies.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.slaves} {c.slaves === 1 ? 'slave' : 'slaves'}{c.slaves < 4 ? ' (needs 4)' : ''}</option>)}
        </SelectField>
        <TextField label="name" inputProps={{ 'aria-label': 'simulation name', 'data-testid': 'new-simulation-name', value: name, disabled: pending, onChange: (event) => setName(event.target.value) } as React.InputHTMLAttributes<HTMLInputElement>} />
        <SelectField label="policy" selectProps={{ 'aria-label': 'policy', 'data-testid': 'new-simulation-policy', value: policy, disabled: pending, onChange: (event) => setPolicy(event.target.value as 'A' | 'B') } as React.SelectHTMLAttributes<HTMLSelectElement>}>
          <option value="A">A — wait for the normal supplier</option>
          <option value="B">B — hedge with the fast supplier when a delivery is at risk</option>
        </SelectField>
        <TextField label="seed" inputProps={{ 'aria-label': 'seed', 'data-testid': 'new-simulation-seed', value: seed, disabled: pending, inputMode: 'numeric', onChange: (event) => setSeed(event.target.value) } as React.InputHTMLAttributes<HTMLInputElement>} />
        <div className="flex items-center gap-3">
          <PrimaryButton data-testid="new-simulation-submit" disabled={pending || companyId === '' || name.trim() === ''} onClick={() => void submit()}>{pending ? 'creating…' : 'Create simulation'}</PrimaryButton>
          {errorText !== null && <span role="alert" data-testid="new-simulation-error" className="text-xs text-tone-blocked">{errorText}</span>}
        </div>
      </aside>
    </div>
  )
}
```
(`TextField`'s prop shape: check `FormControls.tsx` — it takes `{ label?, inputProps }` like `SelectField`; if it differs, follow the file.)

`apps/web/src/components/sim/SimulationsClient.tsx`:
```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { SimulationSummary } from '@slave-of-ai/control'
import { Card } from '../ui/Card'
import { Chip } from '../ui/Chip'
import { PrimaryButton } from '../ui/FormControls'
import { Panel } from '../ui/Panel'
import { NewSimulationDrawer, type SimulationCompanyOption } from './NewSimulationDrawer'

const STATUS_TONE = { ready: 'idle', running: 'working', paused: 'paused', finished: 'done', halted: 'blocked' } as const

export function SimulationsClient({ cards, companies }: { readonly cards: readonly SimulationSummary[]; readonly companies: readonly SimulationCompanyOption[] }): React.JSX.Element {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-4 p-6">
      <Panel title="Simulations" action={<PrimaryButton data-testid="new-simulation" onClick={() => setOpen(true)}>+ New simulation</PrimaryButton>}>
        {cards.length === 0 ? (
          <p data-testid="sim-empty" className="text-xs text-text-3">No simulations yet. Create one from a catalog company — the seed ships “Demo Trading Co.” with the four roles the trade sector needs.</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {cards.map((card) => (
              <div key={card.id} data-testid="sim-card">
                <div data-testid={`sim-card-${card.id}`}>
                  <Card onClick={() => router.push(`/sim/${card.id}`)}>
                    <div className="flex items-center gap-2">
                      <span data-testid="sim-chip"><Chip tone="waiting">SIMULATION</Chip></span>
                      <span className="text-sm text-text-1">{card.name}</span>
                    </div>
                    <div className="text-xs text-text-3">{card.companyName} · {card.sector} · policy {card.policy} · {card.decisionProvider} provider</div>
                    <div className="flex items-center gap-2 text-xs text-text-2">
                      <span>day {card.simTime} / {card.horizonDays}</span>
                      <Chip tone={STATUS_TONE[card.status]}>{card.status}</Chip>
                    </div>
                  </Card>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
      <NewSimulationDrawer open={open} onClose={() => setOpen(false)} companies={companies} />
    </div>
  )
}
```
`StatusTone` values: read `apps/web/src/lib/tones.ts` for the exact union (`working`, `blocked`, `paused`, `idle`, `done`, `waiting` are expected); use the ones that exist.

Sidebar: add `{ label: 'Simulations', href: '/sim' }` after `Slaves`; extend `isCurrent` so `/sim` is current for `pathname.startsWith('/sim')`.

- [ ] **Step 4: Run the tests, the sidebar test, typecheck, build**

Run: `npx vitest run apps/web/test/money.test.ts apps/web/test/simulations-page.test.tsx apps/web/test/sidebar.test.tsx` → PASS (update the sidebar test's expected row list if it pins the five labels); `npm run --silent typecheck` → 0; `npm run web:build` → 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): m29 t9 — the Simulations page: cards with the SIMULATION chip, the New simulation drawer (no Git fields), the sidebar row"
```

---

### Task 10: UI — the simulation run page

**Files:**
- Create: `apps/web/src/app/sim/[simulationId]/page.tsx`, `apps/web/src/components/sim/SimulationClient.tsx`, `apps/web/src/components/sim/SimulationStrip.tsx`, `apps/web/src/components/sim/JournalTable.tsx`
- Test: `apps/web/test/simulation-page.test.tsx`

**Interfaces:**
- Consumes: Task 7's `buildSimulationSnapshot`, `SimulationSnapshot`; Task 9's `formatMinor`.
- Produces: testids `sim-strip`, `sim-controls`, `sim-step`, `sim-run-to`, `sim-run-to-day`, `sim-pause`, `sim-resume`, `sim-halt`, `sim-halt-confirm`, `sim-inject-open`, `sim-inject-kind`, `sim-inject-day`, `sim-inject-qty`, `sim-inject-extra-days`, `sim-inject-submit`, `sim-company`, `sim-company-day`, `sim-company-cash`, `sim-company-inventory`, `sim-model-usage`, `sim-metric-<name>`, `sim-tab-overview`, `sim-tab-decisions`, `sim-tab-journal`, `sim-decision-row`, `sim-journal-row`, `sim-error`.

- [ ] **Step 1: Write the failing test**

`apps/web/test/simulation-page.test.tsx`:
```tsx
// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimulationClient } from '../src/components/sim/SimulationClient.js'
import type { SimulationSnapshot } from '../src/server/simulation.js'

const routerRefresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }) }))

function snapshot(over: Partial<SimulationSnapshot> = {}): SimulationSnapshot {
  return {
    summary: { id: 's1', companyId: 'c1', companyName: 'Demo Trading Co.', name: 'Q3 plan', sector: 'trade', mode: 'simulation', decisionProvider: 'rules', policy: 'B', status: 'running', simTime: 4, horizonDays: 30, stepCount: 4, decisionCount: 16, version: 2, haltedReason: null, createdAt: '2026-09-06T00:00:00.000Z', synthetic: true },
    currency: 'USD',
    company: { day: 4, cashMinor: 4_575_000, inventory: 10, openOrders: 1, pendingDemand: 0, inboundPurchases: 2, dailyShipCapacity: 30 },
    roles: [{ name: 'sales', slaveName: 'Sonia', purpose: 'accepts demand', allowedActions: ['accept_order', 'note'] }],
    metrics: { deliveredQty: 90, onTimeQty: 90, lateDays: 0, purchaseCostMinor: 725_000, closingInventory: 10, closingCashMinor: 4_575_000, minCashMinor: 4_575_000, minCashDay: 3, collectedMinor: 0, unpaidCommitmentsMinor: 300_000, sources: { deliveredQty: ['action_applied:ship_order'], lateDays: ['state.orders'], purchaseCostMinor: ['action_applied:place_purchase'], collectedMinor: ['event:collection'], unpaidCommitmentsMinor: ['state.purchases'] } },
    journal: [
      { seq: 5, simTime: 1, kind: 'decision', actorRole: 'purchasing', payload: { index: 1, provider: 'rules', observation: { inventory: 100 }, actions: [{ type: 'place_purchase', params: { supplierId: 'normal', qty: 50 }, rationale: 'shortfall 50 against open orders', refs: ['order-2'] }] } },
      { seq: 6, simTime: 1, kind: 'action_applied', actorRole: 'purchasing', payload: { index: 1, actionIndex: 0, action: { type: 'place_purchase', params: { supplierId: 'normal', qty: 50 } }, costMinor: 300_000, expectedDay: 8 } },
      { seq: 7, simTime: 1, kind: 'action_rejected', actorRole: 'operations', payload: { index: 2, actionIndex: 1, action: { type: 'ship_order', params: { orderId: 'order-2', qty: 40 } }, reason: { kind: 'capacity_exhausted', remainingCapacity: 0 } } },
      { seq: 8, simTime: 1, kind: 'event', actorRole: null, payload: { kind: 'close', inventory: 70, cashMinor: 5_000_000, openOrders: 1, lateOrders: 0 } },
    ],
    modelUsage: { rows: 0, costUsd: null, unmeasured: 0 },
    scenario: [{ day: 1, event: { type: 'demand', qty: 150 } }],
    ...over,
  }
}
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); routerRefresh.mockClear() })
afterEach(() => vi.unstubAllGlobals())

describe('SimulationClient', () => {
  it('shows the persistent strip, the two money panels apart, and the metrics with their sources', () => {
    render(<SimulationClient initial={snapshot()} />)
    const strip = screen.getByTestId('sim-strip').textContent ?? ''
    expect(strip).toContain('SIMULATION')
    expect(strip).toContain('trade')
    expect(strip).toContain('rules provider')
    expect(strip).toContain('synthetic')
    expect(screen.getByTestId('sim-company-cash').textContent).toBe('$45,750.00')
    expect(screen.getByTestId('sim-company-day').textContent).toContain('4 / 30')
    expect(screen.getByTestId('sim-model-usage').textContent).toContain('no model calls')
    expect(screen.getByTestId('sim-model-usage').textContent).not.toContain('$0')
    expect(screen.getByTestId('sim-metric-purchaseCostMinor').textContent).toContain('$7,250.00')
    expect(screen.getByTestId('sim-metric-purchaseCostMinor').textContent).toContain('action_applied:place_purchase')
    expect(screen.getByTestId('sim-metric-lateDays').textContent).toContain('0')
  })
  it('Step posts one step with an idempotency key and a version, then refreshes; Run to day posts untilDay', async () => {
    render(<SimulationClient initial={snapshot()} />)
    await act(async () => { fireEvent.click(screen.getByTestId('sim-step')) })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/sim/s1/step')
    const body = JSON.parse(String(init.body)) as { steps: number; expectedVersion: number; idempotencyKey: string }
    expect(body).toMatchObject({ steps: 1, expectedVersion: 2 })
    expect(body.idempotencyKey.length).toBeGreaterThan(8)
    expect(routerRefresh).toHaveBeenCalled()
    fireEvent.change(screen.getByTestId('sim-run-to-day'), { target: { value: '30' } })
    await act(async () => { fireEvent.click(screen.getByTestId('sim-run-to')) })
    expect(JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toMatchObject({ untilDay: 30, expectedVersion: 2 })
  })
  it('a refusal lands in sim-error; Pause/Resume/Halt hit their routes; halt needs a confirm', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'simulation s1 moved on (version 3, you saw 2): reload and retry' }), { status: 409 }))
    render(<SimulationClient initial={snapshot()} />)
    await act(async () => { fireEvent.click(screen.getByTestId('sim-step')) })
    expect(screen.getByTestId('sim-error').textContent).toContain('moved on')
    await act(async () => { fireEvent.click(screen.getByTestId('sim-pause')) })
    expect(fetchMock).toHaveBeenCalledWith('/api/sim/s1/pause', expect.objectContaining({ method: 'POST' }))
    fireEvent.click(screen.getByTestId('sim-halt'))
    await act(async () => { fireEvent.click(screen.getByTestId('sim-halt-confirm')) })
    expect(fetchMock).toHaveBeenCalledWith('/api/sim/s1/halt', expect.objectContaining({ method: 'POST' }))
  })
  it('a paused run shows Resume instead of Pause and disables Step; a finished run disables everything but the tabs', () => {
    const { unmount } = render(<SimulationClient initial={snapshot({ summary: { ...snapshot().summary, status: 'paused' } })} />)
    expect(screen.queryByTestId('sim-pause')).toBeNull()
    expect(screen.getByTestId('sim-resume')).toBeTruthy()
    expect((screen.getByTestId('sim-step') as HTMLButtonElement).disabled).toBe(true)
    unmount()
    render(<SimulationClient initial={snapshot({ summary: { ...snapshot().summary, status: 'finished', simTime: 30 } })} />)
    expect((screen.getByTestId('sim-step') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('sim-run-to') as HTMLButtonElement).disabled).toBe(true)
  })
  it('the Decisions tab lists each decision with role, provider, actions, rationale and the rule outcome; the Journal tab lists every row', () => {
    render(<SimulationClient initial={snapshot()} />)
    fireEvent.click(screen.getByTestId('sim-tab-decisions'))
    const rows = screen.getAllByTestId('sim-decision-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('purchasing')
    expect(rows[0]?.textContent).toContain('rules')
    expect(rows[0]?.textContent).toContain('place_purchase')
    expect(rows[0]?.textContent).toContain('shortfall 50')
    expect(rows[0]?.textContent).toContain('applied')
    fireEvent.click(screen.getByTestId('sim-tab-journal'))
    expect(screen.getAllByTestId('sim-journal-row')).toHaveLength(4)
    expect(screen.getAllByTestId('sim-journal-row')[2]?.textContent).toContain('capacity_exhausted')
  })
  it('injecting a demand posts the event for a future day', async () => {
    render(<SimulationClient initial={snapshot()} />)
    fireEvent.click(screen.getByTestId('sim-inject-open'))
    fireEvent.change(screen.getByTestId('sim-inject-kind'), { target: { value: 'demand' } })
    fireEvent.change(screen.getByTestId('sim-inject-day'), { target: { value: '6' } })
    fireEvent.change(screen.getByTestId('sim-inject-qty'), { target: { value: '20' } })
    await act(async () => { fireEvent.click(screen.getByTestId('sim-inject-submit')) })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/sim/s1/inject')
    expect(JSON.parse(String(init.body))).toMatchObject({ day: 6, event: { type: 'demand', qty: 20 } })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/web/test/simulation-page.test.tsx` → FAIL.

- [ ] **Step 3: Implement the page**

`apps/web/src/app/sim/[simulationId]/page.tsx`:
```tsx
import { buildSimulationSnapshot } from '../../../server/simulation'
import { SimulationClient } from '../../../components/sim/SimulationClient'

export const dynamic = 'force-dynamic'

export default async function SimulationPageRoute({ params }: { params: Promise<{ simulationId: string }> }): Promise<React.JSX.Element> {
  const { simulationId } = await params
  const snapshot = await buildSimulationSnapshot(simulationId)
  if (snapshot === null) return <main className="p-6 text-tone-blocked">no simulation with id {simulationId}</main>
  return <SimulationClient key={`${simulationId}:${snapshot.summary.version}`} initial={snapshot} />
}
```
`apps/web/src/components/sim/SimulationStrip.tsx`:
```tsx
import { Chip } from '../ui/Chip'
import type { SimulationSummary } from '@slave-of-ai/control'

/** The one line every simulation screen carries (spec §7): what this is, and what it is not. */
export function SimulationStrip({ summary }: { readonly summary: SimulationSummary }): React.JSX.Element {
  return (
    <div data-testid="sim-strip" className="flex flex-wrap items-center gap-2 border-b border-line bg-bg-1 px-6 py-2 text-xs text-text-2">
      <Chip tone="waiting">SIMULATION</Chip>
      <span>{summary.companyName}</span><span>·</span><span>{summary.sector}</span><span>·</span><span>policy {summary.policy}</span><span>·</span>
      <span>{summary.decisionProvider} provider</span><span>·</span>
      <span className="text-text-3">synthetic data — not a real company; no real order, payment or tool is touched</span>
    </div>
  )
}
```
`apps/web/src/components/sim/JournalTable.tsx`: a `DataTable`/`Row` (from `ui/DataTable`) rendering `JournalRow[]` with columns seq · day · kind · role · summary, where `summary` is: decision → the action types and rationale list; action_applied → `applied <type> <params JSON>`; action_rejected → `rejected <type>: <reason.kind> <reason JSON>`; event/external_event → `<event.type ?? payload.kind> <record JSON minus event>`; control → `payload.op`. Each row `data-testid="sim-journal-row"`.

`apps/web/src/components/sim/SimulationClient.tsx` — the body:
```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatMinor } from '../../lib/money'
import { sendControl } from '../../lib/postControl'
import type { SimulationSnapshot, JournalRow } from '../../server/simulation'
import { DangerConfirm } from '../ui/DangerConfirm'
import { PrimaryButton, GhostButton, SelectField, TextField } from '../ui/FormControls'
import { Panel } from '../ui/Panel'
import { StatStrip } from '../ui/StatStrip'
import { JournalTable } from './JournalTable'
import { SimulationStrip } from './SimulationStrip'

type Tab = 'overview' | 'decisions' | 'journal'
const METRIC_LABELS = { deliveredQty: 'delivered', onTimeQty: 'on time', lateDays: 'late days', purchaseCostMinor: 'purchase cost', closingInventory: 'closing stock', closingCashMinor: 'closing cash', minCashMinor: 'minimum cash', collectedMinor: 'collected', unpaidCommitmentsMinor: 'unpaid commitments' } as const
const MONEY = new Set(['purchaseCostMinor', 'closingCashMinor', 'minCashMinor', 'collectedMinor', 'unpaidCommitmentsMinor'])

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
}

export function SimulationClient({ initial }: { readonly initial: SimulationSnapshot }): React.JSX.Element {
  const router = useRouter()
  const { summary, company, metrics, currency } = initial
  const [tab, setTab] = useState<Tab>('overview')
  const [runToDay, setRunToDay] = useState(String(summary.horizonDays))
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [injectOpen, setInjectOpen] = useState(false)
  const [inject, setInject] = useState({ kind: 'demand', day: String(company.day + 1), qty: '10', unitPrice: '120.00', dueInDays: '10', collectInDays: '15', supplierId: 'normal', extraDays: '3' })
  const runnable = summary.status === 'ready' || summary.status === 'running'
  const base = `/api/sim/${summary.id}`

  const call = async (path: string, body?: Record<string, unknown>): Promise<void> => {
    if (pending) return
    setPending(true)
    setErrorText(null)
    const error = await sendControl(`${base}/${path}`, body === undefined ? { method: 'POST' } : { method: 'POST', body })
    setPending(false)
    if (error !== null) setErrorText(error)
    else router.refresh()
  }
  const stepBody = (extra: Record<string, unknown>): Record<string, unknown> => ({ ...extra, expectedVersion: summary.version, idempotencyKey: newKey() })
  const submitInject = (): Promise<void> => {
    const day = Number.parseInt(inject.day, 10)
    const event = inject.kind === 'demand'
      ? { type: 'demand', qty: Number.parseInt(inject.qty, 10), unitPriceMinor: Math.round(Number.parseFloat(inject.unitPrice) * 100), dueInDays: Number.parseInt(inject.dueInDays, 10), collectInDays: Number.parseInt(inject.collectInDays, 10) }
      : { type: 'supplier_delay', supplierId: inject.supplierId, extraDays: Number.parseInt(inject.extraDays, 10) }
    return call('inject', { day, event, idempotencyKey: newKey() })
  }
  const decisions = initial.journal.filter((row) => row.kind === 'decision')
  const outcomesFor = (decision: JournalRow): readonly JournalRow[] => initial.journal.filter((row) => (row.kind === 'action_applied' || row.kind === 'action_rejected') && row.simTime === decision.simTime && row.actorRole === decision.actorRole && row.payload['index'] === decision.payload['index'])

  return (
    <div className="flex min-h-screen flex-1 flex-col">
      <SimulationStrip summary={summary} />
      <div className="flex flex-col gap-4 p-6">
        <div data-testid="sim-controls" className="flex flex-wrap items-center gap-2">
          <h1 className="mr-2 text-[14.5px] font-semibold text-text-1">{summary.name}</h1>
          <PrimaryButton data-testid="sim-step" disabled={pending || !runnable} onClick={() => void call('step', stepBody({ steps: 1 }))}>Step 1 day</PrimaryButton>
          <TextField inputProps={{ 'aria-label': 'run to day', 'data-testid': 'sim-run-to-day', value: runToDay, inputMode: 'numeric', className: 'w-16', onChange: (event) => setRunToDay(event.target.value) } as React.InputHTMLAttributes<HTMLInputElement>} />
          <PrimaryButton data-testid="sim-run-to" disabled={pending || !runnable} onClick={() => void call('step', stepBody({ untilDay: Number.parseInt(runToDay, 10) }))}>Run to day</PrimaryButton>
          {summary.status === 'paused' ? (
            <GhostButton data-testid="sim-resume" disabled={pending} onClick={() => void call('resume')}>Resume</GhostButton>
          ) : (
            <GhostButton data-testid="sim-pause" disabled={pending || !runnable} onClick={() => void call('pause')}>Pause</GhostButton>
          )}
          <DangerConfirm label="Halt" testId="sim-halt" confirmText="halt this simulation: no further step, ever" disabled={pending || summary.status === 'finished' || summary.status === 'halted'} onConfirm={async () => { const error = await sendControl(`${base}/halt`, { method: 'POST', body: { reason: 'operator' } }); if (error === null) router.refresh(); return error }} />
          <GhostButton data-testid="sim-inject-open" disabled={summary.status === 'finished' || summary.status === 'halted'} onClick={() => setInjectOpen((v) => !v)}>Add external event</GhostButton>
          {errorText !== null && <span role="alert" data-testid="sim-error" className="text-xs text-tone-blocked">{errorText}</span>}
          {summary.status === 'halted' && <span className="text-xs text-text-3">halted{summary.haltedReason !== null ? ` (${summary.haltedReason})` : ''} — stepping is in-request, so nothing was in flight to stop</span>}
        </div>
        {injectOpen && (
          <div className="flex flex-wrap items-end gap-2 rounded-card border border-line bg-bg-2 p-3">
            <SelectField label="event" selectProps={{ 'data-testid': 'sim-inject-kind', value: inject.kind, onChange: (event) => setInject({ ...inject, kind: event.target.value }) } as React.SelectHTMLAttributes<HTMLSelectElement>}><option value="demand">customer demand</option><option value="supplier_delay">supplier delay</option></SelectField>
            <TextField label="day" inputProps={{ 'data-testid': 'sim-inject-day', value: inject.day, className: 'w-16', onChange: (event) => setInject({ ...inject, day: event.target.value }) } as React.InputHTMLAttributes<HTMLInputElement>} />
            {inject.kind === 'demand' ? (
              <>
                <TextField label="qty" inputProps={{ 'data-testid': 'sim-inject-qty', value: inject.qty, className: 'w-16', onChange: (event) => setInject({ ...inject, qty: event.target.value }) } as React.InputHTMLAttributes<HTMLInputElement>} />
                <TextField label={`unit price (${currency})`} inputProps={{ 'data-testid': 'sim-inject-price', value: inject.unitPrice, className: 'w-20', onChange: (event) => setInject({ ...inject, unitPrice: event.target.value }) } as React.InputHTMLAttributes<HTMLInputElement>} />
                <TextField label="due in days" inputProps={{ 'data-testid': 'sim-inject-due', value: inject.dueInDays, className: 'w-16', onChange: (event) => setInject({ ...inject, dueInDays: event.target.value }) } as React.InputHTMLAttributes<HTMLInputElement>} />
                <TextField label="collect in days" inputProps={{ 'data-testid': 'sim-inject-collect', value: inject.collectInDays, className: 'w-16', onChange: (event) => setInject({ ...inject, collectInDays: event.target.value }) } as React.InputHTMLAttributes<HTMLInputElement>} />
              </>
            ) : (
              <>
                <SelectField label="supplier" selectProps={{ 'data-testid': 'sim-inject-supplier', value: inject.supplierId, onChange: (event) => setInject({ ...inject, supplierId: event.target.value }) } as React.SelectHTMLAttributes<HTMLSelectElement>}><option value="normal">normal</option><option value="fast">fast</option></SelectField>
                <TextField label="extra days" inputProps={{ 'data-testid': 'sim-inject-extra-days', value: inject.extraDays, className: 'w-16', onChange: (event) => setInject({ ...inject, extraDays: event.target.value }) } as React.InputHTMLAttributes<HTMLInputElement>} />
              </>
            )}
            <PrimaryButton data-testid="sim-inject-submit" disabled={pending} onClick={() => void submitInject()}>Add</PrimaryButton>
            <span className="text-xs text-text-3">a clone of this run's scenario will not carry an event added here</span>
          </div>
        )}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Panel title="Simulated company">
            <div data-testid="sim-company" className="flex flex-col gap-1 text-xs text-text-2">
              <div>day <span data-testid="sim-company-day">{company.day} / {summary.horizonDays}</span></div>
              <div>cash <span data-testid="sim-company-cash" className="font-mono text-text-1">{formatMinor(company.cashMinor, currency)}</span></div>
              <div>stock <span data-testid="sim-company-inventory">{company.inventory}</span> · capacity {company.dailyShipCapacity}/day</div>
              <div>open orders {company.openOrders} · pending demand {company.pendingDemand} · inbound purchases {company.inboundPurchases}</div>
              <div className="text-text-3">simulated money in {currency}; not real spend</div>
            </div>
          </Panel>
          <Panel title="Model usage (real)">
            <div data-testid="sim-model-usage" className="text-xs text-text-2">
              {initial.modelUsage.rows === 0
                ? `${summary.decisionProvider} provider — no model calls; cost: no record`
                : `${initial.modelUsage.rows} calls · ${initial.modelUsage.costUsd === null ? 'cost unmeasured' : `$${initial.modelUsage.costUsd.toFixed(2)}`}${initial.modelUsage.unmeasured > 0 ? ` · ${initial.modelUsage.unmeasured} unmeasured` : ''}`}
            </div>
          </Panel>
        </div>
        <div className="flex gap-2 text-xs">
          {(['overview', 'decisions', 'journal'] as const).map((t) => <button key={t} type="button" data-testid={`sim-tab-${t}`} onClick={() => setTab(t)} className={`rounded px-2 py-1 ${tab === t ? 'bg-bg-2 text-text-1' : 'text-text-3'}`}>{t}</button>)}
        </div>
        {tab === 'overview' && (
          <Panel title="Metrics (from the journal)">
            <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
              {(Object.keys(METRIC_LABELS) as (keyof typeof METRIC_LABELS)[]).map((key) => {
                const value = metrics[key]
                const sources = (metrics.sources as Record<string, readonly string[] | undefined>)[key]
                return (
                  <div key={key} data-testid={`sim-metric-${key}`} className="rounded-card border border-line bg-bg-2 p-2 text-xs">
                    <div className="text-text-3">{METRIC_LABELS[key]}{key === 'minCashMinor' ? ` (day ${metrics.minCashDay})` : ''}</div>
                    <div className="font-mono text-sm text-text-1">{MONEY.has(key) ? formatMinor(value, currency) : String(value)}</div>
                    {sources !== undefined && <div className="text-[10px] text-text-3">from {sources.join(', ')}</div>}
                  </div>
                )
              })}
            </div>
            <div className="mt-3 text-xs text-text-3">roles: {initial.roles.map((r) => `${r.name} — ${r.slaveName}`).join(' · ')}</div>
          </Panel>
        )}
        {tab === 'decisions' && (
          <Panel title="Decisions">
            <div className="flex flex-col gap-2">
              {decisions.map((d) => (
                <div key={d.seq} data-testid="sim-decision-row" className="rounded-card border border-line bg-bg-2 p-2 text-xs text-text-2">
                  <div>day {d.simTime} · <span className="text-text-1">{d.actorRole}</span> · {String(d.payload['provider'])} provider</div>
                  {((d.payload['actions'] as { type: string; params: Record<string, unknown>; rationale: string }[] | undefined) ?? []).map((a, i) => {
                    const outcome = outcomesFor(d)[i]
                    return <div key={i} className="ml-2">{a.type} {JSON.stringify(a.params)} — “{a.rationale}” → {outcome === undefined ? 'no outcome' : outcome.kind === 'action_applied' ? 'applied' : `rejected: ${JSON.stringify(outcome.payload['reason'])}`}</div>
                  })}
                  {((d.payload['actions'] as unknown[] | undefined) ?? []).length === 0 && <div className="ml-2 text-text-3">no action</div>}
                </div>
              ))}
            </div>
          </Panel>
        )}
        {tab === 'journal' && <Panel title={`Journal (last ${initial.journal.length})`}><JournalTable rows={initial.journal} /></Panel>}
      </div>
    </div>
  )
}
```
`GhostButton`/`TextField` prop shapes: follow `FormControls.tsx` exactly (if `TextField` requires `label`, pass `label=""`; if `GhostButton` has no `data-testid` passthrough, it spreads `...rest`, so it does).

- [ ] **Step 4: Tests, typecheck, build**

Run: `npx vitest run apps/web/test/simulation-page.test.tsx` → PASS; `npm run --silent typecheck` → 0; `npm run web:build` → 0; `node scripts/gate-m26-vocabulary.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): m29 t10 — the simulation page: strip, controls, two money panels, metrics with sources, decisions and journal tabs, external events"
```

---

### Task 11: The closing gate, README, spec errata, full verification

**Files:**
- Create: `scripts/gate-m29-simulation.mjs`
- Modify: `package.json` (`"gate:m29-simulation": "tsc --build && node --env-file=.env scripts/gate-m29-simulation.mjs"`), `.github/workflows/*.yml` (add the gate beside `gate:m23-onboarding` only if CI has Chromium — check how m23 is run there; otherwise leave CI alone and record it), `README.md` (a "Simulations" row in the web UI table, a CLI cheat-sheet block, a short section "Company simulations"), the spec's §13
- Test: the gate itself; then the whole suite

- [ ] **Step 1: Write the gate**

`scripts/gate-m29-simulation.mjs`, borrowing `gate-m11-shell.mjs`'s skeleton verbatim (dist imports, `findFreePort`, `next dev` spawn + ready wait, Chromium from `CHROMIUM_PATH`, `try/finally` teardown, `exitCode` 1 until the end, scratch dir + screenshot on failure). Stages:
1. Seed a company `M29 Gate Trading` with four departments/slaves directly with prisma (the m10/m11 stage-1 idiom).
2. `/sim`: click `new-simulation`, pick the company, name `gate A`, policy A, seed 5, submit; wait for the URL `/sim/<id>`; assert with prisma that one `SimulationRun` exists with `definition.policy === 'A'` and `state.day === 0`.
3. On the run page: set `sim-run-to-day` to 30, click `sim-run-to`, wait until `sim-company-day` reads `30 / 30`; read `sim-metric-deliveredQty`, `sim-metric-lateDays`, `sim-metric-purchaseCostMinor` from the page; call `replaySimulation(id)` from `packages/control/dist/simulation.js` and assert `matches === true`; assert the page's metric text equals `tradeMetrics` computed from the DB journal via `packages/simulation/dist` (format the money through `Intl.NumberFormat` the same way).
4. Assert `SimulationModelUsage` count is 0 and `sim-model-usage` contains `no model calls`.
5. Repeat 2–3 for `gate B` (policy B); assert on the page that B's late days text is `0` and A's is not, and that B's purchase cost is greater — read from the DB, compared to the page.
6. `sim-step` on the finished run stays disabled; `/w/<seed workspace>` still renders its Overview (the software flow untouched — one navigation, one `slave-card` count vs prisma).
7. Cleanup in `finally`: delete the two runs, the company, close browser and server.

- [ ] **Step 2: Run the gate**

Run: `npm run gate:m29-simulation` (no `next dev` running elsewhere) → `PASS: …` and exit 0. Re-run once if a stage-2 badge-style repaint race appears; a second failure is a real one.

- [ ] **Step 3: README and spec errata**

README: in the web UI table add `| **Simulations** \`/sim\` | Company simulation runs (M29): create one from a catalog company — a trade company on synthetic data, decided by the rules provider, no repository and no model call; step it by day, run it to a horizon, pause, halt, add customer demand or a supplier delay; the simulated company's cash and the real model cost are two separate panels; metrics are computed from the run's own journal. |`. In the CLI cheat sheet add the three verbs. Add a short section after "Attach your repository":

> ## Try a company simulation
>
> A simulation is not a project: it needs no repository and calls no model. `npm run db:seed` ships “Demo Trading Co.” with the four roles the trade sector uses (sales, purchasing, operations, finance). From **Simulations** → **+ New simulation** pick it, choose policy A (wait for the normal supplier) or B (hedge with the fast one when a delivery is at risk), and run to day 30. Every number on the page is synthetic and every metric is derived from the run's journal; the spec at `docs/superpowers/specs/2026-09-06-m29-company-simulation-design.md` lists the assumptions.

Spec §13: replace "(filled in during execution)" with the rulings actually made across Tasks 1–11 (each task's report names its deviations; if none, write "No divergence from §1–§12 surfaced in Tasks 1–11." and list the M30 backlog: clone/compare, restart-safe pause, CLI parity for pause/inject/halt, SSE).

- [ ] **Step 4: Full verification**

Run, in this order, one at a time: `npm run --silent typecheck`; `npm test` (background, 10-minute budget); `npm run web:build`; `npm run gate:m26-vocabulary`; `npm run gate:m11-shell`; `npm run gate:m29-simulation`. All must pass; paste the tail of each into the task report.

- [ ] **Step 5: Commit**

```bash
git add scripts package.json README.md docs
git commit -m "test(gates),docs: m29 t11 — gate:m29-simulation drives two policies from the browser and checks replay and metrics against the journal; README; errata"
```
