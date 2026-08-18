# ADR 0003 — The Event Log Has One Application-Level Write Gate

**Status:** Accepted
**Date:** 2026-08-18
**Context:** M2 design spec §6, parent spec §6.3

## Decision

`appendEvent()` in `packages/events` is the only write path to `ExecutionEvent`. It inserts,
validates the returned row against the domain's Zod union, and issues `pg_notify` — all inside one
transaction. `packages/db` does not export the Prisma client from its barrel; the one package that
needs it (`packages/events`) imports `@ai-team-os/db/client` explicitly.

## Rationale

A database trigger would make the notification impossible to skip regardless of how a row was
written. It was rejected because the logic would live in migration SQL: untestable from the test
suite, awkward to version, and the hardest thing on the branch to hold to this project's standard
that every load-bearing behaviour has a test that fails when it breaks.

The application-level gate gets the same atomicity from Postgres rather than from discipline:
NOTIFY is delivered only on commit, so a rolled-back append cannot announce itself. What it does
require is that no second write path exists — hence the export rule.

## Consequences

- Every row in the append-only log is guaranteed parseable by `parseExecutionEvent`.
- A new event type requires three coordinated changes: the Zod union, the `EventType` enum, and
  `EVENT_TYPE_BY_DOMAIN_TYPE`. The `satisfies` clause on that map fails the build if the union
  moves without it.
- If a future writer bypasses `appendEvent`, the guarantee is gone and nothing will report it.
  That is the cost of choosing the gate over the trigger. Note that the export rule is a
  convention, not a mechanism: `@ai-team-os/db/client` is a declared public subpath (it has to be —
  `appendEvent` lives in a different package from the client), so any package can import it. Keeping
  it out of the barrel makes a bypass a deliberate, greppable act rather than an impossible one.
  See `docs/event-model.md` for the audit command.
