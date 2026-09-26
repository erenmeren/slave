# Review, round 3 — "Build the first fair autonomous delivery benchmark" (implementation brief)

**Verdict: good brief; build it, with the corrections below.** It follows round 2 faithfully:

- the harness owns the judge;
- product changes are near zero;
- there are three arms on one model id;
- goals pin their interface, and each case has a reference solution validated fail-before/pass-after;
- runs are no-touch and end on terminal triggers;
- thresholds are pre-registered;
- nothing organisational is built before the baseline.

The corrections below are things the brief gets wrong or leaves open that would make the pilot unfair or its numbers wrong. Each one was checked against `main` (Claude Code CLI 2.1.283 on the operator's machine).

---

## A. Facts from the code that the brief must account for

1. **Self-review is possible today.** `dispatchReviews` (`apps/orchestrator/src/review.ts`, ~L409–425) picks the first non-busy seat holding `reviewer`. Nothing excludes the task's implementer. The brief's §20 allows "a tiny predicate fix if needed", and it is needed: without it, arm A and arm B do not have the "independent review" the comparison attributes value to.
   - **Do it before the baseline.** It is a correctness fix for a claim the benchmark measures, not an optimisation.
   - **One product diff:** add `reviewer.id !== implementer.slaveId` to the candidate filter, plus one test.
   - **If the only reviewer is the implementer**, the existing `no_reviewer` → hire path must take over. Check this in the dry run.

2. **Killed runs have no cost, so Slave's budget cap is softer than arm C's.**
   - Slave's spend (`packages/control/src/spend.ts`) is Σ `SlaveRun.costUsd` + Supervisor + intake + chat. That part is correct and complete by kind.
   - A Claude run that is killed (timeout, loop breaker, SIGKILL, budget cancel) never emits its final result line, so its `costUsd` stays `null` and counts as 0. In the live data most failed Claude runs are `null`.
   - Arm C has `claude --max-budget-usd`, enforced by the CLI itself.
   - **Consequences:**
     - Arm A/B's real spend is understated exactly on the runs that failed.
     - Slave's `budget_exhausted` guardrail fires late.
     - A and B can overspend their "$25" while C cannot.
   - **Fix in the harness (no product change):** estimate every null-cost run from the usage the stream did emit. Each assistant message in `stream-json` carries a `usage` block; sum those at the model's list price.
     - Where the run output is not retained, fall back to tokens on the run row, else mark `costStatus: partial`.
     - The harness enforces the budget for A/B **itself**, on measured + estimated spend: it emergency-stops the workspace and records `BUDGET_EXCEEDED`. It does not rely on the product guardrail.
     - Report measured and estimated spend separately, and never mix them into one headline figure without saying so.

3. **Concurrency 1 serialises everything, not only implementation.** `decide()` counts planning and review runs against `maxConcurrentRuns`. That is the right definition for arm B, because it isolates parallelism completely, but the brief's §10 wording ("for execution") suggests otherwise. Define B as: `set-limits --max-concurrent-runs 1`, the same roster, and review still by a different seat (after fix A1).

4. **The same model id must be set in four places.** Worker seats resolve their model through `resolveRuntime` (seat → person → template → workspace default). The planner is a seat. The Supervisor has its own `supervisorModel`. Intake has its own model call. For the matrix to be `comparable: true`, the harness sets and then **asserts from the rows after the run**:
   - every `SlaveRun.model`;
   - every `SupervisorDecision` model;
   - the intake's model.

   A run where any differ is `comparable: false`.

5. **Intake forms the team from the catalogue in the run's database.** A scratch database has no catalogue unless it is imported (`import-catalog`), and without one intake cannot staff anything.
   - Import the same catalogue snapshot into every run's scratch DB, and record its hash in the result.
   - If the benchmark bypasses intake (`create-workspace` + `hire`), that is a *different arm definition*: someone chose the team. Use `intake open` / `intake say` / `intake accept` with the goal text as the only human-authored input, which counts as setup, not intervention.

## B. Things the brief gets wrong or leaves open

6. **The "no progress" window must exceed the run timeout, or it kills working runs.**
   - §13 counts only run starts, task transitions, integrations and Supervisor actions. A single healthy implementation run can go 30 minutes (`runTimeoutMs`) with none of those.
   - Either count `run.tool_call` events as progress, or set N ≥ run timeout + one sweep margin.
   - Recommendation: count tool calls, with N = 20 minutes, and document it. A run that makes no tool call for 20 minutes is already a stall by the product's own breaker.

7. **"Seed" is a repetition index, not a seed.** Claude Code runs are not seedable. Call it `rep`, and do not imply determinism.

8. **Account usage limits will confound the arms if runs are ordered naively.**
   - The operator's Claude account has a weekly limit. It was hit on 2026-09-21 mid-work, and `api_error` rate-limit failures appeared in the live data.
   - If arm A runs first and exhausts the window, B and C inherit a different world.
   - Rules:
     - run the matrix **sequentially** (one run at a time, since A's three workers already stress the limit);
     - interleave arm order per case and rep (Latin-square: A-B-C, B-C-A, C-A-B);
     - record every `api_error` / rate-limit event;
     - a run that hit a provider limit is `comparable: false` and is re-run later, not counted as a failure of that arm.
   - Also check before starting: whether the account is subscription or API-billed, and whether the whole matrix (18 runs × up to $25 of *API-equivalent* spend) fits the weekly window. If not, split the pilot across windows **by rep, never by arm**.

9. **Wall-clock budget.** Sequential with up to 3 h per run means the full pilot can take up to 54 h. That is acceptable, but say so. The first dry run should use the **fake CLI** for A/B and a tiny real case for C, to shake out the harness before the matrix.

10. **Arm C needs the same stopping rules as A/B.**
    - Its caps are `--max-budget-usd <limit>` plus a harness `timeout` for wall-clock.
    - Its no-progress rule should be comparable: no stream output for N minutes ends it.
    - When it stops, the harness commits whatever is in the working tree (the same thing Slave's WIP commit now does for workers), so both arms are judged on "everything that was written".
    - Also pin its permission mode. Slave workers run under a permission matrix and C should not have strictly more power: allow edit + shell inside the clone, no network beyond the package install the case needs, **and no user plugins or skills**. That is the same rule Slave now applies to its workers (F9: `--setting-sources project,local`).

11. **Hermetic also means the package install.** "No external services" is right, but `npm install` / `pip install` are network calls whose results drift. For each case:
    - commit a lockfile;
    - install once during validation;
    - cache the install (e.g. an npm cache directory or a vendored `node_modules` tarball) and reuse it in every arm and in the judge.

    Otherwise a registry change between runs shows up as a failure of one arm.

12. **Where the judged commit comes from.**
    - For A/B, the judged commit is the workspace's base branch head at termination. Add a check that every `done` task's merge is an ancestor of it (`integratedAt` set and the branch merged).
    - A task that is `done` without being integrated means the run is not complete, even if the hidden tests happen to pass. Report both flags.

13. **Tamper check scope.** Hidden tests never enter the repository, which is correct. For the repository's own tests and verify script:
    - diff base..judged over test directories and the verify command's files;
    - flag deleted test files, a net decrease in assertion count (a grep for the language's assertion calls is enough as evidence), skip/only markers added, and changes to the verify script or test config.
    - Output the evidence. A hard fail should be only for deleted or disabled tests and a weakened verify script. Everything else is reported for a human to read after the run; that reading happens post hoc and does not count as an intervention.

14. **Review value measurement is feasible and cheap:**
    - worktrees and branches are preserved after rejection;
    - so for every review rejection the judge can run the hidden suite against the rejected snapshot, post hoc;
    - that tells you whether the rejection caught a real defect (hidden fails) or rejected good work (hidden passes).

    Include it in the judge from the start; it is the only evidence the pilot can produce about review's value.

15. **Terminal trigger "all tasks terminal" needs two guards:**
    - **A board that has not been planned yet.** An empty board before the planner concludes must not count as "all terminal": require at least one `workspace.plan_created`.
    - **A pending Supervisor action.** `failed` tasks with a `retry_task` or `retry_planning` the Supervisor may still apply. Wait one Supervisor cycle after the last transition before declaring the end.

    **NEEDS_HUMAN** is mechanically: a `SupervisorDecision` in `pending`/escalation state under `act`, or a halt the product will not lift automatically (`budget_exhausted`, a breaker halt with no applied retry within one cycle), persisting for 2 Supervisor cycles.

16. **Case choice: prefer real small open-source repositories over repositories written for the benchmark.**
    - A repository written for the benchmark risks being unconsciously shaped around what Slave's planner does well.
    - Pick small, well-tested TypeScript or Python projects with fast suites (under 60 s), pin a commit, and write the goal, reference patch and hidden tests against them.
    - Record why each was chosen *before* any run.
    - For the wide case, the three sub-features must be independent in the code as well as in the prose. For example, three new endpoints or commands that share no file beyond a router or registry. Check this in the reference patch itself: its three parts should touch mostly disjoint files.

## C. Agreements (no change)

- **The judge:** harness-side and external; for Slave arms it runs on the integrated base, in a fresh clone.
- **`PROJECT_COMPLETED`:** requires all of verify, hidden suite, no tamper, zero human, within limits, and integrated.
- **Failure categories:** derived in analysis with raw evidence kept, `UNKNOWN` allowed, no schema.
- **What stays unbuilt before the baseline:** no plan-quality, staffing, delivery-note or UI work.
- **Pre-registration:** a decision file committed before the runs; the pilot is treated as directional.
- **The outcome reading:** A > B > C / B > C with A ≈ B / C ≥ both, named in advance.
- **After the baseline:** exactly one change, then re-run the same matrix.

## D. Answer to the brief's §34 structure: what changes from my side

- **Product changes required: ONE.** The reviewer ≠ implementer predicate (A1). Everything else stays in the harness, including cost estimation and budget enforcement for A/B (A2).
- **Implementation order to the first dry run:**
  1. **Case schema and validator,** built on one real repository case, with the lockfile/cache rule (B11).
  2. **Arm C runner** (smallest), then the **judge**, then the **tamper check**. Validate them together on the reference patch: C is replaced by "apply the reference", and the judge must say `PROJECT_COMPLETED`.
  3. **Arm A/B runner.** It reuses the gate harness (scratch DB, state dir, daemon spawn, event reads), plus catalogue import, intake driving, model pinning with the post-run assertion, and terminal detection. Dry-run it on the **fake CLI** with a scripted plan.
  4. **Cost estimation from stream usage,** plus harness budget enforcement.
  5. **The reviewer ≠ implementer predicate** plus its test.
  6. **Aggregator, decision file, and README.** Then a harness review before any paid run.
  7. **One real single-case smoke** per arm (3 runs), then the 18-run pilot, sequential, with the Latin-square order.
