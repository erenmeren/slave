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

- **Evidence** — recorded failure: M12 Task 8, under full-suite load, `AgentRun.status` reached
  `failed` but zero `guardrail_tripped` events existed. New this wave: read
  `apps/orchestrator/test/integration/cli.test.ts:745–781`, `apps/orchestrator/src/sweep.ts:202–299`,
  `apps/orchestrator/src/daemon.ts:96–140`, `apps/orchestrator/src/pump.ts:476–888`, and
  `packages/providers/src/claude/adapter.ts:296–399`/`packages/providers/src/runtime/process.ts`
  (`terminateChild`). Reproduction: `scripts/repeat-test.sh` against this one test, under
  synthetic `nproc - 2` (6) `yes > /dev/null` load — 10 runs, then 30 more (40 total loaded runs
  across two batches) — stayed **GREEN 10x** / **GREEN 30x**; every run's own duration held
  steady at 1.0–1.7 s regardless of load (`tests` timing in the vitest summary), unlike Flake 1's
  hook I/O, which measurably slowed under the same load. That is itself informative: this test's
  race window is not CPU-contention-sized, it is event-ordering-sized (see Mechanism), so a
  single-file synthetic-load loop was never going to be the tool that catches it — consistent with
  the recorded failure being a single occurrence under genuine full-suite (many concurrent
  processes/DB connections) contention. Per the brief's step 2 fallback ("if 10 loaded runs stay
  green, the mechanism must be established by reading alone... and still apply the fix the
  reading justifies"), the mechanism below is established from the code, not from a caught red.

- **Mechanism** — `sweep.ts`'s timeout path never writes `AgentRun.status` to `failed` itself. On
  a breach it claims `stopping` (`sweep.ts:246–250`), calls `await adapter.cancel(...)`
  (`sweep.ts:275`), and only then appends `guardrail.tripped` (`sweep.ts:280–295`). The row's
  actual `failed` conclusion is written by a *different* component — `pump.ts`'s "stream ended
  without terminal result" branch (`pump.ts:838–855`, now :838–867 after this change) — once its
  `for await` loop over the adapter's event queue ends, which happens when `adapter.cancel`'s kill
  closes the child's stdout. `pump.ts:800–807`'s own comment already documents this design:
  "the guardrail sweep... claims the SAME `stopping` status ahead of its own `adapter.cancel`...
  and writes no terminal row of its own -- it relies on this branch."
  These two writers are triggered by the *same* child dying but through *two different, unordered
  event listeners*: `sweep.ts`'s `await adapter.cancel()` resolves via `terminateChild`'s
  `child.once('exit', ...)` (`packages/providers/src/runtime/process.ts:76–95`), while the pump's
  loop ends via `lines.once('close', ...)` on a readline wrapping `child.stdout`
  (`packages/providers/src/claude/adapter.ts:375–385`). Node's `child_process` API gives no
  ordering guarantee between a child's `'exit'` and its stdio streams' `'close'`. Downstream, the
  two writers also need different amounts of further async work before their own write lands:
  sweep needs one more DB round trip (`appendEvent`); the pump needs a `writeStreamUsage` call
  (1–2 queries), a conditioned `stopClaimed` update, and only then the `concluded` status update
  plus its own `emit`. Under quiet conditions sweep's shorter chain usually — but not
  structurally guaranteed to — finish first, which is why this is rare rather than routine. The
  test then compounds the race: it polls only for `status === 'failed'`, then does a single
  *immediate*, unretried read of `guardrail_tripped` events — asserting an ordering the code never
  promises. This is a genuine, narrow race between two independent, unsynchronized writers, not a
  wrong writer, not a lost claim, and not an event rename (candidate 3 in the brief was checked
  and ruled out: the `guardrail.tripped` / `guardrail_tripped` spelling difference is the Prisma
  `EventType` enum's `@map` between the domain literal and the DB value —
  `packages/db/src/enums.ts:19`, `packages/domain/src/events/schema.ts:42` — both sides of the
  test and the emitter already agree). Candidate 2 (the daemon coalescer) does not apply either:
  `runTimeoutMs: 1` means the very next `sweep()` after the run gets a pid catches it, coalescing
  only delays, and delay does not explain zero events after a full 15 s poll window followed by an
  unretried read.

- **Change** — two changes, both justified directly by the mechanism above, neither a rename of
  any operator-visible event (only additions):
  1. **Test fix** (the actual flake fix) — `apps/orchestrator/test/integration/cli.test.ts`: the
     poll loop now waits for *both* `run.status === 'failed'` **and** a `run_timeout`
     `guardrail_tripped` event before breaking, instead of polling for status alone and then doing
     one unretried event read. This matches what the code actually guarantees (both writers will
     eventually land, with no ordering promise between them) instead of an assumption the code
     never made.
  2. **Product instrumentation** (discriminating, additive, no schema/event change) —
     `apps/orchestrator/src/pump.ts`: the "stream ended without terminal result" branch now logs a
     `console.warn` naming itself as the alternate `failed` writer and noting that a guardrail
     sweep's own `guardrail.tripped` append may still be in flight, so a *real* recurrence (a
     genuine full-suite-contention red, or a future regression) is legible in daemon output rather
     than a silent status flip. No new persisted event was added — `apps/orchestrator/test/integration/sweep.test.ts:259–271`
     already locks the existing single-event, post-cancel `guardrail.tripped` shape for the
     cancel-failure case (`expect(events).toHaveLength(1)`), so reordering the sweep-side append
     ahead of `cancel()` (the brief's option (b)) would have broken that test's contract for no
     benefit — the log line gets the legibility without touching it.
  Commit: `fad0ffa`.

- **Proof** — `scripts/repeat-test.sh 20 apps/orchestrator/test/integration/cli.test.ts "the
  daemon enforces the run-timeout guardrail on a hung run"` → **GREEN 20x** (2.1–2.7 s/run),
  unloaded. Same command with `nproc - 2` (6) synthetic `yes` load running throughout → **GREEN
  15x** (2.4–2.7 s/run) — all `yes` processes confirmed killed (`pgrep -x yes`) before and after.
  `npm test` → `Test Files 131 passed (131)`, `Tests 1801 passed (1801)`, 145.69 s — includes the
  new `console.warn` firing (as expected, harmlessly) in `pump.test.ts`'s existing
  "fails a run whose stream ends without a terminal result" and skillCalls-no-terminal-event
  cases. No stray orchestrator daemon or vitest process at any point (checked via
  `/proc/<pid>/cmdline` on every live `node` pid, not `pgrep -f`, which false-matches its own
  invoking shell's command text on this host).

- **Residue** — the underlying race between `sweep.ts`'s post-cancel event append and `pump.ts`'s
  stream-end status write is *reduced in observability impact* (the test no longer asserts an
  ordering the code doesn't guarantee, and a recurrence now logs) but not eliminated at the
  source: the two writers are still unsynchronized, by design, for reasons `sweep.test.ts:259–271`
  locks in (the cancel-failure diagnostic needs `cancel()` to have already resolved before the
  event's `detail` is composed). A future task could close the underlying race itself — e.g. by
  having `sweep.ts` write a short-lived marker the pump's stream-end branch can read to attribute
  its own conclusion — but that is model/behavior surface beyond this flake's fix, and the current
  two-writer design is deliberate (the cancel-failure test guards it), not accidental.

## Flake 3 — subscribe.test.ts "delivers exactly one notification per event across a reconnect"

## Flake 4 — stream.test.ts delivery tests (:77 and :115)

## Flake 5 — activity-history.test.ts sparkline buckets

## Flake 6 — live-gate Activity hydration
