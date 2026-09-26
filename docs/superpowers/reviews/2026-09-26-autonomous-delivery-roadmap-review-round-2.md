# Review, round 2 — "Slave — Revised Autonomous Delivery Master Plan"

Same reviewer as round 1 (`2026-09-26-autonomous-delivery-roadmap-review.md`). This round classifies only what is **new or changed**, answers the 18 questions in §56, and checks the remaining claims against `main`.

The revision took round 1's findings almost wholesale. That is not in itself a reason to approve, so the questions below are aimed at what the revision **added**. It added four kinds of thing:

- the judge's product-mode semantics;
- the arm definitions;
- the phase exit criteria;
- the failure-class taxonomy.

It also left the **first benchmark behind six product phases**, which the code shows it does not need to be.

---

## 0. One new fact from the code that changes the order

Everything a benchmark needs to drive Slave headlessly already exists as CLI verbs (`apps/orchestrator/src/cli.ts`):

- `init-repository`
- `intake open` / `intake say` / `intake accept [--draft file.json]`, where Slave forms the team from the goal with no human choosing people
- `create-workspace --repo --verify --budget --provider --auto-merge`
- `set-goal`
- `set-supervisor --autonomy act`
- `set-limits --run-timeout-min --max-concurrent-runs --max-attempts`
- `hire`
- `status`
- `emergency-stop`
- `daemon`

The `gate:*` scripts already start daemons against scratch databases and state directories, run them to quiescence and read the event log. They do this with fake CLIs, and pointing them at real CLIs is a flag (`SLAVEOFAI_REQUIRE_FAKE_CLI` unset).

**Consequence:** the first fair benchmark needs no product change. The judge, the tamper check, human-intervention counting and cost can live **in the harness** for the first run. They read the database and the integrated clone after the run ends. Phases 0–1 of the revised plan are product work (a `ProjectOutcome` table, halt events, cost provenance, version columns), and doing them before any data exists means building a judge whose rules have never met a real run.

Build the judge outside the product, learn its rules on real runs, then move it in.

---

## 1. Classification of the new pieces

| § | Piece | Verdict | Note |
|---|---|---|---|
| 1, 12 | Evaluate the ORIGINAL goal independently of the planner | **AGREE** | |
| 5 | Measure → classify → fix → re-run → keep/revert | **AGREE** | Add: pre-register the decision thresholds before the first run (§3 below) |
| 7 | Flat first-milestone organisation | **AGREE** | |
| 8 | Phase 0 measurement correctness | **MODIFY (split)** | Harness-side for the first benchmark; the product-side items follow the first data. Cost: restrict the first benchmark to Claude Code, where cost is measured, instead of building estimation first |
| 8 | Human intervention "when required because Slave could not continue" | **MODIFY** | "When required" is a judgement. Make it mechanical, and in benchmarks make human rescue impossible (§2 Q11) |
| 8 | Budget → `PROJECT_FAILED{BUDGET_EXCEEDED}` | **AGREE for benchmarks; MODIFY for product** | In the product, `budget_exhausted` is a person's money and stays a halt that asks (it is deliberately excluded from automatic remedies). Benchmark mode makes it terminal |
| 9–12 | Goal-level judge, deterministic core | **AGREE, with one missing definition** | *When* does the judge run? There is no terminal trigger (§4 item 1) |
| 10 | Held-out acceptance | **MODIFY** | Practical only with interface-pinned goals, a reference solution per case, and a fail-before/pass-after validation (Q3) |
| 11 | Product acceptance = GoalVersion + frozen spec | **MODIFY** | Says who must *not* judge, but not who writes the spec. It needs an author other than the planner, and it must be executable where possible (Q2) |
| 13 | LLM judging secondary only | **AGREE** | |
| 14 | Tamper check | **AGREE** | Held-out files never enter the repo during the run, so the check is really about the repo's own tests and verify script |
| 15–17 | Benchmark runner, three arms, repeated trials | **AGREE, with arm definitions tightened** | Q4 |
| 18 | Primary metric = unassisted completion rate | **AGREE** | |
| 19 | Secondary metrics | **AGREE** | Report "planner failure share" only once it has a mechanical definition (Q11) |
| 20–23 | Task-size budget, width/depth, deterministic plan self-check | **AGREE, conditional** | Conditional on the baseline showing the problem *at benchmark scale*; see Q7 |
| 24–26 | Plan-first roster reusing `formTeam` | **MODIFY → conditional** | Its exit criterion ("less irrelevant staffing") measures something with no cost. Build it only if the baseline shows staffing delay or unserved roles (Q5) |
| 27 | Eight failure classes | **MODIFY** | Do not add them as columns. `SlaveRun.failureClass` (worker/platform, merged 2026-09-25) stays the only run-level column; the eight are a *benchmark-analysis* classification derived from existing events |
| 28 | Delivery note | **AGREE, with source and timing specified** | Q8 |
| 29 | reviewer ≠ implementer, enforced at dispatch | **AGREE** | Necessary, not sufficient (Q9) |
| 30–31 | Minimal preflight + planner repo notes in Memory | **AGREE** | Add the product/benchmark split for a red baseline (Q10) |
| 32 | Persisted waiting reasons | **AGREE** | The tick already computes most of them (`waitingOn`, `skippedNoRole`, `unservedRoles`) |
| 33–37 | Graph → Command Map in place | **AGREE** | Late (Phase 8) is right |
| 38 | Office frozen | **AGREE** | |
| 39 | Final report | **AGREE** | |
| 40 | Deterministic platform gate | **AGREE** | Most of it exists across `gate:m38`, `gate:m47`, `gate:m50` and `gate:h9-restart-chaos`; compose, don't rewrite |
| 41–43 | Hypothesis test, support/non-support conditions | **MODIFY** | "Materially" is undefined. Pre-register numbers (Stop Conditions below) |
| 44–48 | Borrowing | **AGREE** | Matches round 1 |
| 49 | Explicit deferrals | **AGREE** | |
| 50 | Implementation order | **MODIFY** | Move the benchmark ahead of product Phases 0–1 (see §0) |
| 53–55 | Core question, decision rule, near-term target | **AGREE** | The best part of the document |

---

## 2. Answers to §56

**1. Is measurement early enough?** Almost. It is first in the order, but it is framed as product work, so the first data point waits on a `ProjectOutcome` table, halt events, cost provenance and version columns. Put the judge and the metrics in the harness for the first benchmark. They then become product features once their rules have been exercised on real runs.

**2. Is the judge independent enough from the planner?**

- **For benchmarks, yes.** The acceptance suite is held out, author-written and run on the integrated base.
- **For the product, not yet.** §11 says the planner must not be "the sole authority", but not who authors the acceptance spec. If it is the intake model, it is the same model family reading the same goal. The minimal rule:
  - the acceptance spec is written **at intake, before planning**, by a run that is not the planner;
  - it is shown to the person once (setup, not an intervention) and frozen on the `GoalVersion`;
  - wherever possible it is **compiled into executable checks** stored in a protected path that workers can read but a commit to which fails the tamper check;
  - prose-only criteria are the LLM-judged secondary evidence.

**3. Is the held-out strategy practical?** Yes, if three conditions hold; otherwise it measures naming luck.

- **Interface-pinned goals.** A hidden test must bind to something the goal fixes: endpoint paths, CLI flags, exported function names, table names. "Add API-key expiration" is not testable black-box until the goal says, for example, `POST /keys` accepts `expiresAt` and an expired key gets HTTP 401. Pin the interface in the goal text; leave everything else open.
- **A reference solution per case.** The case author implements it once. The harness checks that the hidden suite **fails on the base commit and passes on the reference**, otherwise the case is invalid. This is how SWE-bench-style datasets avoid broken cases, and it costs one implementation per case.
- **Hermetic execution.** No external services: the §10 Stripe example is a bad benchmark case unless it runs against a local fake. Hidden tests run in a fresh clone of the integrated base with the case's own dependency install, never inside a worker's worktree.

**4. Is the three-arm comparison fair?** Close. Five definitions need pinning before the first run.

- **Same model id and provider in all arms.** "Model family where possible" leaves a confound. The first benchmark should be Claude Code only, because Cursor runs have no measured cost.
- **Arm B (one seat) = `maxConcurrentRuns = 1` for every run kind**, with the same roster and still a reviewer different from the implementer. This isolates *parallelism*. It does not isolate independent review; if review's value matters, add a later ablation with review off.
- **Arm C (single agent) = one headless coding-agent session in a clone.** It gets the same goal text, the same verify command named in the prompt, and the same budget and time cap enforced by the harness. It has no Slave services. Pre-register whether one "continue" nudge is allowed if it stops early; I recommend none.
- **Budget counts everything Slave spends:** planner, reviewers and Supervisor model calls, not only implementation runs.
- **Wall-clock is a legitimate advantage for A**, not a confound. Report it separately from completion.

It is also important to see what the arms separate. **C → B isolates the value of Slave's harness** (planning, verify, review, retry, integrate, recover) around one worker. **B → A isolates the value of the organisation** (parallel width). If B beats C but A does not beat B, Slave still has a product: a reliability harness rather than an organisation. That outcome should be named in advance so it is not read as a failure.

**5. Is plan-first staffing correctly positioned?** Its position is fine; its justification is not. Its exit criterion ("less irrelevant staffing") improves nothing measurable, because an idle seat costs nothing in Slave. Make it conditional. Build it only if the baseline shows either:

- time lost to reactive staffing (`capability_unstaffed` / `ready_unstaffed` situations delaying runnable tasks); or
- intake picking a planner or roles that fail the plan (`planning_stalled{no_planner}`, unserved roles at plan conclusion).

**6. Still rebuilding anything?** Three small overlaps:

- **Failure classes (§27).** Do not add a column per class; `failureClass` exists. Derive the eight classes in analysis.
- **Human intervention counting.** `EvidenceRecord.humanInterventions` exists per run (`domain/evidence/derive.ts:108`). Fix *its* derivation (breaker-started resumes are currently written with actor `human`) rather than adding a second counter.
- **Halt lifecycle.** `Workspace.haltClearedAt` exists but keeps only the latest clear. Add the `workspace.halt_cleared` event; add no new halt table.

**7. Is task-size and width work the highest-priority improvement?** It is the best-supported *hypothesis*, not a fact.

- **What the live evidence shows:** timeouts and loops on oversized tasks, and 8–10-deep chains, on two large, open-ended projects.
- **The benchmark it would be tested on:** small, two-area goals, which may decompose into three to five tasks where width barely matters.
- **The risk of a small-only benchmark:** it structurally favours the single agent and never exercises the organisation.
- **Remedy:** include at least one **wide case class**, where the goal has three or more independent sub-features pinned by the hidden suite, so parallel width has something to win.
- **A caveat on the live numbers:** they predate the 2026-09-25 platform fixes. Worker/platform failure classes, restart ownership, observed-time timeouts, concurrency as a wait, the WIP commit and workers without user plugins could each change the failure mix. The baseline must run on current `main`.

**8. Is the delivery note sufficient?** Yes, with its source and timing specified.

- **Two parts:**
  - A deterministic part, needing no model output: files changed, commits, the integrated merge sha.
  - A worker-written part: delivered interfaces, deviations and follow-ups, parsed from a structured block at run end the way `<slave-ask>` is parsed. If the block is missing, the deterministic part alone is stored, and delivery is never blocked on it.
- **Timing:** the note is **finalised at integration**, because rebase can change what landed. It is **invalidated** if the task goes back to rework.
- **Scope:** direct upstream only, as proposed.

**9. Is reviewer ≠ implementer enough for independent review?** It is necessary, not sufficient.

- **What stays shared.** The reviewer is a different seat in a fresh session, but typically the same model reading acceptance criteria that the planner wrote. Seat independence is enforced; judgement independence is not.
- **Enough for the first milestone:**
  - review is judged against the **goal's acceptance**, not only the task's criteria (the reviewer sees both);
  - measure review's value directly: review rejections that the hidden suite later confirms were real defects, versus rejections of work that passed.
- **Later:** a different model for review, as a benchmark ablation.
- **Edge case:** when the only reviewer is the implementer, the existing `no_reviewer` → hire path must fire rather than skip review. Test it in the platform gate.

**10. Is preflight small enough?** Yes. It is missing only the behaviour for a red baseline:

- **Benchmark:** a red baseline makes the case invalid, and the case validation in Q3 prevents it.
- **Product:** a red baseline is recorded, and the planner is told that the first task is to make the baseline green. That task is visible and counted, rather than every task silently failing verify.

**11. Remaining metric-quality problems.**

- **Human intervention needs a mechanical definition:** any event with actor `human` after run start, except read-only views. Before that, breaker-initiated actions must stop carrying actor `human`.
- **In the benchmark, nobody may act.** A run that needs a person must *end* rather than wait. That requires two terminal triggers, a *pending escalation under `act`* and a *no-progress window*, both of which end the run as `PROJECT_FAILED{NEEDS_HUMAN}` (see Missing Pieces).
- **Cost:** start Claude-only. Estimate from tokens later, labelled `estimated`, and never mix measured and estimated figures in one headline number.
- **"Planner failure share" has no definition yet.** Candidates:
  - planning run failed;
  - plan rejected by validation;
  - a task failed and was replaced by a replan;
  - the hidden suite failed on a requirement no task covered, which requires mapping hidden tests to goal clauses.

  Report it only once one is chosen.
- **Version pinning:** the cursor binary updates itself between runs. For Claude Code, record the CLI version and model id per run in the harness from day one.

**12. Is budget failure treated correctly?** For benchmarks, yes. Two details:

- **In-flight runs:** when the cap is reached, in-flight runs are cancelled and their cost counted, so the overshoot is recorded, not hidden.
- **Product:** keep the current halt-and-ask behaviour. A benchmark mode flag makes it terminal.

**13. Is Graph → Command Map the right UI evolution?** Yes, and placing it at Phase 8 is right. One constraint: the Organization and Execution modes are developer-mode-only today, and M61's Simple Mode deliberately hides Graph. Promoting them needs a Simple-mode decision, not only a route change.

**14. Anything still prematurely organisational?** Two items:

- Plan-first roster as an unconditional phase (Q5).
- Delivery note as unconditional Phase 5. It is cheap and I would keep it, but its exit criterion ("dependent tasks receive upstream output") only restates the feature. Replace it with a measurable one: fewer downstream verify or review failures that cite missing or mismatched upstream contracts.

reviewer ≠ implementer is *not* organisational; it is a correctness requirement for the claim "independent review", and should be unconditional.

**15. Anything required for autonomous delivery still missing?** Yes, four items:

- A **terminal trigger**: when is a project over?
- **Benchmark case validation:** a reference solution, plus fail-before/pass-after.
- An **interface-pinning rule** for goals.
- A **real verify command** in benchmark repos. Intake plants a stub `scripts/verify.sh` that "checks nothing yet" when none exists; the live Maratus goal says exactly that. In a benchmark the repo's own test command must be the verify gate, or "verify passed" is meaningless.

Details are in Missing Pieces.

**16. Smallest implementation diff for the first fair benchmark.** Zero product changes, plus about four harness pieces:

1. **Case format + validator:** repo URL + pinned commit, goal text with a pinned interface, hidden test directory, reference patch, verify command, budget, time cap. The validator applies the reference patch and checks fail-before/pass-after.
2. **Arm runners:**
   - **A and B:** CLI-driven, using `init`/`create-workspace` or `intake open/say/accept`, then `set-supervisor --autonomy act`, `set-auto-merge`, `set-limits --max-concurrent-runs` (1 for B), and a daemon on a private DB and state dir. This reuses the gate harness.
   - **C:** one headless agent process in a clone with the harness enforcing budget and time.
3. **Terminal detection:** stop when all tasks are terminal with no pending Supervisor retry, or on budget halt, or on a pending escalation, or when there has been no progress for N minutes, or at the time cap.
4. **Harness judge:**
   - fresh clone of the integrated base;
   - install;
   - verify;
   - the hidden suite;
   - a tamper diff over the repo's existing tests and verify script;
   - human-actor events;
   - summed cost;
   - output as one JSON outcome per run, then aggregated per arm.

Product changes come after the first results, starting with whichever the data names.

**17. What result would make me STOP investing in multi-worker?** See Stop Conditions.

**18. What result would justify doubling down?** See Stop Conditions.

---

## Agreements

- **Measure first**, fix the named failure, re-run, keep or revert (§5, §54).
- **The judge evaluates the goal, not the plan.** It has a deterministic core, the LLM judge is secondary and never upgrades a failure, and the tamper check applies.
- **Three arms**, repeated trials, and unassisted completion as the primary metric with human interventions subordinate to it.
- A flat organisation for the first milestone, and no hierarchy, mailbox, manifest tables, new restaffing, capability engine or event bus.
- The delivery note as the only handoff addition.
- reviewer ≠ implementer enforced at dispatch.
- Minimal preflight plus planner notes in existing Memory.
- Persisted waiting reasons.
- Graph evolved in place into the Command Map, late in the order.
- Office frozen and simulation deferred.
- The deterministic platform gate kept separate from the real-model hypothesis test.
- The borrowing decisions for all five reference projects.

## Required Changes

1. **Benchmark before product Phases 0–1.** The judge, metrics, tamper check, cost and human-actor counting live in the harness for the first benchmark. Promote each into the product after it has met real runs (§0, Q1, Q16).
2. **Pre-register decision thresholds** (Stop Conditions) and the arm definitions (Q4) before the first run.
3. **Tighten the arms:** same model id and provider (Claude Code first); B = concurrency 1 for all run kinds with a separate reviewer seat; C = one headless session with no nudges; all Slave spend counted.
4. **Case validity rules:** interface-pinned goal, reference solution, fail-before/pass-after, hermetic hidden tests, the repo's real test command as verify.
5. **Include a wide case class** so the organisation arm has something to win (Q7).
6. **Make human intervention mechanical**, and make benchmark runs no-touch: needing a person ends the run as `PROJECT_FAILED{NEEDS_HUMAN}`.
7. **Product acceptance authorship:** written at intake by a non-planner run, confirmed once as setup, frozen on `GoalVersion`, executable where possible, in a protected path.
8. **Make plan-first roster conditional** on baseline evidence of staffing delay or unserved roles.
9. **Give the delivery note a measurable exit criterion**, and specify its two parts and its timing (finalised at integration).
10. **Failure classes as analysis, not columns;** fix the existing `EvidenceRecord.humanInterventions` rather than adding a counter; add a `workspace.halt_cleared` event rather than a halt table.
11. **Budget:** terminal in benchmark mode only; the product keeps halt-and-ask.

## Things To Delete

- Phase 0 and Phase 1 **as prerequisites** for the first benchmark. They become promotions of the harness logic afterwards.
- Plan-first roster as an **unconditional** phase.
- New per-class failure columns (§27 as schema).
- The exit criterion "less irrelevant staffing".
- The Stripe-style example as a benchmark case, and any case that needs an external service without a local fake.
- "Model family where possible" in the arm definition. Use the same model id, or record the run as not comparable.

## Missing Pieces

1. **A terminal trigger.** The project is over when one of these happens:
   - every task is terminal (`done`, `cancelled`, or `failed` with no Supervisor retry pending);
   - the budget cap is hit;
   - an escalation is pending under `act`;
   - there has been no progress (no run start, no integration, no task transition) for N minutes;
   - the time cap is reached.

   Without this, "the run ended" is decided by whoever is watching.
2. **Benchmark case validation:** a reference solution, plus fail-before/pass-after for the hidden suite.
3. **Interface pinning** in goal text.
4. **A real verify gate in benchmark repos.** Never the planted stub.
5. **A named "harness value" outcome** (B > C, A ≈ B). This is a product result, not a failure.
6. **Pre-registered thresholds and sample sizes.** With 3 repositories × 3 seeds per arm, only large differences are visible; the plan should say so rather than read noise.
7. **Measured review value:** review rejections that the hidden suite would have caught, against rejections of work that passes.
8. **The baseline runs on current `main`** (post-2026-09-25 platform fixes), with the Slave commit recorded.

## Revised First 5 Implementation Steps

1. **Case format + validator + three cases.**
   - Two "narrow" cases: two code areas plus tests.
   - One "wide" case: three or more independent sub-features.
   - Each has an interface-pinned goal, hidden tests, a reference patch, and passes fail-before/pass-after.
   - Claude Code only.
2. **Arm runners + terminal detection.** A and B through existing CLI verbs on a private DB and state dir, reusing the gate harness; C as one headless session. All run under the same budget and time caps.
3. **Harness judge.**
   - Checks: fresh clone of the integrated base, install, verify, the hidden suite, a tamper diff, human-actor events, and summed cost.
   - Output: one JSON outcome per run.
   - Aggregation: per arm.
4. **Baseline:** 3 cases × 3 arms × 2 seeds on current `main`, with versions recorded. Classify every failure into the eight analysis classes from events.
5. **Fix the top failure class the baseline names.** The likely candidates are the task-size budget plus width check, or reviewer ≠ implementer if review turns out to be self-review. Re-run the same matrix. Keep the fix if it moves unassisted completion; revert it otherwise.

Then promote the harness judge into the product (`ProjectOutcome`, halt events, cost provenance, versions per run), and continue with the conditional phases in the order the data names.

## Minimum Benchmark

- **Cases:** 3 (2 narrow, 1 wide), in small TypeScript or Python repositories at pinned commits.
  - Hermetic: no external services.
  - The repo's own test command is the verify gate.
  - Each has an interface-pinned goal and a hidden acceptance suite validated fail-before/pass-after against a reference patch.
- **Arms:**
  - **A:** Slave with the team formed by intake, concurrency 3.
  - **B:** Slave with concurrency 1 for all run kinds and a separate reviewer seat.
  - **C:** one headless session.
  - All arms use the same model id and provider (Claude Code), the same budget cap (e.g. $25) and the same wall-clock cap (e.g. 3 h).
- **Seeds:** 2 per arm per case, so 18 runs, under about $450.
- **A run passes when all of these hold:**
  - the harness judge says completed;
  - verify passes on the integrated base;
  - the hidden suite passes;
  - no tamper was detected;
  - there were zero human-actor events;
  - it stayed within budget and time.
- **Report per arm:**
  - unassisted completion rate;
  - cost per completion;
  - median wall-clock;
  - runs per integrated task;
  - the failure-class histogram;
  - peak concurrency and plan depth/width (A and B).

## Stop Conditions

These should be fixed before the first run.

- **Stop investing in the multi-worker direction** for the tested class if, after the baseline and one round of fixing the top named failure class:
  - A's unassisted completion is ≤ C's, and
  - A's cost per completion is ≥ C's, and
  - A is not ≥ 30% faster in median wall-clock on the cases both complete.
- **Also stop if A ≤ B on every case**, including the wide one. Parallel width then adds nothing. If B > C, pivot the product to "reliability harness around one worker" (see Missing Pieces item 5), and freeze all organisation features.
- **Stop the whole direction for now** if every Slave run in the baseline fails before staffing or coordination is exercised, and two consecutive fix rounds on the top failure class do not raise A's unassisted completion.
- **Double down if either holds:**
  - A completes at least 2 more of the 6 case-seed pairs than C at ≤ 1.5× C's cost per completion; or
  - A matches C's completion at ≥ 40% lower median wall-clock.

  In both cases the evidence must trace the win to an organisational mechanism: overlapping runs on the critical path (parallel width), or review rejections that the hidden suite confirms were real defects C shipped (independent review). Then expand to 5–10 cases × 3 seeds before building any Phase 9 feature.

## Verdict

**APPROVE WITH CHANGES**

The revision is right about what to build and what not to build. The main remaining change is sequencing. The first benchmark can run on today's `main` with a harness and no product diff, so measurement should come before product Phases 0–1 rather than after them. Beyond that, the benchmark needs three things before it can be trusted:

- case-validity rules (interface pinning, a reference solution, fail-before/pass-after, real verify);
- a defined terminal trigger;
- pre-registered stop and double-down thresholds.
