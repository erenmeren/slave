# The Event Log

M2's event log is the audit trail of everything the system does: task and run lifecycle, slave
messages, guardrail trips. This document describes what was actually built — the envelope shape,
the single write gate, the notification model, and the assumption the read path depends on but
never checks.

Design context: `packages/domain/src/docs/superpowers/specs/2026-08-18-m2-persistence-and-events-design.md`
§5-7, and parent spec §3.1, §6.

## Where each piece lives

| Concern | File |
|---|---|
| Domain event union (`ExecutionEvent`, `parseExecutionEvent`) | `packages/domain/src/events/schema.ts` |
| Domain type ↔ database enum mapping (`EVENT_TYPE_BY_DOMAIN_TYPE`) | `packages/db/src/enums.ts` |
| Row → domain mapping (`toExecutionEvent`) | `packages/db/src/mappers.ts` |
| The write gate (`appendEvent`) | `packages/events/src/append.ts` |
| `LISTEN` subscription (`subscribeEvents`) | `packages/events/src/subscribe.ts` |
| Catch-up reads (`readEventsSince`) | `packages/events/src/read.ts` |
| Notification-driven stream with fallback poll (`createEventStream`) | `packages/events/src/stream.ts` |

## The envelope

`ExecutionEvent` (`packages/domain/src/events/schema.ts`) is a Zod discriminated union on `type`,
one member per event type, each with its own `payload` shape. Every member shares an envelope of
`seq`, `ts`, `workspaceId`, optional `taskId` / `slaveId` / `runId`, and `actor`.

`taskId` was optional in the schema from the start, and workspace-scoped events have always
omitted it — the halt announcement's and budget warning's `guardrail.tripped`, M8a's emergency
stop. What M8b's planning run changed is that a whole RUN's event stream now carries no `taskId`:
the run has no `Task` row (`SlaveRun.taskId: null`, see `docs/domain-model.md`'s
scoping-invariant section), so its `run.started`, `run.output`, `run.failed`,
`workspace.plan_created` and so on carry `workspaceId`/`slaveId`/`runId` only. A consumer that
assumed run-scoped events always name a task would break on the first planning run it observed.

At write time the fields come from two different places:

- **`seq` and `ts` come from the database.** `appendEvent` inserts without them; Postgres assigns
  `seq` (an autoincrementing `BigInt` primary key) and defaults `ts` to `now()`. Neither can be
  supplied by the caller.
- **Everything else — `type`, `workspaceId`, the optional ids, `actor`, `payload` — comes from the
  caller**, via the `AppendableEvent` input to `appendEvent`.

`seq` is stored as Postgres `BigInt` but the domain schema validates it as
`z.number().int().nonnegative()`; `toExecutionEvent` in `packages/db/src/mappers.ts` narrows with
`Number(row.seq)`, which is exact only below 2^53 — nine quadrillion events, recorded there as the
place to revisit if that ceiling ever stops being absurd.

Branded ids (`TaskId`, `SlaveId`, `RunId`) do not survive the event boundary — the schema types
them as plain `string` — so `toExecutionEvent` re-brands `row.taskId` / `row.slaveId` /
`row.runId` with `taskId()` / `slaveId()` / `runId()` on the way out.

## `appendEvent`: the single write gate

`appendEvent` (`packages/events/src/append.ts`) is the only function in this codebase that writes
an `ExecutionEvent`. `packages/db` does not export the raw Prisma client from its package root;
the client lives behind the `@slave-of-ai/db/client` subpath declared in `packages/db/package.json`'s
`exports` map, and `packages/events` is the one package that imports it — from `append.ts`,
`read.ts`, and two integration tests.

**This is a convention, not a barrier.** Nothing stops another package from importing
`@slave-of-ai/db/client` and calling `executionEvent.create` directly: the subpath is a declared,
public export, and `stream.test.ts` does exactly that on purpose, to plant rows the gate would have
refused. (`append.test.ts` imports the same subpath, but only for `TRUNCATE`, `count()`, and its
constraint-trigger fixture — it never bypasses the gate to write an event.) It has to be
declared — the design spec places `appendEvent` in `packages/events`, so the client must cross a
package boundary to reach it, and a package-private client would make the gate itself
unimplementable. What the arrangement actually buys is that the raw client is absent from the
barrel every other consumer imports, so reaching it takes a deliberate, greppable import of a
second subpath. That makes a bypass visible in review; it does not make one impossible, and there
is no runtime check behind it either. `grep -rn "@slave-of-ai/db/client" packages` is the audit.

Inside a single `prisma.$transaction`:

1. `tx.executionEvent.create(...)` — an `INSERT ... RETURNING *`. The database assigns `seq` and
   defaults `ts` here, so they cannot exist before this step.
2. `toExecutionEvent(row)` validates the **row that came back**, not the object the caller
   supplied.
3. On success, `tx.$executeRaw` calls `pg_notify('events', ...)` with `{ seq, workspaceId }`.
4. On validation failure, `appendEvent` throws, which rolls back the transaction.

Validating the returned row rather than the input is what turns "every row in the log parses"
into an invariant rather than a hope: the object under test is the exact one a reader will later
fetch and parse. If `appendEvent` validated its input instead, a Prisma-level coercion or a
database default applied between insert and read could still land an unparseable row — validating
what the database actually stored closes that gap.

Insert, validate, and notify all happen in the same transaction, so a validation failure (which
rolls the transaction back) and a successful notify (which Postgres delivers only on commit) can
never both occur for the same write. A rolled-back append cannot announce itself.

### Why NOTIFY carries only `{ seq, workspaceId }`

Postgres `NOTIFY` payloads are capped at 8KB. Tool-call output and other event payloads can exceed
that easily, so the notification carries ids only, never the payload. `subscribeEvents` treats the
notification purely as a wake-up signal — see below.

## The single-writer assumption — load-bearing and silent

**This is the one fact in this document that costs the most to get wrong, and the code will not
tell you if you break it.**

`readEventsSince` (`packages/events/src/read.ts`) and the consumer loop in `createEventStream`
(`packages/events/src/stream.ts`) both read forward with `seq > lastSeq`, advancing `lastSeq` to
the highest `seq` seen. This is safe only because `seq` is assigned at `INSERT` time but a row
becomes visible to other transactions only at `COMMIT` time. Under concurrent writers, a
transaction holding a *lower* `seq` can commit *after* one holding a higher `seq` — and a consumer
that has already advanced `lastSeq` past that higher value will never see the lower-`seq` row: it
is permanently skipped, with no error and no failing test.

This is closed only by the parent spec's single-writer rule (§3.1, referenced from the design spec
§6.4): the orchestrator is the sole writer, and it writes serially, so commit order matches `seq`
order. Nothing in `appendEvent`, `readEventsSince`, or `createEventStream` enforces this — there is
no lock, no serialization check, nothing that would fail loudly if a second writer appeared (a web
app writing directly, or the orchestrator parallelising its own writes). Anyone introducing a
second writer must revisit this section, and the ordering guarantee, first.

## Notification as wake-up, not delivery

`subscribeEvents` (`packages/events/src/subscribe.ts`) holds one dedicated `pg.Client` running
`LISTEN events`. A notification's payload is advisory only — it exists to trigger a `seq`-driven
catch-up read, not to deliver the event itself. This means a dropped, coalesced, or duplicated
notification loses nothing: the next one (or the fallback poll) triggers a read that catches up
everything since `lastSeq`, and reconnection needs no special handling beyond re-issuing `LISTEN`.

Two behaviours here matter to whoever wires this into an SSE route (M4):

- **`subscribeEvents()` can reject.** The initial `open()` is bounded by two independent 2000ms
  deadlines (`connectionTimeoutMillis` for connect/handshake, `query_timeout` for the `LISTEN`
  query) rather than one shared budget. If the first connect attempt exceeds either bound,
  `subscribeEvents()` rejects instead of hanging.
- **`close()` can take up to roughly 6.0 seconds.** `close()` awaits any reconnect loop already in
  flight, and the loop's control flow means only one of two mutually exclusive windows sets the
  ceiling — not the sum of every phase the loop can touch (an earlier pass over this doc claimed
  ~8.25s by summing all five as if a single `close()` could pay them all; the loop's `if (closed)
  break` checks make that unreachable):

  - **`close()` lands while a pass is mid-`open()`.** A single failing attempt can burn up to both
    of `open()`'s independent 2000ms deadlines sequentially — connect succeeding just under its
    budget, then `LISTEN events` stalling out its own — before the query timeout finally rejects
    it (up to 4000ms of stall), plus that failed attempt's client being discarded through the same
    bounded `end()` (up to 2000ms more) = **6000ms**. Once `open()` settles, the loop's `while
    (!closed && reconnectRequested)` check now reads `closed` as true and exits immediately — no
    top-of-pass discard or retry delay stacks on top of this window.
  - **`close()` lands at the top of a pass**, before `open()` is even called again: the
    stale-client discard (`endDiscardedClient(stale)`, up to 2000ms) then the 250ms retry delay
    (`RECONNECT_DELAY_MS`) = **2250ms**, because the loop's post-delay `if (closed) break` fires
    right after and the pass never reaches `open()` at all.

  max(6000, 2250) = 6.0s.

  Two things are easy to get wrong here. The top-of-pass discard is part of the *2250ms* budget,
  not a formality: it runs on every pass, including the very first one after a disconnect, before
  the retry delay even starts — but that window's ceiling is still below the mid-`open()` one, so
  it never becomes the binding case. And a slow `close()` does **not** require a reconnect loop at
  all — discarding a live client goes through the same bounded `end()`, which has been measured at
  2007ms against a half-open peer with nothing else in flight. Teardown code must not assume
  `close()` resolves quickly, and should budget past 6.0s rather than at it.

### The fallback poll

`createEventStream` (`packages/events/src/stream.ts`) also runs a poll every
`DEFAULT_POLL_INTERVAL_MS` (5000ms), in case a notification is missed and no later event ever
arrives to trigger a catch-up read. This interval is deliberately slow — well above the one-second
responsiveness the parent spec sets for M6 — so the poll can never quietly become the mechanism the
system relies on; the notification path is expected to carry normal-case latency.

Each poll (and each notification-triggered catch-up) drains at most `DEFAULT_READ_LIMIT` = 500
events via `readEventsSince`'s default `limit`. A backlog larger than 500 events therefore catches
up in 500-event steps, one per poll interval (or per notification, if notifications keep arriving)
— not all at once.

## `readEventsSince` reads the whole log — there is no workspace filter

`readEventsSince(seq, limit)` queries `ExecutionEvent` for rows whose `seq` column exceeds the
`seq` argument, ordered by `seq`, across **all workspaces** — there is no `workspaceId` argument
or `WHERE workspaceId = ...` clause.
`createEventStream` inherits this: its `onEvent` callback fires for every workspace's events, not
just one. This is invisible from either function's signature. Any per-workspace view — including
M4's SSE route — is expected to filter client-side (or route-side) on `event.workspaceId`, not to
rely on the read layer to have scoped it already.

## The `EventType` enum's one-way door

The Postgres `EventType` enum (`packages/db/prisma/schema.prisma`) currently has exactly the 28
members the Zod union in `packages/domain/src/events/schema.ts` supports — no more. This is
deliberate and must stay true in one direction only: **the database enum must never lead the Zod
union.**

Six of the 28 are M8's additions: `task.review_started`, `task.review_approved`,
`task.review_rejected` (the review pass, §3 of the M8a design), `task.merge_failed` (the merge
queue), and `workspace.goal_set`, `workspace.plan_created` (the planning run, M8b). Each landed
through the same three-part change the next paragraph describes, and each extends the M6/M7
maps in `apps/web`: the activity-card registry (a `satisfies Record<DomainEventType, ...>`) fails
the TypeScript build on a missing arm, while `TYPES_BY_KIND` groups types into arrays the
compiler cannot prove complete — its exhaustiveness is enforced by the runtime completeness test
its own comment points at, not by the build.

The log is append-only: a row, once written, cannot be deleted. If the database enum contained a
member the Zod union did not recognize, a row with that `type` could be inserted (nothing at the
database layer would stop it), and every consumer reading forward past that row would hit
`parseExecutionEvent` failure forever — `readEventsSince` throws rather than skipping an
unparseable row, by design (see its docstring), so a stream would be permanently broken rather than
silently degraded.

Adding a new event type is therefore a three-part, Zod-union-first change: add the member to the
`executionEventSchema` discriminated union, add a matching value to the `EventType` Postgres enum
via a migration, and add the mapping in `EVENT_TYPE_BY_DOMAIN_TYPE`
(`packages/db/src/enums.ts`). That map is declared `as const satisfies Record<DomainEventType, string>`,
so a Zod union member added without a corresponding entry fails the TypeScript build — the union
leading the enum is enforced at compile time; the enum never leading the union is a discipline the
migration author must hold, since nothing prevents the database enum from being widened on its own.
