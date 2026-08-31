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
  These two writers are triggered by the *same* child dying but through *two different event
  listeners*, and — corrected after task review — these are NOT symmetric/unordered: `sweep.ts`'s
  `await adapter.cancel()` resolves via `terminateChild`'s `child.once('exit', ...)`
  (`packages/providers/src/runtime/process.ts:76–95`), while the pump's loop ends via
  `lines.once('close', ...)` on a readline wrapping `child.stdout`
  (`packages/providers/src/claude/adapter.ts:375–385`). `packages/providers/src/claude/adapter.ts:450–465`
  already carries a measured fact this investigation missed on first pass: readline's `'close'` on
  `child.stdout` was probed 200 times against a real child process and fired *before* the child's
  own `'exit'` event in **200/200 runs** (recorded there for a different call site, `resume()`'s
  live-child check, but the same two events on the same kind of child). So the pump's own trigger
  — the stdout stream closing — reliably fires FIRST, not at a coin-flip; `sweep.ts`'s `cancel()`
  resolution is the one that is reliably a step behind at the trigger level. What actually decides
  which writer's *DB write* lands first is entirely downstream of that: sweep needs one more DB
  round trip (`appendEvent`), itself serialized behind the process-wide `appendChain`
  (`packages/events/src/append.ts:36`) shared by every append in the process; the pump needs a
  `writeStreamUsage` call (1–2 queries, not chain-serialized), a conditioned `stopClaimed` update,
  and only then the `concluded` status update plus its own `emit` (which *is* chain-serialized).
  Under quiet conditions the pump's longer list of plain queries apparently still loses to sweep's
  shorter, chain-serialized append (matching the observed rarity) — but under full-suite
  contention, the `appendChain` is what a daemon process shares across every concurrent run's
  events, so it plausibly absorbs a disproportionate amount of that contention's delay, while the
  pump's non-chain queries are not similarly funneled through one shared serialization point. That
  is the plausible reason full-suite contention (many concurrent processes/DB connections, and —
  within this one daemon process — many runs' events all fighting over the same `appendChain`)
  produced the recorded red, while this task's single-file synthetic CPU load (one run, one chain,
  no chain contention to speak of) could not reproduce it. The test then compounds whichever writer
  wins: it polls only for `status === 'failed'`, then does a single *immediate*, unretried read of
  `guardrail_tripped` events — asserting an ordering the code never promises, regardless of which
  of the two writers is favored to win it. This is a genuine, narrow race between two independent,
  unsynchronized writers — asymmetric at the trigger (pump's fires first, reliably) but decided
  downstream by chain contention (sweep's shorter path usually still wins) — not a
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
  **Sharpened after task review** (documentation-only correction, no further code change): the
  original write-up above described the race as a symmetric/unordered coin flip between the two
  writers' *trigger* events. `packages/providers/src/claude/adapter.ts:450–465` already carries a
  200/200-measured fact this investigation did not surface on first pass — `child.stdout`'s
  readline `'close'` reliably fires before the child's own `'exit'`, so the pump's trigger is
  reliably first, not a coin flip. It is the *downstream* work after each trigger — sweep's single
  `appendEvent` call, chain-serialized behind the process-wide `appendChain`, versus the pump's
  longer sequence of plain (non-chain-serialized) queries plus its own chain-serialized `emit` —
  that plausibly decides the actual winner, and plausibly explains why `appendChain` contention
  specifically (many concurrent runs' events sharing one process-wide chain, worse under
  full-suite load with more daemons/runs live at once) is the more precise thing a future
  investigation of a recurrence should measure, rather than raw CPU load or DB latency in general.
  Neither the mechanism's conclusion (a real, narrow, structural race between two unsynchronized
  writers) nor the fix (poll for both conditions; log the alternate writer) changes — this
  sharpens the "why full-suite and not single-file load" explanation for whoever investigates a
  recurrence.

## Flake 3 — subscribe.test.ts "delivers exactly one notification per event across a reconnect"

- **Evidence** — recorded failure: a single occurrence, the test's 15 s `testTimeout` tripped at
  ~6× its normal duration (~2.6 s quiet), i.e. a stall rather than slowness — the signature of a
  dropped disconnect leaving the subscription holding a dead client, not of a slow-but-progressing
  reconnect. New this wave: read `packages/events/src/subscribe.ts` in full (added by `01ba261`'s
  `reconnecting` boolean). Characterization before any change:
  `scripts/repeat-test.sh 30 packages/events/test/integration/subscribe.test.ts "delivers exactly
  one notification per event across a reconnect"` → **GREEN 30x** (~3.2–3.5 s/run) — as expected
  for a microsecond-wide race, 30 clean loops neither reproduce nor disprove it.

- **Mechanism (by inspection, not by a caught red)** — pre-fix `scheduleReconnect`
  (`subscribe.ts`, then at lines 176–206): the guard `if (closed || reconnecting) return` (176/177)
  makes "a reconnect loop is already in flight" the single piece of state that collapses one
  disconnect's `error`, `error`, `end` trio into one loop (the `01ba261` design, confirmed against
  real Postgres via `pg_terminate_backend`: one drop reliably fires that trio). The hole: the loop
  sets `current = client` (line 196) on a successful reopen and only *then*, after the `while`
  exits, clears `reconnecting = false` (line 203). Any `scheduleReconnect` call landing in that
  span — including one fired by a disconnect on the *newly opened* client, reported at any point
  from the moment `open()` starts through the instant before `reconnecting` clears — hits the
  `reconnecting` branch of the guard and is dropped outright: no flag records that it happened, no
  further loop iteration is scheduled. The subscription is left holding a `Client` that is already
  dead (or about to die) with nothing left to notice. `close()` never sees this either — it only
  knows about `current`, which still points at the dead client — so the subscription silently stops
  delivering forever. The test's one recorded stall at ~6× normal duration is exactly what that
  looks like from outside: no error, just nothing else ever arrives.

- **Change** — replaced the boolean-only guard with a requested/looping pattern in
  `scheduleReconnect` (`packages/events/src/subscribe.ts:184–228`). A new `reconnectRequested`
  boolean is set to `true` on *every* call, unconditionally, before the `reconnecting` check —
  so a call that arrives while a loop is already in flight is now recorded rather than dropped.
  The loop's own condition became `while (!closed && reconnectRequested)`: each pass clears the
  flag at its top, and only exits once a full pass completes with the flag still `false` — i.e.
  once no new disconnect was reported anywhere during that pass, including in the zero-width
  instant right after `current = client`. A pass also now discards whatever stale client is sitting
  in `current` at its start via the file's existing `endDiscardedClient` (previously the loop never
  called it on the disconnecting client, relying on the client already dying on its own; the new
  shape needed it because, on a pass the loop was re-armed into by a disconnect that landed *after*
  a previous pass's successful `current = client`, that client is the one now being discarded, and
  `endDiscardedClient` is the file's one correct way to do that — bounded, listener-safe, matching
  every other abandon site in this file). `close()`, `open()`, and `endDiscardedClient` itself were
  not touched; `close()`'s existing contract (await `reconnectPromise` so it cannot resolve while
  the subscription still has background network I/O in flight) holds unchanged because
  `reconnectPromise` is still assigned once per `scheduleReconnect` "session" and still resolves
  only when the `while` loop actually exits — now correctly gated on `reconnectRequested` too, not
  just `closed`. The `01ba261` comment block (`subscribe.ts:74–87`) was extended, not replaced: it
  still documents why `reconnecting` exists (collapsing the trio into one loop), with an added
  paragraph describing the hole `reconnectRequested` closes. Commit: `8c708a7`.

- **Proof** — new regression test added, `packages/events/test/integration/subscribe.test.ts`
  "recovers when a second disconnect lands right after a reconnect settles" (two `killListeners()`
  calls back to back, no wait between them, then confirms the subscription still converges to a
  live LISTEN and delivers a post-recovery notification exactly once). Ran 30x alone *before* the
  fix: **GREEN 30x** (as expected — the brief predicted it would likely pass even unfixed, since
  the window is narrow; its value is as a permanent regression net, not a reproduction). After the
  fix: `npx tsc --build` clean;
  `scripts/repeat-test.sh 30 packages/events/test/integration/subscribe.test.ts` (whole file, all 9
  tests including the two `close()`-duration timing neighbours) → **GREEN 30x**, stable per-test
  timings across all 30 runs (`close() waits for an in-flight reconnect...` held at 890–944 ms every
  run, no drift from the added `endDiscardedClient` call on the loop's stale client — it resolves
  fast against an already-dying client); `npm test` → `Test Files 131 passed (131)`,
  `Tests 1802 passed (1802)`, no orchestrator daemon running for either run.

- **Residue** — honest note: the race window this fix closes was **never observed red
  deterministically**, in this task or in the milestone's recorded evidence — the single historical
  occurrence was a stall inferred from a blown timeout, not a caught-in-the-act drop, and 60
  combined loop-runs of the target test (30 pre-fix on the existing test, 30 pre-fix on the new
  regression test) stayed green throughout, consistent with a microsecond-wide window that
  repetition alone cannot force. The fix and its regression test are justified by the by-inspection
  mechanism above, not by a reproduced failure. One implementation risk considered and checked
  empirically rather than dismissed by construction: because `reconnectRequested` is now set on
  every `scheduleReconnect` call, including the redundant `error`/`error`/`end` echoes of a single
  disconnect, a naive reading suggests those echoes could re-arm the loop into a spurious extra
  pass even when the newly opened client is healthy. The 30× whole-file proof run above shows no
  sign of this — per-test timings for the reconnect-dependent tests were stable and consistent with
  their pre-fix baselines across all 30 runs — so if it happens at all, it is not currently
  observable in this suite; a future investigation of unexplained added reconnect latency should
  look here first.

## Flake 4 — stream.test.ts delivery tests (:77 and :115)

- **Evidence** — recorded failure: a single observed occurrence, noted in-file as a comment on
  each test ("Observed once; not reproduced in the eight runs after") — the 2026 mitigation was
  the tests' own 20 s `testTimeout` (both tests already carry it: `packages/events/test/integration/stream.test.ts:103`,
  `:124`). New this wave: read `stream.test.ts:77–125` and `packages/events/src/stream.ts:35–95`
  and ran the brief's two-phase measurement. Quiet: `scripts/repeat-test.sh 20
  packages/events/test/integration/stream.test.ts` → **GREEN 20x**, whole-file `vitest run`
  invocation 3699–3807 ms per run; the two delivery tests held steady at 571–578 ms (":77",
  "delivers an event appended after the stream started...") and 1023–1040 ms (":115", "delivers
  an event that was never announced, via the fallback poll..."). Loaded: `nproc - 2` (6, per Task
  2's deviation from literal `nproc` on this host) concurrent `yes > /dev/null`, then
  `scripts/repeat-test.sh 10 packages/events/test/integration/stream.test.ts` → **GREEN 10x**,
  whole-file invocation 4730–7000 ms per run; the two delivery tests rose to 588–661 ms (":77")
  and 1029–1132 ms (":115") — visibly slower under contention but nowhere near either test's
  5000 ms `expect.poll` timeout or 20 s outer budget. **30/30 GREEN total**, no red observed. All
  `yes` processes confirmed killed (`pgrep -x yes`, empty) before and after; no orchestrator
  daemon at any point (verified via `/proc/<pid>/cmdline`, not bare `pgrep -f`, which false-matches
  this session's own invoking shell command text).

- **Mechanism** — not applicable to a "no code change" ruling in the sense of a bug being fixed;
  the suspected mechanism named in the brief (LISTEN/NOTIFY delivery latency before `expect.poll`
  starts, `stream.ts:35`'s `catchUp`) is the thing this measurement pass targeted and did not
  catch red. Structurally: each test's own timeout budget decomposes as setup + a 5000 ms
  `expect.poll` (interval 50 ms for :77, 100 ms for :115) + a fixed settle `wait` (500 ms for :77,
  700 ms for :115) — both waits are poll-bounded (satisfied the instant `seen.length` clears zero,
  not slept-out), so the observed whole-test time is setup-plus-actual-delivery-latency plus the
  fixed settle, never the poll's own ceiling. Backing out the settle wait from the worst observed
  totals puts the setup+delivery portion at ≤161 ms (:77, 661−500) and ≤432 ms (:115, 1132−700)
  against each test's own 5000 ms poll timeout — 31× and ~11.6× headroom respectively on the poll
  phase alone, before even reaching the outer 20 s budget. Task 4's reconnect fix
  (`packages/events/src/subscribe.ts:184–228`) already sits underneath this file's NOTIFY path
  (`createEventStream` → `subscribeEvents`), so any residual reconnect-drop risk that could have
  starved `catchUp`'s notification trigger was closed before this task's runs, consistent with the
  clean 30/30.

- **Change** — none. Margin math: worst single-test time observed across all 30 runs (quiet +
  loaded) was 1132 ms (":115", loaded run 6) against each test's 20 000 ms budget = **17.7×
  headroom** (20000 / 1132). On the inner `expect.poll` specifically — the piece actually exposed
  to LISTEN/NOTIFY delivery latency — worst inferred setup+delivery time was ≤432 ms against its
  own 5000 ms poll timeout = **≥11.6× headroom**. Both tests' waits are `expect.poll`-bounded, not
  sleep-bounded, for the delivery condition itself; the only fixed sleeps (`wait(500)` /
  `wait(700)`) exist deliberately to let a duplicate delivery show up, not to wait for the primary
  assertion, so they cannot themselves produce a timeout-shaped flake. No product or test code
  changed; the in-file "observed once, not reproduced" comment on the first test
  (`stream.test.ts:97–102`, cross-referenced by the second test's comment at `:123`) already is
  the instrumentation this ruling leaves in place — a real recurrence still reports a legible
  `expect.poll` failure naming which assertion was unsatisfied, per the same design Flake 1/3's
  `testTimeout` work already established.

- **Proof** — `scripts/repeat-test.sh 20 packages/events/test/integration/stream.test.ts` →
  **GREEN 20x** (3699–3807 ms/run), unloaded. `scripts/repeat-test.sh 10
  packages/events/test/integration/stream.test.ts` under `nproc - 2` (6) synthetic `yes` load →
  **GREEN 10x** (4730–7000 ms/run). **30/30 total**, no red. Load processes confirmed started and
  killed cleanly (`pgrep -x yes` empty before and after); no orchestrator daemon running for
  either phase.

- **Residue** — the single historical occurrence (pre-M17, "observed once; not reproduced in the
  eight runs after") was never reproduced in this task's 30 combined runs either, consistent with
  a rare, load-dependent delivery-latency tail this measurement's synthetic CPU load did not
  happen to hit (the same category of honest gap Flake 3 documented: repetition alone cannot force
  a microsecond-to-millisecond-wide timing tail). Residual risk is accepted at the measured
  headroom (≥11.6× on the poll phase, 17.7× on the outer budget) rather than eliminated; the
  in-file comments on both tests remain the instrumentation for a future recurrence. No further
  action queued — unlike Flake 3, this task's brief did not call for a new regression test, since
  no mechanism was caught in the act to regress-test against.

## Flake 5 — activity-history.test.ts sparkline buckets

- **Evidence** — three independent clocks decided the sparkline's bucket layout: the test's own
  `new Date()` (`activity-history.test.ts:214`, pre-fix), the server's own `new Date()`
  (`toolCallSparkline`, `apps/web/src/server/activity.ts:119`, pre-fix), and Postgres's `now()` in
  the raw-SQL window (`:124`, pre-fix). `bucketSparkline` (`:95`) already took an injectable `now`;
  nothing else did. A minute boundary crossed between any two of the three readings shifts every
  bucket index by one, which drops the test's `at(9)` (9-minutes-ago) row out of the 10-minute
  window it asserts is inside it — a genuine, if narrow (sub-second-per-minute), race, not a design
  smell caught only by inspection.

- **Mechanism** — `bucketSparkline` keys each SQL row by `nowMinute - floor(row.minute / 60_000)`
  where `nowMinute` comes from whichever `now` the caller passed. Pre-fix, the test computed its
  `at(9)` timestamp against the test's `new Date()`, the SQL window's lower bound came from
  Postgres's `now()`, and the bucket index came from the server's own separate `new Date()` — three
  reads of "now" that are only guaranteed equal if no minute rolls over between them. If the SQL
  `now()` read lands one minute later than the test's `at(9)` computation, the row is now
  (`now() - interval '10 minutes'`)-excluded entirely; if the server's bucketing `new Date()` reads
  one minute later than the test's, `at(9)`'s row shifts to `minutesAgo = 10`, outside
  `bucketSparkline`'s `< SPARKLINE_MINUTES` guard, and is silently dropped rather than landing at
  index 0.

- **Change** — one injected clock threaded through all three reads. `toolCallSparkline(workspaceId,
  now: Date = new Date())` now casts the same `now` into the SQL predicate
  (`ts >= ${now}::timestamp - interval '10 minutes'` — the explicit `::timestamp` cast was necessary
  beyond the brief's literal `${now} - interval '10 minutes'`: Postgres could not otherwise infer
  the bound parameter's type against the `interval` literal and raised `operator does not exist:
  timestamp without time zone >= interval`, matching `ExecutionEvent.ts`'s undecorated
  `DateTime @default(now())` column type) and passes the identical `now` into `bucketSparkline`.
  `buildActivityHistory` gained a trailing `now: Date = new Date()` parameter (after the existing
  optional `options`) and forwards it to `toolCallSparkline`; `buildActivityPage` was left
  unchanged — it composes `buildActivityHistory(workspaceId, EMPTY_ACTIVITY_FILTERS, {})` and only
  ever reuses `history.sparkline`, never re-deriving it, so no threading was needed there and its
  behaviour (and the HTTP route's, which calls `buildActivityHistory` directly with no `now`) is
  byte-for-byte unchanged — the new parameter is trailing and defaulted everywhere. The bucketing
  test (`activity-history.test.ts:213–239`) now computes a mid-minute-aligned `now` (`Math.floor(Date.now()
  / 60_000) * 60_000 + 30_000`, i.e. second `:30` of the current minute) so its own `at(N)`
  timestamps can never straddle a `date_trunc('minute', …)` boundary, and calls
  `buildActivityHistory(fixture.workspaceId, EMPTY_ACTIVITY_FILTERS, {}, now)` directly (rather than
  `buildActivityPage`, which has no way to receive an injected clock) so that one `now` is the only
  clock in play. The route test at `:335` ("Finding 3…") asserts through the real HTTP handler,
  which has no clock to inject; it previously pinned an exact bucket value
  (`sparkline.at(-1)).toBe(1)`) against the real wall clock between an `appendEvent` and the
  request that reads it back — a second, independent (if very narrow) minute-boundary race. Per the
  brief's fork, this was relaxed to a shape/sum assertion
  (`sparkline.reduce((a, b) => a + b, 0)).toBe(1)`) rather than threaded, since threading a clock
  into an HTTP route's public surface for test convenience would change production API shape for no
  product benefit.

- **Proof** — `npx tsc --build` clean. `scripts/repeat-test.sh 20
  apps/web/test/integration/activity-history.test.ts` → **GREEN 20x**, 2815–3000 ms/run, no red.
  `npm run web:build` green (no `next dev` server was running at any point, confirmed via `pgrep -fa
  'next dev'` excluding self-matches, before and after). Full suite after a `.next` cleanup: `npm
  test` → **131 test files / 1807 tests, all passed**, 158.73 s.

- **Residue** — none queued. The fix is structural (one clock, not a timing margin), so there is no
  residual race in `toolCallSparkline`/`buildActivityHistory` to re-measure later the way Flake 4's
  margin-based ruling required. The route-level relaxation at `:335` still leaves that one test
  reading the real wall clock end-to-end (an HTTP handler has no injectable clock), but it now
  asserts shape/sum rather than an exact bucket index, so a minute boundary crossing there can no
  longer flip it red — no further action queued.

## Flake 6 — live-gate Activity hydration

- **Evidence** — post-M16 gate re-run: 2 of 3 runs FAILED — SSR delivered the Activity page (3
  events counted in the rail), then **zero** client requests (no `/activity/stream`, no `/shell`);
  the page never hydrated (spec §2 roster). A cheap, targeted probe (20 loops: fresh Playwright
  context → `page.goto(baseUrl + '/w/<seeded-workspace>/activity', { waitUntil: 'load' })` →
  `page.waitForRequest` on `/activity/stream`, 15s timeout, next dev spawned/torn down identically
  to the gate, `next dev` warm log + console/pageerror/requestfailed collectors cribbed verbatim
  from `gate-m14-fidelity.mjs:525–583`) reproduced NOTHING: **hydrated 20/20**, every loop firing
  its `/activity/stream` request in well under the timeout. New this wave: the gate itself,
  standalone (pre-fix), failed twice while proving at the gate — once on `/analytics` (a page
  already compiled and served 200 three times earlier in the SAME run), once on
  `/w/[workspaceId]/tasks` (also already compiled) — both `SyntaxError: Unexpected end of JSON
  input`, server-side (`[next] ⨯ ... { page: '...' }`) AND client-side (`[browser:pageerror]`),
  both at moments of high concurrent request load (a live run just starting, several routes'
  first-ever compiles landing close together). Reproduced a third time, on `/w/[workspaceId]/tasks`
  and then `/w/[workspaceId]/activity` itself, while iterating on the fix below.

- **Mechanism** — not Activity-specific, and not a hydration bug: `next dev`'s own manifest reader
  (`node_modules/next/dist/server/load-manifest.external.js:36–53`, `loadManifest`) does
  `readFileSync` then bare `JSON.parse`, no lock, no atomic rename, and its cache is invalidated on
  every compile. A request landing while a compile (ANY route's — first-visit OR the shared
  client-HMR runtime chunk that `next dev` recompiles on ordinary navigation regardless of prior
  warm-up, observed as unnamed `✓ Compiled in Nms (524 modules)` lines with no preceding
  `○ Compiling ...`) is mid-rewrite of a shared manifest reads a torn file and throws exactly this
  `SyntaxError`, server-side; the client sees the identical text when the broken flight payload the
  server was mid-stream on reaches the browser and fails to parse there too — one root cause, two
  observation points. The original Activity-hydration symptom (zero client requests after correct
  SSR) is the same class of failure wearing a different face: if the manifest read that resolves
  `/w/<id>/activity`'s OWN route (or the script tag referencing its client chunk) is what tears,
  the page can render server-side from data already in hand while the client bundle that would
  have opened `/activity/stream` never loads at all. The probe's 20/20 clean run doesn't contradict
  this — it never produces the concurrent-compile conditions the full 5-stage gate does (nine pages
  under a live run, several never-yet-hit API routes compiling back to back); the probe is a single
  page, fresh-context, cold-then-idle. This is a `next dev` implementation bug (confirmed by reading
  its own source, not inferred), not something in this repo's page/component code.

- **Change** — three additive layers in `scripts/gate-m14-fidelity.mjs` and `apps/web/next.config.ts`
  (commit `d936551`, hardened by a same-day fix round after code review, commit `ad0debe`, that
  narrowed the retry to the manifest-race signature, added a retry counter printed beside PASS, and
  guarded the second attempt through `fail()` instead of letting it escape raw; see item 3 below and
  the report's fix-round section for the review finding verbatim), from least to most load-bearing:
  1. **Warm every route once before the browser arrives** (`gate-m14-fidelity.mjs`, right after
     `next dev ready`): a filesystem walk of `apps/web/src/app` collects every `route.ts`/`page.tsx`,
     substitutes `[workspaceId]` with the real seeded id and any other dynamic segment with a fixed
     dummy UUID, and issues one plain `fetch` per route (GET; every route that answers GET is
     read-only, verified by hand against all 27 `route.ts` files' exported methods before adding
     this — a GET to a POST/PUT/DELETE-only route 405s without invoking the handler). The SSE route
     (`/activity/stream`) is included and its body cancelled the instant headers land, since it
     never closes on its own. Front-loads every API route the interactive stages hit for the first
     time deep into the run (pause/resume/stop/message/emergency-stop/budget/goal/provider/company/
     org/*/skills/assign/agents-model/agents-permission/dev-reseed), which is where the two live
     reproductions actually happened — NOT on any page's first-ever visit.
  2. **Widen the on-demand-entries buffer, gate-only** (`next.config.ts`): `next dev` evicts a
     compiled route after 60s idle or once more than 5 OTHER routes have been visited since
     (`node_modules/next/dist/server/config-shared.js:66–67` defaults; eviction logic confirmed
     live in `on-demand-entry-handler.js:225–247,438,470`) — trivially exceeded by a 5-stage,
     9-page, multi-minute gate run, so a page warmed by (1) can still need recompiling later. The
     gate now spawns `next dev` with `AITEAMOS_GATE_WARM=1`, and `next.config.ts` reads that var to
     set `onDemandEntries: { maxInactiveAge: 10 * 60 * 1000, pagesBufferLength: 50 }` — ONLY under
     that flag, so an ordinary developer's `next dev` keeps Next's defaults.
  3. **Retry the browser's own navigation once, but ONLY on the manifest-race signature**
     (`gate-m14-fidelity.mjs`, new `gotoReliably` helper, all 15 `page.goto(...)` call sites routed
     through it): (1) and (2) cut how OFTEN the race fires but do not close it — `next dev` still
     recompiles its shared client-HMR chunk on ordinary navigation independent of both. The write
     that tears a read finishes in milliseconds (both live reproductions self-healed on the very
     next request, no code change, seconds later), so `gotoReliably` retries once, after a 300ms
     beat, on a ≥500 response or a thrown navigation. This is the layer that actually closed it:
     proven live during the fix's own verification — `gotoReliably` fired and healed a real 500 on
     `/analytics` (verification run before the counted 3×) and again on `/agents` and `/` (inside
     the counted 3×'s runs 1 and 2), and every one of those runs still finished green end to end.
     **Fix round 2** (code review, same day): the first version retried ANY ≥500/thrown navigation
     indiscriminately, with no accounting and an unguarded second attempt — exactly the shape of
     hazard M16 already named (a gate that settles a page and carries on). `gotoReliably` now (a)
     retries ONLY when `MANIFEST_RACE_SIGNATURE` ("Unexpected end of JSON input") shows up in the
     browser-console buffer or `next dev`'s own stdout tail since that call started — anything else
     fails the gate immediately, through `fail()`, naming the URL and status/error, so a real
     application 500 can no longer heal itself and go green; (b) counts every retry in a
     module-level array, printed beside the PASS line every run (`gotoReliably: no retries this
     run` / `gotoReliably retried N time(s): [urls]`) so a rising rate is visible in GREEN runs,
     not only a `fail()` dump; (c) routes the SECOND attempt through the same signature-blind
     `fail()` guard if it also ≥500s or throws, so a double-failure can no longer escape as a raw
     Playwright error. `pageerror` events — the ONLY channel the two live reproductions' client-side
     signal ever appeared on — are now pushed into the same `browserConsole` array `fail()` dumps
     and `raced()` reads, not merely printed to the terminal (a real, if minor, pre-existing gap:
     the signature check would otherwise have been blind to the one signal it was reproduced with).

- **Proof** — probe: `node --env-file=.env <scratchpad>/hydration-probe.mjs` → **hydrated 20/20**
  (not reproduced; probe never recreates the full gate's concurrent-compile conditions — see
  Mechanism). Gate 3×, chained (`npm run gate:m14-fidelity && npm run gate:m14-fidelity && npm run
  gate:m14-fidelity`), counted from the first attempt after all three Change layers landed:
  run 1 **PASS** (99s, `gotoReliably` retried `/agents` once, healed), run 2 **PASS** (100s,
  `gotoReliably` retried `/` once, healed), run 3 **PASS** (98s, no retry needed) — **3/3 green**,
  `ALL THREE GREEN`. (Pre-fix, for the record: two standalone gate runs 1-1/1-0 red/green on
  `/analytics`; the first chained-3× attempt died on run 1 — `/w/[workspaceId]/tasks` — restarting
  the count per the brief's own rule, not counted above; two more fix iterations — warm-up alone,
  then warm-up + widened buffer, still without the retry — each reproduced the same class of
  failure again, on `/w/[workspaceId]/tasks` and then `/w/[workspaceId]/activity` itself, before
  the retry layer was added and the counted 3× ran clean on the first attempt after.) Fix round 2
  (narrowed retry + counter + guarded second attempt, per code review): a single gate run (a full
  3× was not required for this scoped change, per the review) — **PASS**, `gotoReliably: no
  retries this run` printed beside `PASS: nine pages, one design`, confirming the counter/PASS-line
  wiring on a real run; the manifest race did not fire this particular run, so the signature-gate
  branch itself was not re-exercised live (it was exercised, and matched, twice during fix round 1
  — see above — and is otherwise verified by code review/inspection: `raced()` reads the exact
  channel, `pageerror`, the two live reproductions' client-side signal actually arrived on).

- **Residue** — the underlying `next dev` manifest race is upstream (confirmed in Next 15.5.23's
  own `load-manifest.external.js`), not patched, not reported — this ledger entry is the record.
  `gotoReliably`'s one retry is what actually closes it for this gate, and it is a dev-server-only
  hazard (`next start`/production serving loads manifests once at boot, never mid-request) with no
  equivalent risk in the shipped app. If a future Next upgrade fixes the torn read upstream, layers
  (1)–(3) stay correct as defensive belt-and-braces (idle cost: ~30 warm-up requests and a handful
  of possible retries, all before or during a gate run that already takes ~100s). If it recurs
  server-side even through a THIRD retry attempt on some future machine/load profile, that is the
  next signal to escalate to `next dev --turbo` (a different, actively-developed dev compiler) or
  to file the manifest-write race upstream with the two live reproductions' exact log lines as
  evidence, both preserved in this entry.
