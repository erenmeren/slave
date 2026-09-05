# M28 — Office Floor: the project's team as a pixel office, driven by live data

**Status:** Approved in outline (2026-09-05: "Office Floor.dc.html bunu da ekler misin projeye, gerçek olarak çalıştırabilir misin? agentlarla uyumlu"; decisions taken in conversation — a project tab, not a global page; real status, real tasks, real run controls, with the cosmetic life of the design kept for idle slaves). Sections below are the design for review.
**Approach:** vendor the design's `office-engine.js` into the web app as an ES module trimmed to what the design uses, put a small `LiveOffice` adapter on top that replaces the simulation's state machine with the project's live status, and rewrite the design's dc-runtime template as React components. One new project tab, one new server read, no schema change, no new dependency.
**Scope rule:** `/w/[workspaceId]/office` only. The design's other canvases (`Office Views.dc.html`, `Transit Map.dc.html`) are out of scope.
**Source:** Claude Design project `a707bbea-1769-4e1d-b3e4-d71f6d7c8d98`, files `Office Floor.dc.html` (template + component logic), `office-engine.js` (world + renderers, 830 lines), `support.js` (the dc-runtime, not needed — its job is done by React here). Copies as handed off live in `docs/superpowers/design/2026-09-05-office-floor/`.

## 1. Why this milestone

The Overview tab lists slaves as cards; the Graph tab draws them as nodes. Neither gives the operator the one-glance feeling of "the office is busy / quiet / stuck". The design is an isometric pixel office: desks in department pods, slaves sitting at their screens while they work, a red speech bubble when they are blocked, grey when paused, a lounge with a coffee machine, an arcade cabinet, a cat and a roomba, a day/night cycle. As delivered it is a **simulation**: it invents tasks, blocks slaves at random, and its pause/stop buttons act on invented runs. M28 keeps the picture and replaces the invention with the project's real state.

**Non-goals:** a global office across projects; editing (rename, move, delete) from the office; sound; touch gestures; the boss's whip speeding work up (progress is real now); saving camera position across reloads.

## 2. Principles

| | as designed (simulation) | M28 (live) |
|---|---|---|
| departments, desks | `makeDepartments(n, perDept)` | the project's departments (`Team`) and their slaves, in the server's order |
| slave status | internal state machine | derived from the overview stream's `SlaveCardData.status`, `taskStatus`, `blocked[]` |
| task on screen | invented `T-1xx` titles | the slave's real `taskTitle`, `stepLabel`, `progressPct` |
| task board on the wall | invented cards | card counts from `OverviewSnapshot.tasks` |
| pause / resume / stop | mutate the simulation | `POST /api/w/:id/runs/:runId/{pause,resume,stop}` |
| clock | simulated, 150 s per day | the browser's wall clock; the slider still previews any hour |
| idle life (coffee, arcade, sofa) | yes | yes, only for slaves whose status is `idle` |
| cat, roomba, boss, confetti | yes | yes; confetti on a real `run.succeeded` |
| random blocking, invented task spawning, whip speed-up | yes | removed |

**Counts** on the HUD and the board come from one server read plus the overview stream the page already opens; the office never polls.

## 3. Data

### 3.1 Server read (`apps/web/src/server/office.ts`)

```ts
export interface OfficeSlave { readonly slaveId: string; readonly name: string; readonly role: string; readonly color: string }
export interface OfficeDepartment { readonly teamId: string; readonly name: string; readonly color: string; readonly slaves: readonly OfficeSlave[] }
export interface OfficeSnapshot {
  readonly workspace: { readonly id: string; readonly name: string; readonly archived: boolean }
  readonly departments: readonly OfficeDepartment[]
  readonly overview: OverviewSnapshot   // buildOverviewSnapshot(workspaceId), the client's initial stream state
}
export async function buildOfficeSnapshot(workspaceId: string): Promise<OfficeSnapshot | null>
```

- Departments: `prisma.team.findMany({ where: { workspaceId }, orderBy: { name: 'asc' }, include: { slaves: { orderBy: { name: 'asc' } } } })`. A department with no slaves still gets a pod (empty desks are the point of the picture).
- Colors: department `i` gets `DEPT_COLORS[i % 12]`, slave `j` (counted across the whole project in that order) gets `SLAVE_COLORS[j % 6]` — both palettes exported from the vendored engine (`DEPT_POOL`'s colors, `AGENT_COLORS`), so the office looks like the design.
- `null` when the workspace does not exist. An archived workspace still returns a snapshot with `archived: true`.

### 3.2 Live state

The client subscribes with the existing `useOverview(workspaceId, initial.overview)` (SSE, `/api/w/:id/overview`). Per slave, by `id`: `status: SlaveStatus`, `taskTitle`, `taskId`, `taskStatus`, `progressPct`, `stepLabel`, `runId`. Project-level: `tasks { active, ready, blocked, done, failed }`, `blocked[]` (`kind: 'run' | 'task'`, `runId`), `mergeQueue[]`, `workspace.haltedReason`. A slave that is in the roster but absent from the stream (just created) reads as `idle`.

## 4. The engine

### 4.1 Vendoring (`apps/web/src/lib/office/engine.js` + `engine.d.ts`)

- Keep: the base `World` (section 1, minus its three renderers), the section-4 helpers the isometric renderer imports (`agentSprite`, `bubble`, `windowC`, `pendant`, `labelsPx`, `lerpC`, `SEATED`, the lounge furniture), `WorldD`, `WorldE`, `WorldF`, `renderIsoE`, `tod`, `makeDepartments` (kept for tests), `STATUS`. Drop: `renderSide`, `renderTop`, `renderIso`, `WorldB`, `WorldC`, `renderSideB/IsoB/…` (sections 2–3 and the section-4 renderers that `renderIsoE` does not call).
- Wrap as one ES module: no `window.OfficeEngine`, named exports `{ World, WorldF, renderIsoE, tod, STATUS, DEPT_COLORS, SLAVE_COLORS, makeDepartments }`. Internals stay as they are (this is vendored pixel-art code, not house style); the file header names the source and the trim.
- Vocabulary: the file says `agent` 95 times (`this.agents`, `agentSprite`, `AGENT_COLORS`…). The M26 codemod rules (`scripts/rename-agent-to-slave.mjs`) are applied to this one file before it is committed, so `world.slaves`, `slaveSprite`, `SLAVE_COLORS`; the vocabulary gate then scans it like any other file. The handoff copies under `docs/superpowers/design/2026-09-05-office-floor/` keep their original words and join the gate's exclusion list (they are input, like the other handoffs).
- `engine.d.ts` types only what the adapter and the client touch: `World` (`slaves`, `departments`, `desks`, `board`, `view`, `viewHits`, `focusId`, `hour`, `hourLock`, `t`, `tick`, `status`, `clock`, `seat`, `goTo`, `ev`), the slave record (`id`, `name`, `role`, `color`, `dept`, `state`, `task`, `progress`, `x`, `y`, `deskIdx`, `timer`, `path`, `next`), `renderIsoE(ctx, world, opts)`, `tod(hour)`.

### 4.2 The adapter (`apps/web/src/lib/office/liveOffice.ts`)

```ts
export type LiveStatus = 'idle' | 'starting' | 'working' | 'blocked' | 'pausing' | 'paused' | 'resuming' | 'stopping'
export interface LiveSlave { readonly slaveId: string; readonly status: LiveStatus; readonly taskTitle: string | null; readonly stepLabel: string | null; readonly progressPct: number; readonly runId: string | null }
export interface LiveBoard { readonly todo: number; readonly doing: number; readonly review: number; readonly done: number }
export function liveStatusOf(card: SlaveCardData, blockedRunIds: ReadonlySet<string>): LiveStatus
export function boardFromOverview(o: OverviewSnapshot): LiveBoard
export class LiveOffice extends WorldF {
  constructor(departments: readonly OfficeDepartment[])
  apply(live: ReadonlyMap<string, LiveSlave>, board: LiveBoard): void   // on every stream snapshot
  setWallClock(hour: number): void                                        // every frame; hourLock still wins
  tick(dt: number): void   // the design's tick minus the simulation
}
```

- `liveStatusOf`: `blocked` when `card.taskStatus === 'blocked'` or `card.runId` is in `blockedRunIds` (from `overview.blocked` rows with `kind: 'run'`); otherwise `card.status`.
- The world's slave ids are the real `slaveId`s (the base class assigns `'a' + idx`; the adapter overrides them after construction, before any lookup).
- `apply()` sets, per slave, the target state from the table below, `task = { key: stepLabel ?? '', title: taskTitle ?? '—' }` or `null`, `progress = progressPct` (clamped 0–100). It sets `board` to `todo/doing/review/done` arrays of `count` placeholder cards each (capped at 6 per column, the wall board's capacity), and `hour` from the wall clock (`hourLock` still wins).

| live status | slave state in the world | notes |
|---|---|---|
| `working` | at the desk, `work` | progress is the real pct; never advanced by the tick |
| `blocked` | at the desk, `blocked` | red bubble; stays until the status changes |
| `pausing`, `paused` | at the desk, `paused` | grey screen |
| `starting`, `resuming` | walks to the board (`grab`) then back to the desk into `work` | the design's own "picked from board" walk, once per transition |
| `stopping` | walks to the board (`deliver`) then sits | once per transition |
| `idle` | `sit`; the design's idle wander (coffee, arcade, sofa) with its probabilities | the "pick a task from the board" branch of `sit` is removed |

A transition-walk is only started when the slave is seated; a slave mid-walk finishes the walk and then adopts the current target. `tick(dt)`: the base tick's `spawnTask`, review→done timer, random `blocked`, `work` progress advance and the whip's progress boost are removed (overridden, not patched at runtime); cat, roomba, boss (walk/coins/whip animation only), confetti and the `hour` update stay. Confetti fires when a slave's status leaves `working` for `idle` with a task that reached 100, and on a stream event `run.succeeded` for that slave.

- **Roster changes**: the client computes `rosterKey = JSON.stringify(departments)` from each server snapshot (the page is `force-dynamic`; the roster is re-read on navigation and on `router.refresh()` after a department/slave edit elsewhere). When the key changes the world is rebuilt and `view` (zoom level and pan) and `focusId` (if the slave still exists) are carried over.

## 5. UI

- **Tab**: `ProjectTabs` gains `{ id: 'office', label: 'Office', path: /w/${id}/office }` between Graph and Activity. Page `apps/web/src/app/w/[workspaceId]/office/page.tsx` mirrors the Graph page (`force-dynamic`, "no workspace" fallback, keyed client).
- **`OfficeClient`** (`components/office/OfficeClient.tsx`, client): owns the canvas (`data-testid="office-canvas"`, sized to its wrapper by a `ResizeObserver`, pixel-art: canvas pixels = CSS pixels), the `LiveOffice` instance, the rAF loop (`speed` fixed at 1; the loop stops while `document.hidden` and on unmount), wheel zoom / drag pan / click focus exactly as the design's component, and passes `renderVals` to the two presentational parts every 250 ms (the design's cadence).
- **`OfficeHud`**: the design's four overlays. Top-left `office-hud-counts`: `{N} departments · {N} slaves · {N} working` (pluralised with `lib/plural.ts`). Top-centre: `office-tod` label, `office-clock`, the hour range `office-hour`, `office-live` button (green when `hourLock === null`). Bottom-left legend. Bottom-right zoom `office-zoom-out`, `office-zoom` (`1x…4x`), `office-zoom-in`.
- **`FocusCard`** (`office-focus`): initials tile, name, `role · department`, status dot and word, `stepLabel taskTitle`, progress bar, and three buttons: `office-focus-pause` (label `Pause` while `working`/`blocked`, `Resume` while `paused`; disabled when `runId === null`), `office-focus-next` (`Next ⇄`, cycles through the slaves), `office-focus-stop` (disabled when `runId === null`). A refusal shows in `office-focus-error` (`role="alert"`). On an archived project the three buttons are hidden (the header already shows the chip; writes 409 anyway).
- Fonts: the HUD uses Silkscreen through `next/font/google` (variable `--font-pixel`, loaded in the office page only); the canvas labels ask for `'Silkscreen, monospace'` and the loop starts after `document.fonts.load("9px Silkscreen")` resolves (or rejects — then monospace).
- Empty project (no departments): the canvas draws the empty floor and lounge; the HUD says `0 departments · 0 slaves · 0 working`; the focus card is hidden.

## 6. Controls

`office-focus-pause`/`-stop` call `sendControl('/api/w/${workspaceId}/runs/${runId}/pause' | '/resume' | '/stop', { method: 'POST' })`; `null` → nothing more (the stream carries the new status); a string → `office-focus-error`. No optimistic state: the slave's state on the floor follows the stream, as everywhere else in the app.

## 7. Files

Create: `docs/superpowers/design/2026-09-05-office-floor/{Office Floor.dc.html, office-engine.js, README.md}`, `apps/web/src/lib/office/engine.js`, `engine.d.ts`, `liveOffice.ts`, `apps/web/src/server/office.ts`, `apps/web/src/app/w/[workspaceId]/office/page.tsx`, `apps/web/src/components/office/{OfficeClient,OfficeHud,FocusCard}.tsx`, tests in §9.
Modify: `apps/web/src/components/project/ProjectTabs.tsx`, `scripts/gate-m26-vocabulary.mjs` (exclusion for the handoff directory), `scripts/gate-m11-shell.mjs` (stage 7), `README.md`.

## 8. Errors and edge cases

- Stream disconnected: the floor keeps animating with the last state; the HUD shows the existing stream-state chip pattern (`useWorkspaceStream`'s `connection`) as a small `office-stream` badge.
- A slave in the stream but not in the roster (created after the page loaded): ignored until the next roster read; a slave in the roster but not in the stream: `idle`.
- `runId` present but the run ends between click and request: the route's 409 text shows in the card.
- More than 12 departments or 8 slaves per department: the engine's layout is dynamic (WorldF pods and columns scale with the counts); colors wrap.
- Halted project: slaves read `idle`/`paused` from the stream as today; the focus buttons stay (the routes refuse on halt).
- Reduced motion (`prefers-reduced-motion`): the loop still runs (it is the product) but the confetti and the boss's coin throw are skipped.

## 9. Testing

- `apps/web/test/office-engine.test.ts` (node): `new WorldF({ departments })` builds one desk per slave in the given order; `renderIsoE` draws one frame against a fake 2D context (an object recording the calls the engine makes: `fillRect`, `setTransform`, `save/restore`, `beginPath/moveTo/lineTo/fill`, `fillText`, `measureText`) without throwing; the module exports the palettes.
- `apps/web/test/office-live.test.ts` (node): `liveStatusOf` for every `SlaveStatus` and both blocked sources; `boardFromOverview`; `LiveOffice.apply` — each row of the §4.2 table lands the slave in the stated state, progress equals the pct and does not advance across ticks, a transition walk is started once and not restarted while it is under way, idle slaves may leave the desk and non-idle never do, a rebuilt world carries `view` and `focusId`.
- `apps/web/test/office-client.test.tsx` (jsdom, the engine module mocked to a stub world): HUD counts and clock, hour slider sets `hourLock` and LIVE clears it, zoom labels, focus card contents from a stubbed slave, `office-focus-pause` posts the pause URL then the resume URL when paused, `office-focus-stop` posts stop, a refusal renders in `office-focus-error`, buttons disabled without a run, hidden when archived, `Next` cycles.
- `apps/web/test/integration/office.test.ts`: `buildOfficeSnapshot` — departments in name order with their slaves, deterministic colors, `null` for an unknown workspace, `archived: true` for an archived one.
- `apps/web/test/project-tabs.test.tsx` (existing file, one case): the Office tab links to `/w/<id>/office`.
- Gate: m11-shell stage 7 opens `/w/<id>/office`, waits for `office-hud-counts` to equal the prisma counts, asserts the canvas has a non-zero size and a painted pixel (`getImageData` of the canvas centre is not the background colour), clicks `office-focus-next` and sees the name change. No new fidelity PNG (m14 unchanged).

## 10. Global constraints

- No schema change, no new npm dependency (Silkscreen through `next/font/google`).
- The vendored engine is mechanical vendor code: trimmed, module-wrapped and vocabulary-renamed, otherwise untouched; every behaviour change lives in `liveOffice.ts`.
- Vocabulary: "project", "slave", "department" in every user-facing string; the gate covers the vendored file.
- Standing rules: ONE vitest at a time; web tasks gate on `web:build`; gates never overlap; `git add` explicit paths; comments change with behaviour.

## 11. Order of work

1. Handoff copies + vendored engine module (trim, wrap, rename) + `engine.d.ts` + engine tests + vocabulary-gate exclusion.
2. `liveOffice.ts` with its tests.
3. `buildOfficeSnapshot` + page + tab + `OfficeClient`/`OfficeHud`/`FocusCard` with their tests; `web:build`.
4. m11 stage 7, README, §13 errata, closing run.

## 12. Out of scope, recorded

Global office; office-side editing; sound; touch; persisted camera; the other two design canvases; the "fun" props as operator settings (the design's `fun`/`deptSigns` props are fixed to `true`/`'banner'`).

## 13. Errata — where execution corrected the plan

Controller rulings made while executing Tasks 1–4, in order:

- **R1** — the running demo `next dev` (:3000) is stopped right before Task 3's `web:build` (a build clobbers a live dev server) and restarted for the user at the end of the branch; costs one restart, not a design change.
- **R2** — Task 1's engine test gained an empty-roster case (`new WorldF({ departments: [] })` ticks and renders without throwing), since §5 requires an empty project to draw and the vendored engine had never been asked to before.
- **R3** — one more listed vendor edit beyond §4.1's set: the `World` constructor's initial `spawnTask` loop now runs only when `this.departments.length > 0`. The design never had an empty office; §5 does. Recorded in the engine header as well as here.
- **R4** — `blocked` is derived from `card.taskStatus === 'blocked'` only; the design's blocked-run-ids branch (`liveStatusOf(card)`) is dropped, because `overview.blocked`'s `kind: 'run'` rows are paused runs, not blocked ones, and reading them as blocked would invent a status the stream never claims.
- **R5** — the task and the progress bar follow the live entry, not the task's own title: non-idle sets `task = { key: stepLabel ?? '', title: taskTitle ?? '—' }` and `progress = progressPct`; idle sets both to null/0. Set in `apply()` and re-asserted (re-locked) in `tick()` so the engine's own idle-wander never overwrites a real task with cosmetic state.
- **R6** — no confetti trigger in M28: the overview stream carries neither a per-slave event type nor a success signal (`liveEvents` are summaries, not events), so nothing in `liveOffice.ts` can detect a "run succeeded" transition. The engine's confetti/coin machinery stays vendored and unused; the design's "working → idle at 100" trigger and its test are dropped. See also §8's reduced-motion note below — moot without a trigger, but recorded as deferred rather than silently dropped.
- **R7** — board `doing = max(0, tasks.active - tasks.ready)`, so ready tasks are not drawn twice on the wall board; the resulting overlap with the merge queue is accepted as decorative (the wall board was never the queue of record).
- **R8** — Task 3's engine edit at the bottom export block is eight `export const X = OfficeEngine.X` lines rather than one destructuring `export const { X, Y, ... } = OfficeEngine` statement, because Next's webpack build dropped the destructured bindings (every import read `undefined`) while the flat form survives the same build unchanged. Syntax only, not behaviour; the engine header's edit list carries this line per R8's own instruction.
- **R9** — the roster-change rebuild in `OfficeClient` carries the camera forward as `{ li, ox, oy }` in a ref applied on the first frame after the new world's engine-created `view` exists, rather than copying the old `view` object onto the new world (the new world's `levels`/`base`/`w`/`h` must come from itself, not the previous roster's layout). No engine edit; costs a ref and four lines.
- **R10** — that same rebuild effect applies the current overview to the new world immediately (`world.apply(liveSlavesOf(overview), boardFromOverview(overview))`) instead of waiting for the next stream tick, so a roster change never shows a frame of stale (pre-rebuild) slave state.
- **R11** — the HUD's `hour` reads `world.hourLock ?? round(world.hour * 4) / 4` so the controlled range input follows the lock exactly (a lock value the engine's own tick already rounds to quarter-hours) instead of drifting from it by a rounding step.

Divergences the plan itself predicted (plan T5 Step 3), all confirmed as-is:

- The vocabulary gate needed no exclusion for the handoff copies — `docs/superpowers` was already excluded, so §7's planned `scripts/gate-m26-vocabulary.mjs` edit was never made.
- Confetti: no trigger at all in M28 (R6 above supersedes the plan's "working → idle at 100" note).
- The HUD's stream badge (`office-stream`: `● LIVE` / `● RECONNECTING`, following `useWorkspaceStream`'s `connection`) replaced the design's static `● LIVE`.
- Reduced-motion confetti/coin skip (§8) is not implemented: the engine's confetti and the boss's coin throw live inside `WorldE.tick`, and skipping them under `prefers-reduced-motion` needs a vendor flag the constraints forbid beyond the listed §4.1 edits (plus R3, R8 above). Deferred, not silently dropped — moot in practice since R6 means nothing fires the confetti this milestone anyway.

Task 4 deviations from the brief's literal code (from its report):

- A test-only `WorldF` stub in `office-client.test.tsx`, needed for the `importOriginal`/full-mock interaction the client test's mocking strategy required.
- `useFakeTimers` with a narrowed `toFake` list, to avoid a Vitest/sinon `requestAnimationFrame`-fake collision.
- An off-by-one fix in `onNext`: the brief's literal code made the first click a no-op (the initial `focusId` already matched the first slave, so the first `Next` press advanced the index but not the rendered focus); corrected so the first click moves off the first slave.

Anything else that diverged, found while executing Task 5:

- The m11 gate's stage 7 brief code reads `office-focus`'s text unconditionally before checking the roster size, and only guards the `Next`-cycle assertion behind `officeSlaves > 1`. At HEAD, project A's roster at the point stage 7 runs is 1 department and **0** slaves (stage 6a deletes the one slave that stage 5 had moved into the second department; stage 6b then deletes that now-slave-less department, leaving only the original "Crew" department, empty). With zero slaves `OfficeClient` renders no focus card at all (§5's "empty project" case in `OfficeClient.tsx`'s `focused` computation applies to any zero-slave roster, not only a zero-department one), so stage 7 as implemented reads both counts from `prisma` and branches three ways: zero slaves asserts the focus card is absent, exactly one slave asserts it renders but does not assert `Next` changes anything (nothing to cycle to), and two or more asserts the cycle. This is the gate script only; no product code changed.

