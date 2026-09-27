# The Supervisor conducts: one owner per file, skills in the prompt, every requirement verified before merge

Date: 2026-09-27. Status: design, awaiting the operator's read. Supersedes, for new projects, the planner-graph
decomposition; defers plan-first B's two-level planning and department managers
(`feature/plan-first`, `2026-09-21-plan-first-projects-design.md`).

## 1. Why

The benchmark rounds of 2026-09-26/27 (`../slave-of-ai-bench`, `benchmarks/results/matrix/pilot-1` and
`large-1`) measured the product against one Claude Code session on the same goals, same model:

- **Work that fits one session is done better by one session.** On the large case (harlequin `hsql` report
  modes, ~1,750 lines) a single session finished in ~33 min for ~$10 and passed 72–73 of 73 hidden tests with
  the full bug-hunt suite; the Slave team took ~97 min, cost ~2x, passed 33–62 of 73, and an independent blind
  reviewer rejected all three of its changes and ranked them last.
- **The team never became a team.** Intake staffed 1 implementer + 1 reviewer before the plan existed, and
  nothing grew it to the plan's width (4 parallel modes); peak implementation concurrency was 1 in every run.
- **Parallel branches collided.** Tasks touched the same `cli.py`/`config.py`; a task that failed to merge
  twice halted the whole workspace and the Supervisor could only escalate.
- **Nobody held the whole.** The team's defects sat where parts meet (output contracts, stubs left
  "not yet implemented"); the single session's only misses were single goal-stated requirements a
  requirement-by-requirement check would catch.
- **Skills were never used.** Skills were copied into worktrees and named in the prompt; no session loaded one.
- **A stalled worker was not stopped.** A worker's stream stopped mid-answer for 32 min; the workspace's
  30-minute `runTimeoutMs` did not end it.

## 2. Operator rulings (2026-09-27)

1. Slave's purpose is a **control layer that makes AI work reliable and auditable**, for the single developer
   first and teams later on the same base.
2. The **Supervisor works like an orchestra conductor**: everything reports to it; it decides who does what.
3. **Workers touch only their own files; no two workers work on the same file.**
4. **Workers are called with the skills attached to them written into their prompt, and follow their
   workflows.**
5. The developer's trust needs: a **requirement–evidence report**, a **hard gate** (nothing merges until every
   requirement is verified), and **budget and decision trail**.
6. Requirements are **extracted automatically, without an approval step**; the person sees them in the report.
7. The verifier **writes and runs its own checks** per requirement; they are evidence, never committed.
8. No further benchmark round before building this.

## 3. The flow

1. **Requirements.** A goal (version) is turned into a numbered requirement set R1..Rn by the conductor.
2. **Size.** The conductor decides `single` (one worker does the whole goal) or `partitioned` (2..N work
   packages with disjoint files). The default is `single`; `partitioned` only when the goal splits into parts
   that own different files **and** it will not fit one session. The decision and its reason are recorded.
3. **Packages and ownership.** Each package names its requirements, the paths it owns, the interface it must
   provide or may use, and its dependencies. A shared file has exactly one owning package (usually an
   `integration` package that wires the others in, last); everyone else codes against the declared interface.
4. **Staffing.** One seat per package, chosen from the catalogue by the package's capabilities; a seat works
   one package at a time.
5. **Dispatch.** A worker's prompt carries its requirements, its owned paths, the interface contract, the
   **full text of its skills**, and its **workflow as a checklist**.
6. **Report.** Every worker ends with a structured report to the conductor: requirement status and evidence,
   files touched, workflow steps done, open questions. Questions go to the conductor at once.
7. **Verify.** An independent verification run checks every requirement with checks it writes and runs.
8. **Gate and loop.** A failed requirement goes back to the package that owns it, with the verifier's findings;
   the loop runs until all pass or the budget/attempt cap ends it. Merge happens only when all pass.
9. **Report to the person.** One report per goal version: requirement → status → evidence; spend; the
   conductor's decisions and reasons.

## 4. Requirements

**R0 — A stalled run ends at the run timeout (bug, first).** Reproduce the large-1 multi rep 2 stall (a
worker process alive, stream silent) in an integration test; find why `observedWorkingMs` did not reach
`runTimeoutMs` (the sweep's liveness view of a silent process); fix so a run that produces no stream line for
the timeout is ended and follows the existing retry path. Independent of the rest; ships alone.

**R1 — Requirement sets.** `RequirementSet { id, workspaceId, goalVersion, items: [{ key: 'R1', text,
source: string /* the goal sentence it came from */ }] }`, one per goal version, written by a decision call
(`kind: requirements`) right after the goal is set (intake accept and every `set-goal`). Rules the prompt and
a parser enforce: each item one testable statement, quoted-or-paraphrased from the goal, no invented scope,
1–60 items. No approval step (ruling 6). Event `workspace.requirements_set` with the count. A goal change
produces a new set; items that are textually equal keep their key.

**R2 — The conductor's size decision.** A decision call (`kind: conduct`) receives the goal, the requirement
set, a repository map (paths, sizes, top-level symbols — bounded), and the catalogue summary; it answers
`{ mode: 'single' | 'partitioned', reason, packages?: [...] }`. `single` is the default the prompt argues
for; `partitioned` must name ≥ 2 packages whose owned paths are disjoint and give a size reason. Recorded as a
Supervisor decision (`situationKind: conduct`, tier `applied`) so it is in the decision trail. Planner-graph
planning is not dispatched for a conducted workspace.

**R3 — Work packages and file ownership.** `WorkPackage { id, workspaceId, key, title, requirementKeys[],
ownedPaths: string[] /* globs, repo-relative */, interface: string /* the functions/types/CLI surface it
provides and uses */, dependsOn: key[], status }`. Validation (pure, domain): every requirement in exactly one
package; owned path globs pairwise disjoint over the repository's current files **and** over new paths the
packages declare; a path matched by no package is owned by the `integration` package (created by the
validator if the conductor named none, dependent on all others). A package becomes one `Task` (its title,
its requirements as the description, `workPackageId` set); dependencies become task dependencies, so today's
dispatch, worktree, verify, review and merge machinery run unchanged.

**R4 — Ownership is enforced, twice.**
- *At the tool call:* the permission gate denies `Write`/`Edit`/`MultiEdit`/`NotebookEdit` on a path outside
  the run's owned globs (a new matrix input `ownedPaths` in the run's permissions file; deny reason prefixed
  `permission matrix denies 'foreign_file'`).
- *At the end of the run:* a shell can write anywhere, so the run's diff is checked against the owned globs
  before verify; a file outside them fails the run with the list (the worker's attempt, back to rework with
  "revert changes to files you do not own: …").
- `single` mode owns `**`, so both checks pass trivially.

**R5 — Staffing follows the packages.** After R2/R3, the conductor staffs one seat per package with the
existing `formTeam` over the package's capabilities (hire from the catalogue as today; reuse an idle seat of
the same template). A seat holds one package at a time. Intake no longer staffs the implementation team for a
conducted workspace: the conductor is the Supervisor (not a seat), and intake staffs only the verifier seat
(R8).

**R6 — Skills and workflow are in the prompt.** For every implementation, rework and review run, the run context's
SKILLS section carries, for each effective skill (template ∪ grants − revokes, as today), its `SKILL.md`
**body** (front matter stripped), in a section headed as instructions the worker must apply; per-skill cap
8,000 characters, total cap 24,000, skills ordered persona-default first, then grants; a skill cut by a cap
says so and keeps the copied files for the rest. The persona's workflow steps (profile spec `workflow`)
become a numbered checklist the report (R7) must answer step by step. The manifest records which skills were
inlined, truncated or left out.

**R7 — Workers report to the conductor.** An implementation run's final message must contain
`<slave-report>{ "requirements": [{ "key", "status": "done|partial|not_done", "evidence" }],
"filesTouched": [...], "workflow": [{ "step", "done", "note" }], "questions": [...] }</slave-report>`.
Parsed and stored (`RunReport`); a missing or unparsable report is a run failure with a clear reason (one
rework). `questions` open a question to the conductor at once (existing ask machinery, recipient
`conductor`), answered by the Supervisor's sourced-answer path, never left waiting on an idle seat.

**R8 — Verification is its own run.** A new run kind `verification`, dispatched once every package of the
goal version is integrated into the goal version's **integration branch** (R9), and again after each rework
round, in a fresh worktree of that branch, by a verifier seat that implemented nothing in this goal version. Prompt: the requirement set, the
integrated diff summary, the rule "for each requirement write a check (command, script or test) in the
scratch directory `$SLAVEOFAI_VERIFY_DIR` outside the repository, run it, and report". Permissions: read the
repository, run commands, write only the scratch directory. Output
`<slave-verification>{ "items": [{ "key", "status": "pass|fail|unverifiable", "check", "output",
"reason" }] }</slave-verification>`; stored as `VerificationResult` rows with the check text and trimmed
output (evidence).

**R9 — The gate and the loop.** A goal version is `accepted` only when every requirement is `pass` in the
latest verification. A `fail` sends its owning package's task back to `rework` with the verifier's check,
output and reason (the same rework channel verify and review use); `unverifiable` is surfaced to the person
in the report and blocks acceptance (the hard gate). Rounds are capped by the mode's `reviewRetryCap`-like
`verificationRoundCap` (default 3) and by the budget; when a cap ends the loop the goal version ends
`needs_human` with the report.

*Where merges go (ruling 5: nothing reaches the base branch unverified).* A conducted goal version gets an
integration branch `slaveofai/goal-v<n>` cut from the base branch. Package tasks merge into it with today's
merge pass (rebase, post-rebase verify commands, serial), not into the base branch. When the goal version is
accepted, the integration branch is merged into the base branch once (fast-forward or a merge commit, the
workspace's `autoMerge` setting deciding whether a person confirms it, as today). No task of a later goal
version is dispatched until the current one is accepted or the person moves on.

**R10 — One report per goal version.** A page (web) and a Markdown export: the requirement table (key, text,
status, evidence link: the check and its output), the packages and their owners, the files each touched,
spend against budget, and the decision trail (the size decision, staffing, questions answered, reworks and
why). The Supervisor chat's thread for the goal ends with the report's summary.

**R11 — Everything reports to the conductor.** The Supervisor's world gains the requirement set, packages,
run reports and verification results; its situations gain `conduct` (R2), `report_missing` (R7),
`foreign_file` (R4, after a second violation), `verification_failed` (R9, informational), `goal_needs_human`
(R9 caps). Existing situations (stalls, breaker, budget, halts) stay.

## 5. What changes for existing behaviour

- New projects are **conducted** by default (`Workspace.delivery = conducted | planned`, default `conducted`);
  existing projects keep `planned` (today's planner graph) and can be switched.
- The planner graph, intake team sizing by workstreams and plan-first B's workstreams/managers stay in the
  code for `planned`; B's two-level planning is deferred.
- Repeated merge failure no longer halts a conducted workspace: disjoint ownership removes the cause; a merge
  failure into the integration branch goes back to its package's rework once, then escalates that package
  only.
- A conducted workspace's base branch changes only when a goal version is accepted (R9).

## 6. Data and interfaces (what a plan will name)

- Prisma: `Workspace.delivery`; `RequirementSet`, `WorkPackage` (+ dependencies), `Task.workPackageId`,
  `RunReport`, `VerificationResult`; `SlaveRunKind` gains `verification`; situation kinds as in R11; hand-
  written migrations.
- Domain: `requirements/` (schema, parser, stable keys across versions), `conduct/` (decision schema,
  `validatePackages`: disjointness, coverage, integration fallback), `ownership/` (glob match, diff audit),
  `report/` (parsers for `<slave-report>` and `<slave-verification>`), run-context sections for skills bodies,
  workflow checklist, requirements, owned paths, interface.
- Providers/scripts: permission gate `ownedPaths` input and `foreign_file` deny.
- Control/orchestrator: requirement extraction after goal set; conduct decision + package → task
  materialisation; staffing per package; the goal version's integration branch as the merge target; dispatch
  of `verification` runs; the gate and the final merge into the base branch; R0's sweep fix.
- Web: the goal-version report page; Markdown export route; workforce cards unchanged.

## 7. Test plan (headline cases)

- R0: a run whose process is alive and silent past `runTimeoutMs` is ended and retried (integration).
- R1: a 20k-character brief yields a bounded, keyed set; a second version keeps unchanged keys.
- R3: overlapping globs refused; an unowned path lands in `integration`; coverage of every requirement.
- R4: an `Edit` on a foreign file is denied by the gate; a shell write to a foreign file fails the run at the
  diff audit with the file named.
- R6: a seat with two skills gets both bodies in the prompt within the caps; the manifest says so.
- R7: a run without `<slave-report>` fails once with the reason; a question in the report reaches the
  conductor on the next tick.
- R8/R9: a failing requirement reworks exactly its owning package; all-pass accepts the goal version;
  `unverifiable` blocks acceptance and appears in the report; the round cap ends in `needs_human`.
- End to end with the fake CLI: a `single` goal and a two-package goal each reach `accepted` with a report.

## 8. Risks

- **Requirement extraction quality** decides the gate's value; a missing requirement is a blind spot the
  report cannot show. Mitigation: `source` sentences in the report let the person spot gaps; no approval step
  by ruling 6.
- **Disjoint ownership needs a good split**; a goal whose parts all edit one file is `single` by R2's rule.
- **Skill text costs tokens** on every run; the caps bound it; generic skills may still not change behaviour.
- **Verifier false failures** cost rework rounds; the round cap and the report bound them.
