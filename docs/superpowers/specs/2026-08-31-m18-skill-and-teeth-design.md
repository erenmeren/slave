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
dependencies; schema changes limited to exactly two additive migrations — the `run.tool_denied`
`EventType` value (the enum was inventoried 2026-08-31: no denial-ish member exists;
`guardrail_tripped` is the closest and means something else) and an `ExecutionEvent`
`(runId, seq)` index (the N+1 note at `overview.ts:277-285` names it as the deferred fix; the
skill-chain DTO is the third consumer that makes it due). The `AgentPermission` table already
exists; no `Checkpoint` column (resume re-derives, §2).

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
- **Tool vocabulary — the mapping is the hard truth (measured 2026-08-31).** The matrix's six
  columns (`PERMISSION_TOOLS`, `packages/control/src/permission.ts:15-22`) are *capability
  phrases*, not tool names; the wire carries ~25 Claude tools and Cursor's `shell/edit/read`.
  v1 mapping, resolved ORCHESTRATOR-SIDE at file-write time (one TS table beside
  `PERMISSION_TOOLS`; the gate scripts stay dumb membership tests):
  - `repo read` → Claude `Read` / Cursor `read`
  - `source write` → Claude `Write`, `Edit`, `NotebookEdit` / Cursor `edit`
  - `run tests`, `create branch`, `deploy prod` → all shell-backed: a deny on ANY of the three
    denies Claude `Bash` / Cursor `shell`, and the deny reason names the denied capability.
    Coarse by design — command-string inspection is out of scope; the matrix UI copy states
    the coarseness.
  - `read secrets` → **unenforced in v1** (a path predicate, no tool maps to it); the matrix
    UI copy says so.
  - Every unmapped tool passes (default-allow doctrine).
  The `permissions.json` therefore carries the RESOLVED vendor-tool deny list for that run's
  provider: `{"version":1,"deny":[{"tool":"Bash","capability":"run tests"}]}` — empty `deny`
  written when nothing is denied.
- **Cursor caveat (measured, M13):** Cursor's `preToolUse` `tool_name` is untrustworthy for
  write/read discrimination (a file write arrived as `tool_name: "Read"` —
  `cursor-shell-gate.sh:11-14`). v1: shell enforcement via `beforeShellExecution` is reliable;
  non-shell enforcement on Cursor is best-effort, stated in the spec and the task report.
- **Discrimination from pause denials.** The deny reason carries a fixed prefix
  (`permission matrix denies`), defined once as a TS constant (`packages/providers/src/gate.ts`)
  and written literally by the shell helper — a test pins the two spellings equal. Claude:
  the matrix deny arrives as `hook_denied` whose `reason` starts with the prefix;
  `classifyGateEvent` gains a THIRD `GateOutcome` kind (`tool_denied`) — `gate.ts:20-40`'s
  own doctrine sanctions a new kind and forbids widening the existing two. Cursor: the stream
  starts reading the measured-but-discarded `rejected.reason` (`cursor/stream.ts:309-333`)
  into the `permission_denied` event; a prefix match routes it the same way. The pump's new
  `tool_denied` case emits `run.tool_denied` `{ tool, capability }` and NOTHING else — it must
  not push into the pump-local `denied` array (that would poison the Cursor was-this-pause-real
  heuristic at `pump.ts:397`) and must not touch the paused/stopped path.
- **The gate's hot path stays one node call.** Both gates today drain stdin unread
  (`pause-gate.sh:81`, `cursor-shell-gate.sh:165`); the permissions branch captures the payload
  and a single `node -e` (stdin: the payload; argv-free, the `json_string` discipline) reads
  the payload's tool name plus the permissions file and answers ALLOW / DENY-with-capability.
  Unparseable payload or unreadable-but-present permissions file → fail closed (`exit 2`),
  never silently allow. A MISSING permissions file → allow (pre-M18 runs and rehearsals
  without the orchestrator still gate pause correctly). Pause check remains first.
- **Resume.** `executeResume` (`apps/orchestrator/src/resume.ts`) never calls `runFilePaths` —
  the permissions file is re-derived (`dirname(checkpoint.pauseFlagPath)/permissions.json`) and
  REWRITTEN from the agent's current rows at resume (a fresh snapshot; no `Checkpoint` column).
- **Plumbing details:** `buildChildEnv` gains a required `permissionsFilePath` →
  `AITEAMOS_PERMISSIONS_FILE` (all four adapter call sites + both `StartInput` shapes);
  dispatch sites (tick.ts:459/581, planning.ts:222/322, review.ts:240/357) already hold the
  Agent row — `permissions: true` joins the existing `include`. The shared shell logic lives in
  `scripts/lib/permissions.sh`, mirroring `pause-flag.sh`'s conventions (report-don't-print,
  out-parameter globals, `PAUSE_GATE_NAME` prefixes) and gets a census row.
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

- Where (located 2026-08-31): the task board's paused-run line — `TaskDetailPanel.tsx:70-75`
  ("paused at step N · session … · N dirty files"), served by `tasks.ts`'s checkpoint DTO at
  :13/:80-87. `deniedToolUseIds` reaches NO web DTO today (grep-verified) — this is greenfield,
  and the house rule (graph.ts:24-34) binds: the DTO field ships with its renderer in the same
  task.
- What: a "denied during pause" line listing the denied tool uses. The ids are opaque
  `toolUseId`s; the reader joins them against the run's `run.tool_call` events to show human
  summaries where a match exists, and falls back to a count + truncated ids where not.
- Empty case: field `[]` or absent → the line does not render at all (no "0 denied" noise).

## 4. Series A3 — the sse·ms chip

Activity's `sse · <ms>` chip reads `—` because `ActivityClient.tsx:178-188` hard-codes
`latencyMs={null}` — `useActivityStream` wraps its own `EventSource` and measures nothing.
Decision (revised to the HOUSE pattern, 2026-08-31): copy `useWorkspaceStream.ts:113-118`
verbatim — on each message, `latencyMs = max(0, Date.now() - Date.parse(event.ts))` — so every
page's chip computes the same number the same way (`TopBar.tsx:77` already renders
`sse · <n>ms`). Changes confined to `useActivityStream.ts` (state + `ActivityStreamState`
field) and `ActivityClient.tsx:185`. Em-dash until the first message stays.

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
- `postControl` wrapper duplication (M17 backlog; inventoried 2026-08-31): widen the lib with
  one `sendControl(url, { method, body? })` that subsumes every variant, keep `postControl` as
  a thin alias, then re-point the five named wrappers (`AgentPanel:17-29` byte-identical —
  delete; `EmergencyStopButton:11-20` and `GoalCard:9-22` strict subsets — call `postControl`;
  `RuntimeCard:12-25` PUT and `graph/DepsMode:16-28` POST|DELETE — call `sendControl`). The
  six INLINE copies (PermissionMatrix, SkillsClient, ModelOverrideEditor, TemplateCatalog,
  AssignCompanyDialog, CompanyManager) stay — noted to the backlog, not this milestone. The
  lib's "single canonical copy" docstring becomes true again.

## 6. Series B — the Skill-chain view (user decision: both views)

The Graph's `skill` tab unlocks with its own node/edge set (design README "1b — Modes": each
mode is its own set; "skills of one task" is the task-focus half).

**Data (server) — verified shapes (2026-08-31).** `skillCalls` is an unordered tally — the
ORDER lives in `ExecutionEvent`: payload keys are `name`/`summary` (schema.ts:25-29; the pump
renames `toolName`→`name` at pump.ts:572). A Skill call is `payload.name === 'Skill'` (the DB
filter precedent is `overview.ts:289`: `payload: { path: ['name'], equals: 'Skill' }`) and the
skill name parses from the summary via `skillNameOf`'s `/^Skill\s+(\S+)/` convention
(overview.ts:225-229 — REUSE it, don't fork a second unknown-handling convention). The new
`(runId, seq)` index (§1 non-goals) makes the per-run scan cheap. New SIBLING builder — NOT a
`GraphSnapshot` widening (the costUsd ruling at graph.ts:24-34 and the 250ms-debounce cost
both forbid it): `buildSkillGraph(workspaceId)` in `apps/web/src/server/skillGraph.ts` behind
its own route `apps/web/src/app/api/w/[workspaceId]/skill-graph/route.ts` (mirror the 14-line
graph/route.ts):

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
  repeats, in-order edges. Deselect returns to aggregate. The DTO's `runs[]` carries its own
  metadata (runId, taskTitle, agentName, live, startedAt) — `GraphSnapshot` has run ids only
  for LIVE runs (graph.ts:176), and finished runs are exactly where skill data lives, so the
  selector cannot lean on the snapshot. `hasSkillData` stays what the M14 ruling made it:
  a reachability signal only.
- **House mechanics (verified):** builder follows the `buildDepsGraph` contract — pure, nodes
  at `{x:0,y:0}`, exported id prefix + frozen node-type map, edges `type: 'cable'` with
  `{tone, active}`; layout via `useLayoutedGraph(nodes, edges, 'layered')`; the new node type
  registers its footprint in `layout.ts` `DEFAULT_SIZE` (or it lays out at fallback silently);
  `GraphCanvas` provides fit-after-measure for free. `SkillMode` lives in its own file on the
  `DepsMode.tsx:52-162` template (error band, empty-state hint, canvas), receives
  `{ workspaceId, snapshot }` like its siblings, fetches its own DTO on mount and refetches,
  debounced, when the graph stream delivers a `run.tool_call` frame (GraphClient already
  receives raw frames via `onGraphEvent`). No drawer for skill nodes in v1 (skill≠agent; the
  selector strip is the interaction surface).
- **Tab unlock:** `hasView('skill')` becomes true and `GraphClient.tsx:212`'s
  `disabled = tab.mode === 'skill'` dies — the comment at :206-211 names this exact line as
  the one a later milestone flips. The `· later` suffix goes with it.
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
