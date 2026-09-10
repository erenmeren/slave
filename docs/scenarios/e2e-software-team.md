# One story, end to end: a software team that coordinates itself

`npm run gate:m41-scenario` (`scripts/gate-m41-scenario.mjs`) tells one story through the whole
system and then asks every operator surface what happened. Every earlier gate proves one seam —
m35 integration truth, m36 ask and answer across a restart, m37 the recorded prompt, m38 staffing
and budget, m39 the mailbox, m40 re-planning. None of them runs the seams in sequence, and the
sequence's claim — a team that coordinates itself and tells the truth about its state — is only
proven when one run crosses all of them.

Nothing here is mocked except the model. Two real `orchestrator daemon` processes and two one-shot
`orchestrator tick` commands run in turn against a real git repository and the real database; every
`claude` invocation is `packages/providers/test/fake-claude.mjs --fixture m41-flow`, so the gate
spends nothing and replays the same recorded transcripts every other gate does.

## The company

| Slave | Runtime roles | What it does in the story |
| --- | --- | --- |
| Atlas | `manager` | plans, and re-plans |
| Dev | `backend` | one of the two who can take a task |
| Ops | `backend` | the other one |
| Rae | `reviewer` | reviews, and nothing else — so it never reviews its own work |
| Quinn | `qa`, then nothing | holds the role the question is addressed to, and loses it |

`Quinn` is not decoration. `ask.ts` refuses a question addressed to a role no other slave holds —
parking a task to wait for nobody is the bug that check exists to prevent — so a question can only
*become* unanswerable after it was asked. Quinn holds `qa` while the question is asked and the
operator takes it away immediately afterwards with `set-runtime-roles --roles ''`, which is the only
shape in which the Supervisor's `unanswerable_question` is reachable at all.

The project does **not** auto-merge. A reviewed task lands `done` with its branch unmerged, and a
person merges it and runs `confirm-integration`. That buys three things at once: `task.integrated`
becomes a real event (only `confirmIntegration` writes it — the auto-merge path stamps `integratedAt`
and emits `task.done` alone); M35's integration rule becomes a measured act rather than a footnote;
and it is what keeps the board still between acts, because a task whose dependency is done but
unmerged cannot be dispatched, so every measurement the gate takes is a measurement rather than a
race.

## Who is actually running

Two real daemons and two hand `tick`s, not four daemons — and the reason is a fact about the
product worth knowing. `runDaemon` subscribes to the event stream and wakes its tick coalescer on
**every** event in the workspace; the period is a fallback, not the trigger. So the
`workspace.plan_created` that announces a board exists is itself the notification that wakes the
tick which dispatches off it: measured, the first `task.started` landed 24 ms after the plan
committed, with the period set to 750 ms. "Stop the daemon after the plan lands but before any work
starts" is a coin flip, not a measurement, and no period value widens that window.

The two acts whose whole claim is *the board was planned and nothing started* therefore run the
operator's own one-shot `tick` — the same `tick()` function the daemon calls, which dispatches work
**first** and plans afterwards, and which then waits for what it started (`drainPumps`) before the
process exits. One hand tick plans the board, concludes the plan, and returns with the dispatch
phase already behind it. Nothing is timed and nothing is raced.

The cast, in order: `tick` for act 1's plan; `daemon-1` for acts 2 to 4's core leg, carrying
`--ask-on-task core` and the question envelope; `daemon-2` for act 4's api leg, carrying no ask
flag; `tick` again for act 5's re-plan, carrying `--replan-cancel <polish>`. Acts 6 and 7 run with
nothing alive at all.

## Act 1 — a requirement becomes a plan

`set-goal` prints `{"version":1,"sha256":"…"}`. One hand `tick` gives Atlas a planning run, and the
run lands three tasks: `Write the feature core` → `Expose the API` → `Document and polish`, all
`ready`, all stamped `goal v1`.

Asserted: `set-goal` printed version 1 and the v1 text's own hash, computed with the product's
exported `goalSha256`; three tasks with those titles; every one `ready` at `goalVersion 1`; the core
task's description really carries the sentence act 3 will quote; exactly one `workspace.plan_created`
carrying version 1; every `task.created` carrying it too; the planning run **the event names**
recorded a context whose manifest says `planning_goal` version 1 with the v1 hash and has **no**
`replan` section; the prompt carrying the goal text; and `replan-status` reporting `willReplan false`
with `blockedBy null` at goal 1 / board 1.

Then the certainty the hand tick buys: no orchestrator daemon is alive on this host, no run of any
kind is still in flight (the proof `drainPumps` really drained), and not one `SlaveRun` row exists
for any of the three tasks.

## Act 2 — a worker starts, and stops to ask

Daemon-1 carries `--ask-on-task core` on the fake CLI's argv and the question envelope in its
environment. The core task is dispatched to Dev or Ops — the gate records which; either is a true
story — and the run stops mid-task and asks the `qa` role which database the service talks to.

Asserted: the run is `paused` with `waiting_for_answer`; exactly one `question` row exists, addressed
to the `qa` role and carrying the envelope's own question; the task is `waiting` and still points at
that run; **no attempt was charged** and no `run.failed` was written, because asking is neither
failing nor finishing; `api` and `polish` have not moved and have no runs at all.

And the run's recorded manifest hashes exactly the task text the renderer hashed —
`sha256("<title>\n<description>")`, computed here with the product's own exported hash rather than a
copy of it. The prompt carries its `Task: Write the feature core` line and does **not** contain the
task's id anywhere, which is why the fake CLI's ask flag keys on a word from the title in the first
place.

Then the operator runs `set-runtime-roles --slave <Quinn> --roles ''`, and the question has nobody
left who could answer it.

## Act 3 — the Supervisor answers what nobody else can

On its next pass the Supervisor sees `unanswerable_question` — no staleness wait, because however
fresh a question is, nobody can answer it — chooses `answer_question`, drafts one, and checks every
quote it cites against the asking task's own description. The quote is really there, so the answer
is sent by the machine itself.

Asserted: the decision row is `applied`/`applied` with no failure reason, `decidedBy: model`,
carrying the cost of **both** calls — the choice and the draft — read off the fixtures at runtime;
the draft's confidence is `sourced`, with `PostgreSQL on port 5433` among its verified citations and
nothing rejected; exactly one `answer` message exists, its body is the draft's own text, its envelope
actor is `system` and the `slave.message_sent` payload says `answeredBy: 'supervisor'`; a later
tick's `deliverAnswers` resumes the **same session** (the single `run.resumed` names the session id
`run.started` did), the resumed leg carries a fresh pid and reaches `succeeded`, and there is still
exactly **one** run for the task — the answer continued the waiting run rather than starting a new
one; and the Supervisor's own report says it answered one question in the last day and has no draft
waiting on anybody.

## Act 4 — verified, reviewed, and integrated by a person

Core's run succeeds, verify passes, Rae reviews it, and the merge pass marks it `done` with
`integratedAt` still null and its branch left alone.

Asserted: core reached `done` with every one of `task.verifying`, `task.verify_passed`,
`task.review_started`, `task.review_approved` and `task.done` on its timeline; its review run was
taken by Rae, who wrote none of it; and `api` reports `dependenciesDone: false` through the
orchestrator's **own** `loadWorld` — the snapshot the scheduler decides from — while core is done but
unmerged, as does `polish`, read for itself rather than inferred.

Daemon-1 is then stopped and the stop is proved: the pid answers no signal, `/proc/<pid>/cmdline` no
longer reads as a daemon, no orchestrator daemon is alive on this host, and no run exists for `api`
or `polish`. The operator merges core's branch into `main` for real (`--no-ff`), checks the work is
there, and runs `confirm-integration`: `integratedAt` is written, exactly one `task.integrated` event
exists with actor `human`, and `api` becomes schedulable.

Daemon-2 takes `api` through the same pipeline with no question in it — exactly one implementation
run, reviewed by Rae again, and still only one question in the whole workspace. `polish` reads
`dependenciesDone: false` (api is done and unmerged), and daemon-2 is stopped with the same proof.

The spend so far is printed as a table (kind, count, unit cost, subtotal) and asserted against
`workspaceSpend`, the one formula the guardrails and every surface read:

```
   1 x $0.209339 = $0.209339  planning run (the first plan)
   1 x $0.209339 = $0.209339  implementation run, core (asking leg $0 + resumed leg: ONE row, ONE recorded cost)
   1 x $0.209339 = $0.209339  implementation run, api
   2 x $0.209339 = $0.418678  review run
   1 x $0.010000 = $0.010000  supervisor decision: choose an action
   1 x $0.020000 = $0.020000  supervisor decision: draft the answer
  total $1.076695
```

One line of that table is worth reading twice: **the leg that asked recorded no cost at all.** A
run's cost is written once, at its terminal conclusion, and a run that stops to ask never reaches
one — so the single row for that task carries exactly the resumed leg's price, which is asserted on
the row itself.

## Act 5 — the requirement changes

`set-goal` v2 — the goal now asks for an endpoint doc. `goal-history` prints v2 before v1 with the
line diff between them (v2 with one line added and one removed, v1 with no diff at all, because it
replaced nothing), both texts and both hashes; `listGoalVersions`, the control verb the web history
route reads through, returns the same bytes. `replan-status` says a re-plan is due with nothing in
the way, at goal 2 / board 1.

The second hand `tick` runs the re-plan. Asserted: exactly one `workspace.replan_started` at version
2; that run's manifest has a `replan` section moving v1 → v2 with both goal texts' own hashes; the
board it was shown is the **unfinished** board alone — `boardTaskIds` is `[polish]`, because core and
api are done; the prompt carries the literal `"replan"`, the heading `THE GOAL CHANGED`, and both
requirements.

On conclusion: one new task `Document the new endpoint`, `ready` at `goal v2`, and the three older
tasks still stamped v1; `workspace.replanned` accounting for all four lists (`added [docs]`,
`proposedCancellations [polish]`, nothing dropped, nothing failed); exactly one **pending**
`stale_task` proposal, `proposed`/`pending`, whose action is `cancel_task` on `polish`; and `polish`
still `ready`, because a cancellation is a proposal and not a deletion. The proposal cost nothing —
`modelCalled false`, `modelCostUsd null` — because the re-plan run had already paid for that
judgement, and the Supervisor's spend must not gain a call that never happened.

And again the hand tick's certainty: no daemon anywhere, nothing in flight, and no run for `docs` or
`polish`.

## Act 6 — a human approves

`approve-decision --id <proposal>` cancels `polish`. Asserted: the decision reads `approved` — not
`applied`; `approveDecision` claims the row to `approved` and then carries the action out — with no
failure reason; the task is `cancelled` and keeps the reason; exactly one `task.cancelled` event, for
`polish`, carrying **the task's own** `goalVersion: 1` — the requirement whose work was dropped, not
the one that dropped it — with actor `human`; and a `supervisor.applied` event names the decision
that did it. Then the operator merges `api`'s branch and confirms its integration too.

## Act 7 — with nothing running, every surface has to agree

No daemon is alive on the host, and the gate refuses to take a single reading until it has checked.
Every value below is printed before it is asserted.

- **The board.** `core` done and integrated at v1; `api` done and integrated at v1; `polish`
  cancelled at v1; `docs` ready at v2, and the workspace on goal v2. Nothing is stale: the count
  behind the task card's **stale** badge is 0, because every task still carrying v1 is terminal. One
  ready task, nothing running, waiting or blocked; two done and integrated, none awaiting
  integration; and nothing stuck.
- **The goal history.** `[v2, v1]`, each with its hash, v2 carrying a non-empty diff and v1 carrying
  none. The CLI and the control verb the web history route reads through return the same bytes.
- **The Supervisor.** Exactly two decisions: the answer, `applied`; the cancellation, `approved`.
  Nothing pending, nothing escalated, nothing failed. `listDecisions` and `supervisor-decisions`
  return identical rows, and the Supervisor is still switched on.
- **The mailbox.** `messages` prints `no slave is waiting on an answer`, `listPendingQuestions` is
  empty, and the thread is two messages long — the question and its answer, in that order.
- **The spend.** The run census is asserted **first** — 2 planning (a plan and a re-plan), 2
  implementation, 2 review — so a duplicated run fails with a diagnosis instead of an unexplained
  figure. Then the printed table:

  ```
     1 x $0.209339 = $0.209339  planning run (the first plan)
     1 x $0.209339 = $0.209339  implementation run, core (asking leg $0 + resumed leg: ONE row, ONE recorded cost)
     1 x $0.209339 = $0.209339  implementation run, api
     2 x $0.209339 = $0.418678  review run
     1 x $0.010000 = $0.010000  supervisor decision: choose an action
     1 x $0.020000 = $0.020000  supervisor decision: draft the answer
     1 x $0.030000 = $0.030000  planning run (the re-plan)
     1 x $0.000000 = $0.000000  supervisor decision: the cancellation proposal (the re-plan run already paid; no model here)
    total $1.106695
  ```

  Its total equals `workspaceSpend.spentUsd` to a billionth of a dollar
  (`runsMeasuredUsd 1.076695` + `supervisorMeasuredUsd 0.03` = `spentUsd 1.106695`), no Supervisor
  call was charged at the unmeasured cap, and `workspaceStats` — the reading every guardrail
  evaluates — agrees, on an idle project with no consecutive failures and no emergency stop.
- **The event log.** A count per type is printed, and the load-bearing ones are asserted: two
  `workspace.goal_set`, one `workspace.plan_created`, one `workspace.replan_started`, one
  `workspace.replanned`, four `task.created`, one `task.cancelled`, two `task.integrated`, two
  `task.done`, two `slave.message_sent`, one `run.paused`, one `run.resumed`, no `run.failed`, two
  `supervisor.decided`, one `supervisor.proposed`, two `supervisor.applied`, one
  `supervisor.resolved`, no `supervisor.failed`, one `slave.runtime_roles_changed` — and **zero**
  `guardrail.tripped`.
- **The CLI's last word.** `status` reports no halt, no archive and no live run; `show-context` on
  the re-plan run renders its `replan` section and the prompt it was given; `replan-status` says the
  board has caught up to v2 with no further re-plan due; and re-typing the requirement the project
  already has exits non-zero and writes no third version.

## What the story found

An end-to-end gate earns its cost by finding what unit gates cannot, and this one did on its first
few runs.

`dispatchReview` guarded only on *"is a review run already live for this task"*. But the pump writes
a run terminal and emits `run.succeeded` **before** the chained conclusion moves the task off
`reviewing` — and the daemon wakes on every event, including that one. That tick found a task still
`reviewing` with zero live review runs and started a **second reviewer on the same branch**:
measured 16 to 45 ms after the first went terminal, on 5 of 7 gate runs, one extra provider run per
reviewed task ($1.495373 instead of $1.076695). Nothing was corrupted — the second verdict is a
no-op — but the bill and the story were both wrong.

The implementation path was never exposed, because `startRun` claims its task atomically. The review
path had no claim of its own. It has one now: a review run claims `Task.activeRunId` exactly the way
an implementation run does, the loser deletes its row and starts nothing, every conclusion releases
the claim, a failed review hands it back without charging an attempt, and the sweep returns an
orphaned review claim to `reviewing` rather than to `rework`. The gate's `review === 2` and its
exact-spend assertions were right as written and did not move.

No unit test could have seen it: each seam was correct on its own, and the defect lived in the timing
between three of them.

## Things this story deliberately does not do

- It never calls a real model. `SLAVEOFAI_REQUIRE_FAKE_CLI=1` makes that a refusal rather than a
  convention.
- It does not import `apps/web`. The web builders compose control and domain verbs, and the gate
  calls those verbs — `apps/web/test/integration/gate-surface-parity.test.ts` pins the mapping so a
  builder that starts computing something of its own fails a test rather than silently making this
  gate a measurement of nothing.
- It does not run a one-shot `tick` for anything a daemon can drive. The daemon drives every work
  run, every review, every merge pass and every Supervisor pass in the story; the two hand ticks
  exist only because the daemon cannot drive "plan the board and dispatch nothing", being woken by
  the very event that says the board exists.
- It fixes nothing. Every stage prints what it measured and then asserts it; a failed assertion
  dumps every row this workspace owns and exits 1, and the teardown runs whichever way the run
  ended.
