# M18 — Skill Chain & Teeth: The Last Surface, and a Matrix That Bites

**Status:** Approved (scope, both-views decision, gate-script enforcement mechanism, and Approach A all settled in conversation 2026-08-31; user waived further design questions and pre-approved spec/plan — subagent-driven execution)
**Approach:** A — Series A "teeth" first (enforcement → deniedToolUseIds reader → sse·ms chip → mini debts), Series B flagship (Skill-chain view), zero-spend gate.

## 1. Why this milestone

M17 left the floor solid; M18 finishes the two things that make the product honest. The Graph's
fourth tab ("Skill chain") has existed since M14 with no view behind it — the last
designed-but-unbuilt surface. And the Settings permission matrix is decorative: an operator can
set `deny` on a tool and nothing anywhere refuses it. M18 gives the matrix teeth through the
gate-hook infrastructure both providers already run on every tool call, makes the denial trail
readable (the `deniedToolUseIds` field M15 started writing finally gets its reader), fixes the
Activity chip that reads `—`, and sweeps three M17 leftovers.

**Non-goals:** no auth story (localhost-only posture unchanged); no live mid-run permission
resync (snapshot at start/resume, stated limitation); no Skills-page redesign; no per-command
granularity (enforcement is at the matrix's tool level, `PERMISSION_TOOLS`); no new
dependencies; no schema changes beyond, at most, one additive `EventType` enum value for the
denial trail — and only if the existing event vocabulary genuinely has no fitting type (the
implementing task inventories the enum first). The `AgentPermission` table already exists;
Series B's skill data comes from `ExecutionEvent` as-is.

**Branch:** `feature/m18-skill-and-teeth`. Binding rules carry over: one vitest run at a time,
daemon down during tests, apps/web tasks gate on `npm run web:build`, flake bar (a retry that
goes green is never evidence), and M17's lesson — trace every new field/file/flag to its
consumer before calling a task done.

## 2. Series A1 — permission enforcement through the gates

**Mechanism (user decision):** extend the existing gate scripts. Both providers already run a
hook on every tool call (Claude: `PreToolUse` → `scripts/pause-gate.sh`; Cursor: matcher-less
`preToolUse` + `beforeShellExecution` → `scripts/cursor-shell-gate.sh`), both source
`scripts/lib/pause-flag.sh`. The same rails carry permissions:

- **The permissions file.** At dispatch (and at resume), the orchestrator writes
  `permissions.json` into the run's `runDir` beside `pause.flag`:
  `{"deny": ["Shell", "Write"]}` — the deny list only. Unset and allow both pass
  (default-allow, the matrix's own "unset is not deny" doctrine — the file never lists them).
  An agent with no deny rows gets `{"deny": []}` written anyway, so the gate never guesses
  from a missing file. Snapshot semantics: written once per start/resume; a matrix edit does
  not affect runs already in flight (stated limitation, documented in the matrix UI copy).
- **Plumbing.** `runFilePaths` (or a sibling) names the path; `buildChildEnv` gains
  `AITEAMOS_PERMISSIONS_FILE` beside `AITEAMOS_PAUSE_FLAG`. A new shared shell helper
  (`scripts/lib/permissions.sh`, sourced by both gates the way `pause-flag.sh` is) reads the
  file and answers "is this tool denied". Single-sourced; the census (§6 of M17) grows a row.
- **Gate behaviour.** The gate extracts the tool name from the hook payload (Claude:
  `tool_name`; Cursor: the payload shape Task 9/M13 measured — the implementing task reads the
  fixtures). If the tool is on the deny list, the gate answers with each vendor's deny shape
  and a reason naming the matrix: `permission matrix denies <tool> for this agent`. **Order:**
  the pause check stays first — a paused run's deny message must not change.
- **A permission deny does NOT stop the run.** This is the delicate half. The pause deny is a
  stop-intent the pump reads as "the gate stopped this run"; a permission deny is a per-call
  refusal the agent is expected to route around. The stream/pump must distinguish them: the
  deny reason is the discriminator (the parser maps a matrix-reasoned deny to a new
  non-terminal event, `run.tool_denied`, payload `{ tool, reason: 'permission' }`, appended to
  the run's event trail and visible in Activity) and never to the paused/stopped path. The
  implementing tasks measure the actual stream shapes against fixtures before wiring —
  M12/M13's fixture discipline.
- **Tool vocabulary.** The matrix's column set is `PERMISSION_TOOLS` (settings.ts) — that
  constant is the single source; the mapping from vendor tool names to matrix tools lives in
  ONE place per provider (the task inventories actual tool names from existing fixtures; e.g.
  Claude `Bash` ↔ matrix `Shell` if the columns say so — the code follows the constant, this
  spec does not restate the list).
- **Matrix UI:** one copy change only — the section's descriptive line says denials are
  enforced at dispatch snapshot, plus the existing cells unchanged.
- **Proof:** unit tests on the shell helper (both gates × allow/deny/unset/malformed-file);
  integration: a fake-claude run with a seeded deny row → the gate refuses the tool, the run
  CONTINUES and concludes normally, `run.tool_denied` appears exactly once per refused call.

## 3. Series A2 — the deniedToolUseIds reader

`Checkpoint.deniedToolUseIds` (populated since M15 for Cursor pause denials) finally gets read.
**Scope guard:** this field records tool uses denied during a PAUSE window; it is a different
trail from §2's permission denials (`run.tool_denied` events). The reader shows the checkpoint
field; permission denials are already visible in Activity via their event. Do not conflate.

- Where: wherever the paused run's checkpoint renders today (the implementing task locates the
  real surface — AgentPanel / task board panel — and reports it; the mockup's drawer checkpoint
  list is the aesthetic reference).
- What: a "denied during pause" line listing the denied tool uses. The ids are opaque
  `toolUseId`s; the reader joins them against the run's `run.tool_call` events to show human
  summaries where a match exists, and falls back to a count + truncated ids where not.
- Empty case: field `[]` or absent → the line does not render at all (no "0 denied" noise).

## 4. Series A3 — the sse·ms chip

Activity's `sse · <ms>` chip reads `—` because `useActivityStream` measures no arrival age.
Decision: the chip shows **age since last SSE arrival** (client-clock only — skew-free), not
server-to-client latency. The hook records `Date.now()` at each message; the chip re-renders on
a 1s tick showing the age (`sse · 0.4s` / `sse · 12s`), em-dash until the first message, and
whatever stale/disconnected styling the chip already carries stays untouched.

## 5. Series A4 — mini debts (M17 leftovers)

- `close()` worst-case doc: the landed 8.25s is unreachable (M17 final re-review hand-trace +
  simulation: the loop's post-delay `if (closed) break` cuts the chain; true max ≈ 6.0s =
  open()'s two 2s deadlines + one 2s discard). Correct `packages/events/src/subscribe.ts`'s
  OPEN_TIMEOUT_MS block and `docs/event-model.md` with the phase math.
- Ownerless reconnect loop (`subscribe.ts:231`, pre-existing, flagged in M17): a failed initial
  `open()` can emit `error` → `scheduleReconnect` starts a loop nobody owns (caller got a
  rejection, no handle, orphaned LISTEN client). Fix at the root: during initial open, a
  failure path must not leave a live loop — mark closed / detach before rethrowing (the
  implementing task reads the file and picks the minimal shape), plus a regression test.
- `postControl`/`putControl` wrapper duplication across components (M17 backlog): inventory the
  copies; byte-identical ones re-point at `lib/postControl.ts`'s exports (the errorMessage
  pattern, Task 14 style); divergent ones are left with a one-line report note.

## 6. Series B — the Skill-chain view (user decision: both views)

The Graph's `skill` tab unlocks with its own node/edge set (design README "1b — Modes": each
mode is its own set; "skills of one task" is the task-focus half).

**Data (server).** `skillCalls` is an unordered tally — the ORDER lives in `ExecutionEvent`:
`run.tool_call` events whose tool is `Skill` (the pump's summary convention `Skill <name>`; the
implementing task verifies the payload shape against fixtures and parses from the payload
field, falling back to the summary prefix only if the payload carries no tool name). New
bounded server query (graph.ts or a sibling `skill-graph.ts`):

- Scope: the workspace's most recent N runs that contain at least one Skill call (N = 50,
  a named constant), newest first — bounded by construction, no full-table scan (M17 §4 rule).
- Per run: the ordered chain of skill names (repeats kept in place).
- DTO: `{ skills: [{ name, calls }], edges: [{ from, to, count }], runs: [{ runId, taskTitle,
  agentName, live, chain: [name…] }] }` — `skills`/`edges` are the aggregate (nodes = unique
  skills sized by total calls; edges = adjacent-pair successions summed across the N runs);
  `runs` feeds the selector and the focus view. Consecutive repeats collapse into one chain
  entry with a count (the ×N badge) in the DTO, not in the client.

**View (client).** New `SkillMode` component beside `ExecutionMode`/`DepsMode`:

- **Aggregate (default):** skill nodes as mono chips (the drawer mockup's chip aesthetic at
  canvas scale — `SECTION_LABEL`-family typography, chip radius 5), node prominence from call
  count, directed edges with thickness from succession count, laid out with the same
  ELK/layout machinery the other modes use. Follows every graph-kit convention (tones, drawer,
  auto-fit — including M16's fit-after-measure rule).
- **Focus:** picking a run (from a run-selector strip: recent runs with task title + agent +
  live dot) switches the canvas to that run's chain, left-to-right, ×N badges on collapsed
  repeats, in-order edges. Deselect returns to aggregate. Selection also reachable by arriving
  from another mode with an agent selected whose latest run has skill data (`hasSkillData`
  finally earns its keep — it marks selectable agents).
- **Tab unlock:** `hasView('skill')` becomes true; the `?mode=skill` fallback comment dies.
- **Empty state:** a workspace with zero Skill events renders an honest empty panel naming why
  (no skill calls recorded yet), never a blank canvas.

## 7. Testing & the gate

- Unit/integration per piece: shell-helper matrix tests; enforcement integration on the fake
  CLI (deny refused, run continues, event once); reader join logic; hook arrival-age test with
  fake timers; skill-graph DTO tests on seeded events (ordering, collapse, bounds, empty).
- **`gate:m18-skill-and-teeth`** (zero spend, browser-driven like m14/m16 gates, fake CLI
  only): (1) enforcement rehearsal — seeded deny row, fake-claude run: the gate's deny is
  observed, the run concludes `succeeded`, exactly-once `run.tool_denied`; (2) the skill tab —
  aggregate canvas renders seeded nodes/edges, run focus renders the chain with a ×N badge,
  empty workspace shows the empty state; (3) chrome truths — sse·ms chip shows a number once
  the stream ticks, a seeded pause-with-denials shows the reader line. Suite + `web:build`
  green precede the gate as always.
