# M14: Design Fidelity — Nine Pages, One Design — Design

**Date:** 2026-08-29
**Status:** Approved
**Predecessor:** M13 (runtime hardening). M11 took the design handoff as its structural reference
and migrated its tokens and information architecture; the card-and-panel anatomy, two of the
nine pages, and the motion never arrived. This milestone finishes what M11 started: every page
of the handoff's 3a shell, recreated pixel-close in the real app with real data.
**Design reference (binding):** `design_handoff_ai_team_os/README.md` — the "3a — The nine-page
shell" section, "Interactions & Behavior", "Design Tokens" — and `mockups/AI Team OS Web.dc.html`
for behavior. Its numbers (sizes, radii, alphas, grid templates, timings) are requirements, not
illustrations; where this document and the README disagree, the README wins unless a section
below names the deviation.
**Structural reference:** `apps/web/src/components/ui/` (M11's primitives), `apps/web/src/app/globals.css`
(the migrated tokens), `apps/orchestrator/src/pump.ts` (where run facts are recorded).

The README asks that the mocks be *recreated in the target codebase using its existing
patterns, component library and data layer — not copied*. That is the method here: the anatomy
becomes primitives once, the pages consume them, and every figure a page shows comes from
Postgres and the event log, never from placeholder state.

## 1. Scope

In scope, in order:

- **Series A — the anatomy.** `AvatarTile`, a rebuilt `StatusPill`, a rebuilt `AgentCard`,
  `Panel`/`SectionLabel` headers, the 212px `Sidebar` with counts and a guardrails block, the
  52px `TopBar` with the gradient hairline and latency chip, and the motion vocabulary
  (`rise`, `sweep`, `dash`, `pulse`) behind `prefers-reduced-motion`.
- **Series B — the data the missing pages need.** Skill invocations counted from the run
  stream onto `AgentRun.skillCalls`; token usage onto `AgentRun.tokensIn/tokensOut`; a skill
  catalog synchronized from disk into the existing `SkillProvider`/`Skill` tables; the
  analytics aggregation (7-day outcomes, KPIs, per-agent performance).
- **Series C — the nine pages**, one task each: Overview, Agents, Tasks, Graph, Activity,
  Projects, Settings, Skills, Analytics.
- **Series D — the fidelity gate.** `scripts/gate-m14-fidelity.mjs`: nine committed
  screenshots, the README's measurable values asserted from the DOM, reduced-motion,
  behavior stages, and real Skills/Analytics data. Zero vendor spend.

Out of scope (deliberate): the 1a/1b/1c/2a exploration directions as separate products (the
3a shell's cabled Graph and river Activity are their in-product descendants); the 3D Floor;
Codex and Gemini as real adapters; enforcing the permission matrix at runtime; WebSocket
transport; authentication (still localhost-only; the auth story stays the first item after
this milestone); pixel *equality* (font rasterization differs — pixel-close is the bar).

## 2. Decisions of Record

1. **The README's numbers are requirements.** 212/52/352/340px, radius 5-10, `1a`/`3d` alphas,
   `0 0 8px` glow, the Agents grid template, x=88, `5 11` dash at `-32/1.15s`. The gate reads
   them back from `getComputedStyle`; a page that rounds one off fails by name.
2. **Anatomy is written once.** Cards, pills, avatar tiles and panel headers live in
   `components/ui/` and are consumed by every page. A page that re-implements one is a defect.
3. **Truth from snapshot, never from placeholders** (README "State Management"). Every figure on
   every page comes from the DB snapshot plus SSE. A page with no data shows `—` or an empty
   state, never a demo number. The one labeled exception: the seeded development workspace
   shows the README's "seeded development data" caption on Analytics.
4. **Unknown is `null`, shown as `—`** (M12 Decision 6, extended). Token counts and skill calls
   are `null` for a runtime that does not report them (Cursor), and a sum over unknowns says
   how many were unknown.
5. **Skill use is a fact of the run, recorded at its end.** The pump counts `Skill` tool calls
   it already observes and writes `skillCalls` when the run concludes. No new `RuntimeEvent`
   variant; no live counter.
6. **The catalog is read from the daemon's disk and never deletes.** `syncSkillCatalog()`
   upserts what it finds; a skill that disappears is marked `missingSince`, not removed —
   history that referenced it stays legible.
7. **What has no backend says so.** Codex/Gemini adapter cards render disabled with
   `not configured · later`; the permission matrix is editable but captioned "not yet enforced
   at runtime"; transport is a read-only `SSE`. Nothing looks functional that is not.
8. **Motion is optional and centralized.** All keyframes live in `globals.css`; under
   `prefers-reduced-motion: reduce` no element animates. Motion is never load-bearing
   (README).
9. **Evidence is committed.** The gate writes its nine screenshots into
   `docs/superpowers/fidelity/m14/`, and they are reviewed against the mockups page by page
   — by the task reviewer during the milestone and by the operator at its end.
10. **No vendor spend.** The gate runs against fake CLIs (`scripts/gate-fakes/`) and the seeded
    database; the only real run in this milestone is the one recording a `Skill` tool call as a
    parser fixture (Series B, one execution).

## 3. Series A — The Anatomy

All in `apps/web/src/components/ui/` unless noted; all values from the README's "1a — Control
Room" and "Design Tokens".

- **`AvatarTile`** — 28×28, radius 7, background status color at `1a`, border at `3d`, 11px
  mono initials (first letters of the first two words of the name). Props: `name`, `tone`.
- **`StatusPill`** — padding `3px 7px`, radius 20, 5px dot + 9.5px mono uppercase label. The
  dot pulses (1.5s ease-in-out) for in-flight tones only: `working`, `planning`,
  `pause_requested`, `resuming`, `review`. Tone → color is a lookup on the `--tone-*` tokens;
  the ten statuses map to tones in one table (`lib/tones.ts`), tested exhaustively.
- **`AgentCard`** — border 1px status color at `3d`, radius 8, bg `#0f1217`, padding `12px 13px`.
  Header: `AvatarTile`, name 13px/600, role 10.5px `#7c8697`, `StatusPill`. Task line: 10px mono
  id + 11.5px title, ellipsis. 3px `ProgressBar` with `0 0 8px` glow in the status color;
  step/percent row; chips (skill · queue · provider); footer of three ghost buttons
  Pause↔Resume / Message / Stop wired to the existing run controls (`AgentPanel`'s handlers —
  no new endpoint). A 2.2s `cubic-bezier(.4,0,.2,1)` gradient sweep across the top hairline
  while `working`. Hover: border → `rgba(255,255,255,.2)`.
- **`Panel` / `SectionLabel`** — label 9px mono uppercase `letter-spacing .09em`, optional right
  action (`all →`); panel radius 9-10, resting shadow `0 4px 16px rgba(0,0,0,.35)`, active
  `0 0 0 1px <status>14, 0 6px 22px rgba(0,0,0,.45)`.
- **`Sidebar`** (`components/Sidebar.tsx`) — 212px; nav rows carry live counts (tasks active,
  agents working); selected row bg `#151a21`; a bottom **Guardrails** block listing budget,
  concurrency, run timeout and attempts from the `Workspace` columns, 9px mono labels with
  right-aligned mono values.
- **`TopBar`** — 52px, bg `#0c0f13`, a 1px bottom gradient `transparent → rgba(46,230,207,.5) →
  rgba(123,140,255,.3) → transparent`; the connection chip becomes `sse · <ms>` using the
  age of the most recent event on arrival (`Date.now() − event.ts` — heartbeat frames are id-only
  and unobservable to `EventSource`, so arrival age is the measurable latency); the budget bar and two-step STOP keep M11's behavior
  and take the mockup's geometry. **Measured on Overview, Tasks and Graph only**: Activity streams
  through `useActivityStream`, which wraps its own `EventSource` and measures no arrival age, so
  `/activity` renders `sse · —`. A deviation on the record, not a defect — the honest reading of an
  unmeasured latency — and widening the hook is scheduled, not done.
  *(Deviation recorded 2026-08-30 — erratum 5.)*
- **Motion** — `globals.css` gains `@keyframes pulse | dash | sweep | rise | spin` exactly as the
  mockup defines them, and `@media (prefers-reduced-motion: reduce) { * { animation: none !important } }`.
  New rows in any list get `.rise` (0.3s `translateY(5px)`); M11's dropped "new-row rise"
  lands here.

Tests: each primitive renders its tokens — in vitest as class-string / inline-style / SVG-attribute
assertions (jsdom loads no CSS, so numbers derived from classes are asserted only by the Series D
Playwright gate; each task lists which is which); the tone table is exhaustive over `RunStatus`/agent status; `AgentCard` renders all
ten states in one `it.each`; reduced-motion removes every animation class.

## 4. Series B — The Data

### 4.1 Skill calls (`apps/orchestrator/src/pump.ts`, `packages/db`)

Claude Code invokes a skill as a `tool_use` named `Skill` with `input.skill` (e.g.
`superpowers:brainstorming`). The pump already receives every `tool_call` event; it keeps a
per-run `Map<string, number>` of skill names and, **when the pump's event stream ends, however it
ends** — a terminal result, a bare end, an operator's kill, or a pause — writes
`AgentRun.skillCalls Json?` as `{ [skillName]: count }`, **merged into whatever the row already
holds**. A run whose **provider** is Cursor writes `null`; the discriminator is the provider, never
the stream's contents (`runtimeReportsUsage`). Migration: one nullable column.
*(Corrected 2026-08-30 — erratum 2; the original said "when the run concludes (any terminal path
that writes `terminalAt`)" and "their parser never sees a `Skill` tool".)* Evidence: one real Claude run recorded as a fixture showing the `Skill` tool_use line
shape — the mapping is written from the recording, not from documentation (M12 discipline).

### 4.2 Tokens (`packages/providers/src/claude/stream.ts`, `packages/db`)

Claude's `result` line carries `usage.input_tokens`, `usage.output_tokens` (and cache
fields). `RunOutcome` gains `tokens: { input: number; output: number } | null`; the pump
writes `AgentRun.tokensIn Int?`, `tokensOut Int?` beside `costUsd`. Missing `usage` →
`null`, never `0`. Cursor → `null` — **by provider rule, not for want of data**: Cursor's `result`
line does report usage (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` — see
`packages/providers/test/fixtures/cursor/cursor-run.ndjson`), and it is simply unmapped in M14.
Migration: two nullable columns. *(Premise corrected 2026-08-30 — erratum 3.)*

### 4.3 The catalog (`packages/control/src/skills.ts`)

`syncSkillCatalog(roots?)` scans, in order: `~/.claude/skills/*/SKILL.md` (provider
`personal`), `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/*/SKILL.md`
(provider `plugin:<plugin>`, the highest version wins), `<repo>/.claude/skills/*/SKILL.md`
(provider `project`). Frontmatter `name`/`description` become `Skill` rows under a
`SkillProvider` row keyed by provider name; existing rows are updated, absent ones get
`Skill.missingSince` (new nullable column) set, never deleted. Runs at daemon start and via
`npm run orchestrator -- skills sync`. Assignment (`AgentSkill`) is written from the Skills
page through a control verb `assignSkill(agentId, skillId)` / `unassignSkill`.

### 4.4 Analytics (`apps/web/src/server/analytics.ts`)

One server module, one query round per section, all scoped to a workspace (or all workspaces
for the global page):

- **7-day series** — per day, `succeeded` and `failed` run counts (`terminalAt` in the day).
- **KPIs (6)** — task success rate (done / (done+failed)), average run duration
  (`endedAt − startedAt`), total spend as `sumSpend`'s `{ known, unknownRuns }`, total tool
  calls, pauses (count of `run.paused` events), active agents now.
- **Per-agent performance** — runs, success %, average duration, tokens (sum, `null`-aware),
  cost (`null`-aware). Rendered with the Agents table primitives.

Limits stated in the module: skill counts are end-of-run facts; tokens are Claude-only; the
catalog reads the daemon host's disk.

## 5. Series C — The Nine Pages

Each page is one task; each consumes Series A and, where named, Series B. Values from README §3a.

1. **Overview** (`/w/[id]`) — 6-up strip with 1px gutters (agents working · tasks active ·
   tasks ready · tasks done · blocked · spend), 3-column `AgentCard` grid (11px gap), a bottom
   row: "blocked · needs you" panel (flex 1) listing blocked tasks and `pause_requested`/paused
   runs with their action, plus a 340px live-events panel (last 8, `all →` to Activity).
   `GoalCard` gains the `waiting` caption and suggestion chips (the last three distinct goals);
   a "merge queue · serial" panel lists `merging` tasks **in the daemon's own order**: ascending by
   the latest `task_review_approved` `ExecutionEvent.seq` per task, ties broken by task id
   (`packages/domain/src/merge/queue.ts`'s `mergeQueueOrder`, shared with
   `apps/orchestrator/src/merge.ts`). A `merging` task with no approval event — which `merge.ts`
   skips — is listed last and marked, because a task stuck in the queue is what the panel is for.
   *(Corrected 2026-08-30 — erratum 1; the original said "FIFO".)* `RuntimeCard` keeps its place.
2. **Agents** (`/agents`) — `DataTable` with grid template `200px 130px 120px 1fr 110px 90px 80px`:
   `AvatarTile`+name+role · department (team name) · `StatusPill` · current task with an inline
   `ProgressBar` · provider (mark only when `capabilitiesOf(kind).gate === 'shell-only'`) ·
   tokens (`tokensIn+tokensOut`, `—` when null) · cost. Row click opens `AgentPanel`.
3. **Tasks** (`/w/[id]/tasks`) — six columns Backlog / Todo / In Progress / Review / Blocked /
   Done. Status mapping in one table (`lib/taskColumns.ts`, tested): `backlog`→Backlog;
   `ready`→Todo; `assigned, running, verifying`→In Progress; `reviewing, merging`→Review;
   `blocked`→Blocked; `done, failed, cancelled`→Done (failed/cancelled carry their own pill).
   Compact card: mono id, priority chip, title, assignee chip, step counter.
4. **Graph** (`/w/[id]/graph`) — React Flow stays. Edge renderer draws the README's cable:
   a 5px blurred halo (`feGaussianBlur stdDeviation=4`, opacity .18) in the target's status
   color, a 1.4px solid core, a 1.6px white dashed overlay `stroke-dasharray: 5 11` animated
   `stroke-dashoffset: -32` over 1.15s linear (behind reduced-motion); inactive edges 3px
   `rgba(255,255,255,.13)`, no animation. Canvas `#08090c`, 26px radial-dot grid, a soft teal
   radial wash at the top. Mode switch Organization / Execution / Dependencies. **Skill chain is a
   disabled `later` for the whole of M14** (Task 11 ruling I2: a data signal is not a view);
   `GraphAgent.hasSkillData` is the plumbing a later milestone flips, and nothing reads it today.
   *(Corrected 2026-08-30 — erratum 4; the original promised it would appear once Series B data
   exists.)* A 352px right drawer:
   selected agent header, provider/model tiles, current task + progress, checkpoint list
   (✓ / ● / ○ from `Checkpoint`), quick-instruction chips, free-text instruct (Enter sends —
   the existing message route), Pause / Reassign(`later`) / Stop, recent events.
5. **Activity** (`/w/[id]/activity`) — a vertical rule at x=88px with a teal→indigo gradient;
   rows `74px right-aligned mono timestamp · 28px dot gutter (7px dot, 0 0 9px glow) · who +
   event kind + text · ref`; type chips filter by kind prefix; payload disclosure ▸/▾ (kept);
   new rows `.rise`; a right rail of event-type volume bars (counts for the visible window).
   Clicking a roster row filters the stream and dims non-matching cards to opacity .35.
6. **Projects** (`/`) — 3-up cards: name, one-line description (the goal), `StatusPill`
   (halted / running / idle), team avatar row of `AvatarTile`s, `ProgressBar` (done / total
   tasks), 4-up stat strip (agents / active / blocked / spend with `null` awareness).
7. **Settings** (`/settings`) — Provider adapters: Claude Code and Cursor cards are real
   (binary path, `--version`, `capabilitiesOf`, connect state = binary found on PATH); Codex
   and Gemini cards render disabled `not configured · later`. Permission matrix: rows =
   agents, columns = the README's six tools, cells ✓/✕ from `AgentPermission` (read and
   written through `setAgentPermission(agentId, tool, mode)`), captioned "not yet enforced at
   runtime". Realtime transport: `SSE` selected, `WebSocket · later` disabled. Danger zone:
   the existing emergency stop, and `reset demo data` only when `NODE_ENV !== 'production'`
   (runs `db:seed`). The template catalog and company manager stay.
8. **Skills** (`/skills`) — provider list (personal / plugin:* / project) with run counts
   (sum of `skillCalls` across runs), per-skill state (`missing` when `missingSince`), usage
   bars normalized to the max; a 2-column domain-skill grid tagged by source; an "add skill
   source" dashed tile that shows the three scanned roots (no write). Assign/unassign to an
   agent from the row.
9. **Analytics** (`/analytics`) — 6 KPI tiles, the 7-day stacked bar chart (successes in the
   `working` teal `#2ee6cf`, failures in `#f87171`, per the README; drawn with the `Sparkline`
   primitive generalized to bars — no chart library), the per-agent performance table. Workspace
   selector at the top; "Last 7 days · seeded development data" caption on the seeded
   workspace.

Routes: `/skills` and `/analytics` are global (no workspace); `Sidebar` grows to nine rows in the
README's order. Every page: existing tests extended, new pages get render + DTO tests.

## 6. Series D — The Fidelity Gate

`scripts/gate-m14-fidelity.mjs` (skeleton: `gate-m11-shell.mjs` — `next dev` + Playwright on the
seeded database; fake CLIs from `scripts/gate-fakes/` for the behavior stages). Stages:

1. **Nine pages render** at 1440×900 with their structural `data-testid`s; a screenshot of
   each is written to `docs/superpowers/fidelity/m14/<page>.png` and committed.
2. **Numbers** — asserted from `getComputedStyle`: sidebar 212, topbar 52, card radius 8 and
   padding 12/13, avatar 28, Agents grid-template-columns string, Activity rule at 88, drawer
   352, cable `stroke-dasharray 5 11`, pill radius 20. Any deviation fails with page+property.
3. **Motion** — under emulated `prefers-reduced-motion: reduce` no element has an
   `animation-name` other than `none`; normally the `working` card has the sweep and an
   in-flight pill pulses.
4. **Behavior** — two-step STOP → halt banner on every page → clear halt; a fake-CLI run
   reaches `working`, pause shows `pause_requested` then `paused` (truth from snapshot);
   roster click filters the stream and dims cards.
5. **Data** — after `syncSkillCatalog`, Skills lists at least one `plugin:superpowers`
   provider; Analytics' 7-day counts equal an independent SQL count.

PASS line: `nine pages, one design`. Spend: none.

**Human acceptance.** The gate measures conformance, not taste. Each Series C task's reviewer
reads the page screenshot beside the mockup; at the milestone's end the nine screenshots are
presented to the operator on one page for a per-page accept/fix verdict, and the final
review's fix wave takes the fixes.

## 7. Testing

- **Primitives** — class/inline-style assertions in vitest, computed numbers in the Playwright gate;
  exhaustive tone/column tables; reduced-motion.
- **Data** — parser fixture for the `Skill` tool_use line and for `usage`; pump writes
  `skillCalls`/tokens on every terminal path (integration, real DB); `syncSkillCatalog`
  against a temp directory tree (upsert, `missingSince`, version precedence); analytics
  aggregation against seeded rows with `null` costs mixed in.
- **Pages** — render tests through the existing harness; DTO tests for every new server
  module; route tests for `setAgentPermission`, `assignSkill`.
- **Gate** — every task's gate is `npm test && npm run typecheck && npm run web:build`, run
  with the dev server stopped (build and dev share `.next`).

## 8. Milestone Gate

`npm run gate:m14-fidelity` (§6) plus the per-task triple. The gate needs the seeded database
and Playwright's Chromium; it spends nothing and never skips a page.

## 9. Errata (post-execution)

Recorded 2026-08-30, from the final whole-branch review of M14
(`.superpowers/sdd/2026-08-29-m14-design-fidelity/final-review.md`) and applied in the fix wave of
the same date. Each is corrected **in place** above as well as listed here, so a reader who lands
mid-document is not misled and a reader who wants the diff can find it in one place. The rule this
milestone was written to enforce applies to its own spec: a claim nobody verified is a claim that
will be relied on.

1. **§5.1 — the merge queue is not FIFO.** The spec said the `merge queue · serial` panel lists
   `merging` tasks FIFO. It lists them in the daemon's own order: ascending by the latest
   `task_review_approved` `ExecutionEvent.seq` per task, ties broken by task id
   (`packages/domain/src/merge/queue.ts`'s `mergeQueueOrder`, shared by `apps/orchestrator/src/merge.ts`
   and `apps/web/src/server/overview.ts`, so the panel and the daemon cannot drift by construction).
   A `merging` task with no approval event is listed last and marked. For the record: this sends a
   re-approved rework task to the BACK of the queue, which is what the daemon does and what a narrow
   reading of the README's "FIFO by approval time" would not predict.

2. **§4.1 — `skillCalls` is a fact of the STREAM, not of a terminal status write.** The spec said
   the tally is written "when the run concludes (any terminal path that writes `terminalAt`)". It
   is written when the pump's event stream ends, however it ends — a terminal result, a bare end,
   an operator's kill, or a pause — and merged into whatever the row already holds, never replacing
   it (Task 4 ruling I1+I2). `control/stop.ts` concludes the row from another call path and
   normally wins the race, so a terminal-status hook would have lost the tally exactly when an
   operator stopped a run. The merge is also what makes a pause→resume total add up.
   Second correction in the same section: "Cursor runs write `null` (their parser never sees a
   `Skill` tool)" states a reason that is not the rule. A run whose **provider** is Cursor writes
   `null`; the discriminator is the provider, never the stream's contents (`runtimeReportsUsage`).

3. **§4.2 — "Cursor → `null`" is right, its premise is wrong.** The rule stands and did not change
   in M14. But Cursor's `result` line DOES report usage, in camelCase:
   `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` — the same four counters the
   Claude billed-input rule sums. The repository's own recording proves it:
   `packages/providers/test/fixtures/cursor/cursor-run.ndjson`'s result line carries
   `"usage":{"inputTokens":15391,"outputTokens":223,"cacheReadTokens":25856,"cacheWriteTokens":0}`.
   `RunOutcome.tokens` is `null` for Cursor **by provider rule, not for want of data**; the four
   fields are unmapped in M14. The comment in `packages/providers/src/cursor/stream.ts` that denied
   the data exists was corrected in the same fix wave (review I6) — it had contradicted the same
   file's own docstring since M12.

4. **§5.4 — Skill chain does not appear this milestone.** The spec said the fourth graph mode
   "appears once Series B data exists; otherwise a disabled `later`". It is a disabled `later` for
   the whole of M14 (Task 11 ruling I2: a data signal is not a view — having the data does not mean
   having designed the view). `GraphAgent.hasSkillData` (`apps/web/src/server/graph.ts`) is the
   plumbing a later milestone flips; nothing reads it today, and that is deliberate and tested.

5. **§3 — the `sse · <ms>` chip is not measured on all nine pages.** It is measured on Overview,
   Tasks and Graph, whose page-owned hooks time an event's arrival age. Activity streams through
   `useActivityStream`, which wraps its own `EventSource` and measures nothing, so `/activity`
   renders `sse · —`. That is the honest reading of an unmeasured latency and is left as-is;
   widening the hook is a scheduled follow-up, recorded here rather than silently deviated from.

6. **Plan errata** (`docs/superpowers/plans/2026-08-29-m14-design-fidelity.md`) — annotated in the
   plan itself, listed here so the pair stays findable: Task 8's reference code reads a dead
   `Approval` table via `decidedAt` (≈lines 4147-4148, 4189-4194, 4247) and instructs adding
   `"Approval"` to a TRUNCATE list (≈lines 1546-1547). The Task 8 NEEDS_CONTEXT ruling replaced all
   of it with the `task_review_approved` seq rule (erratum 1 above), so none of that reference code
   describes what was built. Separately, Task 2's Step 4 names `ui-components.test.tsx` as being in
   its Files block, where it is not.
