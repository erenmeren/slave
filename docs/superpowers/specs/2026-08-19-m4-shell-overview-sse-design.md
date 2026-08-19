# M4: App Shell, Overview, and SSE — Design

**Date:** 2026-08-19
**Status:** Approved for planning
**Parent:** `2026-08-17-ai-team-os-design.md` §3, §6.3, §12, §13 (M4 row)
**Depends on:** M2 (event log, LISTEN/NOTIFY, `createEventStream`), M3 (orchestrator producing real
events), ADR 0002 (derived agent status), ADR 0003 (single write gate), ADR 0004 (command boundary)

---

## 1. What M4 Is

The first screen: `apps/web` is born. An operator opens a browser and watches a real agent do real
work, live — the parent spec's verification criterion in one sentence. M4 is **read-only**: the web
app reads the database and streams events; it mutates nothing and commands nothing. The command
surface (pause/resume/stop/message from the UI) is M5's milestone, deliberately.

Scope, decided during brainstorming:

- **App shell** — sidebar, top bar, visual language, design tokens.
- **Overview page** — top strip (agent status counts, task counts, budget gauge) and agent cards
  with a **live action line** (the §12.3 signature element: `Write note3.txt` → `Bash npm test`).
  Action buttons are rendered but disabled, labeled for M5 — the card's final shape exists, its
  wiring does not.
- **SSE** — the §6.3 transport realized as a web route over M2's `createEventStream`.
- **Demo script** — one command that makes the milestone verification repeatable.

Out of M4 (parent spec page map, deferred): Tasks board, Agent detail panel, Activity timeline,
Graph, ⌘K palette, activity sparkline, any write path.

---

## 2. Package Layout and the Dependency Rule

```
apps/
  web/            Next.js App Router, TypeScript, Tailwind v4, Node runtime
  orchestrator/   (unchanged)
```

`apps/web` may import `packages/db` (Prisma reads only), `packages/domain` (types,
`deriveAgentStatus`), and `packages/events` (`createEventStream`). It may **never** import
`apps/orchestrator` or `packages/providers` — apps do not import apps, and anything both need
belongs in a package. Nothing needs to move today: everything the web needs already lives in
packages, which is M2 and M3's layering paying out.

**The single-writer rule survives M4 untouched.** The web app performs zero INSERTs and zero
UPDATEs — not even "harmless" ones like a viewed-at timestamp. The read-only property is enforced
by review and by the absence of any write call site, not by a second database role; a dedicated
read-only connection string is a deliberate simplification (§12).

Next.js runs on the **Node runtime** (not edge): Prisma and `pg` LISTEN/NOTIFY require it.

---

## 3. Routing

- `/` — resolves the workspace the same way the CLI does: exactly one workspace → redirect to
  `/w/<id>`; several → a minimal picker list; none → "seed one first". Guessing which workspace an
  operator is looking at is the same mistake `resolveWorkspace` refuses in the CLI, so the answer
  is always in the URL.
- `/w/[workspaceId]` — the Overview.
- `/api/w/[workspaceId]/events` — SSE.
- `/api/w/[workspaceId]/overview` — snapshot JSON.

---

## 4. The Realtime Plane: SSE Route

`GET /api/w/[workspaceId]/events`, a thin shell around M2's `createEventStream`:

- **Resume point:** `Last-Event-ID` header (or `?from=<seq>`) → `fromSeq`. Absent → start from the
  current max `seq` ("from now"). `EventSource` sets the header automatically on reconnect, which
  is the §6.3 replay contract working as designed.
- **Message shape:** one SSE message per event — `id: <seq>`, `data: <envelope JSON>`.
- **Workspace filter in the route:** `createEventStream` is global. Events for other workspaces are
  not written to the response, but the connection's *id watermark still advances past them*: the
  next keeper — or, on a filtered span with no keeper, the heartbeat — carries the last **seen**
  seq, not the last written one, so a reconnect never replays a span the route already filtered. A
  watermark that lags on filtered spans would re-deliver them on every reconnect forever.
- **Heartbeat:** every 15 seconds, an `id: <last seen seq>` message with no `data` field. Per the
  SSE spec such a block updates the client's last event ID **without dispatching an event**, which
  makes the heartbeat do double duty: proxies do not reap the idle connection, the client can
  distinguish "quiet" from "dead", and the watermark advances across filtered spans.
- **`onEvent` never throws** — `createEventStream`'s documented contract (a thrown `onEvent` skips
  the event permanently). A failed `res.write` is caught and closes the connection instead: the
  client reconnects with `Last-Event-ID` and replays the gap. The stream handle is closed when the
  request aborts, so an abandoned tab does not leak a LISTEN connection.

---

## 5. The Snapshot Read Model

`GET /api/w/[workspaceId]/overview` returns one JSON document, assembled from Prisma reads:

- **Workspace:** name, `haltedReason` + `haltedAt` (or null), `budgetUsd`.
- **Budget spent:** sum of every run's `costUsd` regardless of status — `loadWorld`'s rule (money
  is spent whether or not the run is still going), duplicated in meaning but not in code path;
  both sides read the same rows the same way.
- **Agents:** for each agent — name, role, provider id, `deriveAgentStatus(activeRun)` computed
  with the **domain function** (ADR 0002; the UI never re-derives status), the active task's title,
  and the initial action line: the latest `run.tool_call` event for the agent's active run, so a
  card is never blank while waiting for the next live event.
- **Task counts:** active (`ready/running/verifying/rework`) and `blocked`, plus `done/failed`
  totals for the strip.

Status derivation happens **only here, server-side, with domain code**. The client renders what it
is told.

---

## 6. Client Data Flow: the Hybrid Rule

Approach C from brainstorming, and the design's one load-bearing idea:

- **Structural state** (statuses, counts, budget, halt, task titles) always comes from the
  snapshot. The SSE stream is a **wake-up, not a delivery** — M2's rule extended to the UI. Any
  received event schedules a snapshot refetch behind a 250ms debounce, so an event burst (a chatty
  run) costs one query, not one per event.
- **The action line is the one exception:** display-only ephemera. A `run.tool_call` event updates
  the matching card's action line immediately from the payload. If it is ever wrong — stale,
  duplicated, out of order — the next refetch overwrites it; it cannot corrupt state because it
  *is not* state.

Why this split: a client that folds events into state re-implements the domain's derivations
(second source of truth) and inherits every replay hazard — including M3's measured carry that one
pause emits **several `run.paused` events** (the real CLI retries a denied tool call; see the
2026-08-19 gate spike). Under the hybrid rule that carry is absorbed by construction: repeats and
reordering are harmless to a consumer whose state is always a fresh snapshot.

The hook (`useOverview(workspaceId)`) exposes `{ snapshot, actionLines, connection }` where
`connection` is `connected | reconnecting`, surfaced in the top bar.

---

## 7. UI: Shell, Tokens, Overview

Parent spec §12: Mission Control — dark, dense, instrument-like; **status colours are the only
saturation on screen**; every movement carries information. M4 ships dark-only.

- **Shell:** narrow left sidebar — Overview active; Tasks / Activity / Graph visible but disabled
  (the roadmap rendered as chrome). Top bar: workspace name, SSE connection indicator, budget
  gauge. When `haltedReason` is set, a full-width red halt banner under the top bar shows the
  reason verbatim and notes that `clear-halt` is a CLI action (no button in M4).
- **Tokens:** Tailwind v4 with CSS custom properties — layered neutral backgrounds (`--bg-0..2`),
  1px hairlines, no shadows, no gradients. Sans (Inter) for chrome; mono (JetBrains Mono) for
  identifiers, logs, and the action line. Status palette: `working` green, `starting/resuming`
  cyan, `pausing/paused` blue, `stopping` orange, `idle` neutral; halt/failed red. Everything else
  is greyscale.
- **Motion:** the status dot pulses only while `working`; the action line cross-fades on change.
  Nothing else moves.
- **Top strip:** agent counts grouped from derived status (working / paused / idle), active and
  blocked task counts, budget bar (`spent / budgetUsd`; amber past 80%, red past 100%).
- **Agent cards (grid):** name + role, status dot + label, current task title (or "idle"),
  provider badge, live action line (mono), disabled pause/stop icons with an "arrives in M5"
  tooltip. The card border takes the status colour on change.

The visual pass during implementation uses the `frontend-design` skill (§12.5's assignment); the
rules above are the binding constraints it works within.

---

## 8. The Demo Script

`npm run demo` packages what M3's live gate did by hand:

1. Creates (or resets) a real fixture git repository at `~/.aiteamos/demo-repo`.
2. Seeds the dev database with a demo workspace pointing at that repository — real
   `verifyCommands`, real `setupCommands` — plus a team, agents, and a few `ready` tasks whose
   descriptions force several tool calls each (so the action line visibly streams).
3. Starts the orchestrator daemon and prints the web URL.

It uses the real `claude` by default and honours `AITEAMOS_CLAUDE_BIN`/`AITEAMOS_CLAUDE_ARGS`, so
the same script is a zero-cost smoke test against the fake. The demo seed is separate from
`db:seed` (which stays a pure-data UI-filler with a fake repoPath); a seed that mutates the
filesystem must be the thing you asked for, never a side effect of the generic one.

---

## 9. Error Taxonomy

§13 of the M3 spec applies: no failure is silent.

- **SSE drops:** `EventSource` auto-reconnects with `Last-Event-ID`; the route replays the gap.
  The top bar shows "reconnecting". Structural state self-heals on the next refetch regardless.
- **Snapshot fails (DB unreachable):** the route returns 500 with a reason; the UI keeps the last
  snapshot, dims it, and shows an error band — never a blank screen, never a spinner over nothing.
- **Orchestrator down:** the web keeps serving (separate process). Events stop and data goes
  stale; M4 does not detect this specifically — the connection indicator covers the web's own
  plane only. Detecting a dead daemon is deferred (§12).
- **Malformed event payload:** the route streams envelopes as stored; the client's card reducer
  ignores payload shapes it does not recognize (the action line simply does not update). Repeated
  or out-of-order events are harmless under §6's hybrid rule.

---

## 10. Testing

The house style: integration-first against real infrastructure, mutation-measured afterwards.

- **Route integration tests (real DB, real NOTIFY):** an appended event reaches an open SSE
  connection within a second; `Last-Event-ID` replays a gap without loss or duplication; another
  workspace's events never appear but do advance the watermark; heartbeats arrive; the snapshot
  reports derived statuses, budget arithmetic, halt reason, and initial action lines correctly.
- **Component tests (Vitest + Testing Library):** strip counts group by derived status; card
  renders each status; halt banner appears with the reason; action buttons are disabled; action
  line updates on a `run.tool_call` and survives an unrecognized payload.
- **No Playwright in M4.** Live verification is the demo script plus eyes; browser E2E arrives
  with M5's intervention surface, where clicking things is the milestone.

---

## 11. Milestone Gate

M4 is done when:

1. `npm run demo` brings up daemon + web against a real repository.
2. The Overview shows the seeded agents; a tick starts a real run; the card flips to `working`
   live, its action line streams real tool calls, and the top strip's counts and budget move.
3. Killing the SSE connection (network blip, server restart) recovers without a refresh.
4. A workspace halt shows its banner with the reason.
5. Route and component tests pass in CI against the fake `claude` and the test database.

Steps 1–2 are run once by hand against the real CLI and the captures recorded under
`docs/superpowers/spikes/`, mirroring M3's gate discipline.

---

## 12. Deliberate Simplifications

1. **Read-only enforcement is structural, not mechanical.** No separate read-only DB role for the
   web; the single-writer rule is upheld by there being no write call sites. Revisit at M5 when
   the web gains a command surface.
2. **No dead-daemon detection.** Stale data with a healthy SSE connection is indistinguishable
   from a quiet system in M4. M5's intervention surface will need liveness and owns it.
3. **Dark theme only.** The identity is dark; a light theme is undesigned, not just unbuilt.
4. **No pagination or virtualization.** Seed-scale data (one workspace, ~8 agents) needs none.
5. **The action line shows the latest tool call only** — no scrollback, no log stream. Agent
   detail (M5) owns the full stream.
6. **`run.output` truncation carry (M3 §17.3) stands:** the event log is not a full transcript,
   so neither is anything M4 renders.
