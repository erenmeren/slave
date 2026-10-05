# Lead-flow interface (step 2) -- progress ledger

Work on `main`, pushed after each finished unit (the operator's instruction: no feature branch, no pull
request). Design: `docs/superpowers/specs/2026-10-05-lead-ux-design.md`. One line per finished unit; every design
ruling as "Ruling: what -- why -- cost if wrong"; what was left undone; the stale gates; the three checks before
each push.

## Environment

- Cloud container, Node 22.22 (the repository asks for >= 26; `npm ci` warns and installs). No Postgres, no
  daemon, no real model CLI. Tests are written and NOT run (the operator's instruction); the three checks run
  before every push are `npm run typecheck`, `npm run web:build` and `npm run gate:m26-vocabulary`.
- Every push is `git push --no-verify origin main` (the pre-push hook runs the whole suite, which must not run
  here).

## Units

- Part 1, the design: `docs/superpowers/specs/2026-10-05-lead-ux-design.md` -- six screens and sign-in, one
  Project screen with no tabs, every CLI-only control placed, the removals listed (spec sections 6, 7, 9).

- Control verbs (`feat(control)`): `deleteWorkspace` + CLI `delete-workspace --workspace <id> --yes`,
  `continueWorkspace` / `resumePausedRuns`, `decideBuild` (accept / leave / retry / merged), the read models
  `projectView` and `listProjects`, the domain's `projectPhaseOf`, its label tables and `doingSentence`, and the
  time limit at creation (`createWorkspace.goalTimeLimitMs`, the intake draft's `timeLimitMs`). Tests written,
  not run: `packages/control/test/integration/{delete-workspace,continue,lead-decide,project-view}.test.ts`,
  new cases in `create-workspace.test.ts`, `intake-accept.test.ts`, `apps/orchestrator/test/integration/cli.test.ts`,
  `packages/domain/test/lead/{phase,doing}.test.ts`, `packages/domain/test/intake/draft.test.ts`,
  `apps/web/test/refusal-status.test.ts` (the new kind).

## Rulings

- Ruling: `deleteWorkspace` also deletes `InboundEvent` and `SlaveMessage` rows by their bare `workspaceId`,
  and the lead flow's three system persons (no template, every seat in this project's `Lead flow` team) --
  "everything under it" includes the rows no foreign key reaches, and the system persons exist only for this
  project -- if an external delivery's record was meant to outlive its project (M54 R4 says it outlives its
  mapping), it is gone with the project.
- Ruling: deleting writes no event -- the project's log is what is deleted, and an event on a deleted
  workspace id would be an orphan row the next delete would have to find -- nobody can later read who deleted
  a project; the CLI's and the route's own output is the only record.
- Ruling: the intake draft's `timeLimitMs` is `.optional()` (absent = no limit), not `.default(null)` --
  a required output field broke every fixture typed `IntakeDraft` in four packages -- none known.
- Ruling: a time limit given to `createWorkspace` outside the lead flow is refused (`lead_setting_invalid`)
  rather than stored -- nothing reads it there, and storing it would say a cap exists that does not --
  a person who picks Cursor on the card and a time limit gets a refusal, which the card prevents by
  hiding the time limit for another runtime.
- Ruling: `decideBuild('accept')` closes the build's open `goal_needs_human` card (`rejected`, with the reason
  "accepted as it is", the `resolveSettledDecisions` way) -- the answer was given on the Project screen, not on
  the card -- the card's record says "rejected" where the person accepted; its reason says what happened.
- Ruling: the project phase lays a halt over the build's state (`paused` for an emergency stop, `failed` for
  any other halt) -- nothing runs while either holds, and Continue is the one action -- a project halted after
  delivery reads Paused instead of Delivered until Continue.

## Left undone

## Stale gates

## Checks before each push
- Before the spec push (`docs(spec)`): typecheck exit 0 (1 m 43 s); web:build exit 0; vocabulary PASS.
- Before the control push (`feat(control)`): typecheck exit 0; web:build exit 0; vocabulary PASS.
