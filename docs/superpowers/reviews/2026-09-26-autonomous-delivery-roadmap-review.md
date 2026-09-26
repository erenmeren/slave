# Review — "Autonomous software organisation" roadmap

Reviewer's position: independent. Inputs read before writing: README, `docs/architecture.md`, `docs/domain-model.md`, `docs/event-model.md`, `docs/ia.md`, the design specs under `docs/superpowers/specs/` (M38–M61, capability mapping, self-running project, Supervisor chat), the unmerged `feature/plan-first` spec, the implementation behind each claim below (paths cited), the five reference repositories as cloned locally, and the **live event history of the two real autonomous projects** in the development database (read-only). Milestone numbers in the roadmap are ignored, as instructed.

---

## 0. The evidence this review stands on

### 0.1 What Slave already has (verified in code, `main` as of 2026-09-26)

| Roadmap proposal | State in Slave | Where |
|---|---|---|
| Capability taxonomy, capabilities on tasks and workers | **Exists** — `Capability {key, domain, role, synonyms}` (~111 keys), `Task.requiredCapabilities`, `SlaveTemplate.capabilityKeys` + model-mapped `mappedCapabilityKeys` for the 279-person catalogue, `Person.capabilities` | `schema.prisma:660,1096,493-506`; `domain/capability/taxonomy.ts` |
| Capabilities projected onto the role scheduler | **Exists** — `projectRoles(capabilities)` → `runtimeRoles`; `decide()` matches `runtimeRoles.includes(requiredRole)`; planner's role defaults to `roleOfFirst(capabilities)` | `domain/scheduler/decide.ts:100`; `control/capability.ts:790`; `orchestrator/planning.ts:178` |
| "Smallest sufficient team" | **Exists as a pure set-cover** — `formTeam`: existing worker → pool person → catalogue template → reported gap | `domain/capability/team.ts:228` |
| Staffing candidate order (assigned → company → catalogue → temp hire → gap) | **Exists**, same order, plus `rankCandidates` on evidence and `StaffingPreference` | `domain/capability/rank.ts:355` |
| Project-scoped / temporary hires and release | **Exists** — `Person.lifecycle {permanent, project, ephemeral}`, `Slave.engagementTaskId`, `isReleasable`, situation `engagement_over`, action `release_worker` | `domain/lifecycle/release.ts:52` |
| Dynamic restaffing mid-project | **Exists** — Supervisor situations `capability_unstaffed`, `ready_unstaffed`, `no_reviewer`, `planning_stalled`; actions `hire_from_catalog{temporary}`, `assign_capability`, `set_runtime_roles`, `materialise_company_worker`; applied without a person under `supervisorAutonomy: act` | `domain/supervisor/situations.ts`, `actions.ts:232-342`, `policy.ts:99` |
| Manager vs Supervisor split | **Exists** — planning is a run by a seat holding `manager`; the Supervisor is a per-tick decider (rules first, model when needed), not a seat, and does no implementation | `orchestrator/planning.ts:534`; `orchestrator/supervisor.ts` |
| Visible autonomous decisions ("hired X because…") | **Exists** — `SupervisorDecision {situation, candidates, rationale, action, decidedBy, cost}`, decision cards, Home feed | `schema.prisma:1660` |
| Structured handoff contract | **Partial** — `Task.handoff = {objective, expectedOutput, acceptanceCriteria, knownConstraints, evidenceRequired, contextReferences}` rendered into implementation and review prompts; typed messages `MessageKind {question, answer, information, blocker, handoff}`; `<slave-ask>` routing | `domain/handoff/contract.ts:14`; `schema.prisma:1070` |
| Worker governance (permissions, tools, skills, provider/model policy) | **Exists** — `PermissionKind` × allow/deny matrix with provenance, per-run-kind baseline grants, per-provider tool maps, a credential broker for `deploy_release`, a versioned skill catalogue injected per worker, `resolveRuntime` seat → person → template → workspace | `domain/permission/kinds.ts:205`; `control/skills.ts:309`; `control/runtime.ts:63` |
| Memory classes (facts / decisions / worker history) | **Exists** — `Memory {type: fact/decision/procedure/lesson/…, scope: company/workspace/worker, status: candidate/verified/superseded}` with provenance and promotion rules; ≤12 injected per run | `schema.prisma:1554`; `domain/memory/promote.ts` |
| Observability (first-pass, rework, review rejects, cost, human interventions) | **Exists per run** — `EvidenceRecord` per concluded run with `verifiedFirstPass`, `reviewRejected`, `integrated`, `reworkCycles`, `humanInterventions`, `actualCostUsd` + `costProvenance`; Workforce → Evidence by profile and by model | `schema.prisma:1369`; `domain/evidence/derive.ts:108` |
| Verification → review → rework → serialized integration | **Exists** — verify commands + stage gates; review run; `rework`/`failed` by attempt cap; merge claim, rebase, **re-verify of the rebased branch**, `--no-ff` merge, `integratedAt`; `autoMerge` is a product switch | `orchestrator/merge.ts:242-327` |
| Restart recovery, halts, emergency stop | **Exists, and since 2026-09-25 tested under chaos** — `gate:h9-restart-chaos` kills the daemon 6× mid-run (SIGKILL) and the board still finishes with no human decision | `scripts/gate-h9-restart-chaos.mjs` |
| Command Map "Organisation / Execution / Dependencies" projections | **Exists by those exact names** — Graph has five modes: Organization, Execution, Dependencies (editable task DAG), Skill chain, Communication | `apps/web/src/components/graph/GraphClient.tsx:51-57` |

What does **not** exist:

- a project-level outcome;
- a goal-level acceptance definition;
- a benchmark runner;
- a persisted repository profile;
- an upstream-output section in a dependent task's prompt;
- an "implementer never reviews own work" rule;
- per-task "why is this waiting" persisted anywhere a person can see it;
- two-level (lead → department manager) planning.

The last one is designed in `feature/plan-first` but not built.

### 0.2 What actually happened when Slave ran real projects (dev DB, read-only)

The two real projects: *Maratus.co redesign + growth strategy* and *Key/certificate manager (Next.js + Spring Boot)*. Both were formed by intake from the catalogue and ran under `act` + `autoMerge`.

| | Maratus | Key manager |
|---|---|---|
| Tasks planned / integrated | 19 / 12 | 19 / 7 |
| Longest dependency chain / widest level | 10 / 4 | 8 / 4 |
| Seats / peak concurrent runs | 10 / 3 | 6 / 3 |
| Implementation runs: ok / failed | 27 / 19 | 15 / 19 |
| Run failure rate (all kinds) | 37% | 42% |
| Max implementation runs for one task | 7 | 8 |
| Guardrail kills: timeout / behavioural loop | 12 / 3 | 9 / 6 |
| Platform faults (API limit, maxBuffer, silent CLI exit, no runtime, orphan) | 11 | 7 |
| Circuit-breaker halts that needed a person | 4 | 6 |
| Recorded cost (floor — every Cursor run and most failed Claude runs have `costUsd = null`) | ≥ $73.51 | ≥ $46.23 |
| Supervisor decisions applied with no person | 29 | 21 |
| Outcome | not finished; emergency-stopped by the person | not finished; emergency-stopped by the person |

Read honestly:

- **Staffing was not the bottleneck.** The Supervisor hired and assigned 13 times by itself. No task waited long on a missing capability.
- **The failures were execution failures:**
  - runs timing out or looping (30 kills);
  - platform faults turned into human-only halts;
  - tasks that were 5–6 tasks in one;
  - workers that did 170 tool calls and never committed;
  - a Cursor worker that loaded the person's own process plugin and ran a whole brainstorm-plan-review cycle inside one task;
  - a planner that chains 19 tasks 8–10 deep, so a 10-seat team never ran more than 3 things at once.

The platform-side items were fixed on 2026-09-25: failure class worker/platform, orphan/stopping ownership, the advisory lock, observed-time timeouts, concurrency as a wait, the WIP commit, and workers without user plugins. **None of the rest is an organisation-design problem.**

### 0.3 The reference projects, as code rather than README

- **None of the five shows end-to-end autonomous software delivery.**
  - Ruflo's only non-mock benchmark is a draft GAIA Level 1 Q&A run, n = 1.
  - Its "84.8% SWE-bench" claim has no run in the repository.
  - Its `verification/results.md` checks file hashes, not behaviour.
- **Ruflo** is real code: queen coordinator, message bus, Raft/Byzantine/Gossip modules, a daemon, SQLite + vector store, and its own event log. The model router is a lexical complexity score (<0.4 → small model, <0.7 → mid, else large) plus a Thompson-sampling bandit on outcomes.
- **Munder Difflin** is real code. Git is its coordination database, with a file mailbox and a single committer. A god agent holds its policy in the prompt, and a Stop-hook `decision: block` keeps agents alive.
  - Its circuit breaker (steer → constrain → stop on token velocity, repeated calls and no file progress) is the same ladder Slave already has.
- **The persona corpus** is 282 markdown definitions. "Success metrics" are prose; the lint only warns on missing sections.
- **Everything Claude Code** (the fork cloned here) is 81 files. Its hooks are small quality nudges.
  - "Eval harness" and "verification loop" are prompt text; nothing executes or scores an eval.
  - "Continuous learning" is a SessionEnd script that counts user messages and logs a nudge.
- **henryalouf/ruflow** is a Ruflo fork with vendored third-party skill packs (~1,500 directories; 64 of them carry a version), two client websites, and course material. It is not a curated or tested corpus.

---

## 1. Section-by-section classification

| § | Proposal | Verdict | Reason (details in the numbered answers below) |
|---|---|---|---|
| 1 | Product hypothesis | **AGREE** | Correct and falsifiable, *if* completion is judged against something the planner did not write (see §9) |
| 2 | Lifecycle as 17 sequential stages | **MODIFY** | Stages 2–5 collapse into two that exist: *plan* (emits capabilities per task) → *derive roster from plan*. Handoffs and restaffing are not stages; they are things that happen inside execution |
| 3 | Preserve architecture | **AGREE** | Nothing found that blocks the goal |
| 4 | Ruflo: hierarchy, capability routing, model routing, background monitors, memory | **MODIFY** | Capability routing and monitors already exist in a simpler form. Hierarchy is unsupported by evidence. Model routing is later |
| 5 | Munder: identity, Supervisor, handoffs-not-mailbox, blackboard, providers, observability | **AGREE in direction, but already built** | Person/Slave/EvidenceRecord, Supervisor, SlaveMessage, Memory, provider manifests, EvidenceRecord. The only real gap is the blackboard's *repository facts* (see §11) |
| 6 | Agency: role blueprint, catalogue, metrics | **MODIFY** | Blueprint fields beyond capabilities/permissions/skills are prompt content. The catalogue is imported and capability-mapped. Metrics must come from EvidenceRecord, never from the persona file |
| 7 | ECC: separate Role/Capability/Skill/Rule/Hook/Tool/Permission | **MODIFY** | Four are persisted already; the other four should stay non-persisted (see Q7/Q8) |
| 8 | ruflow as skill corpus | **MODIFY → mostly Never** | Cherry-picking is fine, but see the F9 warning in Q19: process skills inside a worker actively harm task execution |
| 9 | Uniquely-Slave list | **AGREE on short term, but trim it** | Keep "objective completion assessment" and "human-intervention measurement". Drop "structured handoffs" and "dynamic restaffing" as *differentiators*: they are plumbing, and they exist |
| 10 | Phase 0 baseline | **AGREE, merge with 9 + 10** | A baseline needs the judge and the runner, otherwise it is anecdotes like §0.2 |
| 11 | Phase 1 Repository Intelligence | **MODIFY (shrink)** | A deterministic preflight plus planner-written notes stored as existing Memory facts |
| 12 | Phase 2 Capability Requirement Analysis | **REJECT as a phase** | It is the planner's `capabilities` field; it exists |
| 13 | Phase 3 Organisation Design | **REJECT as a phase / MODIFY to one function** | `formTeam` exists. Replace with "derive roster from the plan's roles × plan width" (the plan-first spec's R4) |
| 14 | Phase 4 Capability-aware planning | **MODIFY** | Task already has capabilities + dependencies + handoff (with acceptance criteria). Add only a **task-size budget** and a **width-aware planning instruction**: these address observed failures |
| 15 | Phase 5 Parallel execution + explainability | **AGREE (small)** | The scheduler is already parallel; width is limited by the plan. Persist the tick's existing waiting reasons per task and show them |
| 16 | Phase 6 Dynamic restaffing | **REJECT as new work** | It exists. Test it; do not rebuild it |
| 17 | Phase 7 Structured handoffs | **MODIFY (shrink to one field)** | 7 of the 8 handoff types are already statuses/events. The missing piece is *upstream output reaching the dependent task* (see Q6) |
| 18 | Phase 8 Worker manifest / governance | **REJECT as a phase** | Exists; one rule to add (reviewer ≠ implementer) |
| 19 | Phase 9 Completion judge | **AGREE, move first, and strengthen** | The most important phase. Its definition is task-centric and needs a pre-registered goal acceptance (see Q31–34) |
| 20 | Phase 10 Benchmark mode | **AGREE, move first** | It reuses the gate harness, which already drives daemons against scratch DBs |
| 21–24 | Project Command Map | **REJECT as a new surface / MODIFY** | Graph already has Organization / Execution / Dependencies. Add decision-reason and handoff edges to the existing modes |
| 25 | Surface positioning | **AGREE, with Office frozen** | Office: no further work |
| 26–27 | Supervisor panel, visible decisions | **AGREE, exists** | Polish only |
| 28 | Final delivery report | **AGREE (small)** | A projection of EvidenceRecord + the new outcome row; "done vs integrated" is already `integratedAt` |
| 29 | Memory strategy | **AGREE, exists** | M49 is exactly this |
| 30 | Observability | **AGREE, fix data correctness first** | See Missing Pieces: cost nulls, mislabelled human actor, no halt-cleared event |
| 31 | Do not build yet | **AGREE, and extend** | See §3 |
| 32 | Phase order | **REJECT the order** | It builds the organisation before it can measure whether the organisation matters |
| 33 | Why simulation later | **AGREE** | |
| 34 | Minimum E2E test | **MODIFY** | It mixes a platform regression test with a hypothesis test. Split it (see §8) |
| 35 | Fastest experiment | **AGREE, and add a control arm** | Without a single-agent baseline it cannot falsify the *organisation* claim |
| 36–37 | Thesis, decision filter | **AGREE** | The filter, applied honestly, removes phases 2, 3, 6, 7, 8, 11 and 12 as new work |

---

## 2. Answers to the 45 questions

**1. Duplicates.** Phase 2 (capability analysis), Phase 3 (organisation design and staffing order), Phase 6 (dynamic restaffing), Phase 8 (governance), §29 memory classes, §30 metrics, §26–27 visible decisions, and the Command Map's three projections all exist (table in §0.1). Roughly half of the roadmap's build list is already on `main`.

**2. Where capability analysis belongs.** Inside planning. The planner already emits `capabilities` per task, and a separate pre-planning capability pass would be a second opinion on the same text with nothing to check it against. Staffing comes *after* the first decomposition, because the plan is the only artefact that knows what is actually needed. Reactive restaffing covers what the plan missed.

**3. Manager vs Supervisor.** Keep them separate; they already are. The planner is a *run*, taken by a seat; the Supervisor is a *pass*, with rules first and a model only when needed. Do not make the Supervisor a seat, and do not give it implementation work. What should *not* be added now is a manager *hierarchy* (lead → department managers owning review and questions). The plan-first spec's B2 half proposes this. No failure in the live data would have been prevented by it.

**4. Organisation design before the planner?** No. Intake currently picks a team by persona name before any plan, which is backwards and is the one real staffing defect. The fix is plan-first: the planner runs with a single planner seat, and the roster is derived from the plan.

**5. Dynamic mid-project hiring for the first milestone?** It already exists (`capability_unstaffed` → `hire_from_catalog{temporary}` under `act`), and the live runs used it 13 times. Build nothing new. Keep one deterministic regression test for it, and do not make it part of the hypothesis test.

**6. Handoffs as first-class domain concepts?** No. Map the proposed types onto what exists:

| Proposed handoff | Already represented as |
|---|---|
| READY_FOR_REVIEW | task status `reviewing` + review run |
| REVIEW_REJECTED | `task.review_rejected` event → `rework` |
| DEPENDENCY_READY | `integratedAt` on the upstream task, which releases dependents |
| BLOCKER_FOUND | `SlaveMessage{kind: blocker}`, `task.blocked` |
| CONSULTATION_REQUESTED | `<slave-ask>` → `SlaveMessage{kind: question}` routed by role |
| ENVIRONMENT_READY | a dependency on the environment task |
| READY_FOR_QA | review/verify are system functions (see Q24) |
| CONTRACT_READY | **the gap**: the dependency exists, but the *content* does not reach the dependent run |

The one missing thing is that a dependent task's run context has no section for what its upstream tasks produced. It gets only the integrated code on the base branch. The smallest fix: each implementation run concludes with a short structured **delivery note** (what was built, public interfaces, files, deviations from the contract), stored on the task, and rendered into the run context of every task that depends on it. Handoff latency is then derivable from existing timestamps (upstream `integratedAt` → dependent `run.started`) with no new entity.

**7. Separate abstractions?**

| Concept | Persist? | Today |
|---|---|---|
| Role | yes, exists | runtime role on the seat |
| Capability | yes, exists | taxonomy + projection |
| Permission | yes, exists | kind × allow/deny matrix with provenance |
| Skill | yes, exists | skill catalogue per person/template |
| Tool | no, stays provider data | `TOOLS_BY_KIND` in the provider manifest |
| Rule | no, stays prompt/profile text | the profile and the run context |
| Hook | no — orchestrator-owned only | pause gate, permission gate. User-level hooks must stay *out* of worker runs, which is what fixed F9 |
| Memory scope | exists as a column | `Memory.scope` |

**8. Conceptual only for now.** Rule, Tool, Hook, Escalation policy, Consultation preference, Success metrics on a blueprint. A "Worker Capability Manifest" table would duplicate Person + Slave + SlavePermission + skills.

**9. Evolving `requiredRole` without a second matcher.** It already evolved: capabilities project onto runtime roles, and the scheduler matches roles. Keep one matcher. If evidence ever shows two tasks with the same role needing workers the role cannot tell apart, add an *optional* capability filter inside `decide()`'s existing seat choice. It would be a predicate on the same candidate list, not a new engine. There is no such evidence today.

**10–12. Command Map vs existing UI.** The Command Map as written is a duplicate dashboard: Graph already has Organization, Execution and Dependencies modes over the same state. So Graph becomes the Command Map, in place, by three edits:

1. Take Graph's Organization and Execution modes out of developer-only.
2. Draw decision edges ("hired because TASK-18 needs X", from `SupervisorDecision`) and delivery-note edges on the existing canvas.
3. Show the persisted waiting reason on task nodes.

No new route and no new graph engine.

**13. Office.** Keep it as it is: optional, "who is working". No further investment until the hypothesis is answered.

**14. Ruflo concepts Slave already solves more simply.**

- **Queen/hierarchical swarm:** the DB-claimed scheduler plus one planner.
- **Consensus (Raft, Byzantine, Gossip):** Postgres row claims and, since 2026-09-25, an advisory lock for one daemon per database.
- **Message bus:** the append-only event log with LISTEN/NOTIFY.
- **Background workers:** daemon passes (sweep, merge, capability mapping, memory) plus Supervisor situations.
- **SQLite/vector memory:** `Memory` with provenance.

**15. Ruflo ideas that would genuinely help.**

- **Model routing, later**, keyed on run *kind* and task risk rather than on lexical complexity. Slave already knows the kind (planning / implementation / review / Supervisor), and `resolveRuntime` has the rungs.
- **Outcome-learned routing** (their bandit) only once EvidenceRecord has enough runs per (model × task class) to learn from. That is after the benchmark exists.
- Nothing else from Ruflo is needed to answer the hypothesis.

**16. Munder concepts that conflict with Slave's architecture.**

- Git/files as the orchestration database and audit log.
- File mailboxes with a single committer.
- A Stop-hook that blocks the agent from stopping, which fights Slave's run lifecycle and pause gate.
- Policy held in a god agent's prompt rather than in code.
- PTY-wrapped interactive sessions as the unit of work, where Slave's unit is a run with a terminal result.

**17. Mailbox.** Unnecessary. `SlaveMessage` plus the event log already carries typed messages with routing and a waiting-for-answer pause.

**18. Agency Agents value beyond prompt engineering.** Only the *catalogue coverage*: a broad set of roles, already imported and model-mapped to capability keys. The success metrics in those files are prose and nothing checks them; measured metrics must come from Slave's EvidenceRecord. There is no reason to import more personas.

**19. ECC: runtime vs prompt.**

- **Runtime** (and Slave already has a stronger version): the verification loop — verify, review, rebase, re-verify, merge are orchestrator code, not worker instructions.
- **Prompt content, through the skill catalogue:** TDD, debugging and security-review checklists. They should be few, and measured by `skillCalls` against outcomes.
- **Must not enter workers:** process-management skills (brainstorm, write a plan, dispatch sub-agents, review rounds). F9 is the evidence: a Cursor worker that loaded such a plugin spent a 30-minute attempt planning and dispatching helpers, with 2 of 59 tool calls editing a file, and timed out three times. Process belongs to the orchestrator, execution to the worker.
- **Continuous learning:** Slave's memory promotion already requires verified provenance. ECC's version is a nudge, so there is nothing to take.

**20–21. Is Repository Intelligence overbuilt? What is needed before planning?** Yes, it is overbuilt. The planner runs read-only in the repository and can read what it needs. What is actually needed before planning is deterministic and small:

- The verify command runs **green on the base branch**. If it is red before any work, no task can pass, and the run must fail fast as "unverifiable", not burn attempts.
- Setup commands run.
- The bootstrap `scripts/verify.sh` is planted when absent (exists).
- The planner writes 5–15 **repository notes**: build/test commands, conventions, module boundaries relevant to the goal. These are stored as `Memory{type: fact, scope: workspace}` and fed to every worker through the existing memory section, so workers do not rediscover them. No new table.

**22. Is "minimum sufficient team" the right objective?** No. In Slave an idle seat costs nothing; cost is per run. "Smallest team" optimises a quantity that has no cost, while the live data shows the binding constraints are **role coverage** and **plan width**. The objective should be: for each role the plan needs, seats = min(peak ready width for that role, concurrency limit). That is deterministic, computed from the plan, with no model call.

**23. Full team up front or reactive?** Derive the roster from the plan up front, which is deterministic and cheap. Reactive hiring stays as the existing safety net.

**24. QA as a persistent worker?** No. Verification is a system function. Review is a run kind on a reviewer seat. What is missing is **independence**: `dispatchReviews` takes the first free reviewer and nothing stops the implementer from reviewing its own task. "Independent review" is a stated requirement and is not currently enforced. That is a one-predicate fix.

**25. Engineering Lead as a worker?** No, it is the planning function. A lead seat consumes a concurrency slot and adds a relay.

**26–27. Is the hierarchy too human-like? Could flatter pools do better?** For the first milestone, yes to both. A flat capability pool, plus one planner run, plus the Supervisor pass is the smallest thing that can execute a DAG. Hierarchy earns its place in simulation and in explaining work to people. The hypothesis test does not need it, and nothing in the live data shows a coordination failure that a hierarchy would fix.

**28. Metrics that matter.**

1. **Unassisted completion rate:** runs that end `PROJECT_COMPLETED` by the judge with zero human interventions, over a fixed benchmark set.
2. Held-out acceptance pass rate on the integrated base.
3. Cost per unassisted completion.
4. Wall-clock time.
5. Platform-failure share vs worker-failure share.
6. Runs per integrated task.

The rest (first-pass, review rejects, conflicts) are diagnostics.

**29. Is humanInterventions the most important metric?** Not alone. It is gameable: failing fast gives zero interventions, and `PROJECT_FAILED` is a legitimate result. It must be read *together* with completion (metric 1). Also, today it is **mis-measured**: 21 of 24 "human" resumes in the live data were started by the circuit breaker, a bulk action counts as 12, and there is no event for a halt being lifted.

**30. The missing metric.** A **control baseline**: the same goal given to one single-agent session (e.g. one Claude Code run with the same budget). Without it, "the organisation completed the project" cannot be told apart from "the model completed the project despite the organisation".

**31. Is the completion judge correctly defined?** Not quite: it is task-centric. Every check listed passes if the planner quietly dropped half of the goal, because the plan is what defines "required tasks". The judge must check the goal, not the plan.

**32. Goal satisfaction when repository tests do not express the requirement.** The benchmark ships a **held-out acceptance suite** per goal:

- written before the run by the benchmark author;
- never visible to workers or the planner;
- run by the judge on the integrated base.

For the product (not the benchmark), the equivalent is an acceptance spec agreed at intake and frozen per goal version (`GoalVersion` exists). Workers may see the spec; they must not be the ones who wrote its checks.

**33. An LLM judge?** Acceptable only as a *secondary* signal for criteria that cannot be executed (copy tone, design fidelity). It must be recorded as such, and it can never turn a failed deterministic check into `PROJECT_COMPLETED`.

**34. Checks that must stay deterministic.**

- Every task that is not cancelled is terminal.
- Every `done` task is integrated.
- The verify command passes on the integrated base at the final commit.
- The held-out acceptance suite passes.
- There is no open halt, no pending escalation, and no unanswered question.
- A **tamper check**: no acceptance file and no pre-existing test was deleted or weakened in the diff (worker commits to protected paths flagged).
- The budget was not exceeded.

**35. Auto-merge in benchmark runs.** Yes. Without it every task waits for a person by design. Run against a disposable clone at a pinned commit; the integration target is that clone's base branch.

**36. Evaluating integration success.** The final base commit contains every done task's merge, verify passes there, and the held-out suite passes there. Merge conflicts and rebase failures along the way are diagnostics, not the outcome.

**37. Phase to remove.** Phase 7 as a domain concept; it shrinks to one field. Close behind: Phases 2, 3, 6 and 8, which exist. Phase 12 (performance learning) needs data the benchmark has not produced yet.

**38. Phase to move earlier.** Phases 9 and 10, the judge and the benchmark. They merge with Phase 0 into the first thing built.

**39. Phase to move later.** Phase 11 (Command Map UX), Phase 6 (any restaffing beyond what exists), and model routing.

**40. Largest unnecessary abstraction.** Organisation design as a lifecycle stage: hierarchy, "minimum team" and department structure. It optimises something that costs nothing and addresses no observed failure.

**41. Most dangerous missing abstraction.** A **pre-registered goal acceptance**, independent of the planner. Without it, every `PROJECT_COMPLETED` is self-graded.

**42. Single highest-risk assumption.** That the bottleneck to autonomous delivery is *organisational* (who does the work and how workers coordinate) rather than **per-task execution reliability and plan quality**. The live data points the other way:

- 37–42% of runs failed;
- timeouts and loops dominated;
- up to 8 runs per task;
- tasks were 5–6 tasks in one;
- dependency chains were 8–10 deep.

Staffing worked.

**43. Fastest experiment that could disprove the direction.** See §10 below. In short: five small repositories with held-out acceptance suites, three arms (Slave multi-seat, Slave one seat, one single-agent session), same model and budget. If the single agent matches or beats multi-seat Slave on unassisted completion at equal or lower cost, the *organisation* part of the thesis is falsified for that task class. That is roughly a week of work plus a few hundred dollars of runs, not twelve phases.

**44. Minimum architecture.** See §6.

**45. What not to build first.** See §3.

---

## 1. Agreements

- The hypothesis, the "failure is a valid outcome" stance, and the decision filter in §37.
- Preserving the existing architecture (§3). Nothing examined blocks the goal.
- The Manager/Supervisor distinction. Slave already has it: planner run vs Supervisor pass.
- Handoffs as structured facts rather than agent-to-agent chat, and no second mailbox or event system.
- Deterministic daemon passes before AI monitors.
- Memory as three plain classes (facts, worker history, decisions) with no vector store. This already exists.
- Observed metrics only, and no fabricated ratings.
- Making autonomous decisions visible with evidence. This already exists as decision cards.
- "Done" vs "integrated" reported separately. This already exists as `integratedAt`.
- The Phase 0 baseline, the Phase 9 completion judge, the Phase 10 benchmark mode, and the §35 experiment.
- The whole §31 "do not build yet" list.
- Simulation after real execution data exists (§33).

## 2. Required Changes

1. **Reorder around measurement.** Judge + benchmark runner + baseline come first (see §7). Nothing organisational is built until the baseline says it is the bottleneck.
2. **Redefine the completion judge against the goal, not the plan.** It needs a pre-registered, planner-independent acceptance per goal (held-out in benchmarks, frozen per `GoalVersion` in the product), deterministic checks, and a tamper check. An LLM judge is secondary and can never upgrade a failure.
3. **Add a control arm to every benchmark.** Run a single-agent session with the same model and budget, plus a one-seat Slave.
4. **Replace "Repository Intelligence" with a deterministic preflight plus planner notes.** The preflight checks that verify is green on base and that setup runs. The notes go into the existing `Memory`.
5. **Replace "Capability Analysis + Organisation Design" with plan-first staffing.** The planner emits capabilities; the roster is derived from roles × plan width; intake stops picking people before a plan exists.
6. **Replace "Structured Handoffs" with a delivery note.** It is written at run conclusion and rendered into dependent tasks' run context.
7. **Put plan quality where the evidence is:**
   - a task-size budget in the planning prompt (e.g. at most N acceptance criteria and one deliverable per task, refused at `parsePlanGraph` if exceeded);
   - an instruction and a check against needless chaining (report depth and width; warn when depth > width × k).
8. **Enforce independent review.** The implementer of a task never reviews it.
9. **Persist the scheduler's "why waiting" per task.** The tick already computes it, and it is currently stdout-only.
10. **Fix measurement correctness before the baseline.** Each item here feeds a headline metric:
    - estimated cost for runs with null cost (Cursor, failed Claude runs) from token counts, labelled `estimated`;
    - a breaker-started resume must not be written as actor `human`;
    - a `workspace.halt_cleared` event;
    - a project outcome row;
    - the CLI/model version on every run.
11. **Command Map → evolve Graph in place.** Promote its Organization and Execution modes, and add decision edges and delivery-note edges. Build no new surface.

## 3. Things To Delete

- **Phase 2** (Capability Requirement Analysis) as a phase: exists.
- **Phase 3** (Organisation Design) as a stage: hierarchy, "minimum sufficient team", Engineering Lead seat. The roster-from-plan function replaces it.
- **Phase 6** (Dynamic Restaffing) as new work: exists. Keep a regression test only.
- **Phase 7** (Structured Handoffs) as a domain entity and handoff event taxonomy: replaced by the delivery note.
- **Phase 8** (Worker Capability Manifest / governance tables): exists as Person + Slave + SlavePermission + skills + `resolveRuntime`. Add no Rule/Hook/Tool/Escalation tables.
- **Phase 11 as a new dashboard**, and any new graph engine.
- **Phase 12** (performance learning) until the benchmark has produced enough runs.
- Department manager hierarchy and lazy two-level planning (the plan-first spec's B2 half) until evidence shows coordination failures. This one is a note to ourselves.
- **Importing:**
  - further personas;
  - Ruflo swarm, consensus or daemon;
  - Munder's git/file coordination;
  - ECC hooks;
  - bulk skills from ruflow;
  - any process-management skill into a worker.
- Office improvements and simulation expansion (already on the §31 list; restated because they compete for the same time).

## 4. Missing Pieces

1. **Pre-registered, planner-independent goal acceptance** and the tamper check (see Q32–34).
2. **A control baseline** (single-agent arm) and a one-seat Slave ablation.
3. **An "impossible goal" case that must end `PROJECT_FAILED`.** Without it, the judge's ability to fail is untested.
4. **Plan quality controls.** The planner is one read-only shot today: no task-size budget, no width/depth check, no self-review. Every live failure mode traces back here or to the platform.
5. **Upstream output reaching dependents** (the delivery note).
6. **Independent review enforcement.**
7. **Measurement correctness** (cost nulls, mislabelled human actor, halt-cleared event, pinned versions per run).
8. **Budget as an outcome.** Exceeding the budget must end the run as `PROJECT_FAILED{reason: budget}`, not as a halt waiting for a person.
9. **Repeated trials.** One run per repository proves nothing; LLM runs have variance. At least 3 seeds per arm per repository.
10. **Version pinning.** Model id, CLI version (cursor-agent updates itself) and base commit, recorded per benchmark run.

## 5. Borrowing Matrix

| Project | What Slave should take | What Slave should adapt | What Slave should not take | Timing |
|---|---|---|---|---|
| **Ruflo** | Nothing structural for the hypothesis | Model routing keyed on run kind + task risk through `resolveRuntime`; later an outcome-learned router fed by EvidenceRecord (their bandit idea) | Queen/hierarchical swarm, Raft/Byzantine/Gossip, message bus, own daemon/event log/SQLite/vector store, 100s of agents/tools, lexical complexity scoring, benchmark claims without runs | Router: **Later**; rest: **Never** |
| **Munder Difflin** | Nothing new: its breaker ladder and cost ledger already have Slave equivalents | Provider presets list as a reference when adding Codex/Gemini adapters to the provider manifest | Git/files as orchestration DB, file mailbox, single-committer model, god agent with prompt-held policy, Stop-hook `decision: block` loop, PTY sessions as the unit of work, office as identity | Provider reference: **Later**; rest: **Never** |
| **Agency Agents** | Nothing new: the catalogue is already imported and capability-mapped | Section headings (mission / rules / deliverables) as a *profile template* for new catalogue entries | Prose success metrics as data, personality fields as abstractions, bulk imports | Template: **Later**; imports: **Never** |
| **Everything Claude Code** | — (Slave's verify → review → rebase → re-verify → merge is already the runtime version of its "verification loop") | A few execution checklists (TDD, debugging, security review) as catalogue skills, measured by `skillCalls` against outcomes | Hooks into workers, directory layout, slash-command product model, "continuous learning" nudge, any process skill (plan/brainstorm/dispatch) inside a worker run | Checklists: **Later**, after baseline; rest: **Never** |
| **henryalouf/ruflow** | — | Individual execution skills only, after reading and testing each | Bulk import, vendored packs, anything unversioned | **Never** in bulk; single skills **Later** |

## 6. Revised Architecture

Everything below exists unless marked **new**. Nothing is removed and no boundary moves.

```
intake(repo, goal, provider, budget, autonomy=act, autoMerge=on)
  → preflight                                  new, deterministic: verify green on base, setup runs
  → acceptance spec frozen on GoalVersion      new: held-out in benchmarks
  → planning run (one planner seat, read-only)
       emits tasks {capabilities, dependsOn, handoff, needs}
       + repo notes → Memory(fact, workspace)  new: prompt + write path
       + task-size budget / width check        new: validation in parsePlanGraph
  → roster = roles(plan) × width(plan)         new: small deterministic function; the formTeam
                                                   candidate order fills each seat
  → scheduler (decide: role match, concurrency; waiting reason persisted — new)
  → implementation runs in worktrees
       conclusion: WIP commit (exists since 09-25)
                 + delivery note on task       new
  → verify → review (reviewer ≠ implementer — new predicate) → rework | merge
       merge: serialized, rebase, re-verify, integrate
  → Supervisor pass under act                  restaffing, retries, halts
  → completion judge                           new, deterministic core:
       all non-cancelled tasks integrated; verify on final base;
       acceptance suite on final base; no open halt / escalation / question;
       tamper check; budget respected
       → ProjectOutcome{COMPLETED | FAILED, reasons, evidence refs}   new row + event
  → report: projection of EvidenceRecord + outcome                   new, read-only
benchmark runner = the gate harness pointed at real CLIs:           new script
  pinned repo commit, pinned versions, N seeds, arms {slave, slave-1-seat, single-agent}
```

The new code is roughly:

- one table (`ProjectOutcome`);
- one event type;
- three validation or derivation functions;
- two prompt sections (repo notes, delivery note);
- one reviewer predicate;
- a waiting-reason column;
- one runner script.

## 7. Revised Phase Order

0. **Measurement correctness.** Cost estimates for null-cost runs, actor labelling for breaker resumes, `halt_cleared` event, versions per run, budget exhaustion as an outcome. *Exit:* a replay of the two live projects reports the same numbers as a hand count.
1. **Completion judge + acceptance spec + benchmark runner.** *Exit:* two fake-CLI cases through the runner: a solvable goal ends `PROJECT_COMPLETED`, an impossible one ends `PROJECT_FAILED`, both with evidence.
2. **Baseline and falsification experiment** (§10), on current `main` with no new features. *Exit:* a table of unassisted completion, cost, time and failure classes per arm.
3. **Fix the top observed failure class from step 2.** Expected, from the live data: plan quality (task-size budget, width check) and the delivery note. Re-run the benchmark.
4. **Plan-first staffing.** Roster derived from the plan, intake stops pre-picking people, independent review predicate. Re-run.
5. **Preflight + repo notes.** Only if step 2 or 4 shows workers rediscovering the repository or failing on a red base.
6. **Explainability:** persisted waiting reasons, Graph promoted with decision and delivery edges, final report page.
7. **Only then, and only if the benchmark shows the failure:** model routing by run kind, manager hierarchy, richer restaffing, performance-informed staffing.
8. Simulation, fed by benchmark data.

Each step after 2 must move a benchmark number, or it is reverted from the plan.

## 8. Minimum Autonomous Delivery Test

Two tests, because the roadmap's single 25-step test mixes two different claims.

**A. Platform regression gate** (deterministic, fake CLI, runs in CI; mostly composed from existing gates m38, m47, m50, h9-restart-chaos)

- **Input:** a scratch repository, one goal, and `act` + `autoMerge`. No team is pre-assembled: intake forms it.
- **Scripted fake plan:** at least 5 tasks with parallel width at least 2.
- **Injected along the way:**
  - one task needs a role nobody holds, so the Supervisor hires under `act`;
  - one review rejects, so the task goes to rework and passes;
  - one daemon SIGKILL mid-run, so recovery happens with no human decision.
- **Must end** `PROJECT_COMPLETED`, with judge evidence and `humanInterventions = 0`.
- **Variant:** a goal whose acceptance check cannot pass must end `PROJECT_FAILED` with the failing check named.

**B. Hypothesis test** (real models, not CI)

- **Repositories:** 5, at pinned commits: small TypeScript/Python services, each needing a change across two layers plus tests.
- **Acceptance:** a held-out suite per goal, written in advance, never exposed to workers. One goal is deliberately unsatisfiable.
- **Arms:** Slave (plan-derived team), Slave with one seat, and a single-agent session. All use the same model and the same budget cap (e.g. $25 and 3 h per run), with 3 seeds each.
- **Pass for a run:** the judge says `PROJECT_COMPLETED`, **and** the held-out suite passes on the integrated base, **and** `humanInterventions = 0`, **and** the tamper check is clean.
- **Reported per arm:** unassisted completion rate, cost per completion, wall-clock time, runs per integrated task, and platform vs worker failure share.

## 9. Highest-Risk Assumptions

1. **That organisation is the bottleneck** rather than per-task reliability and plan quality. The live evidence contradicts it (§0.2).
2. **That multi-worker decomposition beats a single capable agent** on the same budget for software goals of this size. It is untested; the control arm tests it.
3. **That the planner's task graph is good enough to execute.** Observed: 5–6-task "tasks", 8–10-deep chains, one planner shot with no review.
4. **That "done + verify green" means the goal was met.** With a stub `verify.sh` that "checks nothing yet" (the live Maratus goal says exactly this), it means very little.
5. **That humanInterventions as currently recorded is a valid metric.** It is mislabelled today (§Q29).
6. **That cost is known.** More than half the runs in the live data have no recorded cost.

## 10. Fastest Falsification Experiment

- **Build:** Phases 0–1 of §7 (measurement fixes, judge, runner). About a week of work, most of it reusing the gate harness.
- **Run:** the three-arm hypothesis test (§8 B), first on 3 repositories × 2 seeds. About 18 runs at ≤ $25, so under $500.
- **Direction falsified** (for this task class) if either:
  - the single-agent arm's unassisted completion rate is at least multi-seat Slave's at equal or lower cost; or
  - every Slave run fails at planning or task execution before staffing or coordination is ever exercised.

  In the second case the organisation layer is not what stands between Slave and the goal, and phases 3, 6 and 7 are the wrong investment.
- **Direction supported** if multi-seat Slave completes goals the single agent does not, at comparable cost, and the win traces to parallel width or independent review in the evidence.

## 11. Open Disagreements

1. **Phase order.** The roadmap builds organisation (phases 1–8) before measurement (phases 9–10). I would build measurement first and let it choose what comes next.
2. **Capability analysis before planning.** I would do it inside planning (it already exists), with staffing after the plan.
3. **"Minimum sufficient team" as the staffing objective.** Seats cost nothing in Slave; I would staff from role coverage × plan width.
4. **Hierarchy (Project Coordinator → Engineering Lead → …).** I would keep it flat for the first milestone. The lead is the planning function, not a seat.
5. **Structured handoffs as a first-class domain concept.** I would use the existing statuses/events plus one delivery-note field.
6. **Worker Capability Manifest / governance phase.** It already exists; I would add nothing but the reviewer ≠ implementer rule.
7. **Project Command Map as a new primary surface.** I would promote the existing Graph modes instead.
8. **Dynamic restaffing as a phase.** It already exists; I would test it, not build it.
9. **humanInterventions as "the most important metric".** I would pair it with completion (unassisted completion rate) and a control arm, and fix how it is counted first.
10. **The 25-step acceptance test.** I would split it into a deterministic platform gate and a real-model hypothesis test with held-out acceptance, a control arm and repeated seeds.
11. **The completion judge's definition.** It judges the plan; it must judge the goal, against acceptance the planner did not write.
12. **Using ECC/ruflow skills as worker content.** I would admit execution checklists only. Process skills inside workers caused a measured failure (F9).
13. **Repository Intelligence as a phase.** I would reduce it to a deterministic preflight plus planner notes in existing Memory.

## 12. Verdict

**APPROVE WITH CHANGES**

The hypothesis, the failure-is-valid stance, the decision filter, the do-not-build list and the §35 experiment are right. The phase order and about half of the build list are not: they re-specify what Slave already has, and they aim at an organisational bottleneck that the live evidence does not show. Measure first. Build only what the measurement names.
