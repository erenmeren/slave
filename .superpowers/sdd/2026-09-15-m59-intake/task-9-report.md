# M59 Task 9 Report

## Implementation

### Step 1 — fake CLI intake arm

- Added `intakeArm(prompt)` beside `supervisorArm` in `packages/providers/test/fake-claude.mjs`.
- The arm is stateless and keyed on prompt content:
  - the configured fixture repository path returns the existing-repository draft;
  - `NEW REPOSITORY` returns the new-repository draft;
  - every other intake prompt asks where the repository is.
- Armed it immediately before `supervisorArm` in all four prompt-sniffing modes: `m8-flow`,
  `m8a-flow`, `m36-flow`, and `m41-flow`.
- Kept the three-line decision shape: `system/init`, `assistant`, and terminal `result`. The
  terminal result repeats the answer and carries `total_cost_usd`, so the real decision parser can
  measure the call and stage 8 can prove that cost is not invisible.

### Step 2 — fake CLI tests

- Added three cases covering the question, existing-repository draft, and new-repository draft.
- The cases write the prompt to stdin with the same bare `-p` shape `decideWithModel` uses.

### Step 3 — eight-stage gate

- Added `scripts/gate-m59-intake.mjs`.
- The gate starts a real `next dev`, a real Chromium browser, and a real daemon with no
  `--workspace`; the daemon's child configuration resolves exclusively to the fake CLI.
- It creates a real git fixture carrying `npm test` and `npm run typecheck`, an active catalogue
  template, and a temporary repositories root.
- Cleanup stops processes first, removes all three created projects and their events, removes all
  three intakes and the template, restores the prior installation repositories root, and removes
  temporary repositories.
- All eight stages pass.

### Product defects exposed by the gate

1. The composer was enabled while `POST /api/intakes` was still in flight. An immediate first
   message called `send()` with `intakeId === null` and was silently lost. The composer and Send
   button now remain disabled until the intake id exists. A deferred-response test pins the race.
2. `ensureStaffRoles` existed and was unit-tested in isolation but was never applied to a parsed
   model draft. `parseIntakeAnswer` now applies it to every valid non-empty team, and a parser test
   pins the `backend, manager, reviewer` result.

### Gate corrections to match shipped identifiers

- The brief's `new-project-trigger` is a typo. Both gate uses target the shipped
  `data-testid="new-project"`, also used by M44 and the projects-page tests.
- The brief's stage-8 selector expected `data-workspace-id` on a project card, but shipped project
  cards expose only `data-testid="project-card"`. The gate selects the card containing the unique
  created project name instead.
- Confirmed `new-project-drawer`, generated `new-project-drawer-scrim`, and
  `new-project-close` against `NewProjectDrawer` and `Drawer`; the gate does not rely on a
  nonexistent drawer identifier.

### Steps 4–6 — registration and documents

- Registered `gate:m59-intake` after `gate:m57-ui-redesign` in `package.json` and CI. There is no
  M58 gate on this branch, so M59 is the historical 33rd gate as the brief requires.
- Rewrote the README quick start, repository attachment, CLI cheat sheet, CI roster, M59 proof,
  and count line.
- Added the `New project` section and Later entries to `docs/ia.md` without changing its five
  rules.
- Verified spec errata E1–E10 were already present and appended execution erratum E11 for
  per-workspace `ticksHaveRun`.

## Gate Stage Results

| Stage | Result | Evidence |
|---|---:|---|
| 1 | PASS | Daemon started with no `--workspace`; `serving 1 project ...; following new ones every 10s`. |
| 2 | PASS | Drawer opened with 0 messages; one sentence received `Where is the repository?`. |
| 3 | PASS | Fact chips showed `main`, `npm test`, and `npm run typecheck` with `package.json` provenance; draft had both checked and `backend,manager,reviewer`. |
| 4 | PASS | Created `Public API`, goal v1, verify commands exactly `["npm test"]`, with intake id on `workspace_created`. |
| 5 | PASS | Daemon emitted `serving 2 projects`; staff step was honestly `skipped / M58 not merged`; guardrail was `no_planner`. |
| 6 | PASS | New repository was under the configured temporary root, with exactly one commit and goal text in README. |
| 7 | PASS | CLI intake created `Public API From The CLI`, goal v1, with both detected verify commands. |
| 8 | PASS | Intake recorded 2 calls and USD 0.02; the project card showed spend USD 0.03 including the Supervisor call. |

## Verification

### Focused and gate development runs

| Command | Exit | Result |
|---|---:|---|
| `node --check scripts/gate-m59-intake.mjs && node --check packages/providers/test/fake-claude.mjs && npx vitest run --root /home/meren/projects/slave-of-ai-m59 packages/providers/test/fake-claude.test.ts` | 1 | RED: the three new cases showed the synthetic terminal result omitted its `result` payload. |
| `npx vitest run --root /home/meren/projects/slave-of-ai-m59 packages/providers/test/fake-claude.test.ts && npx tsc --build` | 0 | 62 tests passed; build passed. |
| `npm run gate:m59-intake` | 1 | Stage 1 passed; stopped on brief typo `new-project-trigger`. |
| `npm run gate:m59-intake` | 1 | Stages 1–2 reached; exposed the intake-opening first-message race. |
| `npx vitest run --root /home/meren/projects/slave-of-ai-m59 apps/web/test/intake-conversation.test.tsx` | 1 | RED: composer was enabled while intake creation was deferred. |
| `npx vitest run --root /home/meren/projects/slave-of-ai-m59 apps/web/test/intake-conversation.test.tsx` | 0 | 15 tests passed after the composer fix. |
| `npx vitest run --root /home/meren/projects/slave-of-ai-m59 packages/domain/test/intake/answer.test.ts` | 1 | RED: parsed team remained `["backend"]`. |
| `npm run gate:m59-intake` | 2 | TypeScript caught the readonly team result before the gate body ran. |
| `npm run gate:m59-intake` | 1 | Stages 1–7 passed; stage 8 exposed the brief-only `data-workspace-id` mismatch. |
| `npm run gate:m59-intake` | 0 | Eight stage lines passed. |
| `npm run gate:m59-intake` after the final stage-5 log correction | 0 | Eight stage lines passed; the current serving line is printed. |
| `npx vitest run --root /home/meren/projects/slave-of-ai-m59 packages/providers/test/fake-claude.test.ts packages/domain/test/intake/answer.test.ts apps/web/test/intake-conversation.test.tsx` | 0 | 3 files, 91 tests passed. |

### CI gate sweep

Every gate registered in `.github/workflows/ci.yml` ran sequentially and exited 0:

| CI gate | Exit |
|---|---:|
| `gate:m26-vocabulary` | 0 |
| `gate:m15-boundary` | 0 |
| `gate:m20-auth` | 0 |
| `gate:m21-loose-ends` | 0 |
| `gate:m23-onboarding` | 0 |
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
| `gate:m50-ephemeral` | 0 |
| `gate:m51-breaker` | 0 |
| `gate:m52-broker` | 0 |
| `gate:m53-evidence` | 0 |
| `gate:m54-triggers` | 0 |
| `gate:m55-catalog` | 0 |
| `gate:m56a-provider-contract` | 0 |
| `gate:m57-ui-redesign` | 0 |
| `gate:m59-intake` | 0 |

The package-script loop also ran legacy gates that are not in CI. `gate:m8a-merge`,
`gate:m8a-estop`, `gate:m11-shell`, `gate:m16-chrome`, `gate:m18-skill-and-teeth`, and
`gate:m19-measure-and-harden` exited 0. Three stale non-CI gates exited 1:

- `gate:m8-plan`: its fixture project tripped the circuit breaker; one task failed after three
  attempts and the dependent remained ready.
- `gate:m10-org`: its old CLI invocation parsed `--team template` and refused `no company team
  with id template`.
- `gate:m17-stability`: it requires the removed
  `apps/web/test/integration/analytics-aggregates.test.ts`.

As directed, `gate:m12-providers`, `gate:m13-runtime`, and `gate:m14-fidelity` were skipped because
they are not in CI. The aggregate all-package-script loop therefore exited 1, while all 33
registered CI gates exited 0.

### Ladder

| Command | Exit | Result |
|---|---:|---|
| `npm run gate:m26-vocabulary` | 0 | Vocabulary passed. |
| `npx tsc --build` | 0 | Build passed. |
| `npm run --silent typecheck` | 0 | Typecheck passed. |
| Test-file count command | 0 | 397 test files. |
| `npx vitest run --root /home/meren/projects/slave-of-ai-m59` | 1 | 397 files; 6,777 passed and 1 failed, 6,778 total. The sole failure is the ledger-known private-database name assertion: expected `slaveofai_test`, received `slaveofai_test_m59`. |
| `npm run web:build` | 0 | Production build passed; no `next dev` was running before it. |

## Files

- Added `scripts/gate-m59-intake.mjs`.
- Added `.superpowers/sdd/2026-09-15-m59-intake/task-9-report.md`.
- Modified `.github/workflows/ci.yml`.
- Modified `README.md`.
- Modified `docs/ia.md`.
- Modified `docs/superpowers/specs/2026-09-15-m59-intake-design.md`.
- Modified `package.json`.
- Modified `packages/providers/test/fake-claude.mjs`.
- Modified `packages/providers/test/fake-claude.test.ts`.
- Modified `packages/domain/src/intake/answer.ts`.
- Modified `packages/domain/test/intake/answer.test.ts`.
- Modified `apps/web/src/components/projects/IntakeConversation.tsx`.
- Modified `apps/web/test/intake-conversation.test.tsx`.

## Concerns

- The complete suite's one failure is environment-specific and pre-existing: the connectivity test
  hardcodes `slaveofai_test`, while this worktree intentionally uses the isolated
  `slaveofai_test_m59` database. No product test failed.
- Three package scripts outside the CI workflow are stale and fail for the reasons recorded above.
  All 33 actual CI gates passed.
- The gate run logs carry PostgreSQL client's existing concurrent-query deprecation warning; no
  gate assertion failed because of it.
- Task 10 will replace the deliberately pre-M58 stage-5 `staff: skipped` and `no_planner`
  assertions after M58 integration.

## Scratch Directory

`/tmp/tmp.erOjJ7camf`

## Fix Round 1

### Findings

1. **Important — failed intake opens can be retried.** Extracted the intake open request into a
   reusable callback, added an opening-state latch, and added a visible `Retry opening
   conversation` action when the initial open fails. Retrying clears the prior error and a
   successful retry enables the composer. The parameterized regression covers both an HTTP 503
   response and a rejected network request. RED evidence: the focused run exited 1 with both new
   cases unable to find `intake-open-retry`; the other 15 tests passed. GREEN evidence: all 17
   tests passed.
2. **Important — the creation event carries the exact conversation id.** Stage 4 now resolves the
   intake linked to the created workspace and compares `workspace_created.payload.intakeId` for
   exact equality with that row's id.
3. **Important — deterministic intake capture and cleanup.** Removed both pre-open
   `findFirst(orderBy: createdAt)` lookups. Each browser intake is captured only after workspace
   creation through its unique `workspaceId` linkage; the CLI intake keeps the exact id returned
   by `intake open`. Cleanup deletes precisely those captured intake rows before their workspaces.
4. **Important — stage 8 proves the right card and formatted spend.** Project cards now expose
   their workspace id as data, pinned by a component test. Stage 8 selects exactly one card by the
   created workspace id, proves the intake recorded exactly two calls and USD 0.02, and requires
   the exact formatted `$0.03` card value.
5. **Minor — discovery is bounded to two periods.** Reduced `DISCOVERY_TIMEOUT_MS` from 25 seconds
   to 20 seconds.
6. **Minor — repository parent is exact.** Stage 6 compares `dirname(repoPath)` directly with the
   configured repositories root, so a sibling prefix cannot pass.
7. **Minor — manager role matching is exact.** Stage 3 parses each `data-roles` value into role
   entries and checks for the exact `manager` entry instead of a substring.

The approved intake answer seam was not changed. The two deliberately pre-M58 stage-5 assertions
remain unchanged, and each now has a comment naming Task 10 as their replacement point.

### Gate stage results

| Stage | Result | Strongest evidence |
|---|---:|---|
| 1 | PASS | A daemon started without `--workspace` and announced discovery. |
| 2 | PASS | The empty conversation received one assistant question. |
| 3 | PASS | Repository facts, provenance, checked commands, and exact `manager` role were present. |
| 4 | PASS | The workspace definition and exact linked intake event id matched. |
| 5 | PASS | Discovery completed inside the 20-second bound; approved pre-M58 assertions held. |
| 6 | PASS | The repository's parent exactly matched the configured root; one initial commit existed. |
| 7 | PASS | The CLI intake created the expected workspace shape. |
| 8 | PASS | The exact workspace card showed `$0.03`; its intake recorded 2 calls and USD 0.02. |

### Commands

| Command | Exit | Result |
|---|---:|---|
| Initial sandboxed launch of `git -C /home/meren/projects/slave-of-ai-m59 log --oneline -1 && git -C /home/meren/projects/slave-of-ai-m59 status --short --branch` | 1 | The command did not start: the sandbox namespace setup returned `EINVAL`. |
| `git -C /home/meren/projects/slave-of-ai-m59 log --oneline -1 && git -C /home/meren/projects/slave-of-ai-m59 status --short --branch` | 0 | Confirmed `9cced85b` on `feature/m59-chat-onboarding`, initially clean. |
| `npx vitest run --root /home/meren/projects/slave-of-ai-m59 apps/web/test/intake-conversation.test.tsx` (RED) | 1 | 15 passed; both new retry cases failed because the retry action did not exist. |
| `npx vitest run --root /home/meren/projects/slave-of-ai-m59 apps/web/test/intake-conversation.test.tsx` (GREEN) | 0 | 17 tests passed. |
| `npx vitest run --root /home/meren/projects/slave-of-ai-m59 apps/web/test/projects-page.test.tsx` (RED) | 1 | 42 passed; workspace-id card assertion failed with `null`. |
| `npx vitest run --root /home/meren/projects/slave-of-ai-m59 apps/web/test/projects-page.test.tsx` (GREEN) | 0 | 43 tests passed. |
| `node --check scripts/gate-m59-intake.mjs` | 0 | Syntax check passed. |
| `npx vitest run --root /home/meren/projects/slave-of-ai-m59 packages/domain/test/intake packages/providers/test/fake-claude.test.ts apps/web/test/projects-page.test.tsx apps/web/test/settings-page.test.tsx` | 0 | 9 files and 189 tests passed. |
| `CHROMIUM_PATH=/usr/bin/chromium SLAVEOFAI_REQUIRE_FAKE_CLI=1 npm run gate:m59-intake` through the first `tee` logging pipeline | 0 | Eight stages printed PASS; repeated because this pipeline had not enabled `pipefail`. |
| `set -o pipefail; CHROMIUM_PATH=/usr/bin/chromium SLAVEOFAI_REQUIRE_FAKE_CLI=1 npm run gate:m59-intake 2>&1 \| tee /tmp/slaveofai-m59-fix-round-1/gate-m59-intake-final.log` | 0 | Authoritative gate exit; all eight stage lines passed. |
| `npm run gate:m26-vocabulary` | 0 | Vocabulary gate passed. |
| `npx tsc --build` | 0 | Project-reference build passed. |
| `npm run --silent typecheck` | 0 | Full typecheck passed. |
| `npm run web:build` | 0 | Production web build passed. |
| `git diff --check && git diff --stat && git status --short` | 0 | No whitespace errors; expected source, test, gate, and report changes only. |

Final gate log: `/tmp/slaveofai-m59-fix-round-1/gate-m59-intake-final.log`.
