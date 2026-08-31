# M17 flake ledger

One section per named flake (spec §2 roster). A section is complete when it has all five
fields filled with measured facts — "it went green on retry" is not a finding.

Template per flake:
- **Evidence** — the recorded failures (from the spec table) plus anything new this wave measured.
- **Mechanism** — the root cause, stated as a sentence about code, with file:line.
- **Change** — what was changed (product fix / test fix / config), with commit hash. A widened
  timeout must show the margin math: observed worst case × headroom factor = new budget.
- **Proof** — the 20× loop command and its result; for flake 6, the gate 3× result.
- **Residue** — anything left open, or "none".

## Flake 1 — sweep.test.ts "counts only the runs it actually failed"

- **Evidence** — recorded timeouts under full-suite load: M11 ×2, M12 ×1 (spec §2 roster). New
  this wave: read the failing test (sweep.test.ts:427–433, hooks :93–124) and confirmed no
  timing constructs anywhere in the test body, the `beforeEach` hook, `seed()`, `givenRun`,
  `sweep()`, or `reconcileOrphans()` (apps/orchestrator/src/sweep.ts:87–120) — every call is a
  direct Prisma/`db` round trip, no `setTimeout`/poll/wait. Measured 20 quiet runs of the whole
  file (`scripts/repeat-test.sh 20 apps/orchestrator/test/integration/sweep.test.ts`): 2595–2835
  ms per run (file `Duration` 2.24–2.45s, mostly hook TRUNCATE+seed I/O across 33 tests). Under
  synthetic CPU load (6 concurrent `yes > /dev/null` — see Change for the deviation from `nproc`
  — 14 total loaded runs across two batches), per-run file durations ran 3269–7287 ms; the
  slowest single test vitest reported was 533 ms (`marks a run failed when its pid is gone but
  its status is not terminal`, run 2 of the first loaded batch), recurring at 300–363 ms in the
  other 13 loaded runs. All 33 tests stayed well under the old 5000 ms default in every run
  observed this wave — the historical M11/M12 timeouts were a full-suite-contention effect this
  single-file, half-nproc-load reproduction did not fully recreate, consistent with the
  hypothesis that the budget itself was mis-sized, not this test uniquely slow.

- **Mechanism** — the test body (sweep.test.ts:427–433) is two inserts (`givenRun`) and one
  assertion on `reconcileOrphans(deps)`; all cost is in `beforeEach` (sweep.test.ts:95–125): a
  9-table `TRUNCATE … RESTART IDENTITY CASCADE` plus a multi-create `seed()`, ~5 Postgres round
  trips per test. No `testTimeout` was ever set on the integration vitest project
  (vitest.config.ts, was lines 27–35), so it inherited vitest's default 5000 ms. Under
  full-suite CPU contention that hook I/O crossed 5 s three times against a test body that does
  no waiting of its own — the budget was sized for vitest's default, not for shared-DB
  hook-heavy integration tests generally.

- **Change** — added an explicit `testTimeout: 15_000` to the **integration** vitest project
  only (`vitest.config.ts`), with the margin math in a config comment. Commit: `5d675c1`.
  Margin math: worst observed single test under load = 533 ms → rounded up to the next second =
  1_000 ms → ×3 headroom = 3_000 ms, which is below the brief's 15_000 ms floor, so the floor
  governs: **testTimeout = 15_000 ms**. A real hang still fails, 3x later than the old default.
  Deviation from the brief's literal `for i in $(seq 1 "$(nproc)")` recipe: on this machine
  `nproc` reports 8, but ambient load (desktop apps, other concurrent Claude Code sessions) was
  already at a 5.7–7.6 one/five/fifteen-minute load average before adding anything. Spawning 8
  more CPU-bound `yes` loops did not produce proportional contention — it reproducibly starved
  the box: an incremental `tsc --build` that normally takes 0.35 s did not complete within two
  independent 150 s-capped attempts (verified via a scripted, trap-cleaned harness so no `yes`
  processes were ever left running). That is not a measurable "worst case," it is unbounded
  starvation on this particular host. Scaled the synthetic load down to `nproc - 2` (6
  processes), which reliably reproduced genuine, non-pathological single-test slowdowns
  (300–533 ms, well above the ~55–80 ms quiet-run average) without stalling. All load processes
  were started and killed within one shell session via `jobs -p | xargs -r kill` / a script
  `trap … EXIT INT TERM`, and verified absent (`ps aux | grep yes`) after every attempt,
  including the one that hit its timeout cap.

- **Proof** — `scripts/repeat-test.sh 20 apps/orchestrator/test/integration/sweep.test.ts` →
  `GREEN 20x` (2361–2760 ms per run) with the new `testTimeout` in place. Full suite:
  `npm test` → `Test Files 131 passed (131)`, `Tests 1801 passed (1801)`, 145.44 s, with
  `sweep.test.ts` itself green in 1808 ms (33 tests); no orchestrator daemon was running for
  either run.

- **Residue** — none for this test. The historical M11/M12 timeouts were full-suite-contention
  events this task could not fully recreate against a single file even under synthetic load;
  the raised, measurement-derived floor (15_000 ms, 3x the honest worst case observed, with the
  minimum applied) is the mitigation Tasks 3–5 inherit.

## Flake 2 — cli.test.ts "the daemon enforces the run-timeout guardrail on a hung run"

## Flake 3 — subscribe.test.ts "delivers exactly one notification per event across a reconnect"

## Flake 4 — stream.test.ts delivery tests (:77 and :115)

## Flake 5 — activity-history.test.ts sparkline buckets

## Flake 6 — live-gate Activity hydration
