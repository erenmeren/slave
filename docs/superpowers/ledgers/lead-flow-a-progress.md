# Lead flow, plan A -- progress ledger

Branch `feature/lead-flow-a`, cut from `lead-flow-a-plan` (main `3d89a10` plus the controller's answers).
Plan: `docs/superpowers/plans/2026-10-04-lead-flow-a.md`. One line per task outcome; every design ruling as
"Ruling: <what> -- <why> -- <cost if wrong>"; deferred minor findings at the end.

## Before the tasks

- `lead-flow-a-plan` did not exist on the remote (only `main`, which carries the plan WITHOUT the controller's
  answers). On the operator's word ("create that branch") it was cut here from main and the answers were
  written into the plan from the build prompt's account of them: commit "the controller's answers C1-C9 and
  the 2026-10-04 measurement".
- Ruling: C1-C9 were reconstructed, not copied -- the operator's patched plan was unreachable from the cloud
  session -- the build could not start otherwise and the prompt describes M, C1, C5, C6 and C7 closely --
  where the reconstruction differs from the operator's text, the build follows the wrong answer; C4, C8 and
  C9 are marked "builder's ruling" in the plan and are the likeliest to differ.
- Ruling: C2, a lead's spend is each session's largest reported total, summed over sessions; a crashed turn is
  covered by a later total of its session -- the measurement says a resumed process reports the session's
  running total -- if a later CLI reports per invocation again, spend is under-counted by every earlier turn
  of a session.
- Ruling: C5, no default model; seats carry no model and no provider (never a half-pair); `leadRuntime` runs
  them on Claude Code with no `--model` -- the prompt's B2 test ("no `--model` flag by default") implies it --
  the lead runs on whatever the installed CLI defaults to, which may not be the most capable model.
- Ruling: C6 detection reads the pump's own `run.failed` reason ("N tool call(s) were denied: ids") and the
  run's `permission_mode` guardrail trips; a turn that both errored AND had a denial is also continued --
  the row does not keep `isError`, and adding a column for it is beyond this plan -- at most
  `LEAD_DENIAL_CONTINUES_MAX` (2) error turns per version go uncharged.
- Plan defects fixed in one commit ("fix the plan's blocking defects"): B1 (`runtime.ts` in Task 6's files,
  `git add` and a unit test), B2 (the fixture records `model: input.model ?? null`; asserted null in lead-open's
  second case -- the first never starts a run -- and in lead-proof's first case, plus `SlaveRun.model`), B3 (the
  C6 branch in `concludeLeadTurn` after the lost-transcript check, `LEAD_DENIAL_CONTINUES_MAX`,
  `denialContinues`, the `denied` note, two `permission-denied` cases). Minor: stale line references in Tasks
  3-4 (m56a `:161`, adapter `resume` `:521`, stream `:383`/`:407`, fake `:1424-1450`, kinds test `:99`); C1's
  `parentToolUseId` in Task 4's interfaces, parser, event, pump, fake and `leadStatus`, with `subagent` on
  top-level calls only; C7's "at least $X" in `planLeadTurn`'s note; every commit trailer now reads Claude
  Opus 5.5 as the build prompt requires.
- The fake-CLI flag count: this plan's Task 4 lists eight flags, and eight is right here -- the ninth
  (`--repeat-result`) belonged to the operator's patched text and no reconstructed answer needs it.
- `continue` as a Prisma enum value: confirmed with `prisma generate` on a scratch copy of the schema
  (generated `LeadTurn.continue: 'continue'`).
- Environment: Postgres 16 on 5433 (no Docker here), test and gate databases created as ci.yml does,
  `core.hooksPath` set to `.githooks` (README) so a push runs the pre-push hook. Baseline on main before any
  change: see "Results" at the end.

- Environment, measured on unchanged main (`3d89a10`), whole suite as root: 6 files / 7 tests red of 534 / 9618,
  44 min. Three are zombies (PID 1 here, `process_api`, reaps nothing: a killed process stays "alive" to
  `kill -0`) -- `procGroup` "kills a surviving member", `smoke` "kills a timed-out smoke's whole process group"
  and "settles an attempt whose owner died"; they pass under a child-subreaper wrapper
  (`scratchpad/reap.py`). Four need a non-root user (root reads a file whose mode forbids it):
  `pause-gate` and `cursor-shell-gate` "pause flag exists but cannot be read", `runContext` "a copy fails
  part-way", `pause` "a rollback restores the status". Making a second Linux user was refused by this
  session's permission system.
- Ruling (the operator's, asked): the pre-push hook cannot pass here because of those four, so before every push
  the controller runs `npm run typecheck` and the whole suite under the reaper itself, and pushes with
  `--no-verify` only when the sole failures are those four -- the hook's gate is kept, run by hand -- a
  regression hiding inside one of those four files' failing cases would not be seen here.
- GitHub: after a worker restart, every push was refused (403); the operator installed the app and pushes work.
- Ruling (the operator's, superseding the one above): every push is `--no-verify`, with no whole-suite run
  before it -- each task still runs its own tests and `npm run typecheck`, and the whole suite runs once, in
  Task 12 -- the hook's 45 minutes per push here are not worth it -- a cross-file regression is found at Task
  12 instead of at the task that caused it.

## Tasks

## Deferred minor findings

## Results
