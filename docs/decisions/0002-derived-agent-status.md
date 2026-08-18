# ADR 0002 — Agent Status Is Derived, Never Stored

**Status:** Accepted
**Date:** 2026-08-17
**Context:** Spec §4.1-4.2

## Decision

`Agent` has no status column. Agent status is computed by `deriveAgentStatus(activeRun)` from
the agent's active `AgentRun`.

## Rationale

The original brief gave the agent a twelve-value status enum that overlapped with task and run
status. Three writable sources for one truth drift apart under concurrency; the observable
symptom would be an agent shown as "working" on a task that is blocked.

## Consequences

- The UI reads a computed value; no reconciliation job is needed.
- Statuses that belong to work (`blocked`, `reviewing`, `done`) live on `Task`; statuses that
  belong to execution (`paused`, `stopped`) live on `AgentRun`.
- Adding a new run status requires updating exactly one mapping function.
