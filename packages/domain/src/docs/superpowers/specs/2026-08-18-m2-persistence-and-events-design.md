# M2 — Persistence and Event Log: Design Specification

**Date:** 2026-08-18
**Status:** Approved (brainstormed with the user, section by section)
**Parent spec:** `docs/superpowers/specs/2026-08-17-ai-team-os-design.md` (binding authority)
**Predecessor:** M1 domain core, merged at `067a336` — 79 tests, zero I/O

---

## 1. Purpose and Scope

M2 gives the pure domain core a place to live. It produces a Postgres schema, migrations, seed
data, a single-gate event writer, and a LISTEN/NOTIFY subscriber. The parent spec's verification
criterion is literal: **a seeded database and observed notifications.**

M2 deliberately does NOT build: the orchestrator, any real process execution, the SSE route
(M4), or the *behaviour* of the four items carried over from M1's final review. It builds the
schema those behaviours will need, and nothing more.

---

## 2. Decisions Confirmed During Brainstorming

| # | Decision | Reason |
|---|---|---|
| D1 | Postgres via Docker Compose, not SQLite | SQLite has no LISTEN/NOTIFY, and Prisma's SQLite connector does not support `enum`. Both are load-bearing here. |
| D2 | Integration tests against a real Postgres | M2's whole value is I/O. A mocked NOTIFY proves nothing. |
| D3 | Schema accommodates the four carried M1 items; behaviour stays in M8 | Migrations against a populated table are the expensive part; behaviour is not. |
| D4 | Local `pre-push` git hook, not GitHub Actions | The repository has no remote. A workflow file would enforce nothing today. |
| D5 | Application-level `appendEvent()` gate, not a database trigger | Trigger logic lives in migration SQL, cannot be unit-tested, and is the hardest thing on this branch to hold to the project's evidence standard. |

---

## 3. Environment

`docker-compose.yml` at the repository root:

- `postgres:17-alpine`, version pinned — the same image runs in every context.
- Host port **5433**, not 5432. A locally installed Postgres on 5432 would otherwise be reached
  silently, and connecting to the wrong database is the least visible failure in this milestone.
- Named volume for data, plus a healthcheck so `docker compose up -d` is a usable precondition
  for the test suite rather than a race.

`.env.example` carries `DATABASE_URL` and `TEST_DATABASE_URL`. `.env` stays git-ignored.

---

## 4. Package Layout Additions

Per parent spec §3.2:

```
packages/
  db/       Prisma schema, migrations, seed, row->domain mappers
  events/   appendEvent (write gate) + subscribeEvents (LISTEN)
```

`packages/domain` remains untouched and pure — zod only, no `node:` imports, no Prisma.

`packages/events` carries **two different connection models by design**: Prisma for writing,
a raw long-lived `pg` client for listening. Prisma cannot `LISTEN`; it has no facility for a
connection that stays outside the pool waiting for asynchronous notifications.

---

## 5. Data Model

The table list is the parent spec's §11.1, unchanged. The decisions below are the ones §11.1
does not settle.

### 5.1 Enum parity with the domain unions

Postgres enums mirror the TypeScript unions exactly:

| Enum | Members | Source of truth |
|---|---|---|
| `TaskStatus` | 12 | `packages/domain/src/task/state.ts` |
| `RunStatus` | 9 | `packages/domain/src/run/state.ts` |
| `Actor` | 3 (`human`, `agent`, `system`) | `packages/domain/src/events/schema.ts` |

Prisma does not derive enums from TypeScript, so these are maintained by hand. They are protected
by an integration test that enumerates every union member and asserts a matching enum value —
a full enumeration, not a sample.

### 5.2 `EventType` is narrower than the catalogue, on purpose

The parent spec §6.2 lists roughly forty event types. M1 implemented ten. The database enum
contains **exactly the ten implemented types**, and grows by migration as each new type gains a
Zod union member.

The reason is a one-way door: the log is append-only. If the enum is wider than the Zod union, a
row can be written that `parseExecutionEvent` rejects. That row cannot be deleted, and every
consumer reading forward from a lower `seq` hits it forever. The enum must never lead the union.

### 5.3 `seq`

The parent spec calls for `bigint`. M1's envelope validates `seq` as
`z.number().int().nonnegative()`, and Prisma maps `BigInt` to JavaScript `BigInt` — the two do
not meet.

Resolution: the column is `BigInt` identity (the correct database type), and `packages/db`
converts to `Number` at the read boundary. M1's schema is not modified. The 2^53 ceiling is
recorded here as an explicit assumption: it is nine quadrillion events, and the conversion is the
place to revisit if that ever stops being absurd.

### 5.4 Branded ids are recovered at the database boundary

`packages/domain/src/events/schema.ts` types ids as plain `string`, so `ExecutionEvent.taskId` is
`string | undefined`. Rather than have every consumer cast, `packages/db` exports row-to-domain
mappers that re-brand: `taskId(row.id)`, `agentId(row.agentId)`, and so on. The brands are lost at
the event boundary and regained in exactly one layer.

### 5.5 Schema accommodations for the carried M1 items

Behaviour is M8's. These columns exist from M2 so that M8 is not a migration against live data.

| Carried item | M2 accommodation |
|---|---|
| QA-review runs unrepresentable | `AgentRun.kind`: `implementation \| review \| planning` |
| Guardrails cannot express "pause active runs" | `AgentRun.pauseReason`: `human \| guardrail \| emergency_stop` |
| The two unlinked `maxAttempts` | `Workspace` holds the guardrail configuration; `Task.maxAttempts` is copied from it at creation, and the seed performs that copy |

`AgentRun.pauseReason` is nullable — it is null for a run that was never paused, and set at the moment of pausing. `AgentRun.kind` is not nullable and defaults to `implementation`.
| Branded ids stop at the event boundary | §5.4 above |

---

## 6. Event Write Path

### 6.1 `appendEvent()`

`packages/events` exports one write gate. Within a single transaction:

1. `INSERT ... RETURNING *` — the database assigns `seq` and defaults `ts`.
2. Map the returned row to the domain shape (re-branding ids per §5.4).
3. `parseExecutionEvent(mapped)` — on failure, throw, which rolls the transaction back.
4. `pg_notify('events', { seq, workspaceId })` — id only, never the payload (parent spec §6.3:
   NOTIFY has an 8KB limit a large tool output would exceed).

### 6.2 Why validation runs on the returned row

At write time `seq` does not exist yet, so the envelope cannot be validated before the insert.
Validating the *returned row* turns that obstacle into a guarantee: the object validated is the
row that will be read, not an object we intended to write. Combined with §5.2, "every row in the
log parses" becomes an enforced invariant rather than a hope.

### 6.3 NOTIFY is transactional

Postgres delivers `NOTIFY` only on commit. A rolled-back write therefore cannot produce a
notification, and the atomicity of §6.1 rests on database semantics rather than on code
discipline. This is what makes the application-level gate (D5) acceptable without a trigger.

### 6.4 Single-writer, and why `seq` ordering is safe

A `BIGSERIAL`-style identity column can produce out-of-order commit visibility under concurrent
writers: a transaction holding a lower `seq` may commit after one holding a higher `seq`, and a
consumer reading `seq > lastSeq` would skip the lower row permanently.

This is closed by the parent spec's single-writer rule (§3.1): only the orchestrator writes, and
it writes serially. Commit order therefore matches `seq` order.

**This assumption is load-bearing and silent.** The moment a second writer is introduced — the
web app writing directly, or the orchestrator parallelising its own writes — this breaks with no
error message and no failing test. Any such change requires revisiting this section first.

### 6.5 The gate is a reviewable convention, not an enforced barrier

`packages/db`'s barrel does not export the raw Prisma client, so `ExecutionEvent` has one write
path by convention. This is the price of choosing the application-level gate over a database
trigger, and it is paid here.

**Amended after implementation (M2).** As first written this section claimed the gate was
protected *by not exporting the alternative*. That protection does not exist and cannot: §4 places
`appendEvent` in `packages/events`, so the client must cross a package boundary to reach it, and
`packages/db/package.json` therefore declares a `./client` subpath export. Any package can import
it, and `stream.test.ts` deliberately does in order to plant rows the gate would have refused.

What the arrangement actually buys is that the client is absent from the barrel every other
consumer imports, so a bypass takes a deliberate, greppable second import and is visible in
review. There is no runtime check behind it. `grep -rn "@slave-of-ai/db/client" packages` is the
audit. See `docs/event-model.md` for the same statement at the implementation level.

---

## 7. Subscription

### 7.1 NOTIFY is a wake-up, not a delivery mechanism

`subscribeEvents()` holds a dedicated `pg` connection issuing `LISTEN events`. On each
notification the consumer reads rows with `seq > lastSeq`.

The payload of the notification is therefore advisory. A dropped or coalesced notification loses
nothing: the next one triggers a read that catches up everything in between. Reconnection needs
no special handling beyond re-issuing `LISTEN` — the read is `seq`-driven.

### 7.2 The fallback poll

One gap remains: if a notification is missed and no further event ever arrives, the consumer
waits forever. A low-frequency fallback read (every 5 seconds) closes it.

The poll is a safety net, not the transport. Its interval is deliberately too slow to satisfy
M6's one-second criterion, so it cannot quietly become the mechanism the system relies on.

---

## 8. Migrations and Seed

Prisma Migrate, with migration files committed. `migrate dev` in development, `migrate deploy`
in test setup.

The seed builds the parent spec §13.1 data: **Atlas** (AI Manager); Engineering — **Alex**
(Backend), **Emma** (Frontend), **Daniel** (DevOps), **Maya** (QA); Security — **Sarah**;
Product — **John** (BA); Marketing — **Oliver** (SEO); workspace **Checkout Platform**.

Two properties:

- Tasks cover **all twelve `TaskStatus` values**, so every state has a real example on screen
  when M4 arrives.
- The seed is idempotent by truncate-and-reseed, with deterministic ids, so tests and the UI can
  reference fixed rows. Upsert-based guessing is not used.

The seed also performs the `Task.maxAttempts` copy from the workspace guardrail configuration
(§5.5) — the first place that link exists in real data.

---

## 9. Testing

### 9.1 Against a real database

Every persistence test runs against the Docker Compose Postgres. No repository mocks.

`npm test` runs both vitest projects — the fast domain unit project and the serial database
integration project. There is no separate command that a person could forget to run, and no
configuration in which a green `npm test` means the database tests did not execute.

### 9.2 Isolation is not transaction rollback

The usual technique — wrap each test in a transaction and roll it back — is **unusable here**.
NOTIFY is delivered only on commit (§6.3), so under rollback isolation no notification is ever
produced and every subscription test would pass for the wrong reason.

Isolation is instead: a dedicated test database, truncated between tests.

### 9.3 The database suite runs serially

Parallel workers share the `events` channel and would receive each other's notifications. The
integration project runs single-threaded.

### 9.4 Integration tests never skip silently

If the database is unreachable, the suite is **red**, not green. A test that skips when its
dependency is absent reports success for work it did not do — the precise failure class this
project has spent M1 eliminating.

### 9.5 The four event-path tests

| Test | Proves |
|---|---|
| A valid event is written and returned parsed | The happy path, end to end |
| An invalid payload leaves **no row** | §6.1 step 3 actually rolls back |
| A subscriber receives `{ seq, workspaceId }` | LISTEN/NOTIFY genuinely works — M2's stated criterion |
| A rolled-back transaction delivers **no notification** | §6.3's atomicity claim, tested rather than asserted |

The last two are the milestone's evidence: "notifications observed" is a test result, not a
manual observation.

---

## 10. Enforcement

`.githooks/pre-push`, committed to the repository and activated with
`git config core.hooksPath .githooks`. It runs `npm run typecheck && npm test` and refuses the
push on failure, with a clear message when the failure is simply that Docker is not running.

A hook in `.git/hooks` would exist only on one machine; this one is versioned with the code.
The `core.hooksPath` setting is per-clone, so it belongs in the README and in M2's verification
checklist.

This closes the gap M1's final review named: `npm run typecheck` was wired to nothing, and the
branded-id guarantee rests on a compile-time-only test that passes vacuously under vitest.

---

## 11. Verification — M2 is complete when all are true

1. `docker compose up -d` yields a healthy Postgres on 5433.
2. `prisma migrate deploy` applies cleanly to an empty database.
3. The seed produces the §13.1 org and tasks covering all twelve statuses.
4. The enum-parity test passes by full enumeration of all three unions.
5. All four event-path tests (§9.5) pass against the real database.
6. `npm run typecheck` and `npm test` are green, and the pre-push hook runs them.

---

## 12. Deferred, and why

| Item | Deferred to | Reason |
|---|---|---|
| Behaviour for the four carried M1 items | M8 | Needs the orchestrator; only the schema is needed now |
| SSE route and `Last-Event-ID` replay | M4 | Consumes this log; nothing here blocks it |
| The remaining ~30 event types | M2+ as emitted | §5.2 — the enum must never lead the Zod union |
| `Checkpoint` persistence | M3 | Its shape depends on M0's session-id findings, now recorded in ADR 0001 |
| GitHub Actions | When a remote exists | D4 |

---

## 13. Open Risks

| Risk | Mitigation |
|---|---|
| Single-writer assumption broken silently (§6.4) | Recorded here explicitly; any second writer requires revisiting this section |
| Hand-maintained enum parity drifts | Full-enumeration integration test (§5.1) |
| `Number` conversion of `seq` (§5.3) | Documented ceiling; conversion isolated to one boundary |
| Integration suite slows the loop | Domain unit tests stay separate and fast; only the DB project is serial |
