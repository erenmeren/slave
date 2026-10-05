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

- Task 1 -- done, reviewed: `6c934c5` (migration `20261004090000_lead_flow`, the domain `lead/` lists, progress
  and state word, two events, web cards, m56a 78 -> 80). Review: CLEAN, three minor findings; two fixed in a
  review commit (timeline detail for `workspace.lead_state`; `LEAD_SITUATION_KINDS` pinned against
  `SITUATION_KINDS`), the third carried to Task 6/7 (below).
- Task 2 -- done, reviewed: `8b5a2fb` + review fix `281353b`. Review round 1: FIX (one Important: a planned
  board with open tasks between runs could be switched; four Minor); round 2: CLEAN. The fix also caught a
  plan bug: `--auto-merge` is a valueless flag to the CLI parser, so `set-flow --auto-merge off` turned automatic
  merge ON; the case now reads the value from argv.
- Ruling: `setFlow` refuses while any task of the board is open (`boardIsBusy`'s rule without its version
  exclusion), runs as one transaction under the workspace row's lock, and refuses an option it would drop --
  L1's "a version must end in the flow it started in" also covers a planned board, which has no delivery row --
  a person must finish or cancel a board's tasks before switching.
- Ruling: switching back to `packages` closes the three system seats (`closedAt`, `runtimeRoles: []`) --
  otherwise `staffVerifier` can pick the lead flow's Verifier for a packages version -- each round trip makes
  three new Person rows (`Lead <id> 2`, ...).
- Task 3 -- done, reviewed: `eea86b2` + review fix. Review: CLEAN (goldens regenerated by the reviewer were
  byte-identical; hook plane untouched). Beyond the plan, two files had to move: `resolve.test.ts`'s toolbox
  count 36 -> 37, and `docs/providers/adding-a-provider.md`'s ledger row (a test pins it to the manifests).
- How the vocabulary gate covers the tool name (asked by the operator): `PROTECTED_EXACT = /(["'`])Agent\1/g`,
  case-sensitive, the same quote on both sides -- `'Agent'`, `"Agent"`, `` `Agent` `` pass; the bare word, any
  other case, a plural and mismatched quotes are still offenders (probed with seven lines and a self-test case).
  Review fix: a removed protected token leaves a space, so `x'Agent'agent` no longer glues into a pass.
- Task 4 -- done, reviewed: `020eafd` + review fix `b13e696`. Review: CLEAN (argv/env byte-identical without a
  resume id or extras file; the fake's m8-flow arm byte-identical without the new flags); four minor fixes
  (a parent id of another shape no longer makes a line unparsable; one reading of the parent for both fields;
  session definitions kept only when they are one JSON object; more bad-file test cases).
- Deviation, accepted: the roster's byte bound uses `TextEncoder`, not `Buffer` -- the domain package is
  bundled into the browser build and imports no Node built-in.
- Task 5 -- done, reviewed: `9625fc3` + review fixes `f41bf6a`, `882f6ea`. Round 1: FIX (Important:
  `goalWorkedMs` charged the pause of a run stopped while paused -- `requestStop` ends it without folding
  `pausedAt`); round 2: CLEAN. Also fixed: a new import cycle (`LEAD_RULES` moved to the leaf `lead/rules.ts`);
  `ROUTING_LITERALS` gained `intakeAnswer` and `personas`, which the fake routes by (a goal quoting them would
  have sent a lead turn to the intake fixture); the share left is cut down to the cent.
- Ruling: a lead leg is also capped so the proof reserve stays whole -- `nextLeadLeg` takes `proofSpentUsd`
  and caps at `budget - leadSpent - proofSpent - budget/5`, the conductor's cost not counted -- spec P5 says
  the reserve always covers the final full verification, and proof runs may spend into the lead's unspent
  share -- the lead can be ended for budget earlier than its share alone says, when proof was expensive.
- Task 6 -- reviewed: `16371dc` + review fixes `fc6d7d3` (+ one more for an unmoved-ref update-ref failure).
  Round 1: FIX (Important: a lead that rewrote integrated commits made `merge-base --is-ancestor` throw out of
  the pump's conclusion, stranding the task and looping paid turns); round 2: CLEAN. Also fixed: stop events
  deduped and written outside the lock honestly; a lost transcript stays lost; an unspawned first turn is not a
  turn; C7's "at least / at most" in what the lead itself reads; a later reset to the cut is not "nothing
  built". Deviation, accepted: `tickUntil` reads Prisma's P2025 from its condition as "not yet" (the plan's
  `merged(f)` reads the delivery before the conductor made it). Two fake switches (`--reset-hard`,
  `--amend-work`), no-ops unless passed.
- Ruling: when the lead's tip does not contain the work branch's tip (it amended, rebased or reset), the work
  branch FOLLOWS the lead's branch by compare-and-swap, with one `branch_rewritten` note -- the work branch is
  the lead's own and the final full verification proves whatever tip is delivered -- commits the lead threw
  away leave the delivered history without a word beyond that note.
- Ruling: `progressJson` cuts a turn note to 20 000 characters and refuses (throws, in the lock) a progress that
  would not read back -- `readLeadProgress` resets the whole record on one bad field -- a write that is refused
  fails its tick instead of storing.
- Task 7 -- done, reviewed: `84ab662` + review fixes `4873a58`, `5ca2a27`, `83def04`, `aa7930b`. Round 1: FIX
  (Important: a resumed paused turn got its whole leg again, because a paused run's cost is not yet on its row
  and `--max-budget-usd` counts from zero per process); round 2: CLEAN. Also fixed: a provider refusal is never
  a C6 continue; decisions re-read at the 40 cap count recorded titles as known; the refused-call list is
  defused before it goes into a prompt; C6 releases the claim before it writes; an ended lead is not told to
  decide; `noteLeadOnce` compares the stored form.
- Ruling: a resumed paused turn's cap counts the checkpoint's `cumulativeCostUsd` (the pump's figure for this
  run so far) while the run's `costUsd` is still null -- the measured figure arrives only at the run's end --
  with no model named (C5) the price estimate can be missing, the figure 0, and the turn gets its whole leg
  again: bounded by the vendor cap of that leg, not by the share.
- Deviation, accepted: a lead task with no goal version (`integrationTargetFor` null) releases a failed turn
  instead of keeping its claim, as Task 6 did.
- Task 8 -- done, reviewed: `2b27467` + review fix `e9ab976`. Review: CLEAN with two minors, both fixed: an
  ended lead's work branch that git cannot move stops the version with one card (was: retried on every pass,
  no card); a turn cancelled for the goal's time is claimed `stopping` + `platform`, so whichever path
  concludes it charges no attempt. The plan's 19.20 / 4.80 legs hold under the Task 5 reserve rule (no proof
  was paid before the wrap-up). Container restarts stopped the implementer twice; its uncommitted work was in
  the tree and it resumed from there.
- Ruling: an idle settle (no claim: the lead was ended) whose work branch git cannot move stops the version
  under the reason the lead was ended for, with git's error as the card's detail -- spec section 3: a system
  fault the product cannot work around reaches a person -- a transient git fault (a lock released a second
  later) stops a version that one more pass would have saved.
- Task 9 -- done, reviewed: `46a761e` + review fix `ed02bc3`. Review: CLEAN with eight minors, seven fixed: a
  smoke or verdict that cannot reach the lead's task stops the version the lead flow's way; the task's
  `done -> rework` write is checked; an unpaid confirmation is named on the card; a resumed lead-flow
  VERIFICATION run is re-capped at what the goal has left (`refreshLeadProofSpawn`, M(b)); a confirmer's
  "unverifiable" is not noted as unverifiable; a missing confirmer seat holds rather than letting the verifier
  confirm itself. Adapted, not weakened: `lead-open`'s `failR1Once` now fails R1 for the confirmer too.
  Deviations, accepted: the smoke step is decided before `workspace.smoke_run` so a stop records
  `reworkedPackage: null`; a lead-flow confirmation re-checks `everyPackageIntegrated` in its locked claim.
- Task 10 -- done, reviewed: `b801c64` + review fixes `cf92a15`, `d0d2c34`, `5b1b05e`. Review: CLEAN with six
  minors, all fixed: Approve on a version whose work branch is gone is refused with the reason (was a throw
  after the card was claimed); the packages flow's Approve of a card whose row is gone is `none` as before;
  the state sync does not overwrite a `left` written meanwhile; the time limit also ends a base turn of an
  accepted version; a moved base is not merged into a dirty lead worktree, and each non-conflict reason is
  said once. Deviations,
  accepted: `leadTakeBaseIn` never throws on git (null-safe reads; a conflict told apart by `MERGE_HEAD`; the
  worktree must exist and be on the lead's branch; a lost compare-and-swap is `unmoved`); `baseCommit` and the
  reopened progress written in one locked write; a failed or cancelled lead task is `unmoved` (the plan's text
  would have waited for ever); `confirm` cleared with `recheckKeys`/`failing` on reopen.
- Task 11 -- done: `5ae2959` (tests only). Every assertion of the plan held against Tasks 1-10 as built; no
  product fix was needed. Two test-only adjustments: `new Set<string>` (the plan's snippet failed typecheck), and
  a check that each run directory still exists before reading its (absent) extras file.
- Task 12 -- typecheck clean; vocabulary gate PASS; no `agency-agent[s]` added (the 15 hits are older plan files,
  the same on main); drift check "No difference detected"; `web:build` passes; hook-plane scripts unchanged
  since the spec commit. Whole suite and gates: see Results.
- Whole-branch review (on the Fable model, read-only while the suite ran): FIX. The five Review Focus scenarios
  hold through the real code. Three Important: (1) every reader except `leadSpendOf` SUMS `SlaveRun.costUsd`,
  so a resumed lead session's running totals were counted many times on the project page, org page and goal
  report; (2) daemon downtime was charged to the goal's time (an orphan's `endedAt` is set when the sweep finds
  it after a restart); (3) a deleted branch threw out of `settleLeadWork`, looping paid uncharged turns. Ten
  Minor. The suite run of Tasks 1-11 was stopped so it runs once on the fixed branch. One fix wave follows.
- Ruling: a lead turn's row stores its OWN spend -- the reported session total less the earlier rows of the same
  session -- and `leadSpendOf` sums -- every other reader of `costUsd` sums, and a row-level figure is what
  they mean -- if a run's earlier rows of the session are rewritten or deleted, its figure is off by them.
- Ruling: an orphaned or dead run (failed `platform`, no cost) counts working time up to its last output, not up
  to when the sweep found it -- L7 says daemon downtime is not charged -- a run that worked silently until it
  died is charged less than it worked.
- Not fixed, recorded: an unbudgeted AND untimed lead project has no bound on alternating failures (SMOKE, then
  R1, then SMOKE: never "the same set twice") -- plan B's spec stage always sets a budget and a time limit (S5);
  until then a person should set one (`set-lead --time-limit-min`, the workspace budget). `proofCapUsd` lets the
  first proof round spend the whole reserve, so spec P5's "the reserve always covers the final full
  verification" is not guaranteed (plan L6's choice). `lead-status` prints `leadUsd` beside `unmeasuredRuns`
  without the C7 wording (the CLI's JSON is for people who read both).

## Deferred minor findings

- Task 1 review, carried forward: `readLeadProgress` resets the WHOLE record when one field fails its schema,
  which would silently wipe `leadEnded`, `askReplies`, `baseMerges`, `denialContinues`. Task 6 makes
  `progressJson` / `updateLeadProgress` validate with `leadProgressSchema` before writing (a throw inside the
  lock), and Task 7 bounds the C6 continue note it writes into `nextTurn.note`.
- Task 2 review round 2, left as built: the open-task refusal says "finish or cancel them" where a done task
  awaiting a hand merge needs merging instead; closing the seats appends no `org.changed` and a round trip makes
  new persons rather than reopening seats; `set-flow --flow lead --auto-merge on` on a project already so
  exits non-zero (not idempotent); `setFlow(…, 'packages')` ignores `model`/`autoMerge` without a word.
- Task 3 review, left as designed: `PROTECTED_EXACT` also passes the old table name when written `"Agent"` (L17's
  design; nothing tracked does it); the codemod's copied comment says "offender" where it means "renamed".
- Task 4 review, for Task 7: a subordinate's TEXT lines arrive on the lead's stream as plain `text` events
  with no parent marker, so the turn's joined output (the ask detection, the "closing report" check) also
  holds what subordinates wrote; and the pump's `lastToolUse` can be a subordinate's call. Left as built:
  marking text lines is beyond C1, and a subordinate writing a `<slave-ask>` block costs one "decide yourself"
  turn at most.
- Task 6 re-review, for Task 9: `lead-open`'s "follows a lead that amended" test scripts only the first
  verifier; once the confirmer exists, run 2 is the confirmer and must fail R1 too, or R1 is disputed.
- Task 6 re-review, accepted: a stop rolled back inside its transaction leaves its two events in the log (the
  card is built from the row, so only the goal report trail can show a stale stop line).
- Task 9 review, not fixed: `afterConfirm` ignores the tip (a confirmation on another commit than the first
  verifier's would still decide) -- the work branch cannot move while a version is `verifying` in this plan.
- Task 9 review, for Task 10/11: a version ended by the unusable-run cap (`endInNeedsHuman`, not `stopLead`)
  keeps a pending `confirm`; a later `retry-goal` would open with a confirmation run. Harmless.

## Results
