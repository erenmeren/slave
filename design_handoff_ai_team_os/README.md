# Handoff: AI Team OS — control surface (1a, 1b, 1c, 2a, 3a)

## Overview
Design references for the operator-facing web UI of **AI Team OS**: an orchestration system that runs a
software team of real Claude Code CLI agents. The operator writes one goal sentence; the system plans
(manager agent emits a task graph), works (developer agents in isolated git worktrees), verifies (verify
commands), reviews (independent QA agent judges the diff), and merges (serialized queue, rebase +
re-verify) onto `main`.

These five directions explore how an operator watches and steers that from a browser.

## About the Design Files
The files in `mockups/` are **design references written in HTML**, not production code. They are
prototypes showing intended look, density, motion and behavior. The task is to **recreate them in the
target codebase** (the real product is a Next.js app under `apps/web`) using its existing patterns,
component library and data layer — not to copy this HTML.

Everything in the mocks is driven by fake in-memory state on timers. In the real app the same values
come from Postgres snapshots + the append-only `ExecutionEvent` log, streamed over SSE.

Open a file: `mockups/AI Team OS Mockups.dc.html` (all five options on one canvas — scroll/pan) and
`mockups/AI Team OS Web.dc.html`. `support.js` must sit next to them. They are plain HTML — no build.

## Fidelity
**High fidelity.** Final colors, type, spacing, motion and interaction states. Recreate pixel-close,
substituting the codebase's own primitives where they exist. The one exception is `2a` (the 3D floor),
which is a **visual concept** — the layout algorithm and physicality are illustrative, not spec.

---

## Screens / Views

### 1a — Control Room (dense agent grid)
- **Purpose:** answer "who is working, who needs me" in one glance.
- **Layout:** 212px sidebar / fluid main. Main = 52px top bar, a 6-up summary strip (1px gutters, hairline
  background showing through), then a 3-column agent card grid (11px gap), then a bottom row: "blocked ·
  needs you" panel (flex 1) + 340px live-events panel.
- **Agent card:** 1px border in the status color at 24% alpha, radius 8px, bg `#0f1217`, padding 12px 13px.
  Header = 28px rounded-7px avatar tile (status color at 10% bg, 24% border, 11px mono initials), name
  13px/600, role 10.5px `#7c8697`, status pill (3px 7px, radius 20px, 5px dot + 9.5px mono label).
  Then task line (`10px mono id` + 11.5px title, ellipsis), 3px progress bar with `0 0 8px` glow in the
  status color, step/percent row, skill/queue/provider chips, and a 3-button footer (Pause/Resume,
  Message, Stop).
- **States:** working / planning / waiting / review / paused / pause_requested / resuming / blocked /
  idle / completed — see Design Tokens.

### 1b — Live Wiring (the graph is the product)
- **Purpose:** see how work flows between agents; select a node and steer it.
- **Layout:** 52px top bar with a 5-way mode switch, fluid canvas, 352px right drawer.
- **Canvas:** `#08090c` with a 26px radial-dot grid and a soft teal radial wash at the top. Nodes are
  absolutely positioned in an 924×570 coordinate space; edges are SVG cubic béziers drawn under them in a
  `viewBox="0 0 924 570"` overlay with `preserveAspectRatio="xMidYMin meet"`.
- **Cables (signature element):** each edge draws three stacked paths — a 5px blurred halo
  (`feGaussianBlur stdDeviation=4`, opacity .18) in the target's status color, a 1.4px solid core, and a
  1.6px white dashed overlay `stroke-dasharray: 5 11` animated `stroke-dashoffset: -32` over 1.15s linear
  infinite. Inactive edges: 3px, `rgba(255,255,255,.13)`, no animation.
- **Modes:** Organization (workspace → leads → agents → QA gate), Execution (pipeline stages),
  Dependencies (task DAG), Skill chain (skills of one task). Each is its own node/edge set.
- **Drawer:** selected agent header, provider/model tiles, current task + progress, checkpoint list
  (✓ / ● / ○), skill chain, quick-instruction chips, free-text instruct box (Enter sends; the message is
  recorded as an event), Pause/Reassign/Stop, recent events.

### 1c — Signal (stream-first console)
- **Purpose:** a keyboard-driven operations console where the event river is the main object.
- **Layout:** 56px top bar with a centered 440px command bar (`⌘K`) and a live/paused stream toggle;
  then 290px roster / fluid stream / 330px board.
- **Stream:** a vertical rule at x=88px with a teal→indigo gradient; each row is `74px right-aligned mono
  timestamp · 28px dot gutter (7px dot, 0 0 9px glow) · who + event kind + text · ref`. Type chips filter
  by `kind` prefix. Bottom composer prefixed with the current target agent.
- **Roster:** click a row to filter the stream and dim non-matching board cards (opacity .35).
- **Board:** compact grouped list (In Progress / Review / Blocked / Done), not full kanban columns.

### 2a — The Floor (3D live office) — *visual concept*
- **Purpose:** an ambient "watch the office" view: agents at desks, talking, passing work.
- **Technique:** CSS 3D. A `perspective: 1500px` wrapper holds a 900×580 `transform-style: preserve-3d`
  plane transformed `rotateX(tilt) rotateZ(yaw) scale(zoom)`; tilt 38–70° (default 56), yaw slider 0–70°
  (default 30), zoom 0.6–1.15.
- **Floor:** inset −40px slab, radius 22px, `linear-gradient(155deg,#0e1319,#0a0d12)`, 45px grid lines at
  2.8% white, `0 40px 90px rgba(0,0,0,.7)`. Rooms are dashed 1px rectangles with 5% tints
  (Engineering teal, Command indigo, Security violet, QA amber, Product neutral); room labels are
  counter-rotated `rotateZ(-yaw)` so they stay readable.
- **Desks:** 124×68 slabs. Above each, a **billboarded** group (`rotateZ(-yaw) rotateX(-tilt)`) holds the
  speech bubble, a 150px "screen" card (status + task + skill, glowing 1px border and inset glow), and a
  floating name chip (20px avatar, name, role, a green "listening" dot).
- **Comm beams:** absolutely positioned 2–3px bars rotated `atan2(dy,dx)` between desk centers,
  `repeating-linear-gradient(90deg,transparent 0 14px,color 14px 26px)` animated by background-position
  (0.55s when hot, 1.6s otherwise), plus a blurred halo underlay. The currently speaking pair is white and
  fully opaque.
- **Right rail:** selected agent, floor chatter transcript (agent→agent lines with kind tags), channel
  volume bars, and a "say" composer.
- **Note for implementation:** if a real 3D scene is wanted later, this maps cleanly onto a fixed
  isometric camera in three.js; the CSS version is intentionally cheap and DOM-editable.

### 3a — The nine-page shell (the actual IA)
One sidebar-driven shell; the routes are the product's real IA. **This is the structural reference.**
1. **Overview** — 6-up status strip + agent cards (from 1a).
2. **Agents** — table: agent (avatar+name+role) · department · status pill · current task with inline
   progress bar · provider · tokens · cost. Grid template
   `200px 130px 120px 1fr 110px 90px 80px`.
3. **Tasks** — six columns (Backlog / Todo / In Progress / Review / Blocked / Done), compact cards with
   task id, priority, title, assignee chip and step counter.
4. **Graph** — the 1b canvas embedded as a route.
5. **Activity** — the 1c timeline + a right rail of event-type volumes.
6. **Projects** — 3 cards: name, one-line description, status pill, team avatar row, progress bar, and a
   4-up stat strip (agents / active / blocked / spend).
7. **Skills** — Superpowers provider list (run counts, per-skill state, usage bars) + a 2-column domain
   skill grid tagged by source (git / local / built-in) + an "add skill source" dashed tile.
8. **Analytics** — 6 KPI tiles, a 7-day stacked bar chart (success teal, failures red), and an agent
   performance table.
9. **Settings** — provider adapters (Claude Code, Cursor, Codex, Gemini) with connect/configure, an agent
   permission matrix (✓/✕ chips), realtime transport choice (SSE selected, WebSocket "later"), and a
   danger zone (stop all / reset demo data).

### Bonus — `AI Team OS Web.dc.html`
A **fully working redesign of the current shipping UI** (the one in `nasil-calisir.pdf`), true to the real
domain: goal form → planning run → task columns `RUNNING / VERIFYING / REVIEWING / MERGING / READY /
DONE` → append-only activity log with expandable JSON payloads → org/dependency graph, plus the budget
bar, SSE latency chip, two-step **STOP** → red halt banner → **clear halt**. Its simulated state machine
mirrors the daemon's pass order and is the best single reference for *behavior*.

---

## Interactions & Behavior
- **Pause/resume is never instant.** `working → pause_requested` ("draining current step") → after ~1.3s
  `paused` with a "checkpoint created" event. Resume: `paused → resuming` → after ~0.9s `working`. Every
  transition writes an event.
- **Emergency stop is two-step.** STOP replaces itself in place with `stop everything` / `cancel`.
  Confirming sets a halt banner on every page, stops scheduling and marks active runs `pausing`.
  `clear halt` releases scheduling and resumes paused runs.
- **The pipeline advances on a tick** (1s in the mock, ~1s in the daemon). Order: schedule → resume →
  plan → review → merge → guardrail sweep. Never advance two stages in one tick.
- **Merge is serialized:** at most one task in `merging` at a time, FIFO by approval time; rebase onto
  `main` → re-verify → `--no-ff` merge commit keyed by task.
- **Event rows disclose payload** on click (`▸ PAYLOAD` → `▾`), showing the raw JSON.
- **Filtering:** clicking a roster row / agent card filters the stream and dims unrelated board cards.
  Type chips filter by event-kind prefix.
- **Motion:** status dots pulse 1.5s ease-in-out (only for in-flight states); cables 1.0–1.15s linear
  dash; new rows enter with a 0.3s `translateY(5px)` rise; progress bars transition `width .5s ease`;
  the agent-card "activity sweep" is a 2.2s `cubic-bezier(.4,0,.2,1)` gradient across the top hairline.
  Respect `prefers-reduced-motion` in the real implementation — none of this is load-bearing.
- **Hover:** borders go to `rgba(255,255,255,.2–.28)`; ghost buttons brighten text to `#fff`; primary
  status buttons use `filter: brightness(1.35)`.

## State Management
Per workspace: `goal`, `phase` (empty | planning | running | finished), `halted`, `spend`, `tasks[]`
(`key, title, deps[], status, pct, attempts, agent, note`), `agents{}` (`name, role, status, pct, turns,
worktree`), `events[]` (append-only, newest first, capped in the UI). UI-only: `page`, `selectedId`,
`filter`, `graphMode`, `openEvent`, `draft`, and 2a's `yaw / zoom / beams`.

Real app: hydrate from a DB snapshot, then apply SSE events. Never render optimistically — the mocks
deliberately show truth-from-snapshot (a paused agent shows `pausing` until the run actually confirms).

## Design Tokens
**Surfaces** — page `#0a0c0f` (1c `#0a0b0e`, graph canvas `#08090c`, floor `#07080b`), panel `#0c0f13`,
card `#0f1217` / `#0f1116`, selected `#151a21`.
**Hairlines** — `rgba(255,255,255,.07)` structural, `.05` inner rows, `.08–.12` card borders.
**Status** — working `#2ee6cf` · planning/context `#7b8cff` · review `#c084fc` · waiting/merging `#f5b34a`
· blocked/failed `#f87171` · done `#4ade80` · paused `#8a929e` · idle `#5b6472`.
Pattern: status color at `1a` alpha for fills, `3d` for borders, `0 0 8px` for bar glow.
**Text** — primary `#e7eaf0`, strong `#f2f5f9`, body `#c8cfda`, secondary `#a8b0bd`, muted `#8a929e`,
dim `#7c8697`, faint `#69727f`, label `#5b6472`, ghost `#3f4650`.
**Type** — UI: IBM Plex Sans 400/500/600 — 9.5/10.5/11.5/12.5/13/14.5px, headings `letter-spacing:-.2px`.
Data/labels: IBM Plex Mono 400/500/600 — 8.5/9/9.5/10/10.5/11px; section labels 9px, `letter-spacing:.09em`,
uppercase. Big numerals: mono 600, 20–24px, `letter-spacing:-1px`.
**Radius** — 5 (chip/button) · 6 (nav/small) · 7 (input/tile) · 8 (card) · 9–10 (panel) · 20px (pill).
**Spacing** — 1px gutters for stat strips; 8/10/11/12px card padding; 14–20px section padding; 11–16px grid gaps.
**Shadow** — `0 4px 16px rgba(0,0,0,.35)` resting, `0 0 0 1px <status>14, 0 6px 22px rgba(0,0,0,.45)` active,
`0 40px 90px rgba(0,0,0,.7)` floor.

## Assets
None. No images, no icon font — every glyph is text (`✓ ✕ ● ○ ▸ ▾ ⇄ →`) or a CSS shape. Fonts: IBM Plex
Sans + IBM Plex Mono (Google Fonts). Swap for the codebase's own font stack if it has one.

## Files
```
mockups/AI Team OS Mockups.dc.html   1a, 1b, 1c (turn 1) · 2a (turn 2) · 3a (turn 3), one canvas
mockups/AI Team OS Web.dc.html       redesign of the current shipping UI, behavior reference
mockups/support.js                   runtime required by both files (keep alongside)
```
Each design is a single self-contained file: markup with inline styles, plus one `Component` class holding
the simulated state machine. Read the class first — it documents the intended transitions.
