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
  replace `packages/providers/test/fixtures/claude/permission-matrix-deny.ndjson` (the
  hand-authored one) with the genuine capture.
- The fixture gains a **provenance header**: CLI version, date, cost, and the workspace/matrix
  shape that produced it.
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

## Series B — hardening informed by A

- **B1** — pump-local `matrixDeniedToolUseIds` vs resume echo: close the fail-safe re-fail risk
  using the id flow observed in A1's real capture.
- **B2** — hookName-adjacency hardening for the Claude tool_use_id association (A1's capture
  also tests the current adjacency assumption).
- **B3** — Cursor malformed-reason pump test (fixture-driven, zero spend).
- **B4** — `permissions.json` self-policing threat note: the child can rewrite its own runDir;
  goes into spec §7 as a stated limitation, sibling to the Cursor gate-inside-worktree note.
- **B5 (conditional on A2)** — un-inert Cursor non-shell enforcement. If A2 says "not fixed",
  this task is dropped, not deferred.

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
| A1 matrix-deny capture | Claude CLI | $1.00 | _(recorded at run time)_ | _(recorded)_ |
| A2 write≠edit probe | cursor-agent | ~$1.00 | _(recorded at run time)_ | _(recorded)_ |

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
