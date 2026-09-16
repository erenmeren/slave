# M59 Task 10 Report

## Rebase and M58 integration

- The branch started at `8899d73c`.
- M58 was confirmed on `origin/main` at `58210fb6 feat(m58): merge persons milestone`.
- The branch was rebased onto `origin/main`; the post-rebase Task 9 head is `f9926543`.
- Mechanical rebase conflicts combined M58 and M59 additions in the refusal taxonomy, CLI
  integration fixture, CI gate list, package scripts, README gate prose/count, and IA route notes.
- The M58 migration was applied to both `slaveofai_m59` and `slaveofai_test_m59`; Prisma generation
  and the project-reference build completed after migration.
- CI now registers 34 gates, with `gate:m59-intake` immediately after `gate:m58-persons`, and the
  README count is 34.

## Signatures used

The merged `packages/control/src/persons.ts`, not the pre-merge brief, is authoritative:

- `createPerson(input, principal?)` accepts
  `{ templateId?, name?, profile?, model?, provider?, capabilities?, lifecycle? }` and returns
  `{ personId, name }`.
- `assignPerson(personId, teamId, options?, principal?)` accepts
  `{ role?, runtimeRoles?, engagementTaskId? }` and returns `{ slaveId, reopened }`.

The staff step uses `person.value.personId` and passes the intake principal to both verbs. Spec
erratum E12 records the brief's `{ id }` mismatch, the optional principal position, and the M58
move from `Slave.name` to `Slave.person.name`.

## Staffing implementation

- A non-empty draft creates one project department named after the project.
- `ensureStaffRoles` guarantees `manager` and `reviewer` on the approved seats.
- Each seat creates a person from its template and assigns that person to the department.
- Any team, person, or assignment refusal fails the `staff` step.
- An empty draft team creates no department and records
  `skipped: the draft asked for nobody`.
- The M58 principal is preserved through team creation, person creation, and assignment.

## RED and GREEN evidence

The first focused intake run exited 1. Both new cases failed for the intended missing behavior:
the staffed project had zero teams, and the empty-team detail was still `M58 not merged`.

After implementation, the focused intake run exited 0 with 12 tests. The combined intake/domain
run exited 0 with 18 tests. The fake-provider test then went RED because the existing-repository
draft still carried `provider: null`; after the runtime fixture correction it passed all 62 tests.

## Gate result

`gate:m59-intake` passed all eight stages with the real daemon, web app, browser, database, and
fake CLI:

- Stage 5 recorded `staff: done`, found one seat with
  `backend, manager, reviewer`, and waited for the planning run to reach `succeeded`.
- M58 runtime resolution is supplied by the active gate template's
  `defaultModel: sonnet` / `provider: claude_code` and the existing-repository draft's
  `provider: claude_code`. The new-repository draft remains `provider: null`.
- The captured `plan-graph` fixture reports a measured planning cost of
  `$0.20933900000000003`.
- The existing-repository fixture uses a `$0.03` budget: its `$0.02` intake permits planning, then
  the measured planning call exhausts the budget before implementation/review calls can blur the
  spend proof.
- Stage 8 pinned the exact project card to `$0.23`: `$0.02` intake plus `$0.209339` planning,
  formatted to cents.
- A planning run that reaches `failed` now fails stage 5 and reports its `run.failed` payload.

## M58 collisions

- `gate:m23-onboarding` expected `delete-slave` to print the seat id. M58 deletes the person behind
  that seat and prints the person id; its two assertions now use `personId`.
- `gate:m50-ephemeral` remains out of scope. It expects M50 D7's greyed released rows on the
  project Organization page, while M58 R17 intentionally shows open seats only. The product file
  and M50 gate are identical to `origin/main`; the whole-branch review must reconcile those two
  milestone contracts.
- `gate:m21-loose-ends` and `gate:m23-onboarding` could not be rerun successfully because a
  `next dev` owned by `/home/meren/projects/slave-of-ai` was running. It was neither stopped nor
  modified.

## Verification commands

| Command | Exit | Result |
|---|---:|---|
| `git fetch origin && git rebase origin/main` | 1 | Stopped at the first mechanical conflict; rebase continued after resolution. |
| Final `GIT_EDITOR=true git rebase --continue` | 0 | Rebase completed at post-rebase head `f9926543`. |
| `npm run db:generate && npm run db:migrate && npm run db:migrate:test && npx tsc --build` | 0 | Generated Prisma, migrated both M59 databases, and built. |
| `npx vitest run --root /home/meren/projects/slave-of-ai-m59 packages/control/test/integration/intake-accept.test.ts` (RED) | 1 | 10 passed; the two new staffing cases failed as intended. |
| Same focused intake command (GREEN) | 0 | 12 tests passed. |
| `npx vitest run --root /home/meren/projects/slave-of-ai-m59 packages/control/test/integration/intake-accept.test.ts packages/domain/test/intake/team.test.ts` | 0 | 2 files, 18 tests passed. |
| `npx vitest run --root /home/meren/projects/slave-of-ai-m59 packages/providers/test/fake-claude.test.ts` (RED) | 1 | Existing-repository provider assertion failed; 61 passed. |
| Same fake-provider command (GREEN) | 0 | 62 tests passed. |
| `CHROMIUM_PATH=/usr/bin/chromium SLAVEOFAI_REQUIRE_FAKE_CLI=1 npm run gate:m59-intake` (final staffed run) | 0 | Eight stages passed; planning succeeded; card showed `$0.23`. |
| `npm run gate:m26-vocabulary` | 0 | Vocabulary passed. |
| `npx tsc --build` | 0 | Project-reference build passed. |
| `npm run --silent typecheck` | 0 | Full typecheck passed. |
| `npx vitest run --root /home/meren/projects/slave-of-ai-m59` | 1 | 408 files: 407 passed and 1 failed; 6,890 tests passed and 1 failed. The sole failure is the known `slaveofai_test_m59` versus hardcoded `slaveofai_test` assertion. |
| `npm run web:build` | 0 | Production web build passed. |

## Final CI gate sweep

All gates were run one at a time with the required fake CLI. M12, M13, and M14 were not run.

| Gate | Exit |
|---|---:|
| `gate:m26-vocabulary` | 0 |
| `gate:m15-boundary` | 0 |
| `gate:m20-auth` | 0 |
| `gate:m21-loose-ends` | 1 — another worktree's `next dev` |
| `gate:m23-onboarding` | 1 — another worktree's `next dev` |
| `gate:m29-simulation` | 0 |
| `gate:m30-simulation-compare` | 0 |
| `gate:m31a-llm-decisions` | 0 |
| `gate:m31b-software-sector` | 0 |
| `gate:m33-adopt` | 0 |
| `gate:m35-pipeline-honesty` | 0 |
| `gate:m36-messaging` | 0 |
| `gate:m37-run-context` | 0 |
| `gate:m38-supervisor` | 0 |
| `gate:m39-supervisor-mailbox` | 0 |
| `gate:m40-requirement-versioning` | 0 |
| `gate:m41-scenario` | 0 |
| `gate:m42-catalog-import` | 0 |
| `gate:m44-ux-foundation` | 0 |
| `gate:m45-project-experience` | 0 |
| `gate:m46-workforce-catalog` | 0 |
| `gate:m47-team-formation` | 0 |
| `gate:m48-runbooks` | 0 |
| `gate:m49-memory` | 0 |
| `gate:m50-ephemeral` | 1 — pre-existing M50 D7 versus M58 R17 contract collision |
| `gate:m51-breaker` | 0 |
| `gate:m52-broker` | 0 |
| `gate:m53-evidence` | 0 |
| `gate:m54-triggers` | 0 |
| `gate:m55-catalog` | 0 |
| `gate:m56a-provider-contract` | 0 |
| `gate:m57-ui-redesign` | 0 |
| `gate:m58-persons` | 0 |
| `gate:m59-intake` | 0 |

## Files

- Modified `packages/control/src/intake.ts`.
- Modified `packages/control/test/integration/intake-accept.test.ts`.
- Modified `scripts/gate-m59-intake.mjs`.
- Modified `packages/providers/test/fake-claude.mjs`.
- Modified `packages/providers/test/fake-claude.test.ts`.
- Modified `docs/superpowers/specs/2026-09-15-m59-intake-design.md`.
- Modified `scripts/gate-m23-onboarding.mjs`.
- Added `.superpowers/sdd/2026-09-15-m59-intake/task-10-report.md`.

## Concerns

- The full suite's only failure is the ledger-known private test-database name assertion.
- The M50/M58 project-roster contract collision is already on `origin/main` and remains for the
  whole-branch review.
- M21 and M23 need a clean rerun when the other worktree's development server is no longer
  running. The M23 person-id correction itself has not received a successful gate run in this
  worktree because of that environmental refusal.
