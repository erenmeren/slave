# M9: Documentation + Code Review Pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The parent spec's M9 row (§16): documentation completeness and a final review pass —
"All docs present, review clean." No new features; the milestone closes the ledgers' deferred
follow-ups and brings the three living docs and the ADR series up to what M8a/M8b actually
built.

**Architecture:** Two doc deliverables (the living-docs refresh; two new ADRs), one small
code-fix batch from the accumulated review findings, then a final completeness review over the
whole M8 range.

**Spec:** the parent `docs/superpowers/specs/2026-08-17-ai-team-os-design.md` §16 defines M9's
scope and gate; the M8a/M8b SDD ledgers' "deferred follow-ups" entries are the review-pass
worklist of record.

## Global Constraints

- Full gate for any task touching code: `npm test && npm run typecheck && npm run web:build`.
- Docs state what IS, verified against the code at head — no aspirational text.
- Commit style unchanged; messages end with the Fable co-author line.

---

### Task 1: The living docs catch up with M8

**Files:** modify `docs/architecture.md`, `docs/domain-model.md`, `docs/event-model.md`.

- `architecture.md` "The tick": the pass order — reconcile/resume, **plan** (goal + empty
  board → a `manager` planning run in the primary checkout), **schedule**, verify, **review**
  (green → `reviewing`; a `reviewer` run over the diff in the preserved worktree), **merge**
  (serialized, claim column, rebase → re-verify → --no-ff, autoMerge Decision 5), and where
  each lives (`planning.ts`, `review.ts`, `merge.ts`). "Two things called halt" gains the
  emergency-stop chain (control → CLI/web route → STOP button). "Concurrency" gains the global
  limit (6) beside the per-workspace one.
- `domain-model.md`: Workspace gains `goal`; Task gains `mergeClaimedAt` (the merge claim,
  first-writer-wins, crash-recovered by the sweep); AgentRun's `taskId` is now nullable — the
  planning run — and the **scoping invariant**: a run's workspace is derived through
  `agent.team.workspaceId`, never through `task`, because a planning run has no task. The
  planning graph contract (`parsePlanGraph`: 1–20 tasks, unique keys, acyclic, free-form
  roles) beside the merge-queue section. The review retry cap (2 per work attempt) and the
  planning retry cap (2 per goal-set) as the escalation-by-run.failed convention.
- `event-model.md`: the enum one-way-door section's member count and the six M8 additions
  (`task.review_started/approved/rejected`, `task.merge_failed`, `workspace.goal_set`,
  `workspace.plan_created`); the envelope note that `taskId` is genuinely optional now
  (planning runs emit without one).
- [ ] Verify every claim against the code at head; full gate (docs-only, but run it once);
  commit `docs(m9): the living docs catch up with the M8 pipeline`.

### Task 2: Two ADRs

**Files:** create `docs/decisions/0005-execution-closure.md`,
`docs/decisions/0006-task-less-planning-runs.md` (follow 0001-0004's format).

- 0005: Definition of Done = verify green + independent QA approval (parent D6); the serialized
  merge queue with the claim column and crash recovery; autoMerge consulted only by the merge
  pass (Decision 5); retry caps escalate by `run.failed` events, not new guardrail types.
- 0006: `AgentRun.taskId` nullable for the planning run; the agent→team workspace-scoping
  invariant and the nine-site audit; the empty-board trigger (no replanning); free-form roles
  (user decision, visibility over gating via `skippedNoRole`); the known benign self-race (a
  second planning run in the conclude-to-commit window, absorbed by the ANY-task guard) and why
  the naive dispatch-gate fix is a trap (a dropped-graph run stays `succeeded` forever — the
  clean fix needs conclusion-owned terminal status, deliberately not done).
- [ ] Commit `docs(m9): ADRs for execution closure and task-less planning runs`.

### Task 3: The review-pass fixes

**Files:** modify `apps/orchestrator/src/merge.ts` (+ its test), `scripts/gate-m8-plan.mjs`,
`apps/web/src/components/GoalCard.tsx` (+ its test), `tsconfig.tools.json` (evaluate).

- (a) **Post-rebase verify artifact clobbering** (M8a Task 7 review, deferred): the merge
  pass's `runVerify` writes into the same `attempt-NN` dir as the implementation attempt.
  Route it to `join(workspace.repoPath, '.aiteamos', 'artifacts', task.id, 'merge')` — a
  sibling namespace the attempt dirs never use. TDD: extend merge.test.ts (a) to assert the
  implementation-attempt artifact files survive the merge pass byte-identical.
- (b) **gate-m8-plan stage-1 FAIL dump** (M8b Task 9 review): the plan-never-landed timeout
  throw gains the m8a-estop-style dump — planning-run statuses and the workspace's event
  types. Verified by reading; the gate re-run in Task 4 proves it still PASSes.
- (c) **GoalCard `aria-label="workspace goal"`** on the input (M8b Task 8 review); assert it
  in goal-card.test.tsx via `getByRole('textbox', { name: 'workspace goal' })`.
- (d) **tools tsconfig**: attempt `allowJs`/`checkJs` + `scripts/**/*.mjs` include so the gate
  scripts actually typecheck; if the existing scripts produce an error storm, record the
  decision to skip in the commit message instead — do not half-fix.
- [ ] TDD where testable; full gate; commit
  `fix(orchestrator,web,scripts): the M8 review-pass follow-ups`.

### Task 4: The completeness review and the close

- [ ] One reviewer agent over the M8 range (`440e6d2..HEAD`) summary + the refreshed docs:
  "anything the docs still misstate, any deferred finding unaddressed and unrecorded?"
  Findings → fix or record.
- [ ] Full gate + all three measured gates (`gate:m8a-merge`, `gate:m8a-estop`,
  `gate:m8-plan`) green in one sitting.
- [ ] Merge to main, push. M9's by-eyes half: the user's demo walkthrough (goal → board →
  merged, STOP mid-flight) — findings become gate-fix tasks.
