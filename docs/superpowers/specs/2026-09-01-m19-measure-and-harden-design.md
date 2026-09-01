# M19 — Measure and Harden

**Date:** 2026-09-01 · **Branch:** `feature/m19-measure-and-harden` · **Status:** approved (operator, 2026-09-01)

M18 shipped permission enforcement v1 and the skill-chain tab, and left two kinds of debt on
record: assumptions that were never checked against a real vendor (the matrix-deny fixture is
hand-authored; the Cursor write≠edit mismatch was measured on a binary that has since updated
itself), and a queue of hygiene items each carrying an M18 ruling. M19 pays both. Auth is
explicitly out of scope — it is M20, alone.

## Shape

Three series. A measures, B hardens on what A measured, C is independent hygiene that may run in
parallel with either.

**The ordering rule (why measurements come first):** A1's real capture can falsify the
hand-authored fixture's shape assumptions, and A2's verdict decides whether B5 exists at all.
Building B on the unmeasured fixture and measuring afterwards (M12's order) risks tearing out
work built on a wrong assumption. Any A-vs-fixture divergence is a **written finding** feeding
B — never silently patched.

## Series A — two live measurements

### A1 — real matrix-deny capture (≤ $1)
- Dev workspace, permission matrix with an explicit deny on a tool the task is certain to
  attempt; real Claude CLI through the orchestrator.
- Capture the NDJSON stream; scrub home-dir per the M17 rule (including the mangled form);
  replace `packages/providers/test/fixtures/permission-matrix-deny.ndjson` (top level — it is a
  replay mode enumerated by `fake-claude.mjs`, so it must stay in the replay namespace; the
  spec's first draft wrongly placed it under `claude/`) with the genuine capture.
- Provenance goes where this repo keeps it — the sibling `fixtures/README.md` (NDJSON carries no
  comments): CLI version, date, runnable command, cost, and the workspace/matrix shape that
  produced it. The "hand-authored exception" section is retired. The four redaction rules bind.
- Success: pump classification holds on the real capture — matrix deny → `run.tool_denied`,
  run **continues**, matrix-attributed ids excluded exact-set from the failure computation.
  Shape divergence from the hand-authored fixture = finding, recorded, routed to B1/B2.
- Record in the task report: version, cost, event shapes observed.

### A2 — Cursor write≠edit re-measure
- First act: record `cursor-agent --version` (memory rule: version per measured run; re-pair on
  drift; never assert vendor message prefixes).
- Probe whether `preToolUse` now reports tool names truthfully (write vs edit discrimination).
- Two outcomes, both valuable: fixed → B5 opens (un-inert Cursor non-shell enforcement,
  `CAPABILITY_TOOLS` updated); not fixed → enforcement stays inert v1, measurement report and
  version record refreshed.
- **Verdict (recorded 2026-09-01): `not fixed`** — `cursor-agent --version` still reports
  `2026.08.25-3e8eec8`, the exact binary M13 measured on 2026-08-29, so the standing
  id-sharing evidence in `packages/providers/test/fixtures/cursor/gate/README.md` is current and no
  paid run was made ($0.00). Task 7 dropped per spec (B5 conditional).

## Series B — hardening informed by A

- **B1** — pump-local `matrixDeniedToolUseIds` vs resume echo: close the fail-safe re-fail risk
  using the id flow observed in A1's real capture.
- **B2** — hookName-adjacency hardening for the Claude tool_use_id association (A1's capture
  also tests the current adjacency assumption).
- **B3** — Cursor malformed-reason pump test (fixture-driven, zero spend).
- **B4** — `permissions.json` self-policing threat note: the child can rewrite its own runDir;
  goes into spec §7 as a stated limitation, sibling to the Cursor gate-inside-worktree note.
- **B5 (conditional on A2)** — un-inert Cursor non-shell enforcement. If A2 says "not fixed",
  this task is dropped, not deferred. **DROPPED 2026-09-01:** A2's verdict is `not fixed` (same
  binary version, standing measurement current) — see the A2 verdict above.

## Series C — hygiene and performance (independent)

- **C1** — functional index on the Skill payload path used by `buildSkillGraph`; migration;
  before/after `EXPLAIN` recorded in the task report.

  **C1 evidence** (dev DB, workspace `00000000-…-000001`, 7-row table): Prisma's `payload: {
  path: ['name'], equals: 'Skill' }` folds to `(payload #> '{name}'::text[]) = '"Skill"'::jsonb`
  (provable Const), but its `type = CAST($n::text AS "EventType")` does **not** fold — so `type`
  had to become an ordinary indexed column (`workspaceId, type, runId, seq`), not part of the
  partial predicate, or the index was structurally invisible to the planner (proven dead by
  EXPLAIN with every competing index dropped). Before: both queries `Seq Scan`, `Filter:
  (workspaceId=… AND (payload #> '{name}') = '"Skill"' AND type = (…::cstring)::"EventType")`.
  Table too small (7 rows) for the planner to prefer the index unforced; with
  `enable_seqscan = off` both queries switch to `Index (Only) Scan using
  "ExecutionEvent_skill_calls_idx"`, `Index Cond` covering `workspaceId`/`type`/`runId`, groupBy
  as `Heap Fetches: 0`. The findMany's `ORDER BY runId, seq` is fully satisfied by index order --
  no `Sort` node at all. The groupBy is more nuanced: the index removes the *input* sort feeding
  `GroupAggregate` (before: two `Sort` nodes, one by `runId` ahead of the scan and one by
  `MAX(seq) DESC` after; after: only the latter remains) -- the outer sort by `MAX(seq) DESC`
  survives because it orders an *aggregate result*, which index order can never satisfy. Full
  plans and the CAST-immutability rejection in Task 8's report.
- **C2** — typecheck gate step: `npm run typecheck` (the full chain at `package.json:15`)
  becomes a standard milestone-gate step; proven by a probe that it catches a red `tsc --build`
  alone misses (test-tsconfig breakage).
- **C3** — `edges[].count` → cable thickness in `SkillMode`, clamped to a sane min–max, in the
  handoff's cable language. Closes the `skillGraph.ts:24` computed-unrendered ruling.
- **C4** — the five components with inline POST copies (SkillsClient, CompanyManager,
  ModelOverrideEditor, TemplateCatalog, AssignCompanyDialog) move to the existing `sendControl`.
- **C5** — `listWorkers` all-history run fetch pushed into SQL (the `listProjects` groupBy
  pattern from M17), behind a permanent equivalence test.
- **C6** — CompanyManager (375 lines) split along responsibility boundaries; characterization
  tests first; zero behavior change.
- **C7** — `TASK_STATUS_*` dot-tables (5 files) derived from the tone table — the remaining
  half of M16's status→tone fold.

## Gate — `gate:m19-measure-and-harden`

Zero-spend assertions only; the paid measurements happen **once, inside A1/A2**, and the gate
verifies their recorded evidence rather than re-spending:

1. The typecheck step runs and a probe proves it catches a planted red.
2. The real fixture exists with its provenance header (version + date + cost).
3. Cable thickness responds to count (two snapshots at different counts differ).
4. Equivalence tests (C5) green; full suite green.
5. Spend ledger present and ≤ $2 total.

## Spend ledger

| Run | Vendor | Cap | Actual | Version |
|-----|--------|-----|--------|---------|
| A1 matrix-deny capture | Claude CLI | $1.00 | **$0.0741884** (2026-09-01, one run, no retry) | **2.1.252 (Claude Code)** |
| A2 write≠edit probe | cursor-agent | ~$1.00 | **$0.00** (2026-09-01, no run: version unchanged) | **2026.08.25-3e8eec8** (identical to the M13-measured version) |

### A1 findings (recorded 2026-09-01, routed to B1/B2)

The capture is `packages/providers/test/fixtures/permission-matrix-deny.ndjson`; its full provenance
is in that directory's `README.md`. Every assumption the hand-authored fixture encoded about the
DENY ITSELF held against the real CLI — the `permissionDecisionReason` grammar byte for byte, the
`hook_name`/`hook_event` form, `permission_denials` as `{tool_name, tool_use_id, tool_input}` on an
`is_error: false` result, and the run concluding `succeeded` with exactly one `run.tool_denied`
`{tool: 'Bash', capability: 'run tests'}`, no `guardrail.tripped`, no pause and no checkpoint. All
52 `pump.test.ts` cases and all 18 `fake-claude.test.ts` cases pass on the real capture with **no
test change**. What the hand-authored file did not and could not model:

1. **Hook responses are not adjacency-ordered, and more than one `PreToolUse` hook runs per tool
   call.** Two fire here (this repo's `pause-gate.sh` plus a plugin's). The second
   `PreToolUse:Read` response lands on line 24 — after the `Bash` tool_use, after the deny
   response, and after the deny's `tool_result`. `pump.ts`'s `matrixDeniedToolUseIds` association
   ("the last `tool_call` seen") is correct in this recording but is a guess: a deny from a
   late-arriving response would be attributed to the wrong tool_use id. **→ B2.** The stream does
   carry the fix: `hook_id` pairs each `hook_response` to its own `hook_started` (line 15 ↔ line
   24), and `parseStreamLine` currently ignores that field entirely.
2. **`hook_started` lines exist** (7 of them) and are `ignored` by `parseStreamLine` — confirmed
   inert, no `unparsable` for any of the 29 lines. **→ B2 context only.**
3. **`tool_result_meta` is a structural denial signal.** The denied `tool_result` carries
   `[{"id":"toolu_01LiQ…","non_execution_kind":"permission-rule"}]` plus a `tool_use_result` of
   `"Error: permission matrix denies …"`. Nothing reads either today; everything currently keys off
   the reason STRING. **→ B1/B2.**
4. **`PostToolUse` hook pairs are present** for the allowed `Read`, and that response is also out of
   order (line 25, after the `Bash` cycle). Same class of fact as finding 1.
5. **The `init` line is now real** — `claude_code_version` 2.1.252, `model` `claude-sonnet-5`,
   `permissionMode` `bypassPermissions`, `plugins[]`, `memory_paths`, `messaging_socket_path` —
   where the hand-authored one was schema-minimal. It required the home-dir and socket-path
   redactions the M3/M8 fixtures still owe, **and a fifth redaction rule**: the line's environment
   catalog (`mcp_servers`, `tools`, `plugins`, `skills`, `agents`, `slash_commands`) published which
   third-party accounts the recording operator has connected — no path, email, UID or PID, so rules
   1–4 did not catch it. Rule 5 replaces each inventory array with a `fixture-*` stand-in of the same
   schema and binds every future capture. Any milestone that adds a capture inherits it.
6. **`session_id` is a real UUID**, not the `fake-session-<mode>` convention every other replay mode
   in that directory follows. Nothing reads it; rewriting it would make the recording less
   checkable. Recorded so the inconsistency is deliberate rather than discovered later.
7. **An `assistant` `thinking` content block and a `rate_limit_event` line** appear mid-stream (the
   latter between the `Bash` `hook_started` and its response). Both `ignored` by the parser; neither
   existed in the hand-authored file.

## Out of scope

- Auth/origin story (M20, alone).
- The `/tmp/does-not-matter` placeholder still in `goal/org/workspace-settings.test.ts` —
  harmless today (nothing there reaches `runFilePaths`); recorded in project memory 2026-09-01.
- Skills page two-section visual layout; six inline `postControl` copies beyond the five
  components named in C4 if any others surface — record, don't chase.

## Standing rules that bind this milestone

- `apps/web` tasks gate on `npm run web:build` (tsc/vitest miss bundler-only breakage).
- One vitest run at a time; no daemon while `subscribe.test.ts` runs.
- Never `web:build` while `next dev` is up.
- Trace every new field/element to its consumer before calling a task done (M16/M17/M18 rule —
  caught an inert feature three milestones running).
- `git add` with explicit paths only.
- Verify backlog items against source before planning them (done 2026-09-01 for every item
  above).

## Errata (post-execution, 2026-09-01)

Written at Task 14, after every other task landed. Where this section and the sections above
disagree, this section is what shipped.

### A1 — the capture, and what it changed

`packages/providers/test/fixtures/permission-matrix-deny.ndjson` is now a real `claude` recording
(2.1.252, 2026-09-01, one run, **$0.0741884**), made by `scripts/capture-matrix-deny.mjs` driving
this repository's own orchestrator daemon. It replaced M18's hand-authored file with **no product
and no test change**: all 52 `pump.test.ts` cases and all 18 `fake-claude.test.ts` cases passed on
the real bytes as committed. Every assumption the hand-authored file encoded about the deny itself
held byte for byte.

**Eight divergence findings** came out of it (the seven in the "A1 findings" section above plus the
init-line disclosure caught in review). Two mattered enough to change code and both were routed
into Series B: the non-adjacency of hook responses (→ B2) and the id flow the resume echo re-reads
(→ B1). The rest are recorded, not chased.

The review round added a **fifth standing redaction rule**: the `init` line's environment catalog
(`tools`, `mcp_servers`, `plugins`, `slash_commands`, `skills`, `agents`) published which
third-party accounts the recording operator had connected — a privacy class rules 1–4 had no reason
to anticipate, since it carries no path, email, UID or PID. Rule 5 replaces each inventory array
with a `fixture-*` stand-in of the same schema and **binds every future capture**; it is the rule
the M19 gate's check 2 pins by number. Two plugin names left visible in the fixture's own
`SessionStart` hook output were ruled acceptable (public plugin names, no account or path) rather
than scrubbed, on stream-fidelity grounds.

### A2 — a no-op verdict, and B5 dropped

`cursor-agent` was still **2026.08.25-3e8eec8**, byte-identical to the version M13 measured, so
there was nothing new to measure: the standing "write ≠ edit enforcement is not fixed" verdict
carries forward unchanged and A2 cost **$0.00**. The task's diff is documentation only. Per the
spec's own conditional, **B5 (Task 7) was dropped, not deferred** — see the Series B entry above.

### B1/B2 — what landed

- **B1**: the `run.tool_denied` payload now carries the denied `toolUseId`, and a resumed pump seeds
  `matrixDeniedToolUseIds` from the run's already-persisted denials, so the resume echo of a
  previously-denied call cannot re-fail a run that survived the deny the first time.
- **B2**: the deny→tool association is name-checked. `pump.ts` tracks `lastToolUse` as `{id, name}`
  rather than a bare id, and a `hook_response` whose `hook_name` does not match the last `tool_call`
  is not credited to it. The direction is deliberately conservative (fail-safe): an unassociable
  deny fails the run rather than being silently excluded.
- **Known limit, unclosed**: two *same-named* calls racing in one stream are still ambiguous. The
  real fix is `hook_id`↔`hook_started` pairing, which A1's capture proves the stream carries and
  `parseStreamLine` ignores. Out of scope here; an M20+ backlog candidate.
- **Known limit, unclosed**: `toolUseId` survives only in `ExecutionEvent.payload`'s raw column —
  `packages/events/schema.ts`'s non-strict domain schema strips it, so the next *typed* consumer of
  that event will find nothing there. Recorded, not fixed.

### C1 — the index's columns are not the plan's

The plan asked for `(workspaceId, runId, seq)`. What shipped is
**`(workspaceId, type, runId, seq)`**, partial on `(payload #> '{name}') = '"Skill"'::jsonb`
(`20260901120000_m19_skill_calls_partial_index`). The reason is a real finding, not a preference:
Prisma emits the `type` filter as a **parameterized cast**, which cannot live inside a partial
index predicate — the planner would never match it, and the DDL would not be IMMUTABLE. So `type`
moved out of the predicate and into the key columns. The predicate that remains is reachable only
because `@prisma/adapter-pg` issues these statements **unnamed**, which Postgres always plans as
custom plans with the parameters substituted; a driver change to named/cached prepared statements
would plan them generically, the partial predicate would stop matching, and the index would go dead
**silently** — a correct result over a Seq Scan, with no error. That failure mode is documented at
the query site in `apps/web/src/server/skillGraph.ts`.

Two corrections to earlier claims: the `groupBy` still carries its own `Sort`/`GroupAggregate` for
the `MAX(seq) DESC` ordering (an aggregate result no index order can satisfy) — the index removes
the *input* sort, not the outer one; and the applied migration's header keeps its now-imprecise
"no Sort node" wording on purpose, because editing an applied migration for comment-only text costs
a checksum hand-repair. The correction lives at the query site and here.

The M19 gate checks this index **by name only**, deliberately: the column list is free to keep
following the query, but the migration having run at all is not.

### C7 — wider than the two examples

The `TASK_STATUS_*` dot-tables folded into one derivation off the tone table moved **29 cells
across 7 statuses** (plus a `TEXT`/`reviewing` fix), where the task brief named two example
movements. This was pre-ruled in the SDD ledger before execution: the spec mandates derivation, and
recon had already shown derivation is not colour-preserving, so the movements are the point rather
than a regression. The handoff tokens agree with the derived direction (`done` = green). There is no
visual-snapshot tooling in this repo, so the evidence is the derivation chain plus a 7/7 spot-check
in review, not a screenshot diff.

### Gate check 4 — narrower than the Gate section says

The Gate section's item 4 above ("Equivalence tests (C5) green; full suite green") reads wider than
what shipped: `gate-m19-measure-and-harden.mjs`'s check 4 runs only the C5 equivalence suite
(`apps/web/test/integration/org-workers-groups.test.ts`), not the full suite — the full suite is
enforced at every task's commit gate and by the pre-push hook, consistent with this standing gate's
own design of reading recorded evidence rather than re-running the world.

### Deferred minors

Every deferred minor from every task — including the ones named above — is recorded in
`.superpowers/sdd/2026-09-01-m19-measure-and-harden/progress.md` under its own task line. They are
the M20 backlog's raw material and were deliberately not chased here.

### Final spend

**$0.0741884** total against a **$2.00** milestone cap — A1's single capture, and nothing else.
Both live measurements happened once, during execution; the gate reads their recorded evidence and
spawns no vendor CLI at all, so verifying this milestone costs nothing forever.
