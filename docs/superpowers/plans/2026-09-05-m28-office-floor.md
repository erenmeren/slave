# M28 Office Floor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new project tab `/w/[workspaceId]/office` that draws the project's departments and slaves as the design's isometric pixel office, with every slave's state, task and progress coming from the overview stream and the focus card's Pause/Resume/Stop hitting the real run routes.

**Architecture:** The design's `office-engine.js` is vendored into `apps/web/src/lib/office/engine.js` as one ES module: unused renderers dropped, `World.tick` split into `tick` + `simulate`, the pixel-font name made settable, and the whole file run through the M26 word codemod (`agent` → `slave`). `LiveOffice extends WorldF` (`liveOffice.ts`) overrides `simulate` so slaves never invent work: each frame it reconciles every slave with the live status the client `apply()`s from `useOverview`, keeps the design's idle wander, and locks progress to the real percentage. A server read `buildOfficeSnapshot` gives the page its roster (departments → slaves, deterministic colors) plus the initial overview snapshot; `OfficeClient` owns the canvas and the loop, `OfficeHud` and `FocusCard` are the design's overlays as React.

**Tech Stack:** Next.js 15 App Router, React 19, `next/font/google` (Silkscreen), Canvas 2D, Vitest 3 (unit `node`/`jsdom` + integration projects), Playwright gate m11.

**Spec:** `docs/superpowers/specs/2026-09-05-m28-office-floor-design.md` — read §2–§6 and §8 before any task; §-numbers below refer to it.

## Global Constraints

- Branch: `feature/m28-office-floor` (holds the spec commit e327e8e). Every task commits there.
- No schema change, no new npm dependency (Silkscreen through `next/font/google`).
- The vendored engine is vendor code: exactly the edits Task 1 lists (trim entry points, module wrap, `tick`/`simulate` split, `setPixelFont`, palette exports, the word codemod). Every behaviour change lives in `liveOffice.ts`.
- Live status per slave: `blocked` when `card.taskStatus === 'blocked'` or the card's `runId` is in `overview.blocked[]` rows of `kind: 'run'`; otherwise `card.status` (`SlaveStatus` = `idle | starting | working | pausing | paused | resuming | stopping`).
- Slave state on the floor (spec §4.2): `working` → `work`, `blocked` → `blocked`, `pausing`/`paused` → `paused`, `starting`/`resuming` → one walk to the board (`grab`) then `work`, `stopping` → one walk to the board (`deliver`) then `sit`, `idle` → `sit` with the design's wander (arcade 18 %, coffee 22 %). Progress is the real `progressPct`, never advanced by a tick. Idle slaves may leave the desk; non-idle never do.
- Controls: `office-focus-pause` → `POST /api/w/${workspaceId}/runs/${runId}/pause` (label `Pause`) or `/resume` (label `Resume`, when the live status is `paused`); `office-focus-stop` → `/stop`; both disabled when `runId === null`; hidden when the project is archived; a refusal string renders in `office-focus-error` (`role="alert"`). No optimistic state.
- HUD copy: `{N} department(s) · {N} slave(s) · {N} working` via `plural()` from `apps/web/src/lib/plural.ts`; the clock is the browser's wall clock unless the slider (`office-hour`) locks an hour; `office-live` clears the lock.
- Testids: `office-canvas`, `office-stream`, `office-hud-counts`, `office-tod`, `office-clock`, `office-hour`, `office-live`, `office-legend`, `office-zoom-out`, `office-zoom`, `office-zoom-in`, `office-focus`, `office-focus-pause`, `office-focus-next`, `office-focus-stop`, `office-focus-error`, `project-tab-office`.
- Vocabulary: "project", "slave", "department" in every user-facing string; identifiers keep Team/Workspace. `npm run gate:m26-vocabulary` must pass with the vendored engine (renamed) in the tree; `docs/superpowers/**` is already excluded, so the handoff copies need no gate change.
- Standing rules: ONE vitest run at a time; no orchestrator daemon during tests; root `tsc --build` does NOT cover `apps/web` — `npx tsc -p apps/web/tsconfig.test.json --noEmit`; every web task gates on `npm run web:build` before commit (`pgrep -fa 'next dev'` empty first, `rm -rf apps/web/.next` after); `git add` explicit paths; comments change with the behaviour they describe.
- Integration tests (`**/test/integration/**`) use the Postgres at :5433 (`slaveofai_test`); TRUNCATE list: `"ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate"`.
- Commit trailers on every commit: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01Jhjdbyu7XrvmzTL5Vw5aAD`.

## File structure

Create:
- `docs/superpowers/design/2026-09-05-office-floor/{Office Floor.dc.html, office-engine.js, README.md}` (already on disk, untracked — Task 1 commits them)
- `apps/web/src/lib/office/engine.js`, `apps/web/src/lib/office/engine.d.ts` — the vendored engine and its types
- `apps/web/src/lib/office/liveOffice.ts` — the adapter (status → floor state, board, wall clock, progress lock)
- `apps/web/src/server/office.ts` — `buildOfficeSnapshot`
- `apps/web/src/app/w/[workspaceId]/office/page.tsx`
- `apps/web/src/components/office/OfficeClient.tsx` (canvas, loop, input, stream), `OfficeHud.tsx` (four overlays), `FocusCard.tsx`
- Tests: `apps/web/test/office-engine.test.ts`, `apps/web/test/office-live.test.ts`, `apps/web/test/office-client.test.tsx`, `apps/web/test/integration/office.test.ts`

Modify: `apps/web/src/components/project/ProjectTabs.tsx`, `apps/web/test/project-tabs.test.tsx`, `scripts/gate-m11-shell.mjs` (stage 7), `README.md`, the spec's §13.

---

### Task 1: Vendor the engine as a module

**Files:**
- Create: `apps/web/src/lib/office/engine.js`, `apps/web/src/lib/office/engine.d.ts`, `apps/web/test/office-engine.test.ts`
- Commit also: `docs/superpowers/design/2026-09-05-office-floor/` (three files, already on disk)

**Interfaces:**
- Produces the module `apps/web/src/lib/office/engine.js` with named exports `World`, `WorldF`, `renderIsoE`, `tod`, `STATUS`, `setPixelFont`, `makeDepartments`, `DEPT_COLORS`, `SLAVE_COLORS`, typed by `engine.d.ts` (below). After the codemod the world's fields are `slaves`, `desks[].slave`, `events[].slave`/`slaveColor`, `makeDepartments()` returns `{ name, color, slaves }`, and the constructor reads `cfg.departments[i].slaves`.
- `World.tick(dt)` = `this.t += dt; this.simulate(dt)`; `simulate(dt)` holds the design's whole state machine (the part Task 2 overrides).

- [ ] **Step 1: Failing test.** Create `apps/web/test/office-engine.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { DEPT_COLORS, SLAVE_COLORS, STATUS, WorldF, makeDepartments, renderIsoE, setPixelFont, tod } from '../src/lib/office/engine.js'

/** A 2D context that accepts every call the engine makes and answers `measureText`. Any property
 *  read is a chainable no-op function (so `createLinearGradient(...).addColorStop(...)` works),
 *  any write is accepted, and `canvas` reports a size. */
function fakeContext(width = 800, height = 500): CanvasRenderingContext2D {
  const fake: unknown = new Proxy(function noop() {}, {
    get(_target, key) {
      if (key === 'canvas') return { width, height }
      if (key === 'measureText') return () => ({ width: 10 })
      return () => fake
    },
    set() {
      return true
    },
  })
  return fake as CanvasRenderingContext2D
}

const DEPARTMENTS = [
  { name: 'Engineering', color: '#2ee6cf', slaves: [{ name: 'Alex', role: 'backend' }, { name: 'Maya', role: 'qa' }] },
  { name: 'Product', color: '#7b8cff', slaves: [{ name: 'John', role: 'analyst' }] },
]

describe('the vendored office engine', () => {
  it('builds one desk per slave, in department order, and names departments as given', () => {
    const world = new WorldF({ departments: DEPARTMENTS })
    expect(world.departments.map((d) => d.name)).toEqual(['Engineering', 'Product'])
    expect(world.slaves.map((s) => s.name)).toEqual(['Alex', 'Maya', 'John'])
    expect(world.desks).toHaveLength(3)
    expect(world.desks.map((d) => d.slave?.name)).toEqual(['Alex', 'Maya', 'John'])
    expect(world.slaves.every((s) => s.state === 'sit')).toBe(true)
  })

  it('exposes the palettes the server read colours departments and slaves with', () => {
    expect(DEPT_COLORS).toHaveLength(12)
    expect(DEPT_COLORS[1]).toBe('#2ee6cf')
    expect(SLAVE_COLORS).toHaveLength(6)
    expect(STATUS.working).toBe('#2ee6cf')
    expect(tod(12).label).toBeTypeOf('string')
    expect(makeDepartments(2, 3)[0]?.slaves).toHaveLength(3)
  })

  it('ticks and renders one isometric frame against a recording context without throwing', () => {
    const world = new WorldF({ departments: DEPARTMENTS })
    setPixelFont('Silkscreen')
    for (let i = 0; i < 20; i++) world.tick(0.05)
    expect(() => renderIsoE(fakeContext(), world, { viewKey: 'view', tod: true, fun: true, autofit: true, deptSigns: 'banner' })).not.toThrow()
    expect(world.view?.levels).toHaveLength(4)
    expect(world.t).toBeCloseTo(1, 5)
  })

  it('splits tick into the clock and the simulation so an adapter can replace the simulation', () => {
    const world = new WorldF({ departments: DEPARTMENTS })
    let simulated = 0
    world.simulate = () => {
      simulated += 1
    }
    world.tick(0.1)
    expect(simulated).toBe(1)
    expect(world.t).toBeCloseTo(0.1, 5)
  })
})
```

- [ ] **Step 2: RED.** `npx vitest run apps/web/test/office-engine.test.ts` → fails: cannot find `../src/lib/office/engine.js`.

- [ ] **Step 3: Copy and trim.** `mkdir -p apps/web/src/lib/office && cp "docs/superpowers/design/2026-09-05-office-floor/office-engine.js" apps/web/src/lib/office/engine.js`. Then, in `apps/web/src/lib/office/engine.js`, delete these top-level definitions whole (each is a `function …(){…}` or `class …{…}` that starts at column 0 and ends at the next column-0 definition; the line numbers are those of the handoff file — re-locate by name, never by number, after each deletion):
  - section 1: `function renderSide`, `function renderTop`, `function renderIso` (lines 97–189);
  - section 2 (the whole IIFE at 193–303: `WorldB`, `walkRows`, `drawDeskSide`, `arcadeSide`, `coffeeSide`, `vendingSide`, `sofaSide`, `plantSide`, `windowSide`, `renderSideB`, `renderIsoB` and its `E.WorldB=…` line) — delete from the `(function(){` at 194 through its `})();` at 303 inclusive;
  - section 3: `class WorldC`, `function renderSideC`, `function renderIsoC`, and the line `E.WorldC=WorldC;E.renderSideC=renderSideC;E.renderIsoC=renderIsoC;` — keep everything else in that section (the sprite tables, `look`, `pal`, `spr`, `acc`, `agentSprite`, `bubble`, `lerpC`, `SEATED`, `skyColor`, `windowC`, `deskC`, `arcadeC`, `coffeeC`, `vendingC`, `sofaC`, `plantC`, `shelfC`, `coolerC`, `pendant`, `labelsPx`, the `E._c=…` line);
  - section 4: `function renderSideD`, `function renderIsoD`, `function renderSideE`, and the lines `E.renderSideD=renderSideD;E.renderIsoD=renderIsoD;` and `E.renderSideE=renderSideE;` — keep `wallD`, `floorD`, `deskD`, `shadow`, `focusMark`, `fit`, the `PX/BANDS/CORR` line, `WorldD`, `renderIsoE`, `TOD`, `E.tod`, `windowE`, every `*S` prop function, `WorldE`, `WorldF`, `DEPT_POOL`, `NAME_POOL`, `E.makeDepartments`.
  If a later step's test throws `ReferenceError: X is not defined`, restore `X` from the handoff copy and name it in the report.

- [ ] **Step 4: Module wrap.** Still in `engine.js`:
  1. Replace the file's first line (`/* Pixel office simulation + 3 renderers … */`) with:
  ```js
  /**
   * Vendored from the Claude Design handoff `docs/superpowers/design/2026-09-05-office-floor/office-engine.js`
   * (M28 §4.1). Edits, and only these: the side/top/iso v1–v4 renderers and WorldB/WorldC dropped;
   * the four IIFEs became block scopes over one `OfficeEngine` object with named exports at the
   * bottom; `World.tick` split into `tick` (the clock) + `simulate` (the design's state machine,
   * which `liveOffice.ts` overrides); the pixel font name is settable (`setPixelFont`) because
   * `next/font` serves Silkscreen under a hashed family name; the palettes are exported; the M26
   * word codemod renamed agent → slave. Pixel-art code keeps its own style.
   */
  const OfficeEngine = {}
  let PIXEL_FONT = 'Silkscreen'
  ```
  2. Each remaining `(function(){` → `{` and each `})();` → `}` (four IIFEs → four blocks; section 2 is already gone).
  3. Section 1's export line `window.OfficeEngine={World,renderSide,renderTop,renderIso,STATUS,_h:{…}};` → `Object.assign(OfficeEngine,{World,STATUS,_h:{rect,spr,SPR,pal,drawBoard,bubble,labels,screenLines,stars,rnd,shade}});`.
  4. Every `const E=window.OfficeEngine,` (sections 3 and 4) → `const E=OfficeEngine,`.
  5. Palettes: in section 1, right after the `Object.assign(OfficeEngine, …)` line from step 3, add `OfficeEngine.AGENT_COLORS=AGENT_COLORS;`; in section 4, after the `E.makeDepartments=function…;` line, add `E.DEPT_COLORS=DEPT_POOL.map((d)=>d[1]);`.
  6. The three font literals: `'9px Silkscreen, monospace'` (two places: section 1 `labels`, section 3 `labelsPx`) → `` `9px ${PIXEL_FONT}, monospace` `` and `'8px Silkscreen, monospace'` (section 4 `neonS`) → `` `8px ${PIXEL_FONT}, monospace` ``; `grep -c Silkscreen engine.js` must then be 1 (the `let PIXEL_FONT` default).
  7. `World.tick` (section 1): change the method head
  ```js
    tick(dt){
      this.t+=dt;const T=this.t;
  ```
  to
  ```js
    tick(dt){this.t+=dt;this.simulate(dt)}
    /** The design's state machine: invents tasks, moves agents, blocks them at random. `liveOffice.ts`
     *  overrides this whole method; nothing else in the engine calls it. */
    simulate(dt){const T=this.t;
  ```
  (the rest of the old `tick` body becomes `simulate`'s body, unchanged).
  8. Append at the end of the file:
  ```js
  export const { World, WorldF, renderIsoE, tod, STATUS, makeDepartments, DEPT_COLORS, AGENT_COLORS } = OfficeEngine
  export function setPixelFont(family) { PIXEL_FONT = family }
  ```
  9. `node --check apps/web/src/lib/office/engine.js` passes (a `SyntaxError` here means a block was cut mid-definition).

- [ ] **Step 5: The word codemod.** `node scripts/rename-agent-to-slave.mjs --phase words apps/web/src/lib/office/engine.js` (the M26 codemod's `words` phase renames `agent`/`Agent`/`AGENT` and their plurals in one file; `--dry-run` first to see the count). After it: `grep -ci agent apps/web/src/lib/office/engine.js` is 0; the export line reads `… DEPT_COLORS, SLAVE_COLORS } = OfficeEngine`; `this.slaves`, `slaveSprite`, `d.slaves`, `desks[].slave`, `e.slave` throughout. `node --check` again.

- [ ] **Step 6: Types.** Create `apps/web/src/lib/office/engine.d.ts`:

```ts
/** Types for the vendored engine (M28 §4.1): only what `liveOffice.ts` and the office components
 *  touch. The JS is the source of truth; these names follow the M26 rename (`slaves`, not agents). */
export interface WorldTask {
  key: string
  title: string
  color: string | null
  deptColor: string | null
  status: string
  blockedBy: WorldTask | null
}
export interface WorldPoint { x: number; y: number }
export interface WorldSlave {
  id: string
  name: string
  role: string
  color: string
  dept: number
  /** `sit | walk | grab | work | blocked | pausing | paused | resuming | coffee | arcade | deliver` */
  state: string
  next?: string
  delivering?: boolean
  task: WorldTask | null
  progress: number
  x: number
  y: number
  dir: number
  vdir?: 'front' | 'back' | 'side'
  path: WorldPoint[]
  timer: number
  deskIdx: number
  sw: number
  lookIdx?: number
}
export interface WorldDepartment { name: string; color: string; index: number; x0: number; x1: number; y0: number; y1: number; band?: number }
export interface WorldDesk { x: number; y: number; dept: number; slave?: WorldSlave }
export interface WorldView { S: number; ox: number; oy: number; w: number; h: number; levels: number[]; li: number; base?: number }
export interface WorldHit { id: string; x: number; y: number; w: number; h: number }
export interface WorldEvent { seq: number; t: number; type: string; slave: string; slaveColor: string; task: string; text: string }
export interface DepartmentInput { name: string; color: string; slaves: { name: string; role: string; color?: string }[] }
export type StatusKey = 'working' | 'planning' | 'review' | 'waiting' | 'blocked' | 'done' | 'paused' | 'idle'

export declare class World {
  constructor(cfg: { departments: DepartmentInput[] })
  t: number
  hour: number
  hourLock: number | null
  focusId: string | null
  slaves: WorldSlave[]
  departments: WorldDepartment[]
  desks: WorldDesk[]
  board: { todo: WorldTask[]; doing: WorldTask[]; review: WorldTask[]; done: WorldTask[] }
  view?: WorldView
  viewHits?: WorldHit[]
  events: WorldEvent[]
  W: number
  D: number
  tick(dt: number): void
  simulate(dt: number): void
  status(slave: WorldSlave): StatusKey
  clock(): string
  seat(slave: WorldSlave): WorldPoint
  goTo(slave: WorldSlave, target: WorldPoint, next: string): void
  boardTarget(): WorldPoint
  coffeeTarget(): WorldPoint
  arcadeTarget(): WorldPoint
  ev(type: string, slave: WorldSlave | null, task: WorldTask | null, text: string): void
  pause(id: string): void
  resume(id: string): void
  stop(id: string): void
}
export declare class WorldF extends World {}
export declare const STATUS: Record<StatusKey, string>
export declare const DEPT_COLORS: readonly string[]
export declare const SLAVE_COLORS: readonly string[]
export declare function renderIsoE(
  ctx: CanvasRenderingContext2D,
  world: World,
  opts: { viewKey?: string; tod?: boolean; fun?: boolean; autofit?: boolean; deptSigns?: 'banner' | 'pole' },
): void
export declare function tod(hour: number): { sky: string; horizon: string; ambient: string; light: number; label: string }
export declare function makeDepartments(deptCount: number, perDept: number): DepartmentInput[]
/** The family the canvas labels ask for (`next/font` serves Silkscreen under a hashed name). */
export declare function setPixelFont(family: string): void
```

- [ ] **Step 7: GREEN.** `npx vitest run apps/web/test/office-engine.test.ts` → 4 pass. `npx tsc -p apps/web/tsconfig.test.json --noEmit` clean (if tsc complains that `engine.js` is not under `rootDir`/`allowJs`, the `.d.ts` sibling is what it should resolve — check `apps/web/tsconfig.json`'s `include` covers `src/**/*.d.ts` and report what you found). `npm run gate:m26-vocabulary` → PASS (the renamed engine is in the tree; the handoff under `docs/superpowers/` is excluded).

- [ ] **Step 8: Commit.**

```bash
git add "docs/superpowers/design/2026-09-05-office-floor/Office Floor.dc.html" docs/superpowers/design/2026-09-05-office-floor/office-engine.js docs/superpowers/design/2026-09-05-office-floor/README.md apps/web/src/lib/office/engine.js apps/web/src/lib/office/engine.d.ts apps/web/test/office-engine.test.ts
git commit -m "feat(web): m28 t1 — the office engine vendored as a module: renderers trimmed, tick split from the simulation, pixel font settable, agent renamed slave"
```

---

### Task 2: The live adapter

**Files:**
- Create: `apps/web/src/lib/office/liveOffice.ts`, `apps/web/test/office-live.test.ts`

**Interfaces:**
- Consumes `WorldF`, `WorldSlave`, `WorldTask` from `./engine.js` (Task 1); `SlaveCardData`, `OverviewSnapshot` from `apps/web/src/server/overview.ts`.
- Produces (Task 4 consumes):
```ts
export type LiveStatus = 'idle' | 'starting' | 'working' | 'blocked' | 'pausing' | 'paused' | 'resuming' | 'stopping'
export interface LiveSlave { readonly slaveId: string; readonly status: LiveStatus; readonly taskTitle: string | null; readonly stepLabel: string | null; readonly progressPct: number; readonly runId: string | null }
export interface LiveBoard { readonly todo: number; readonly doing: number; readonly review: number; readonly done: number }
export interface OfficeRosterSlave { readonly slaveId: string; readonly name: string; readonly role: string; readonly color: string }
export interface OfficeRosterDepartment { readonly teamId: string; readonly name: string; readonly color: string; readonly slaves: readonly OfficeRosterSlave[] }
export function liveStatusOf(card: SlaveCardData, blockedRunIds: ReadonlySet<string>): LiveStatus
export function liveSlavesOf(overview: OverviewSnapshot): ReadonlyMap<string, LiveSlave>
export function boardFromOverview(overview: OverviewSnapshot): LiveBoard
export class LiveOffice extends WorldF {
  constructor(departments: readonly OfficeRosterDepartment[])
  apply(live: ReadonlyMap<string, LiveSlave>, board: LiveBoard): void
  setWallClock(hour: number): void
  liveOf(slaveId: string): LiveSlave | null
}
```
(`OfficeRosterDepartment` is the shape Task 3's `OfficeDepartment` satisfies; it lives here so the adapter does not import the server module.)

- [ ] **Step 1: Failing tests.** Create `apps/web/test/office-live.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveOffice, boardFromOverview, liveSlavesOf, liveStatusOf, type LiveSlave, type LiveStatus } from '../src/lib/office/liveOffice.js'
import type { OverviewSnapshot, SlaveCardData } from '../src/server/overview.js'

function card(over: Partial<SlaveCardData> = {}): SlaveCardData {
  return {
    id: 's1', name: 'Alex', role: 'backend', provider: null, gate: null, status: 'idle', taskTitle: null, taskId: null,
    taskStatus: null, progressPct: 0, stepLabel: null, skill: null, actionLine: null, runId: null, queuedMessage: null,
    resumeRequestedAt: null, recentEvents: [], costUsd: null, toolCalls: 0, pausedAtStep: null, ...over,
  }
}

function overview(over: Partial<OverviewSnapshot> = {}): OverviewSnapshot {
  return {
    workspace: {
      id: 'w1', name: 'Checkout', haltedReason: null, haltedAt: null, budgetUsd: null, spentUsd: 0, unmeasuredRuns: 0, goal: null,
      provider: null, costBlindBudgeted: false, maxConcurrentRuns: 3, runTimeoutMs: 1000, maxAttempts: 3,
    } as OverviewSnapshot['workspace'],
    slaves: [],
    tasks: { active: 2, ready: 3, blocked: 1, done: 4, failed: 0 } as OverviewSnapshot['tasks'],
    blocked: [],
    liveEvents: [],
    mergeQueue: [],
    ...over,
  } as OverviewSnapshot
}

const ROSTER = [
  { teamId: 't1', name: 'Engineering', color: '#2ee6cf', slaves: [{ slaveId: 's1', name: 'Alex', role: 'backend', color: '#2ee6cf' }, { slaveId: 's2', name: 'Maya', role: 'qa', color: '#7b8cff' }] },
  { teamId: 't2', name: 'Product', color: '#7b8cff', slaves: [{ slaveId: 's3', name: 'John', role: 'analyst', color: '#c084fc' }] },
]

function live(status: LiveStatus, over: Partial<LiveSlave> = {}): LiveSlave {
  return { slaveId: 's1', status, taskTitle: status === 'idle' ? null : 'Add the thing', stepLabel: 'verifying', progressPct: 40, runId: status === 'idle' ? null : 'r1', ...over }
}

function office(): LiveOffice {
  const o = new LiveOffice(ROSTER)
  o.setWallClock(10)
  return o
}

/** Ticks until every slave is seated again (a transition walk takes a few seconds of world time). */
function settle(o: LiveOffice, seconds = 30): void {
  for (let i = 0; i < seconds * 20; i++) o.tick(0.05)
}

afterEach(() => vi.restoreAllMocks())

describe('liveStatusOf', () => {
  it.each(['idle', 'starting', 'working', 'pausing', 'paused', 'resuming', 'stopping'] as const)('passes %s through', (status) => {
    expect(liveStatusOf(card({ status }), new Set())).toBe(status)
  })
  it('is blocked when the task is blocked or the run is in the blocked list', () => {
    expect(liveStatusOf(card({ status: 'working', taskStatus: 'blocked' }), new Set())).toBe('blocked')
    expect(liveStatusOf(card({ status: 'working', runId: 'r1' }), new Set(['r1']))).toBe('blocked')
    expect(liveStatusOf(card({ status: 'working', runId: 'r2' }), new Set(['r1']))).toBe('working')
  })
})

describe('liveSlavesOf / boardFromOverview', () => {
  it('keys cards by slave id, reading the blocked run rows', () => {
    const o = overview({
      slaves: [card({ id: 's1', status: 'working', runId: 'r1', taskTitle: 'Ship it', stepLabel: 'verifying', progressPct: 55 }), card({ id: 's2' })],
      blocked: [{ kind: 'run', id: 'r1', title: 'x', detail: 'y', action: 'resume', runId: 'r1' }] as OverviewSnapshot['blocked'],
    })
    const m = liveSlavesOf(o)
    expect(m.get('s1')).toEqual({ slaveId: 's1', status: 'blocked', taskTitle: 'Ship it', stepLabel: 'verifying', progressPct: 55, runId: 'r1' })
    expect(m.get('s2')?.status).toBe('idle')
  })
  it('maps the task counts onto the board columns', () => {
    expect(boardFromOverview(overview({ mergeQueue: [{ id: 'm1', title: 't', hasApproval: false }] as OverviewSnapshot['mergeQueue'] }))).toEqual({ todo: 3, doing: 2, review: 1, done: 4 })
  })
})

describe('LiveOffice', () => {
  it('uses the real slave ids and the roster order, and reports live data back', () => {
    const o = office()
    expect(o.slaves.map((s) => s.id)).toEqual(['s1', 's2', 's3'])
    expect(o.departments.map((d) => d.name)).toEqual(['Engineering', 'Product'])
    o.apply(new Map([['s1', live('working')]]), { todo: 0, doing: 0, review: 0, done: 0 })
    expect(o.liveOf('s1')?.runId).toBe('r1')
    expect(o.liveOf('s9')).toBeNull()
  })

  it.each([
    ['working', 'work'],
    ['blocked', 'blocked'],
    ['pausing', 'paused'],
    ['paused', 'paused'],
    ['idle', 'sit'],
  ] as const)('seats a %s slave in state %s with the real task and progress', (status, state) => {
    const o = office()
    o.apply(new Map([['s1', live(status)]]), { todo: 0, doing: 0, review: 0, done: 0 })
    o.tick(0.05)
    const alex = o.slaves[0]!
    expect(alex.state).toBe(state)
    if (status === 'idle') {
      expect(alex.task).toBeNull()
      expect(alex.progress).toBe(0)
    } else {
      expect(alex.task).toEqual(expect.objectContaining({ key: 'verifying', title: 'Add the thing' }))
      expect(alex.progress).toBe(40)
    }
  })

  it('never advances progress on its own', () => {
    const o = office()
    o.apply(new Map([['s1', live('working', { progressPct: 40 })]]), { todo: 0, doing: 0, review: 0, done: 0 })
    settle(o, 10)
    expect(o.slaves[0]!.progress).toBe(40)
    o.apply(new Map([['s1', live('working', { progressPct: 41 })]]), { todo: 0, doing: 0, review: 0, done: 0 })
    o.tick(0.05)
    expect(o.slaves[0]!.progress).toBe(41)
  })

  it.each(['starting', 'resuming'] as const)('walks a %s slave to the board once, then it works at its desk', (status) => {
    const o = office()
    o.apply(new Map([['s1', live(status)]]), { todo: 0, doing: 0, review: 0, done: 0 })
    o.tick(0.05)
    const alex = o.slaves[0]!
    expect(alex.state).toBe('walk')
    expect(alex.next).toBe('grab')
    settle(o)
    expect(alex.state).toBe('work')
    const seat = o.seat(alex)
    expect([alex.x, alex.y]).toEqual([seat.x, seat.y])
    o.apply(new Map([['s1', live(status)]]), { todo: 0, doing: 0, review: 0, done: 0 })
    o.tick(0.05)
    expect(alex.state).toBe('work') // the same status again does not restart the walk
  })

  it('walks a stopping slave to the board once, then it sits idle', () => {
    const o = office()
    o.apply(new Map([['s1', live('stopping')]]), { todo: 0, doing: 0, review: 0, done: 0 })
    o.tick(0.05)
    const alex = o.slaves[0]!
    expect(alex.next).toBe('deliver')
    settle(o)
    expect(alex.state).toBe('sit')
  })

  it('lets only idle slaves wander, and always back to the desk', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1) // < .18 → the arcade
    const o = office()
    o.apply(new Map([['s1', live('idle')], ['s2', live('working', { slaveId: 's2' })]]), { todo: 0, doing: 0, review: 0, done: 0 })
    settle(o, 5)
    const [alex, maya] = o.slaves as [typeof o.slaves[0], typeof o.slaves[0]]
    expect(['walk', 'arcade']).toContain(alex.state)
    expect(maya.state).toBe('work')
    settle(o, 30)
    expect(['sit', 'walk', 'arcade']).toContain(alex.state)
    expect(maya.state).toBe('work')
  })

  it('draws the board from the counts, capped at six cards a column', () => {
    const o = office()
    o.apply(new Map(), { todo: 9, doing: 2, review: 0, done: 4 })
    expect(o.board.todo).toHaveLength(6)
    expect(o.board.doing).toHaveLength(2)
    expect(o.board.review).toHaveLength(0)
    expect(o.board.done).toHaveLength(4)
  })

  it('keeps the wall clock unless an hour is locked', () => {
    const o = office()
    o.setWallClock(14.5)
    o.tick(0.05)
    expect(o.hour).toBe(14.5)
    o.hourLock = 3
    o.tick(0.05)
    expect(o.hour).toBe(3)
    o.hourLock = null
    o.tick(0.05)
    expect(o.hour).toBe(14.5)
  })

  it('celebrates a slave whose task finished', () => {
    const o = office()
    o.apply(new Map([['s1', live('working', { progressPct: 100 })]]), { todo: 0, doing: 0, review: 0, done: 0 })
    o.tick(0.05)
    o.apply(new Map([['s1', live('idle')]]), { todo: 0, doing: 0, review: 0, done: 0 })
    expect(o.events[0]).toEqual(expect.objectContaining({ type: 'task.done', slave: 'Alex' }))
  })
})
```

- [ ] **Step 2: RED.** `npx vitest run apps/web/test/office-live.test.ts` → cannot find `liveOffice.js`.

- [ ] **Step 3: The adapter.** Create `apps/web/src/lib/office/liveOffice.ts`:

```ts
import type { OverviewSnapshot, SlaveCardData } from '../../server/overview'
import { WorldF, type WorldSlave, type WorldTask } from './engine.js'

/** The overview stream's per-slave status plus the one derived value the floor needs: `blocked`
 *  (M28 §3.2, §4.2). Everything else is `SlaveStatus` as the stream sends it. */
export type LiveStatus = 'idle' | 'starting' | 'working' | 'blocked' | 'pausing' | 'paused' | 'resuming' | 'stopping'

export interface LiveSlave {
  readonly slaveId: string
  readonly status: LiveStatus
  readonly taskTitle: string | null
  readonly stepLabel: string | null
  readonly progressPct: number
  readonly runId: string | null
}

export interface LiveBoard {
  readonly todo: number
  readonly doing: number
  readonly review: number
  readonly done: number
}

export interface OfficeRosterSlave {
  readonly slaveId: string
  readonly name: string
  readonly role: string
  readonly color: string
}

export interface OfficeRosterDepartment {
  readonly teamId: string
  readonly name: string
  readonly color: string
  readonly slaves: readonly OfficeRosterSlave[]
}

/** Blocked wins over the run's own status: a slave whose task is blocked, or whose run sits in the
 *  overview's blocked list, shows the red bubble whatever the run is doing. */
export function liveStatusOf(card: SlaveCardData, blockedRunIds: ReadonlySet<string>): LiveStatus {
  if (card.taskStatus === 'blocked' || (card.runId !== null && blockedRunIds.has(card.runId))) return 'blocked'
  return card.status
}

export function liveSlavesOf(overview: OverviewSnapshot): ReadonlyMap<string, LiveSlave> {
  const blockedRunIds = new Set(overview.blocked.filter((b) => b.kind === 'run' && b.runId !== null).map((b) => b.runId as string))
  return new Map(
    overview.slaves.map((card) => [
      card.id,
      {
        slaveId: card.id,
        status: liveStatusOf(card, blockedRunIds),
        taskTitle: card.taskTitle,
        stepLabel: card.stepLabel,
        progressPct: card.progressPct,
        runId: card.runId,
      },
    ]),
  )
}

/** The wall board's four columns from the counts the stream already carries (M28 §2): ready → todo,
 *  active → doing, the merge queue → review, done → done. */
export function boardFromOverview(overview: OverviewSnapshot): LiveBoard {
  return { todo: overview.tasks.ready, doing: overview.tasks.active, review: overview.mergeQueue.length, done: overview.tasks.done }
}

/** The design's board draws at most this many cards per column before they run off the wall. */
const BOARD_CAP = 6

/** Where a slave sits when its status needs no walk: the floor state per live status. */
const AT_DESK: Record<Exclude<LiveStatus, 'starting' | 'resuming' | 'stopping'>, string> = {
  working: 'work',
  blocked: 'blocked',
  pausing: 'paused',
  paused: 'paused',
  idle: 'sit',
}

/** States in which the slave is at its desk and can adopt a new status directly. */
const SEATED = new Set(['sit', 'work', 'blocked', 'paused'])

function cards(count: number): WorldTask[] {
  return Array.from({ length: Math.max(0, Math.min(BOARD_CAP, count)) }, () => ({
    key: '',
    title: '',
    color: null,
    deptColor: null,
    status: 'todo',
    blockedBy: null,
  }))
}

/**
 * The design's office with the invention removed (M28 §4.2). `WorldF` lays the pods out and draws;
 * this class replaces `simulate` so a slave's state comes from `apply()` — the stream's status per
 * slave — instead of the engine's own task board and dice. What stays from the design: the walk to
 * the board when a run starts, the walk with the finished work when it stops, the idle wander to
 * the arcade and the coffee machine, the cat, the roomba, the boss, the confetti.
 */
export class LiveOffice extends WorldF {
  private live: ReadonlyMap<string, LiveSlave> = new Map()
  private wallHour = 9
  /** The status each slave last walked for, so `starting` seen on ten consecutive snapshots is one walk. */
  private readonly walkedFor = new Map<string, LiveStatus>()

  constructor(departments: readonly OfficeRosterDepartment[]) {
    super({
      departments: departments.map((d) => ({
        name: d.name,
        color: d.color,
        slaves: d.slaves.map((s) => ({ name: s.name, role: s.role, color: s.color })),
      })),
    })
    // The engine numbers its slaves `a0, a1, …` in roster order; the floor answers to real ids.
    const ids = departments.flatMap((d) => d.slaves.map((s) => s.slaveId))
    this.slaves.forEach((slave, i) => {
      slave.id = ids[i] ?? slave.id
    })
  }

  liveOf(slaveId: string): LiveSlave | null {
    return this.live.get(slaveId) ?? null
  }

  setWallClock(hour: number): void {
    this.wallHour = hour
  }

  /** One stream snapshot: the status, task and progress of every slave, and the board counts. */
  apply(live: ReadonlyMap<string, LiveSlave>, board: LiveBoard): void {
    for (const slave of this.slaves) {
      const before = this.live.get(slave.id)
      const after = live.get(slave.id)
      if (before !== undefined && before.status === 'working' && before.progressPct >= 100 && (after === undefined || after.status === 'idle')) {
        this.ev('task.done', slave, slave.task, 'run succeeded')
      }
      slave.task =
        after !== undefined && after.taskTitle !== null
          ? { key: after.stepLabel ?? '', title: after.taskTitle, color: slave.color, deptColor: null, status: 'doing', blockedBy: null }
          : null
    }
    this.live = live
    this.board = { todo: cards(board.todo), doing: cards(board.doing), review: cards(board.review), done: cards(board.done) }
  }

  private statusOf(slave: WorldSlave): LiveStatus {
    return this.live.get(slave.id)?.status ?? 'idle'
  }

  /** The engine's `tick` still runs the clock, the cat, the roomba, the boss and the confetti; this
   *  is the part that used to invent work. Walks are the design's; states come from the stream. */
  override simulate(dt: number): void {
    for (const slave of this.slaves) {
      slave.timer -= dt
      slave.sw += dt
      switch (slave.state) {
        case 'walk': {
          const p = slave.path[0]
          if (p === undefined) {
            slave.state = slave.next ?? 'sit'
            slave.timer = slave.next === 'grab' ? 1.4 : slave.next === 'coffee' ? 3.5 : slave.next === 'arcade' ? 5 : 0
            if (slave.next === 'deliver') {
              slave.state = 'grab'
              slave.timer = 1.2
              slave.delivering = true
            }
            break
          }
          const dx = p.x - slave.x
          const dy = p.y - slave.y
          const d = Math.hypot(dx, dy)
          const sp = 38 * dt
          if (d <= sp) {
            slave.x = p.x
            slave.y = p.y
            slave.path.shift()
          } else {
            slave.x += (dx / d) * sp
            slave.y += (dy / d) * sp
          }
          if (Math.abs(dx) > 0.5) slave.dir = dx > 0 ? 1 : -1
          slave.vdir = Math.abs(dy) > Math.abs(dx) ? (dy > 0 ? 'front' : 'back') : 'side'
          break
        }
        case 'grab':
          if (slave.timer <= 0) {
            if (slave.delivering === true) {
              slave.delivering = false
              this.goTo(slave, this.seat(slave), 'sit')
              slave.timer = 1.5
            } else {
              this.goTo(slave, this.seat(slave), 'work')
            }
          }
          break
        case 'coffee':
        case 'arcade':
          if (slave.timer <= 0) {
            this.goTo(slave, this.seat(slave), 'sit')
            slave.timer = 3
          }
          break
        default:
          break
      }
      this.reconcile(slave)
    }
  }

  /** A seated slave adopts the live status; a walking one finishes its walk first. */
  private reconcile(slave: WorldSlave): void {
    if (!SEATED.has(slave.state)) return
    const status = this.statusOf(slave)
    if (status === 'starting' || status === 'resuming') {
      if (this.walkedFor.get(slave.id) !== status) {
        this.walkedFor.set(slave.id, status)
        this.goTo(slave, this.boardTarget(), 'grab')
      } else {
        slave.state = 'work'
      }
      return
    }
    if (status === 'stopping') {
      if (this.walkedFor.get(slave.id) !== status) {
        this.walkedFor.set(slave.id, status)
        this.goTo(slave, this.boardTarget(), 'deliver')
      } else {
        slave.state = 'sit'
      }
      return
    }
    this.walkedFor.delete(slave.id)
    const target = AT_DESK[status]
    if (slave.state !== target) {
      slave.state = target
      slave.timer = 2 + Math.random() * 3
    }
    if (status === 'idle' && slave.timer <= 0) {
      const r = Math.random()
      if (r < 0.18) this.goTo(slave, this.arcadeTarget(), 'arcade')
      else if (r < 0.4) this.goTo(slave, this.coffeeTarget(), 'coffee')
      else slave.timer = 2 + Math.random() * 3
    }
  }

  override tick(dt: number): void {
    super.tick(dt)
    this.hour = this.hourLock ?? this.wallHour
    // Progress is the stream's number, whatever the boss did this frame.
    for (const slave of this.slaves) {
      const l = this.live.get(slave.id)
      slave.progress = l !== undefined && l.taskTitle !== null ? Math.max(0, Math.min(100, l.progressPct)) : 0
    }
  }
}
```

`goTo` in `WorldD` (the vendored engine) sets `slave.path`, `slave.state = 'walk'` and `slave.next`; `boardTarget`, `arcadeTarget`, `coffeeTarget`, `seat` are `WorldD`'s too. If `tsc` rejects `override` on `simulate`/`tick` (the `.d.ts` declares both on `World`), the declaration file is wrong — fix it there, not by dropping `override`.

- [ ] **Step 4: GREEN.** `npx vitest run apps/web/test/office-live.test.ts` → all pass (the wander test is the one most likely to need a look: it holds for any `Math.random` return below `.18`; if the arcade target is unreachable from the desk in this layout, `settle` still lands the slave back in `sit`, which the assertion allows). `npx tsc -p apps/web/tsconfig.test.json --noEmit` clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/lib/office/liveOffice.ts apps/web/test/office-live.test.ts apps/web/src/lib/office/engine.d.ts
git commit -m "feat(web): m28 t2 — LiveOffice: the floor follows the stream's status, task and progress; the simulation's invention is gone"
```

---

### Task 3: The server read, the page and the tab

**Files:**
- Create: `apps/web/src/server/office.ts`, `apps/web/src/app/w/[workspaceId]/office/page.tsx`, `apps/web/test/integration/office.test.ts`
- Modify: `apps/web/src/components/project/ProjectTabs.tsx`, `apps/web/test/project-tabs.test.tsx`
- Create: `apps/web/src/components/office/OfficeClient.tsx` with its real props and a minimal body (the canvas wrapper only, so the page compiles and builds); Task 4 fills it in. See Step 4.

**Interfaces:**
- Produces:
```ts
// apps/web/src/server/office.ts
export interface OfficeSlave { readonly slaveId: string; readonly name: string; readonly role: string; readonly color: string }
export interface OfficeDepartment { readonly teamId: string; readonly name: string; readonly color: string; readonly slaves: readonly OfficeSlave[] }
export interface OfficeSnapshot {
  readonly workspace: { readonly id: string; readonly name: string; readonly archived: boolean }
  readonly departments: readonly OfficeDepartment[]
  readonly overview: OverviewSnapshot
}
export async function buildOfficeSnapshot(workspaceId: string): Promise<OfficeSnapshot | null>
```
- `OfficeClient({ workspaceId, initial: OfficeSnapshot, pixelFontFamily: string })` (Task 4 fills it).
- Tab `{ id: 'office', label: 'Office', path: (id) => `/w/${id}/office`, exact: false }` between Graph and Activity → testid `project-tab-office`.

- [ ] **Step 1: Failing tests.** Create `apps/web/test/integration/office.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { DEPT_COLORS, SLAVE_COLORS } from '../../src/lib/office/engine.js'
import { buildOfficeSnapshot } from '../../src/server/office.js'

const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-web-office-'))
afterAll(async () => {
  rmSync(repoPath, { recursive: true, force: true })
  await prisma.$disconnect()
})

let workspaceId = ''
beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
  )
  const ws = await prisma.workspace.create({ data: { name: 'Checkout Platform', repoPath, verifyCommands: ['true'], setupCommands: [] } })
  workspaceId = ws.id
  const product = await prisma.team.create({ data: { workspaceId, name: 'Product' } })
  const engineering = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
  await prisma.team.create({ data: { workspaceId, name: 'QA' } })
  await prisma.slave.create({ data: { teamId: engineering.id, name: 'Maya', role: 'qa' } })
  await prisma.slave.create({ data: { teamId: engineering.id, name: 'Alex', role: 'backend' } })
  await prisma.slave.create({ data: { teamId: product.id, name: 'John', role: 'analyst' } })
})

describe('buildOfficeSnapshot', () => {
  it('lists departments and their slaves in name order, with deterministic colours, and the overview', async () => {
    const snapshot = await buildOfficeSnapshot(workspaceId)
    expect(snapshot).not.toBeNull()
    if (snapshot === null) return
    expect(snapshot.workspace).toEqual({ id: workspaceId, name: 'Checkout Platform', archived: false })
    expect(snapshot.departments.map((d) => d.name)).toEqual(['Engineering', 'Product', 'QA'])
    expect(snapshot.departments.map((d) => d.color)).toEqual([DEPT_COLORS[0], DEPT_COLORS[1], DEPT_COLORS[2]])
    expect(snapshot.departments[0]?.slaves.map((s) => s.name)).toEqual(['Alex', 'Maya'])
    expect(snapshot.departments[0]?.slaves.map((s) => s.color)).toEqual([SLAVE_COLORS[0], SLAVE_COLORS[1]])
    expect(snapshot.departments[1]?.slaves[0]).toEqual(expect.objectContaining({ name: 'John', role: 'analyst', color: SLAVE_COLORS[2] }))
    expect(snapshot.departments[2]?.slaves).toEqual([])
    expect(snapshot.overview.workspace.id).toBe(workspaceId)
    expect(snapshot.overview.slaves).toHaveLength(3)
  })

  it('is null for an unknown project and flags an archived one', async () => {
    expect(await buildOfficeSnapshot('00000000-0000-4000-8000-000000000000')).toBeNull()
    await prisma.workspace.update({ where: { id: workspaceId }, data: { archivedAt: new Date() } })
    expect((await buildOfficeSnapshot(workspaceId))?.workspace.archived).toBe(true)
  })
})
```

In `apps/web/test/project-tabs.test.tsx`: `TAB_HREFS` becomes `['/w/w1', '/w/w1/tasks', '/w/w1/graph', '/w/w1/office', '/w/w1/activity', '/w/w1/settings']`, the first case's title says "six tabs" and its expected labels `['Overview', 'Tasks', 'Graph', 'Office', 'Activity', 'Settings']`; add:

```tsx
  it('marks Office current on the office route', () => {
    pathname = '/w/w1/office'
    render(<ProjectTabs workspaceId="w1" initialTasksActive={0} />)
    expect(screen.getByTestId('project-tab-office').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('project-tab-graph').getAttribute('aria-current')).toBeNull()
  })
```

- [ ] **Step 2: RED.** `npx vitest run apps/web/test/integration/office.test.ts apps/web/test/project-tabs.test.tsx` → module not found / five tabs.

- [ ] **Step 3: Server read.** Create `apps/web/src/server/office.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import { DEPT_COLORS, SLAVE_COLORS } from '../lib/office/engine.js'
import { buildOverviewSnapshot, type OverviewSnapshot } from './overview'

export interface OfficeSlave {
  readonly slaveId: string
  readonly name: string
  readonly role: string
  readonly color: string
}

export interface OfficeDepartment {
  readonly teamId: string
  readonly name: string
  readonly color: string
  readonly slaves: readonly OfficeSlave[]
}

export interface OfficeSnapshot {
  readonly workspace: { readonly id: string; readonly name: string; readonly archived: boolean }
  readonly departments: readonly OfficeDepartment[]
  /** The office client's initial stream state — the same snapshot the Overview tab starts from. */
  readonly overview: OverviewSnapshot
}

/**
 * The Office tab's roster (M28 §3.1): every department of the project with its slaves, both in
 * name order, coloured from the design's palettes by position so the floor looks like the design
 * and the same project always paints the same. A department with no slaves keeps its pod. Live
 * status is not here — the client reads it from the overview stream this snapshot also seeds.
 */
export async function buildOfficeSnapshot(workspaceId: string): Promise<OfficeSnapshot | null> {
  const [workspace, teams, overview] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true, archivedAt: true } }),
    prisma.team.findMany({
      where: { workspaceId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, slaves: { orderBy: { name: 'asc' }, select: { id: true, name: true, role: true } } },
    }),
    buildOverviewSnapshot(workspaceId),
  ])
  if (workspace === null || overview === null) return null
  let slaveIndex = 0
  const departments = teams.map((team, i) => ({
    teamId: team.id,
    name: team.name,
    color: DEPT_COLORS[i % DEPT_COLORS.length] as string,
    slaves: team.slaves.map((slave) => ({
      slaveId: slave.id,
      name: slave.name,
      role: slave.role,
      color: SLAVE_COLORS[slaveIndex++ % SLAVE_COLORS.length] as string,
    })),
  }))
  return { workspace: { id: workspace.id, name: workspace.name, archived: workspace.archivedAt !== null }, departments, overview }
}
```

(`buildOverviewSnapshot`'s exact name and null-return: confirm in `apps/web/src/server/overview.ts` — the Overview page at `apps/web/src/app/w/[workspaceId]/page.tsx:12` calls it; mirror that call.)

- [ ] **Step 4: The client's shell.** Create `apps/web/src/components/office/OfficeClient.tsx` with the real props and the canvas wrapper only — Task 4 fills in the loop and the overlays:

```tsx
'use client'

import type { OfficeSnapshot } from '../../server/office'

/** The Office tab (M28 §5). Task 4 wires the engine, the stream and the overlays in here. */
export function OfficeClient({
  workspaceId,
  initial,
  pixelFontFamily,
}: {
  readonly workspaceId: string
  readonly initial: OfficeSnapshot
  readonly pixelFontFamily: string
}): React.JSX.Element {
  return (
    <div data-workspace-id={workspaceId} data-pixel-font={pixelFontFamily} className="relative h-[calc(100vh-52px-41px)] min-h-[360px] w-full overflow-hidden bg-[#07080b]">
      <canvas data-testid="office-canvas" className="block h-full w-full cursor-grab" />
      <span className="sr-only">{initial.workspace.name}</span>
    </div>
  )
}
```

(The height subtracts the project header (52 px) and the tab strip — read the strip's rendered height from `ProjectTabs`'s classes, `py-[6px]` + a 28 px chip + the border; use the value the existing `GraphClient` uses for the same purpose if it has one — grep `calc(100vh` in `apps/web/src/components/graph/GraphClient.tsx` and copy it.)

- [ ] **Step 5: The page.** Create `apps/web/src/app/w/[workspaceId]/office/page.tsx`:

```tsx
import { Silkscreen } from 'next/font/google'
import { buildOfficeSnapshot } from '../../../../server/office'
import { OfficeClient } from '../../../../components/office/OfficeClient'

export const dynamic = 'force-dynamic'

// The design's pixel font, self-hosted by next/font. Its family name is hashed, so the client gets
// it as a prop and hands it to the engine's canvas labels (`setPixelFont`) and to the HUD.
const pixel = Silkscreen({ weight: '400', subsets: ['latin'], variable: '--font-pixel', display: 'swap' })

// Named like `GraphPageRoute`: the snapshot types live in `server/office.ts`.
export default async function OfficePageRoute({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params
  const snapshot = await buildOfficeSnapshot(workspaceId)
  if (snapshot === null) {
    return <main className="p-6 text-tone-blocked">no workspace with id {workspaceId}</main>
  }
  // Keyed so a client-side project-to-project navigation remounts the office instead of animating
  // the old roster under the new URL.
  return (
    <div className={pixel.variable}>
      <OfficeClient key={workspaceId} workspaceId={workspaceId} initial={snapshot} pixelFontFamily={pixel.style.fontFamily} />
    </div>
  )
}
```

- [ ] **Step 6: The tab.** In `apps/web/src/components/project/ProjectTabs.tsx` insert `{ id: 'office', label: 'Office', path: (id: string) => `/w/${id}/office`, exact: false },` after the `graph` entry and change the docstring's "five route links" to "six route links (Office joined in M28)".

- [ ] **Step 7: GREEN + build.** `npx tsc -p apps/web/tsconfig.test.json --noEmit`; `npx vitest run apps/web/test/integration/office.test.ts apps/web/test/project-tabs.test.tsx` → pass; `npx vitest run apps/web` once; `pgrep -fa 'next dev'` empty, `npm run web:build && rm -rf apps/web/.next` (the build compiles `engine.js` into the client bundle and downloads Silkscreen — a build error here is this task's).

- [ ] **Step 8: Commit.**

```bash
git add apps/web/src/server/office.ts "apps/web/src/app/w/[workspaceId]/office/page.tsx" apps/web/src/components/office/OfficeClient.tsx apps/web/src/components/project/ProjectTabs.tsx apps/web/test/integration/office.test.ts apps/web/test/project-tabs.test.tsx
git commit -m "feat(web): m28 t3 — the Office tab: the roster read with the design's colours, the page with the pixel font, the tab between Graph and Activity"
```

---

### Task 4: The office client — canvas, loop, HUD, focus card

**Files:**
- Modify: `apps/web/src/components/office/OfficeClient.tsx`
- Create: `apps/web/src/components/office/OfficeHud.tsx`, `apps/web/src/components/office/FocusCard.tsx`, `apps/web/test/office-client.test.tsx`

**Interfaces:**
- Consumes `LiveOffice`, `liveSlavesOf`, `boardFromOverview` (Task 2); `renderIsoE`, `tod`, `STATUS`, `setPixelFont` (Task 1); `useOverview(workspaceId, initial.overview)` → `{ snapshot, connection }`; `sendControl` (`lib/postControl.ts`); `plural` (`lib/plural.ts`).
- Produces the presentational props:
```ts
export interface HudView {
  readonly connection: 'connected' | 'reconnecting'
  readonly departments: number; readonly slaves: number; readonly working: number
  readonly todLabel: string; readonly clock: string; readonly hour: number; readonly live: boolean
  readonly zoom: string
}
export interface FocusView {
  readonly id: string; readonly name: string; readonly role: string; readonly department: string; readonly color: string
  readonly status: LiveStatus; readonly statusColor: string
  readonly taskKey: string; readonly taskTitle: string; readonly pct: number
  readonly runId: string | null
}
```

- [ ] **Step 1: Failing tests.** Create `apps/web/test/office-client.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OfficeSnapshot } from '../src/server/office.js'
import type { OverviewSnapshot, SlaveCardData } from '../src/server/overview.js'

// A world the client can drive without a canvas: three seated slaves, the fields the client reads.
const stubSlaves = [
  { id: 's1', name: 'Alex', role: 'backend', color: '#2ee6cf', dept: 0, state: 'work', task: { key: 'verifying', title: 'Add the thing' }, progress: 40 },
  { id: 's2', name: 'Maya', role: 'qa', color: '#7b8cff', dept: 0, state: 'sit', task: null, progress: 0 },
  { id: 's3', name: 'John', role: 'analyst', color: '#c084fc', dept: 1, state: 'paused', task: { key: '', title: 'Plan' }, progress: 10 },
]
const applied: unknown[] = []
const stubWorld = {
  slaves: stubSlaves,
  departments: [{ name: 'Engineering' }, { name: 'Product' }],
  view: { S: 1, ox: 0, oy: 0, w: 100, h: 100, levels: [1, 2, 3, 4], li: 0 },
  viewHits: [] as { id: string; x: number; y: number; w: number; h: number }[],
  focusId: null as string | null,
  hour: 10,
  hourLock: null as number | null,
  t: 0,
  events: [],
  tick: vi.fn(),
  apply: vi.fn((...args: unknown[]) => applied.push(args)),
  setWallClock: vi.fn(),
  liveOf: (id: string) => liveById[id] ?? null,
  status: (s: { state: string }) => ({ work: 'working', sit: 'idle', paused: 'paused', blocked: 'blocked' })[s.state] ?? 'idle',
  clock: () => '10:00',
}
const liveById: Record<string, { slaveId: string; status: string; taskTitle: string | null; stepLabel: string | null; progressPct: number; runId: string | null }> = {
  s1: { slaveId: 's1', status: 'working', taskTitle: 'Add the thing', stepLabel: 'verifying', progressPct: 40, runId: 'r1' },
  s3: { slaveId: 's3', status: 'paused', taskTitle: 'Plan', stepLabel: null, progressPct: 10, runId: 'r3' },
}

vi.mock('../src/lib/office/liveOffice.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/office/liveOffice.js')>()
  return { ...actual, LiveOffice: vi.fn(() => stubWorld) }
})
vi.mock('../src/lib/office/engine.js', () => ({
  renderIsoE: vi.fn(),
  setPixelFont: vi.fn(),
  tod: (h: number) => ({ label: h < 12 ? 'Morning' : 'Afternoon', light: 1, sky: '#000', horizon: '#000', ambient: '#000' }),
  STATUS: { working: '#2ee6cf', planning: '#7b8cff', review: '#c084fc', waiting: '#f5b34a', blocked: '#f87171', done: '#4ade80', paused: '#8a929e', idle: '#5b6472' },
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

let streamSnapshot: OverviewSnapshot
vi.mock('../src/hooks/useOverview', () => ({
  useOverview: () => ({ snapshot: streamSnapshot, connection: 'connected', error: null, latencyMs: null, actionLines: {}, liveEvents: {} }),
}))

import { OfficeClient } from '../src/components/office/OfficeClient.js'

function card(over: Partial<SlaveCardData>): SlaveCardData {
  return {
    id: 'x', name: 'x', role: 'x', provider: null, gate: null, status: 'idle', taskTitle: null, taskId: null, taskStatus: null, progressPct: 0,
    stepLabel: null, skill: null, actionLine: null, runId: null, queuedMessage: null, resumeRequestedAt: null, recentEvents: [], costUsd: null,
    toolCalls: 0, pausedAtStep: null, ...over,
  }
}

function snapshot(archived = false): OfficeSnapshot {
  const overview = {
    workspace: { id: 'w1', name: 'Checkout', haltedReason: null, haltedAt: null, budgetUsd: null, spentUsd: 0, unmeasuredRuns: 0, goal: null, provider: null, costBlindBudgeted: false, maxConcurrentRuns: 3, runTimeoutMs: 1000, maxAttempts: 3 },
    slaves: [card({ id: 's1', status: 'working', taskTitle: 'Add the thing', stepLabel: 'verifying', progressPct: 40, runId: 'r1' }), card({ id: 's2' }), card({ id: 's3', status: 'paused', taskTitle: 'Plan', progressPct: 10, runId: 'r3' })],
    tasks: { active: 1, ready: 2, blocked: 0, done: 3, failed: 0 },
    blocked: [],
    liveEvents: [],
    mergeQueue: [],
  } as unknown as OverviewSnapshot
  streamSnapshot = overview
  return {
    workspace: { id: 'w1', name: 'Checkout', archived },
    departments: [
      { teamId: 't1', name: 'Engineering', color: '#2ee6cf', slaves: [{ slaveId: 's1', name: 'Alex', role: 'backend', color: '#2ee6cf' }, { slaveId: 's2', name: 'Maya', role: 'qa', color: '#7b8cff' }] },
      { teamId: 't2', name: 'Product', color: '#7b8cff', slaves: [{ slaveId: 's3', name: 'John', role: 'analyst', color: '#c084fc' }] },
    ],
    overview,
  }
}

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { setTimeout(() => cb(performance.now()), 16); return 1 })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  Object.defineProperty(document, 'fonts', { value: { load: () => Promise.resolve([]) }, configurable: true })
  stubWorld.focusId = null
  stubWorld.hourLock = null
  applied.length = 0
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  fetchMock.mockClear()
})

async function mount(archived = false) {
  render(<OfficeClient workspaceId="w1" initial={snapshot(archived)} pixelFontFamily="__Silkscreen_test" />)
  await act(async () => {
    await Promise.resolve()
    vi.advanceTimersByTime(320)
  })
}

describe('OfficeClient', () => {
  it('feeds the world the stream snapshot and the wall clock, and shows the counts', async () => {
    await mount()
    expect(stubWorld.apply).toHaveBeenCalled()
    const [live, board] = applied[0] as [Map<string, { status: string }>, { todo: number }]
    expect(live.get('s1')?.status).toBe('working')
    expect(board.todo).toBe(2)
    expect(stubWorld.setWallClock).toHaveBeenCalled()
    expect(screen.getByTestId('office-hud-counts').textContent).toBe('2 departments · 3 slaves · 1 working')
    expect(screen.getByTestId('office-clock').textContent).toBe('10:00')
    expect(screen.getByTestId('office-tod').textContent).toBe('MORNING')
    expect(screen.getByTestId('office-stream').textContent).toContain('LIVE')
  })

  it('locks the hour from the slider and LIVE clears it', async () => {
    await mount()
    fireEvent.change(screen.getByTestId('office-hour'), { target: { value: '21' } })
    expect(stubWorld.hourLock).toBe(21)
    fireEvent.click(screen.getByTestId('office-live'))
    expect(stubWorld.hourLock).toBeNull()
  })

  it('zooms through the levels and labels them', async () => {
    await mount()
    expect(screen.getByTestId('office-zoom').textContent).toBe('1x')
    fireEvent.click(screen.getByTestId('office-zoom-in'))
    expect(stubWorld.view.li).toBe(1)
    await act(async () => { vi.advanceTimersByTime(320) })
    expect(screen.getByTestId('office-zoom').textContent).toBe('2x')
    fireEvent.click(screen.getByTestId('office-zoom-out'))
    expect(stubWorld.view.li).toBe(0)
  })

  it('focuses the first slave by default, shows its live task, and Next cycles', async () => {
    await mount()
    const focus = screen.getByTestId('office-focus')
    expect(focus.textContent).toContain('Alex')
    expect(focus.textContent).toContain('backend · Engineering')
    expect(focus.textContent).toContain('verifying')
    expect(focus.textContent).toContain('Add the thing')
    expect(screen.getByTestId('office-focus-pause').textContent).toBe('Pause')
    fireEvent.click(screen.getByTestId('office-focus-next'))
    await act(async () => { vi.advanceTimersByTime(320) })
    expect(screen.getByTestId('office-focus').textContent).toContain('Maya')
  })

  it('pauses, resumes and stops through the run routes; refusals stay on the card', async () => {
    await mount()
    await act(async () => { fireEvent.click(screen.getByTestId('office-focus-pause')) })
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/runs/r1/pause', expect.objectContaining({ method: 'POST' }))
    await act(async () => { fireEvent.click(screen.getByTestId('office-focus-stop')) })
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/runs/r1/stop', expect.objectContaining({ method: 'POST' }))

    stubWorld.focusId = 's3'
    await act(async () => { vi.advanceTimersByTime(320) })
    expect(screen.getByTestId('office-focus-pause').textContent).toBe('Resume')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'run r3 is not paused' }), { status: 409 }))
    await act(async () => { fireEvent.click(screen.getByTestId('office-focus-pause')) })
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/runs/r3/resume', expect.objectContaining({ method: 'POST' }))
    expect(screen.getByTestId('office-focus-error').textContent).toBe('run r3 is not paused')
  })

  it('disables the run controls for a slave without a run and hides them on an archived project', async () => {
    await mount()
    stubWorld.focusId = 's2'
    await act(async () => { vi.advanceTimersByTime(320) })
    expect((screen.getByTestId('office-focus-pause') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('office-focus-stop') as HTMLButtonElement).disabled).toBe(true)
  })

  it('hides the run controls on an archived project', async () => {
    await mount(true)
    expect(screen.queryByTestId('office-focus-pause')).toBeNull()
    expect(screen.queryByTestId('office-focus-stop')).toBeNull()
    expect(screen.getByTestId('office-focus-next')).toBeTruthy()
  })
})
```

`sendControl` reads `response.json()` for `{ error }` on a non-2xx — confirm in `apps/web/src/lib/postControl.ts` before relying on the 409 shape above and adjust the mocked body to what it parses.

- [ ] **Step 2: RED.** `npx vitest run apps/web/test/office-client.test.tsx` → the shell renders nothing the tests look for.

- [ ] **Step 3: The overlays.** Create `apps/web/src/components/office/OfficeHud.tsx`:

```tsx
'use client'

import { plural } from '../../lib/plural'

export interface HudView {
  readonly connection: 'connected' | 'reconnecting'
  readonly departments: number
  readonly slaves: number
  readonly working: number
  readonly todLabel: string
  readonly clock: string
  readonly hour: number
  readonly live: boolean
  readonly zoom: string
}

const PIXEL = '[font-family:var(--font-pixel),monospace] text-[9px]'

/** The design's four overlays (M28 §5): counts + stream state (top-left), clock + hour slider +
 *  LIVE (top-centre), legend (bottom-left), zoom (bottom-right). Pure: every value arrives composed. */
export function OfficeHud({
  view,
  onHour,
  onLive,
  onZoom,
}: {
  readonly view: HudView
  readonly onHour: (hour: number) => void
  readonly onLive: () => void
  readonly onZoom: (dir: 1 | -1) => void
}): React.JSX.Element {
  return (
    <>
      <div className={`absolute left-3 top-3 flex items-center gap-2 rounded bg-[rgba(8,9,12,.7)] px-2 py-1 text-[#c8cfda] ${PIXEL}`}>
        <span data-testid="office-stream" className={view.connection === 'connected' ? 'text-[#4ade80]' : 'text-[#f5b34a]'}>
          {view.connection === 'connected' ? '● LIVE' : '● RECONNECTING'}
        </span>
        <span data-testid="office-hud-counts" className="text-[#5b6472]">
          {plural(view.departments, 'department')} · {plural(view.slaves, 'slave')} · {view.working} working
        </span>
      </div>
      <div className={`absolute left-1/2 top-3 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-[10px] rounded-md bg-[rgba(8,9,12,.78)] px-[10px] py-[5px] text-[#c8cfda] ${PIXEL}`}>
        <span className="whitespace-nowrap text-[#f5b34a]">
          <span data-testid="office-tod">{view.todLabel}</span> · <span data-testid="office-clock">{view.clock}</span>
        </span>
        <input
          type="range"
          data-testid="office-hour"
          min={0}
          max={24}
          step={0.25}
          value={view.hour}
          onChange={(event) => onHour(Number.parseFloat(event.target.value))}
          className="w-[clamp(90px,22vw,200px)] cursor-pointer accent-[#f5b34a]"
          aria-label="hour of day"
        />
        <button
          type="button"
          data-testid="office-live"
          onClick={onLive}
          className={`rounded border border-[rgba(255,255,255,.12)] px-2 py-[3px] ${PIXEL} ${view.live ? 'bg-[#4ade8022] text-[#4ade80]' : 'bg-transparent text-[#5b6472]'}`}
        >
          LIVE
        </button>
      </div>
      <div data-testid="office-legend" className={`absolute bottom-3 left-3 flex flex-wrap gap-[10px] rounded bg-[rgba(8,9,12,.7)] px-2 py-1 text-[#5b6472] ${PIXEL}`}>
        <span className="text-[#2ee6cf]">■ working</span>
        <span className="text-[#f87171]">■ blocked</span>
        <span className="text-[#8a929e]">■ paused</span>
        <span>· scroll zoom · drag pan · click focus</span>
      </div>
      <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-[5px] bg-[rgba(8,9,12,.7)] p-1">
        <button type="button" data-testid="office-zoom-out" onClick={() => onZoom(-1)} className="h-[22px] w-6 rounded border border-[rgba(255,255,255,.12)] font-mono text-[13px] text-[#c8cfda]">
          −
        </button>
        <span data-testid="office-zoom" className={`min-w-[30px] text-center text-[#c8cfda] ${PIXEL}`}>
          {view.zoom}
        </span>
        <button type="button" data-testid="office-zoom-in" onClick={() => onZoom(1)} className="h-[22px] w-6 rounded border border-[rgba(255,255,255,.12)] font-mono text-[13px] text-[#c8cfda]">
          +
        </button>
      </div>
    </>
  )
}
```

Create `apps/web/src/components/office/FocusCard.tsx`:

```tsx
'use client'

import { useState } from 'react'
import type { LiveStatus } from '../../lib/office/liveOffice'

export interface FocusView {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly department: string
  readonly color: string
  readonly status: LiveStatus
  readonly statusColor: string
  readonly taskKey: string
  readonly taskTitle: string
  readonly pct: number
  readonly runId: string | null
}

/** The design's focus card (M28 §5–§6): who, what, how far, and the run's Pause/Resume/Stop. The
 *  buttons call back with the action; the caller talks to the run routes and returns the refusal
 *  text (or null), which stays on the card until the next action. */
export function FocusCard({
  view,
  archived,
  onRun,
  onNext,
}: {
  readonly view: FocusView
  readonly archived: boolean
  readonly onRun: (runId: string, action: 'pause' | 'resume' | 'stop') => Promise<string | null>
  readonly onNext: () => void
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const paused = view.status === 'paused' || view.status === 'pausing'
  const runAction = async (action: 'pause' | 'resume' | 'stop'): Promise<void> => {
    if (view.runId === null) return
    setPending(true)
    setError(await onRun(view.runId, action))
    setPending(false)
  }
  const button = 'flex-1 rounded-[5px] border border-[rgba(255,255,255,.12)] bg-transparent py-1 text-[10.5px] font-medium text-[#c8cfda] disabled:opacity-40'
  return (
    <div
      data-testid="office-focus"
      className="absolute right-3 top-3 flex w-[min(236px,calc(100%-24px))] flex-col gap-[6px] rounded-lg border border-[rgba(255,255,255,.1)] bg-[rgba(10,12,16,.86)] px-3 py-[10px] backdrop-blur-[6px]"
    >
      <div className="flex items-center gap-2">
        <div
          className="grid h-[26px] w-[26px] flex-none place-items-center rounded-md border font-mono text-[10px] font-semibold"
          style={{ background: `${view.color}1a`, borderColor: `${view.color}3d`, color: view.color }}
        >
          {view.name.slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="truncate text-[12.5px] font-semibold">{view.name}</div>
          <div className="truncate text-[10px] text-[#7c8697]">
            {view.role} · {view.department}
          </div>
        </div>
        <span className="ml-auto whitespace-nowrap font-mono text-[9.5px] font-medium" style={{ color: view.statusColor }}>
          ● {view.status}
        </span>
      </div>
      <div className="truncate text-[11px] text-[#c8cfda]">
        <span className="font-mono text-[10px] text-[#5b6472]">{view.taskKey}</span> {view.taskTitle}
      </div>
      <div className="h-[3px] rounded-sm bg-[rgba(255,255,255,.06)]">
        <div className="h-full rounded-sm transition-[width] duration-500" style={{ width: `${view.pct}%`, background: view.statusColor, boxShadow: `0 0 8px ${view.statusColor}` }} />
      </div>
      <div className="flex gap-[5px]">
        {!archived && (
          <button type="button" data-testid="office-focus-pause" disabled={pending || view.runId === null} onClick={() => void runAction(paused ? 'resume' : 'pause')} className={button}>
            {paused ? 'Resume' : 'Pause'}
          </button>
        )}
        <button type="button" data-testid="office-focus-next" onClick={onNext} className={button}>
          Next ⇄
        </button>
        {!archived && (
          <button
            type="button"
            data-testid="office-focus-stop"
            disabled={pending || view.runId === null}
            onClick={() => void runAction('stop')}
            className="rounded-[5px] border border-[#f871713d] bg-transparent px-[9px] py-1 text-[10.5px] font-medium text-[#f87171] disabled:opacity-40"
          >
            Stop
          </button>
        )}
      </div>
      {error !== null && (
        <span role="alert" data-testid="office-focus-error" className="text-[10px] text-[#f87171]">
          {error}
        </span>
      )}
    </div>
  )
}
```

- [ ] **Step 4: The client.** Replace `apps/web/src/components/office/OfficeClient.tsx`:

```tsx
'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOverview } from '../../hooks/useOverview'
import { STATUS, renderIsoE, setPixelFont, tod } from '../../lib/office/engine.js'
import { LiveOffice, boardFromOverview, liveSlavesOf } from '../../lib/office/liveOffice'
import { sendControl } from '../../lib/postControl'
import type { OfficeSnapshot } from '../../server/office'
import { FocusCard, type FocusView } from './FocusCard'
import { OfficeHud, type HudView } from './OfficeHud'

/** The overlays repaint this often (the design's cadence); the canvas repaints every frame. */
const OVERLAY_MS = 250

function wallHour(now = new Date()): number {
  return now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600
}

/**
 * The Office tab (M28 §5): the vendored pixel office on a canvas, a `LiveOffice` fed by the overview
 * stream, the design's zoom / pan / click-to-focus, and the two overlays. The world is rebuilt when
 * the roster changes (a new server snapshot with different departments or slaves), keeping the
 * camera and the focused slave; the loop stops while the tab is hidden and on unmount.
 */
export function OfficeClient({
  workspaceId,
  initial,
  pixelFontFamily,
}: {
  readonly workspaceId: string
  readonly initial: OfficeSnapshot
  readonly pixelFontFamily: string
}): React.JSX.Element {
  const { snapshot, connection } = useOverview(workspaceId, initial.overview)
  const overview = snapshot ?? initial.overview
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const worldRef = useRef<LiveOffice | null>(null)
  const [frame, setFrame] = useState(0)
  const rosterKey = useMemo(() => JSON.stringify(initial.departments), [initial.departments])

  // Build (and rebuild on a roster change), carrying the camera and the focus over.
  useEffect(() => {
    const previous = worldRef.current
    const world = new LiveOffice(initial.departments)
    if (previous !== null) {
      if (previous.view !== undefined) world.view = { ...previous.view }
      world.hourLock = previous.hourLock
      if (previous.focusId !== null && world.slaves.some((s) => s.id === previous.focusId)) world.focusId = previous.focusId
    }
    worldRef.current = world
    setFrame((f) => f + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key is the roster's identity
  }, [rosterKey])

  // Every stream snapshot lands on the floor.
  useEffect(() => {
    worldRef.current?.apply(liveSlavesOf(overview), boardFromOverview(overview))
  }, [overview])

  // The loop: size, tick, render; the overlays every OVERLAY_MS.
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (canvas === null || wrap === null) return
    setPixelFont(pixelFontFamily)
    let raf = 0
    let last = performance.now()
    let acc = 0
    let stopped = false
    const size = (): void => {
      const r = wrap.getBoundingClientRect()
      const w = Math.max(200, Math.round(r.width))
      const h = Math.max(160, Math.round(r.height))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
    }
    size()
    const observer = new ResizeObserver(size)
    observer.observe(wrap)
    const loop = (now: number): void => {
      if (stopped) return
      const world = worldRef.current
      if (world !== null && !document.hidden) {
        const dt = Math.min(0.05, (now - last) / 1000)
        world.setWallClock(wallHour())
        try {
          world.tick(dt)
        } catch (error) {
          console.error(error)
        }
        const ctx = canvas.getContext('2d')
        if (ctx !== null) {
          try {
            renderIsoE(ctx, world, { viewKey: 'view', tod: true, fun: true, autofit: true, deptSigns: 'banner' })
          } catch (error) {
            console.error(error)
          }
        }
        acc += now - last
        if (acc > OVERLAY_MS) {
          acc = 0
          setFrame((f) => f + 1)
        }
      }
      last = now
      raf = requestAnimationFrame(loop)
    }
    const start = (): void => {
      raf = requestAnimationFrame(loop)
    }
    // Canvas text asks for the pixel font by family; wait for it so the first frame is not monospace.
    document.fonts.load(`9px ${pixelFontFamily}`).then(start, start)
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [pixelFontFamily])

  // Zoom / pan / click-to-focus, as the design wires them.
  const zoom = useCallback((dir: 1 | -1, mx?: number, my?: number): void => {
    const world = worldRef.current
    const canvas = canvasRef.current
    const v = world?.view
    if (world === null || canvas === null || v === undefined) return
    const ni = Math.max(0, Math.min(v.levels.length - 1, v.li + dir))
    if (ni === v.li) return
    const cx = mx ?? canvas.width / 2
    const cy = my ?? canvas.height / 2
    const nS = v.levels[ni] as number
    v.ox = Math.round(cx - ((cx - v.ox) * nS) / v.S)
    v.oy = Math.round(cy - ((cy - v.oy) * nS) / v.S)
    v.S = nS
    v.li = ni
    setFrame((f) => f + 1)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const point = (event: MouseEvent): [number, number] => {
      const r = canvas.getBoundingClientRect()
      return [((event.clientX - r.left) * canvas.width) / r.width, ((event.clientY - r.top) * canvas.height) / r.height]
    }
    let drag: { x: number; y: number; ox: number; oy: number; moved: boolean } | null = null
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const [mx, my] = point(event)
      zoom(event.deltaY < 0 ? 1 : -1, mx, my)
    }
    const onDown = (event: MouseEvent): void => {
      const v = worldRef.current?.view
      if (v === undefined) return
      event.preventDefault()
      drag = { x: event.clientX, y: event.clientY, ox: v.ox, oy: v.oy, moved: false }
      canvas.style.cursor = 'grabbing'
    }
    const onMove = (event: MouseEvent): void => {
      const v = worldRef.current?.view
      if (drag === null || v === undefined) return
      const r = canvas.getBoundingClientRect()
      const k = canvas.width / r.width
      const dx = (event.clientX - drag.x) * k
      const dy = (event.clientY - drag.y) * k
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
      v.ox = Math.round(drag.ox + dx)
      v.oy = Math.round(drag.oy + dy)
    }
    const onUp = (event: MouseEvent): void => {
      if (drag === null) return
      canvas.style.cursor = 'grab'
      const world = worldRef.current
      if (!drag.moved && world !== null) {
        const [x, y] = point(event)
        const hit = (world.viewHits ?? []).find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h)
        if (hit !== undefined) {
          world.focusId = hit.id
          setFrame((f) => f + 1)
        }
      }
      drag = null
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [zoom])

  const world = worldRef.current
  const hud: HudView = {
    connection,
    departments: world?.departments.length ?? initial.departments.length,
    slaves: world?.slaves.length ?? 0,
    working: world?.slaves.filter((s) => world.status(s) === 'working').length ?? 0,
    todLabel: world === null ? '' : tod(world.hour).label.toUpperCase(),
    clock: world?.clock() ?? '--:--',
    hour: world === null ? 9 : Math.round(world.hour * 4) / 4,
    live: world === null || world.hourLock === null,
    zoom: `${(world?.view?.li ?? 0) + 1}x`,
  }
  const focused = world === null ? null : (world.slaves.find((s) => s.id === world.focusId) ?? world.slaves[0] ?? null)
  const focus: FocusView | null =
    world === null || focused === null || focused === undefined
      ? null
      : (() => {
          const live = world.liveOf(focused.id)
          const status = live?.status ?? 'idle'
          const statusColor = STATUS[world.status(focused)]
          return {
            id: focused.id,
            name: focused.name,
            role: focused.role,
            department: world.departments[focused.dept]?.name ?? '',
            color: focused.color,
            status,
            statusColor,
            taskKey: focused.task?.key ?? '',
            taskTitle: focused.task?.title ?? '—',
            pct: Math.round(focused.progress),
            runId: live?.runId ?? null,
          }
        })()

  return (
    <div ref={wrapRef} data-frame={frame} className="relative h-[calc(100vh-52px-41px)] min-h-[360px] w-full overflow-hidden bg-[#07080b]">
      <canvas ref={canvasRef} data-testid="office-canvas" className="block h-full w-full cursor-grab" />
      <OfficeHud
        view={hud}
        onHour={(hour) => {
          if (worldRef.current !== null) worldRef.current.hourLock = hour
          setFrame((f) => f + 1)
        }}
        onLive={() => {
          if (worldRef.current !== null) worldRef.current.hourLock = null
          setFrame((f) => f + 1)
        }}
        onZoom={(dir) => zoom(dir)}
      />
      {focus !== null && (
        <FocusCard
          key={focus.id}
          view={focus}
          archived={initial.workspace.archived}
          onRun={(runId, action) => sendControl(`/api/w/${workspaceId}/runs/${runId}/${action}`, { method: 'POST' })}
          onNext={() => {
            const w = worldRef.current
            if (w === null || w.slaves.length === 0) return
            const i = w.slaves.findIndex((s) => s.id === w.focusId)
            w.focusId = (w.slaves[(i + 1) % w.slaves.length] as { id: string }).id
            setFrame((f) => f + 1)
          }}
        />
      )}
    </div>
  )
}
```

(`key={focus.id}` on the card resets its error/pending state when the focus moves. If `world.status(focused)` is not a key of `STATUS` in the `.d.ts`, widen the declaration in Task 1's file. `useOverview`'s return shape: `{ snapshot, connection, ... }` — the test mocks exactly those two; check the hook exports both under those names.)

- [ ] **Step 5: GREEN + build.** `npx tsc -p apps/web/tsconfig.test.json --noEmit`; `npx vitest run apps/web/test/office-client.test.tsx apps/web/test/office-live.test.ts apps/web/test/office-engine.test.ts` (one run) → pass, no `act` warnings; `npx vitest run apps/web` once; `pgrep -fa 'next dev'` empty, `npm run web:build && rm -rf apps/web/.next`.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/components/office/OfficeClient.tsx apps/web/src/components/office/OfficeHud.tsx apps/web/src/components/office/FocusCard.tsx apps/web/test/office-client.test.tsx
git commit -m "feat(web): m28 t4 — the office client: the canvas loop on the stream, the HUD, the focus card with real pause/resume/stop"
```

---

### Task 5: Gate, README, errata, closing run

**Files:**
- Modify: `scripts/gate-m11-shell.mjs` (stage 7, after the `stage 6 complete` line at ~688 and before `await stopNextDev`), `README.md` (Web UI table), the spec's §13

- [ ] **Step 1: m11 stage 7.** After stage 6's `console.log('stage 6 complete: …')`, add (reuse `page`, `baseUrl`, `workspaceIdA`, `prisma`, `waitVisible`, `clickUntil`, `fail`, `delay`, `ACTION_TIMEOUT_MS`, `NEXT_READY_TIMEOUT_MS` exactly as the file defines them — read stage 6 first; project A was restored at the end of stage 6, so it is live here):

```js
  // ---- Scenario stage 7: /w/<A>/office -- the Office tab (M28 §9) draws project A's departments
  // and slaves from the same rows the Slaves table showed, the HUD counts match prisma, the canvas
  // has painted, and the focus card cycles through the roster.
  const officeDepartments = await prisma.team.count({ where: { workspaceId: workspaceIdA } })
  const officeSlaves = await prisma.slave.count({ where: { team: { workspaceId: workspaceIdA } } })
  await page.goto(`${baseUrl}/w/${workspaceIdA}/office`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('office-canvas'), 'the office canvas')
  const expectedCounts = `${officeDepartments} department${officeDepartments === 1 ? '' : 's'} · ${officeSlaves} slave${officeSlaves === 1 ? '' : 's'} · 0 working`
  {
    const deadline = Date.now() + ACTION_TIMEOUT_MS
    let counts = await page.getByTestId('office-hud-counts').textContent()
    while (counts !== expectedCounts && Date.now() < deadline) {
      await delay(100)
      counts = await page.getByTestId('office-hud-counts').textContent()
    }
    if (counts !== expectedCounts) await fail(`office HUD counts read ${JSON.stringify(counts)}, expected ${JSON.stringify(expectedCounts)}`)
  }
  const painted = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="office-canvas"]')
    if (!(canvas instanceof HTMLCanvasElement) || canvas.width === 0 || canvas.height === 0) return { width: 0, height: 0, painted: false }
    const ctx = canvas.getContext('2d')
    if (ctx === null) return { width: canvas.width, height: canvas.height, painted: false }
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let lit = 0
    for (let i = 0; i < data.length; i += 4 * 97) if (data[i] + data[i + 1] + data[i + 2] > 60) lit++
    return { width: canvas.width, height: canvas.height, painted: lit > 20 }
  })
  if (!painted.painted) await fail(`the office canvas (${painted.width}x${painted.height}) has not painted the floor`)
  const firstFocus = await page.getByTestId('office-focus').textContent()
  await clickUntil(
    page.getByTestId('office-focus-next'),
    async () => (await page.getByTestId('office-focus').textContent()) !== firstFocus,
    'cycling the office focus card with Next',
  )
  console.log(`stage 7 complete: /w/${workspaceIdA}/office painted ${officeDepartments} departments and ${officeSlaves} slaves, counts matched prisma, the focus card cycled`)
```

If project A has one slave (stage 6 deleted one), `Next` cycles back to the same name and the predicate never flips: guard with `if (officeSlaves > 1)` around the `clickUntil` and say so in the log line. Run `CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" npm run gate:m11-shell` → PASS.

- [ ] **Step 2: README.** In the Web UI table add a row after Graph: `| **Office** \`/w/<id>/office\` | The project's departments and slaves as a pixel office: who is working, blocked or paused, on what and how far; pause, resume or stop the focused slave's run; scroll to zoom, drag to pan, click a slave to focus. |` (match the table's real column layout).

- [ ] **Step 3: §13 Errata** in `docs/superpowers/specs/2026-09-05-m28-office-floor-design.md`: one line per controller ruling from the execution ledger, plus: the vocabulary gate needed no exclusion (`docs/superpowers` was already excluded); confetti fires on the working→idle-at-100 transition only (no `run.succeeded` stream hook — `useOverview` does not expose events); the HUD's stream badge replaced the design's static "● LIVE"; anything else that diverged.

- [ ] **Step 4: Closing run.** `npm run typecheck`; `npm test` (600 s, background it and read the log); `npm run web:build && rm -rf apps/web/.next`; `npm run gate:m26-vocabulary`; then, none overlapping, with `SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh"` and `CHROMIUM_PATH` as above: `m15-boundary`, `m20-auth`, `m21-loose-ends`, `m23-onboarding`, `m14-fidelity`, `m16-chrome`, `m11-shell`, `m18-skill-and-teeth`. m14 rewrites its PNGs on every run (timestamp-only) — revert them unless an assertion changed. Record every PASS line.

- [ ] **Step 5: Commit.**

```bash
git add scripts/gate-m11-shell.mjs README.md docs/superpowers/specs/2026-09-05-m28-office-floor-design.md
git commit -m "test(gates),docs: m28 t5 — m11 opens the office and reads the floor; README and errata"
```

## Closing verification (after Task 5, before the final review)

- Everything in Task 5 Step 4 green at HEAD.
- Final whole-branch review (most capable model) with the lens "the floor never invents state: every slave's state, task, progress and every control on the card traces to the stream or a real route; the vendored engine carries only the listed edits"; one fix wave, one scoped re-review; then merge fast-forward, push (pre-push hook: 600 s), update the memory backlog line, delete the plan's workspace.

## Self-review against the spec

- §2 principles → T2 (status/task/board/clock/idle wander, no invention), T4 (controls, no polling). §3 data → T3 (`buildOfficeSnapshot`, colours), T4 (`useOverview`). §4.1 vendoring → T1 (trim, wrap, split, font, palettes, codemod, d.ts). §4.2 adapter → T2 (table, walks once, progress lock, roster rebuild in T4 with camera/focus carried). §5 UI → T3 (tab, page, font), T4 (canvas, HUD, focus card, testids, empty roster). §6 controls → T4. §7 files → header. §8 edge cases → T4 (stream badge, hidden tab pauses the loop, archived hides controls, unknown-stream slave reads idle via `liveOf` null → `idle`); reduced-motion confetti skip is NOT implemented — recorded for §13 as deferred (the engine's confetti/coins are inside `WorldE.tick`; skipping them needs a vendor flag, which the constraint forbids beyond the listed edits). §9 tests → T1 (engine), T2 (adapter), T3 (integration + tabs), T4 (client), T5 (gate). §10 constraints → header. §11 order → T1…T5. §12 out of scope untouched.
- Types: `OfficeRosterDepartment` (T2) is satisfied by `OfficeDepartment` (T3) structurally; `LiveSlave`/`LiveBoard`/`liveSlavesOf`/`boardFromOverview` (T2) ↔ `OfficeClient` (T4); `HudView`/`FocusView` (T4) ↔ their tests; `engine.d.ts` (T1) declares `simulate`, `tick`, `view`, `viewHits`, `focusId`, `hourLock`, `liveOf` lives on `LiveOffice` (T2) not `World`.
- Placeholders: none — every step names its code and its command.
