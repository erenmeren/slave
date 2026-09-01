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
