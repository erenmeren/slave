# M59 Task 8 Report

## Implementation

- Created `apps/web/src/components/projects/IntakeConversation.tsx`.
- Swapped `NewProjectDrawer` from the manual form to the intake conversation while keeping `?new=1`, Escape, scrim, focus trap, and close wiring on the existing `Drawer`.
- Added the always-available `fill in by hand` path, which swaps to `ProjectsPanel` pre-filled from the current draft and facts.
- Added one optional initializer prop to `ProjectsPanel`; with no prop, its defaults remain unchanged.
- Added `ReposRootField` to global Settings, saved through `/api/installation`, with resolved path and source labels.
- Wired `apps/web/src/app/settings/page.tsx` through `readInstallationSettings()` and `resolveReposRoot()`.
- Updated existing stale page tests to assert the M59 intake drawer surface and mock the new Settings data dependency.

## TDD Evidence

- RED: `npx vitest run --root /home/meren/projects/slave-of-ai-m59 apps/web/test/intake-conversation.test.tsx apps/web/test/settings-repos-root.test.tsx`
  - Result: exit 1.
  - Expected failures: missing `IntakeConversation` file and missing `ReposRootField` export.
- GREEN: same command.
  - Result: exit 0, 2 test files, 13 tests passed.

## Verification

- `npx vitest run --root /home/meren/projects/slave-of-ai-m59 apps/web/test/intake-conversation.test.tsx apps/web/test/settings-repos-root.test.tsx apps/web/test/projects-page.test.tsx apps/web/test/settings-page.test.tsx`
  - Exit 0, 4 files, 89 tests passed.
- `npx vitest run --root /home/meren/projects/slave-of-ai-m59 apps/web/test/`
  - Exit 0, 156 files, 2383 tests passed.
- `npm run gate:m26-vocabulary`
  - Exit 0, `PASS: the word is slave everywhere it is ours`.
- `npx tsc --build`
  - Exit 0.
- `npm run --silent typecheck`
  - Exit 0.
- `npx vitest run --root /home/meren/projects/slave-of-ai-m59`
  - Exit 1, 397 files, 6761 passed, 2 failed.
  - Known M59 environment failure: `packages/db/test/integration/connectivity.test.ts` expects `slaveofai_test`, received `slaveofai_test_m59`.
  - Reproducible existing failure outside Task 8 files: `apps/orchestrator/test/integration/cli.test.ts` broker daemon shutdown expected exit 0, received 1. Focused rerun of that single test also failed.
- `npm run web:build`
  - Exit 0. Before this, no real `next dev` process matched `[n]ext dev`.

## Files

- Added `apps/web/src/components/projects/IntakeConversation.tsx`.
- Added `apps/web/test/intake-conversation.test.tsx`.
- Added `apps/web/test/settings-repos-root.test.tsx`.
- Modified `apps/web/src/components/projects/NewProjectDrawer.tsx`.
- Modified `apps/web/src/components/ProjectsPanel.tsx`.
- Modified `apps/web/src/components/SettingsClient.tsx`.
- Modified `apps/web/src/app/settings/page.tsx`.
- Modified `apps/web/test/projects-page.test.tsx`.
- Modified `apps/web/test/settings-page.test.tsx`.

## Self-Review

- Imports under `apps/web/src` omit `.js`; imports under `apps/web/test` keep `.js`.
- Component tests use `.test.tsx` and the jsdom comment is the first line.
- The conversation uses polling only; there is no event stream.
- Raw intake status, step, and verify source values are only in `data-*` or `title`; visible labels come from the label maps.
- Tests stub route calls and make no model calls.
- The manual project form still posts to `/api/org/workspaces`.
- No protected vocabulary was added by this task; the vocabulary gate passed.

## Concerns

- Full Vitest still has the ledger-known database-name failure for the private M59 test database.
- The broker daemon shutdown test fails outside the Task 8 surface and reproduces when run alone. I did not change orchestrator code in this task.

## Fix Round: Review Findings

- Shared the new-repository slug behavior through `intakeRepositorySlug` in the client-safe domain package; control's `slugify` now delegates to it, and the drawer uses the same helper for displayed paths.
- `fill in by hand` now prefills `ProjectsPanel.repoPath` with `<reposRoot>/<slug>` when the draft is `repo.mode: 'new', path: null`.
- `POST /api/installation` now returns `{ ok, reposRoot, resolved, source }` after saving, and `ReposRootField` updates from those route facts instead of reconstructing them locally.
- Step log entries keep raw status in `data-status` and `title`, while visible text comes from the total domain label map.

## Fix Round TDD Evidence

- RED: `npx vitest run --root /home/meren/projects/slave-of-ai-m59 packages/domain/test/intake/constants.test.ts packages/domain/test/intake/draft.test.ts`
  - Exit 1: missing `INTAKE_STEP_STATUSES`, `INTAKE_STEP_STATUS_LABEL`, and `intakeRepositorySlug`.
- RED: `npx vitest run --root /home/meren/projects/slave-of-ai-m59 apps/web/test/intake-conversation.test.tsx`
  - Exit 1: visible raw `failed`, displayed `/deme-sistemi`, and blank manual repo prefill.
- RED: `npx vitest run --root /home/meren/projects/slave-of-ai-m59 apps/web/test/settings-repos-root.test.tsx`
  - Exit 1: clearing a saved root showed the old path/default instead of `/srv/repos` from env.
- RED: `npx vitest run --root /home/meren/projects/slave-of-ai-m59 apps/web/test/integration/intake-routes.test.ts`
  - Exit 1: POST `/api/installation` omitted `resolved` and `source`.

## Fix Round Verification

- `npx vitest run --root /home/meren/projects/slave-of-ai-m59 packages/domain/test/intake/constants.test.ts packages/domain/test/intake/draft.test.ts` — exit 0, 17 tests.
- `npx vitest run --root /home/meren/projects/slave-of-ai-m59 apps/web/test/intake-conversation.test.tsx` — exit 0, 11 tests.
- `npx vitest run --root /home/meren/projects/slave-of-ai-m59 apps/web/test/settings-repos-root.test.tsx` — exit 0, 5 tests.
- `npx vitest run --root /home/meren/projects/slave-of-ai-m59 apps/web/test/integration/intake-routes.test.ts` — exit 0, 9 tests.
- `npx vitest run --root /home/meren/projects/slave-of-ai-m59 packages/control/test/integration/installation.test.ts` — exit 0, 7 tests.
- `npx vitest run --root /home/meren/projects/slave-of-ai-m59 apps/web/test/projects-page.test.tsx` — exit 0, 43 tests.
- `npx vitest run --root /home/meren/projects/slave-of-ai-m59 apps/web/test/settings-page.test.tsx` — exit 0, 33 tests.
- `npm run gate:m26-vocabulary` — exit 0.
- `npx tsc --build` — exit 0.
- `npm run --silent typecheck` — exit 0.
- `npm run web:build` — exit 0.
