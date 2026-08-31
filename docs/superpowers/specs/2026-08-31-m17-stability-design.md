# M17 — Stability & Debt: Six Flakes, One Runtime, Bounded Queries

**Status:** Approved (scope, flake bar, approach A, Skills decision and both open questions settled in conversation 2026-08-31)
**Approach:** A — stabilization first, then churn: flake wave → providers extraction → query hygiene → small-works batch → `gate:m17-stability`.

## 1. Why this milestone

Five feature milestones in a row (M12–M16) each deferred their chores to a named backlog, and the
pile is now the risk: six named timing flakes make every red suite run a mandatory investigation,
~nine blocks are copied verbatim between the Claude and Cursor adapters, three server queries
scan unbounded row sets on page render, and a batch of small correctness/a11y items has ridden
along since M11. M17 ships **no product feature**. It makes the suite trustworthy, the providers
package single-sourced, and the queries bounded — so M18 (Skill-chain view et al.) builds on a
floor that doesn't wobble.

**Non-goals:** no Skill-chain view, no `sse · ms` chip, no `deniedToolUseIds` reader, no
permission-matrix runtime enforcement (all stay queued); no CompanyManager split and no
`TASK_STATUS_*` dot-table derivation (medium refactors, not small works — parked to M18); no
visual redesigns (the Skills page keeps both of its sections; only the data layer unifies); no
new dependencies; no schema migrations.

**Branch:** `feature/m17-stability`. Waves land in order; each wave's commits are independently
green. Binding rules carry over: one vitest run at a time, daemon down during tests, web tasks
gate on `npm run web:build`.

## 2. Wave 1 — six flakes, root cause each

The bar (user-set): **every flake gets a root cause and a fix**; one that resists gets a written
ruling — why it resisted, what instrumentation was added so the next failure explains itself.
A retry that goes green is never evidence. Each flake produces an entry in
`docs/superpowers/specs/2026-08-31-m17-flake-ledger.md`: evidence, mechanism, change, proof.

The roster and the evidence on file:

| # | Test | Evidence | Suspected mechanism |
|---|------|----------|---------------------|
| 1 | `apps/orchestrator/test/integration/sweep.test.ts` "counts only the runs it actually failed" | 5s timeout 2× in M11, 1× in M12; 2.1s green in isolation | load-sensitive wait margin |
| 2 | `apps/orchestrator/test/cli.test.ts` (integration) "the daemon enforces the run-timeout guardrail on a hung run" | 0 timeout events under full-suite load (M12 Task 8); 415ms isolated, 484ms clean full run | guardrail timer misses its window under load |
| 3 | `packages/events/test/integration/subscribe.test.ts` "delivers exactly one notification per event across a reconnect" | 15s timeout in M12 Task 10's gate; 2555ms isolated and 2547ms clean full-suite at the same commit (~6× spike = stall, not drift); the file's last four commits are all reconnect-race fixes (`01ba261`) | **suspected live race** in the reconnect/dedupe path |
| 4 | `packages/events/test/integration/stream.test.ts:77` "delivers an event appended after the stream started" (plus the thin-margin test at :115) | flaked in M2 despite 10 poll-ticks of headroom | LISTEN/NOTIFY delivery latency before the poll starts, or a bottleneck other than poll margins |
| 5 | `apps/web/test/activity-history.test.ts` sparkline-bucket timing | named in M14, pre-existing | time-derived bucket boundaries sensitive to the real clock |
| 6 | live-gate Activity hydration | post-M16 gate re-run: 2 of 3 runs FAILED — SSR fine (3 events in the rail), then **zero** client requests (no `/activity/stream`, no `/shell`); the page never hydrated; the gate now dumps the browser console on failure | Next dev hydration or harness race |

Per-flake discipline, in order:

1. **Read** the test and the code under test; write a mechanism hypothesis before touching anything.
2. **Reproduce cheaply**: loop the single test N× (a shell loop, or vitest's `repeats` test option), add synthetic
   load if the flake is load-conditional. #3 gets a targeted stress harness around the reconnect
   path — it is the one most likely to be a product bug, and a race found there is the most
   valuable outcome of the wave.
3. **Fix at the root**: product bug → fix the product; mis-specified test → fix the test.
   Widening a timeout is acceptable only with a measured margin calculation in the ledger entry
   (observed worst case × headroom factor), never as a blind bump.
4. **Prove**: the targeted test 20× green in a loop, then the full suite green.
5. **Record** the ledger entry.

Flake #6 is fixed and proven at the gate level: whatever changes, the affected live gate must run
**3× consecutively green** (its console dump is the diagnostic if it fails again).

## 3. Wave 2 — providers extraction: `packages/providers/src/runtime/`

One new module directory absorbs the ≥9 blocks copied between `claude/*`, `cursor/*` and
`pause-signal.ts` (inventory from M12's task-12 report, re-verified against source before the
move): `AsyncEventQueue`, `terminateChild`, `killWithEscalation` (the three SIGTERM/grace/SIGKILL
copies become one), `clearAndVerifyPauseFlagAbsent`, `isRecord`, `preflightGate` +
`runGateScript`, `buildChildEnv`, `summaryFor`/`SUMMARY_ARG_KEYS`.

Rules of the move:

- **Behaviour-preserving**: the existing adapter test suites pass **unchanged** — no test edits
  to make the extraction fit. Where a block's existing coverage is thin, a characterization test
  is written against the *current* behaviour **before** the move.
- Blocks move one commit per block (or per tightly-coupled pair), so a regression bisects to one
  block.
- The extraction ends with a **census**: a grep over canonical block signatures proving zero
  copies remain in the adapters. The census lives in the gate (§6) so it stays true.

**Shell-side dedup** (`cursor-shell-gate.sh` carrying `pause-gate.sh`'s json_string/deny/flag-read):
the Cursor gate deploys **inside the worktree** (`.cursor/hooks.json`; the vendor has no
`--settings`), so it cannot source a sibling repo library at run time. Decision deferred to the
first Wave 2 task, which reads the deploy path and picks one of exactly two outcomes, recorded
back into this spec: **(a)** generate the deployed copy from a single repo-side template at
deploy time, or **(b)** keep it a deliberate copy with a census exception entry naming it. No
third option.

## 4. Wave 3 — query hygiene: push aggregation into SQL

Three call sites, one method. For each: write an **equivalence test first** — on a test-DB
fixture, compute the value the old way and the new way side by side, assert equality — then
replace the implementation, then delete the old path.

- `apps/web/src/server/skills.ts:69` — `agentRun.findMany` pulls every non-null `skillCalls`
  JSON into memory to count runs per skill. Replace with raw SQL `jsonb_each` + `GROUP BY`
  (the pattern `activity.ts` already uses for derived-column grouping). The page's **two
  sections both render from this one fetch** (user decision: single fetch, two views — no
  visual change); the second catalog query is deleted.
- `apps/web/src/server/analytics.ts` — the per-agent run query is unbounded; push the aggregate
  into `groupBy`/raw SQL alongside the existing `task.groupBy` at `:126`.
- `apps/web/src/server/org.ts` `listProjects` — the spend rows fetch scans all AgentRun rows on
  every `/` render, summed in JS by `spendOf`. Replace with SQL aggregation. **The
  `unmeasuredRuns` semantic is binding** (the comment at `org.ts:65-71` is the contract): known
  spend and the unmeasured count stay separate — one aggregate for `SUM(costUsd)` over measured
  runs, one for the unmeasured-run count as currently defined. No silently absorbing nulls
  as zeros.

## 5. Wave 4 — small-works batch

All verified present in today's source:

- `errorMessage` helper copy-pasted across ≥8 components (`EmergencyStopButton`, `RuntimeCard`,
  `AgentPanel`, `GoalCard`, `ModelOverrideEditor`, `SkillsClient`, `AssignCompanyDialog`,
  `CompanyManager`) → one export in `apps/web/src/lib/`.
- Dead tokens `--radius-nav`, `--shadow-floor` in `globals.css:34/42/66/72` — only references
  are their own definitions; delete.
- ProgressBar a11y: `role="progressbar"` + `aria-valuemin/max/now` on the element carrying the
  value; in the null/unmeasured state (M16 behaviour) `aria-valuenow` is omitted, per ARIA
  indeterminate convention.
- Section-label class duplication (~7 sites per M11 review): inventory at implementation time,
  extract to the kit (`FormControls.tsx` or sibling) — appearance only, contracts untouched.
- `scripts/pause-gate.sh` node-argv hole: a pause reason beginning with `-` yields a malformed
  deny — apply the same fix Task 11 (M12) applied to `cursor-shell-gate.sh`.
- Fixture home-dir scrub: pre-M12 Claude fixtures carry the operator's home dir in `init` lines
  (`fixtures/claude/README.md`, `skill-tool-use.ndjson` found today; sweep the whole fixtures
  tree). Neutralize paths; parser tests must still pass.
- `paths.ts` `mkdirSync` on an unwritable root: fail fast with an actionable error instead of
  hanging (M15 Task 4 note).
- Spec amendments owed: M12 spec §4 ("pause dispatches on capability" — now true via
  `canPauseMidRun`), §7 ("Cursor fires only the shell hooks" — measured false; and add the
  gate-inside-worktree limitation: the agent can delete its own gate mid-run, Claude's settings
  live outside).

## 6. Gate — `gate:m17-stability` (zero spend, CI-runnable)

Three proofs, one script:

1. **Suite endurance**: the full suite runs **5× consecutively**, serial, daemon down. Any red
   is a gate FAIL and an investigation — never a retry-to-green. Each run's duration and result
   are logged so drift is visible.
2. **Duplication census**: grep over the canonical block signatures from §3 finds **zero**
   matches inside `claude/`, `cursor/`, `pause-signal.ts` — plus the explicit exception list
   (empty, or the one shell-copy entry if §3 lands on option b).
3. **Query equivalence**: the §4 equivalence tests are green (they remain in the suite after
   the old paths are deleted, pinned against fixtures).

Flake #6's proof rides separately: the affected live gate 3× consecutively green (§2).

## 7. Testing posture

- Wave 1 *is* testing work; its deliverable is the ledger plus fixes.
- Wave 2 relies on the untouched adapter suites + characterization tests for thin spots.
- Wave 3's equivalence tests are written before each replacement and kept.
- Wave 4 items each carry their existing tests; the ProgressBar and section-label changes update
  the relevant component tests where assertions name classes/attributes.
- Suite-wide: after every wave, one full serial suite run before the wave's final commit.
