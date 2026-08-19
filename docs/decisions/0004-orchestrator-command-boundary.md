# ADR 0004 — The orchestrator reacts; `decide()` stays pure

**Status:** accepted (M3)
**Date:** 2026-08-19
**Context:** spec §3.2, §12.3; parent spec §7

## The decision

`decide()` returns two command kinds — `start_run` and `halt` — and M3 **did not widen that union**,
even though M3 is where the orchestrator learned to do many more things than start and stop runs.

Everything else M3 does — provisioning a worktree, running verify, writing a checkpoint, moving a
task to `rework`, sweeping a run past its tool-call ceiling — is the orchestrator **reacting to
observed state**, not executing a command the domain asked for.

## Why

Because the alternative changes what `World` is.

A `run_verify` command would have to carry the worktree path. A `cancel_run` command would have to
carry a pid. A `write_checkpoint` command would have to carry a session id and a settings file path.
Each of those is process state, and the moment `World` carries process state, `decide()` is no
longer a pure function of the domain — it is a function of the machine the daemon happens to be
running on. The value of the pure core is precisely that **it does not know processes exist**: it
can be tested exhaustively, it cannot be flaky, and it can be reasoned about without a database or a
child process anywhere in sight.

The boundary is therefore drawn at the same place the parent spec draws it: the domain decides *what
should happen next given the state of the work*, and the orchestrator decides *what to do about the
state of the machine*.

## What it costs, stated plainly

**`decide()`'s tests do not cover M3's reactive behaviour.** The scheduler's test suite says nothing
about whether a gate failure halts a workspace, whether a rework adopts its own worktree, or whether
a dead pid is concluded. That is a real hole, and it is paid for deliberately by spec §12.3's
mutation requirements: every reactive behaviour M3 added is pinned by a mutation that must fail a
named test.

The milestone's record suggests the cost is being paid honestly. Across Tasks 11–16 the mutation
passes found, among other things:

- a test whose fixture could not distinguish the property it was named for (a single-branch repo
  makes "forked from the base branch" and "forked from HEAD" the same commit);
- a swap mutation that proved only that two handlers differed, not that either was right;
- a test that stopped one tick before the property it guarded inverted;
- a boundary test seeded away from its own boundary;
- a test whose setup never reached the code path it was guarding.

None of those would have been caught by type-checking, by review of the diff, or by the tests
themselves. They were caught by asking, of each test, *what wrong implementation still passes this?*

## The alternative that was rejected

**Widen the `Command` union** so the orchestrator becomes a dumb executor of domain instructions.

Rejected because it inverts the dependency that makes the core worth having. `World` would grow a
field per process concern, `decide()` would grow a branch per runtime failure mode, and the pure
function's exhaustive tests would start depending on the shape of a child process's stdout. The
orchestrator would get simpler and the thing that guarantees correctness would get worse.

## Consequences

- `packages/domain` still imports nothing and touches no I/O.
- `packages/providers` still never imports `packages/db` (spec §2.1) — the adapter speaks
  `RuntimeEvent`, and the orchestrator is what translates that into rows and events.
- Every reactive behaviour needs its own integration test *and* a mutation proving that test bites.
  This is the tax, and it is the only thing standing between M3's behaviour and a regression nobody
  notices.
