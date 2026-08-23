# ADR 0005 — Execution Closure: Review, Merge, and the Guardrail Wiring That Backs Them

**Status:** Accepted
**Date:** 2026-08-22
**Context:** `docs/superpowers/specs/2026-08-17-ai-team-os-design.md` §9 (Review and Advance),
§9.2 (guardrails), §10 (git model, D10 auto-merge through a serialized queue), D6 (Definition of
Done); `docs/superpowers/specs/2026-08-22-m8a-execution-closure-design.md`.

## Decision

Four things, closing M8a's half of the M8 gate ("a task → merged branch, unattended"):

1. **Definition of Done is verify green AND independent QA approval, not verify green alone.**
   A task that passes its own verify commands moves to `reviewing`, not `done`. A dedicated
   `reviewer`-role agent — a different agent than the author in the seeded org by role
   convention, though nothing in `review.ts` structurally excludes an agent who also implements
   (free-form roles, ADR 0006, make that combination expressible) — judges
   the diff and returns a Zod-validated `{ verdict: "approve" | "reject", reason }`. Only
   `approve` moves the task toward merge; `reject` re-enters the ordinary rework path with the
   reviewer's reason as the next run's input, the same channel a failed verify already uses.
2. **The merge queue is serialized by construction, not by convention.** One `Task.mergeClaimedAt`
   claim column, set by a conditioned `updateMany`, means at most one task merges per tick per
   workspace even when two ticks overlap. A crashed claim — no live daemon behind a non-null
   `mergeClaimedAt` — is released back to `rework` by the startup reconcile pass, the same
   orphan-run pattern §3.4 already applies to runs, applied here to a claim instead.
3. **`autoMerge` is consulted by the merge pass, not by review conclusion.** An approved task
   always moves to `merging`; whether that pass actually merges is a separate question answered
   at merge time, not baked into the state machine as a second edge.
4. **Retry caps escalate by the `run.failed` rows already on the record, not by inventing a new
   guardrail type.** The review pass caps itself at 2 review runs per implementation attempt
   (counted by review runs — any status — newer than the latest implementation run's
   `startedAt`); the planning pass at 2 FAILED runs per goal-set. At either cap, dispatch goes
   silent rather than emitting a third event — the failed rows are the escalation an operator
   reads.

## Rationale

### Why review is a second gate, not a stricter verify

Verify answers "does the code the agent wrote pass the tests the agent wrote against." That is
necessary and insufficient: an agent that writes a shallow test suite alongside shallow code
passes its own bar by construction. A second agent, with no stake in the diff having been theirs,
judging it against the task's actual intent, catches exactly the class of defect an author-graded
verify cannot. Spec D6 names this precisely: Definition of Done requires independent QA approval
in addition to a green verify. Making the reviewer literally a different agent (never a
self-review pass) is what keeps "independent" from becoming a formality.

### Why the merge queue's serialization is structural, not scheduled

Two individually green branches can still break `main` together — that is the entire hazard a
merge queue exists to prevent, and it is not a hazard "run merges one at a time in practice"
protects against, because "in practice" is exactly what a database crash or an overlapping tick
does not respect. `packages/domain`'s `nextMergeCandidate` already encodes the guarantee at the
pure-function level (it returns `null` unconditionally while a merge is in progress); M8a's job
was to make the orchestrator's own notion of "in progress" durable rather than an in-memory flag
that a crash erases. A claim column reuses the exact shape M5 already validated for a different
race (the resume intent) rather than inventing a second concurrency primitive.

The real gate is the **re-verify after rebase**, not the rebase succeeding. A rebase can change
behavior with no textual conflict at all — a moved file another branch also touched, a changed
default a test never exercised standalone. Running the workspace's verify commands again against
the rebased tree, in the same preserved worktree the review judged, is what actually decides
whether the merge is safe; a clean rebase alone would be judging git's mechanics, not the code.

### Why `autoMerge` moves to the merge pass

The alternative — branching the state machine at review-approval time on `autoMerge` — makes
"was this workspace configured to auto-merge" part of the task's identity at the moment it was
approved, which is the wrong moment to freeze that answer: an operator can flip `autoMerge`
between approval and merge, and the merge pass reading the current value rather than a value
captured earlier is the behavior an operator actually expects. It also keeps the task state
machine's edges the same regardless of the flag — `reviewing → merging` always, with `merging`
meaning "done pending the merge pass's own decision" rather than two different meanings depending
on configuration. When `autoMerge` is `false`, the merge pass marks the task `done` without
touching `main`, leaving the branch and worktree for a human — the M3–M7 ending, plus the review
gate, with no new state invented for it.

### Why retry caps reuse `run.failed`, not a new guardrail

`evaluateGuardrails` is a closed, fail-closed enumeration (`docs/domain-model.md`'s "Guardrails —
fail-closed by design"). Every new guardrail type widens a function whose whole value is being
small enough to read end to end and reason about exhaustively. A review or planning run that keeps
failing to produce a valid, judgeable result is not a new *kind* of danger the system has not seen
before — it is an ordinary run failing, over and over, against the same work. The two `run.failed`
events a capped-out cycle has already written carry everything an operator needs (the run, the
reason, the timestamp); a third, synthesized "gave up" event would say nothing the run history did
not already say, in a channel that exists for genuinely novel breach conditions.

## Alternatives Rejected

- **Author self-review.** Rejected in the design's own decision table: a QA verdict that can be
  satisfied by the same agent that wrote the diff removes the independence D6 requires, and
  reduces to "verify twice" rather than a second, differently-motivated judgment.
- **A verdict file written into the worktree.** Rejected for the same reason a checkpoint file
  written directly by the agent was rejected in ADR 0001's tradition: the transport should be the
  channel the orchestrator already validates (the run's own final output), Zod-checked at the
  boundary, not a side-channel file the agent could leave stale, malformed, or absent with no
  signal beyond a missing file.
- **Exit-code semantics for the verdict.** A binary exit code cannot carry the `reason` text the
  rework path needs to feed the next attempt, and would silently discard exactly the information
  §8's rework loop depends on.
- **A control-package merge operation callable from the web.** The merge queue is autonomous by
  design — there is no "click merge" button in the product, and adding one would mean the queue's
  serialization guarantee now has to hold against a human-triggered path as well as the daemon's
  own tick, doubling the surface the claim column has to defend.
- **Skipping review when `autoMerge` is false.** Rejected because a workspace that does not trust
  auto-merge still benefits from an independent verdict before a human looks at the branch — QA
  and "who presses the merge button" are orthogonal questions, and conflating them would make
  turning off auto-merge also turn off quality review, which nobody asked for.

## Consequences

- A task's Definition of Done is now a two-run process (implementation, then review) rather than
  one, which is a real latency cost the design accepts for the correctness it buys.
- A workspace with no `reviewer`-role agent staffed cannot close any task past `reviewing` — this
  is deliberate escalation (`guardrail.tripped`, `no_reviewer`, once per task) rather than a
  silent stall, but it does mean staffing is now a hard precondition for the pipeline to complete
  at all, the same way staffing already was for implementation work.
- `Task.mergeClaimedAt` and the review/merge event types (`task.review_started/approved/rejected`,
  `task.merge_failed`) are one-way schema and Zod-union additions (`docs/event-model.md`'s
  one-way-door rule) — removing them is not a supported direction.
- The post-rebase re-verify writes into the same worktree the implementation attempt and the
  review both used; artifact placement across those three phases is a known area still being
  hardened (tracked as an M9 review-pass follow-up, not part of this decision).
