# M17 — Stability & Debt: Six Flakes, One Runtime, Bounded Queries

**Status:** Approved (scope, flake bar, approach A, Skills decision and both open questions settled in conversation 2026-08-31)
**Approach:** A — stabilization first, then churn: flake wave → providers extraction → query hygiene → small-works batch → `gate:m17-stability`.

## 1. Why this milestone

Five feature milestones in a row (M12–M16) each deferred their chores to a named backlog, and the
pile is now the risk: six named timing flakes make every red suite run a mandatory investigation,
the providers runtime consolidated in M13 has zero direct test coverage on six of its blocks,
three server queries scan unbounded row sets on page render, and a batch of small
correctness/a11y items has ridden along since M11. M17 ships **no product feature**. It makes
the suite trustworthy, the providers runtime proven where it is only inherited today, and the
queries bounded — so M18 (Skill-chain view et al.) builds on a
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

## 3. Wave 2 — providers runtime: prove what M13 already extracted

**Correction (2026-08-31, pre-plan verification):** the extraction this section originally
ordered was **already done** — M13 Series B (commits `0fc978c`, `692783d`, `1300874`,
2026-08-29) created `packages/providers/src/runtime/` and consolidated all nine block families
(`AsyncEventQueue`, `terminateChild`, `killWithEscalation` — moved *below* `packages/control`,
whose `kill.ts` is now a pure re-export — `clearAndVerifyPauseFlagAbsent`, `isRecord`,
`preflightGate`+`runGateScript`, `buildChildEnv`, `summaryFor`/`*_SUMMARY_ARG_KEYS`, and the
shell `json_string`/flag-read now shared via `scripts/lib/pause-flag.sh`, sourced by both
gates). Zero duplicate copies remain; every hit outside `runtime/` is an import. The
shell-dedup decision this section deferred is moot: its premise was wrong — only
`.cursor/hooks.json` is written into the worktree; the gate *script* stays in the repo and is
invoked by absolute path (`cli.ts` `cursorGatePath()` → `hooks.ts` `buildCursorHooks`). The
backlog memory was stale; this spec inherited it.

What Wave 2 actually owes:

- **Characterization tests for the runtime blocks with zero direct coverage.** Nothing under
  `test/` imports from `runtime/` directly; six blocks are tested only through adapters:
  `AsyncEventQueue` (push-before-iterate, close-with-pending-waiter, push-after-close,
  drain-after-close), `terminateChild` (already-exited fast path, SIGTERM→grace→SIGKILL),
  `runGateScript` (including the `stdin.end()` hang-prevention no test names),
  `buildChildEnv`, `clearAndVerifyPauseFlagAbsent` (including the directory-at-flag-path case
  its doc comment calls out), `isRecord`, and `signalRun` (`isAlive` has partial coverage via
  `kill.test.ts`). Tests pin *current* behaviour — no production changes ride along.
- **The census** (§6): a grep over the canonical definition signatures proving each has exactly
  one definition site. It lives in the gate so the consolidation stays true.
- **One census cleanup**: `apps/orchestrator/src/shell.ts:34` declares a local
  `KILL_GRACE_MS = 2_000` for its process-*group* kill — same number, different mechanism.
  Import the constant (via `@ai-team-os/control`'s re-export surface) so the census greps clean;
  the group-kill mechanism itself stays local on purpose.

## 4. Wave 3 — query hygiene: push aggregation into SQL

Three call sites, one method. For each: write an **equivalence test first** — on a test-DB
fixture, compute the value the old way and the new way side by side, assert equality — then
replace the implementation, then delete the old path.

- `apps/web/src/server/skills.ts:69` — `agentRun.findMany` pulls every non-null `skillCalls`
  JSON into memory to count runs per skill (`buildSkillsPage`, in-memory sum at `:85-93`).
  Replace with raw SQL `jsonb_each` + `GROUP BY` (the pattern `activity.ts` already uses for
  derived-column grouping), guarded by `jsonb_typeof` so non-object columns and non-number
  values are skipped exactly as the JS loop skips them. **Correction:** the page already
  renders both sections from this one fetch — the domain grid is a client-side `flatMap` over
  the same `providers` array (`SkillsClient.tsx:45`). "Single fetch, two views" is the current
  state; the only work here is the query rewrite. No UI change.
- `apps/web/src/server/analytics.ts:99-113` — `allRuns` pulls **every run in the database** (10
  columns, no bound) for the global `/analytics` route, then buckets per agent in JS
  (`:187-219`). Replace with one raw-SQL `GROUP BY "agentId"` using `FILTER` clauses that
  reproduce each JS aggregate exactly: terminal count, succeeded count, duration average
  (terminal + `endedAt` present + non-negative), token sum with the reported-count rule
  (`tokensIn OR tokensOut` non-null; null-vs-sum stays distinct per `:44-51`), and the
  spend pair. The `sumSpend` predicate (`packages/domain/src/guardrails/spend.ts:81` — known =
  every reported cost; unmeasured = `costUsd IS NULL AND provider IS NOT NULL AND status`
  terminal) is the contract the SQL must reproduce.
- `apps/web/src/server/org.ts` `listProjects` — the spend fetch at `:87-101` scans all AgentRun
  rows (four columns + a relation join) on every `/` render, summed in JS by `spendOf`.
  Replace with `prisma.agentRun.groupBy({ by: ['agentId','provider','status'], _sum, _count })`
  plus a bounded agent→workspace map, folded by a new domain helper `sumSpendFromGroups` that
  shares `isInFlight` with `sumSpend` and is property-tested equivalent to it. **The
  `unmeasuredRuns` semantic is binding** (the comment at `org.ts:65-74` is the contract; the
  rule holder is `sumSpend`, not a `COUNT(costUsd IS NULL)`). No silently absorbing nulls as
  zeros; pre-M12 rows (real cost, null provider) keep their money in `known`.

## 5. Wave 4 — small-works batch

Inventory corrected against today's source (pre-plan verification, 2026-08-31):

- `errorMessage`: the canonical export **already exists** (`apps/web/src/lib/postControl.ts:16`)
  and two components already import it. The work is re-pointing the **nine** byte-identical
  local copies at it: `AgentPanel:15`, `GoalCard:11`, `EmergencyStopButton:11`,
  `RuntimeCard:11`, `ModelOverrideEditor:13`, `AssignCompanyDialog:11`, `CompanyManager:26`,
  `TemplateCatalog:33`, `graph/DepsMode.tsx:14` (the original inventory said 8 and missed the
  last two). The near-duplicate `postControl`/`putControl` fetch wrappers several of these also
  carry are noted to the backlog, not this milestone.
- Dead tokens `--radius-nav`, `--shadow-floor` in `globals.css:34/42/66/72` — only references
  are their own definitions (one stale consumer exists only in `.next/` build output); delete,
  then `web:build` to confirm.
- ProgressBar a11y (`ui/ProgressBar.tsx`): `role="progressbar"` + `aria-valuemin`/`aria-valuemax`
  beside the existing `aria-valuenow` (today it sits on a role-less div, inert to AT); in the
  null/unmeasured state (M16 behaviour) `aria-valuenow` stays omitted, per ARIA indeterminate
  convention. `SkillsClient`'s hand-rolled `skill-bar-*` is deliberately separate and untouched.
- Section-label duplication: the kit components **already exist** (`ui/SectionLabel.tsx`,
  `FieldLabel` in `ui/FormControls.tsx` — identical class string
  `font-mono text-[9px] uppercase tracking-[.09em] text-text-3`). The work is single-sourcing
  the class string as an exported constant and re-pointing the seven exact-string sites
  (`AssignCompanyDialog:110` h3, `PermissionMatrix:110` span + `:118` th, `GraphDrawer:98/104`
  divs, `ui/DataTable:20` th, `ui/StatStrip:27`) **without changing any DOM element or
  testid** — several are reached by role/testid in tests. Near-variant strings (`Sidebar`,
  `TaskColumn` — the latter carries a comment saying it is deliberately not SectionLabel) are
  left alone.
- ~~`scripts/pause-gate.sh` node-argv hole~~ — **already fixed** (commit `66a3d97`: both gates
  source the single stdin-based `json_string` in `scripts/lib/pause-flag.sh`). Dropped.
- Fixture home-dir scrub, corrected inventory: `skill-tool-use.ndjson` is already scrubbed;
  still dirty are the **12 pre-M12 root fixtures** (`packages/providers/test/fixtures/*.ndjson`,
  9 occurrences each in the `init` line's `plugins[].path`), `fixtures/cursor/gate/run-1-hook.log`,
  `fixtures/cursor/gate/README.md` (2 lines), and `fixtures/cursor/cursor-run.ndjson`'s
  path-mangled scratchpad `cwd`. `fixtures/claude/README.md:88-101` documents the redaction
  recipe itself — genericize, don't treat as a leak. Nothing asserts on `plugins[].path`;
  `fixtures/claude/README.md`'s byte-count/md5 claims must be updated in the same change if its
  fixtures change. Docs/spikes home-dir mentions are out of scope.
- `packages/control/src/paths.ts:22` (`runFilePaths`) on an unwritable root: two failure modes
  on record (`pause.test.ts:134-140`) — a read-only existing dir surfaces later as a
  mis-attributed EACCES on the flag write, and a nonexistent parent under a pseudo-filesystem
  **hangs recursive `mkdirSync` forever**. Fix: preflight `statSync(repoPath)` (must exist and
  be a directory — turning the hang case into an immediate actionable error) and wrap the
  `mkdirSync` failure with the dir path and run id. All four call sites are on the tick's hot
  path.
- Spec amendments owed to the M12 spec (`2026-08-25-m12-provider-adapters-design.md`): §4:111
  ("pause dispatches on capability" — wired for real in M12's final fix wave; annotate), §7:189
  ("Cursor fires only the shell hooks" — measured false: `preToolUse` fires for Read/Write/Shell;
  annotate), §7:183-186 (`costUsd: null` / "reports neither cost, tokens" — M14/M15 mapped and
  persist Cursor tokens; annotate), and add the gate limitation **as corrected**: the gate
  *script* lives in the repo, but its registration (`.cursor/hooks.json`) is worktree-local, so
  the agent can delete its own gate registration mid-run; Claude's settings live outside.

## 6. Gate — `gate:m17-stability` (zero spend, CI-runnable)

Three proofs, one script:

1. **Suite endurance**: the full suite runs **5× consecutively**, serial, daemon down. Any red
   is a gate FAIL and an investigation — never a retry-to-green. Each run's duration and result
   are logged so drift is visible.
2. **Duplication census**: grep proves each §3 block signature has exactly **one** definition
   site (in `runtime/` or `scripts/lib/`) — zero re-definitions inside `claude/`, `cursor/`,
   `pause-signal.ts`, or the orchestrator. The known intentional non-match: each gate's
   ~10-line bootstrap that *finds* the library (intrinsically unsharable), named in the census
   script.
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
