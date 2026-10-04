# The lead flow: one lead builds the goal, Slave proves it

Date: 2026-10-04. Status: design approved in conversation, awaiting the operator's read of this file.
First of three steps of the change of direction decided on 2026-10-04 (step 2: a new interface; step 3: removal
of the multi-package machinery). Each step has its own spec and plan.

## 1. Why

On 2026-10-03 a project was built from zero on main `5e165508` and watched live
(`/home/meren/slaveofai-logs/2026-10-03-canli-test-raporu.md`, 26 findings). On 2026-10-04 the same goal, the
same 29 requirements, the same starting repository and the same model were given to one session that was allowed
to use its own subordinate sessions (section 10 of that report; evidence in
`/home/meren/slaveofai-logs/solo-comparison-2026-10-04/`).

| | One session | Slave, eight packages |
|---|---|---|
| Time | about 45 min | 2 h 32 min to a passing smoke |
| Spend | 21.91 USD | about 97 USD |
| Decisions asked of the person | 0 | 5 |
| Neutral verification, product requirements | 25/25 | 24/25 |
| Blind comparison | better overall, "ship this one" | better code, required features missing |

It is the third measurement with the same sign (pilot 2026-09-26, large-1 2026-09-27). The expensive failures
of the eight-package run all came from splitting the work: interfaces between packages, ownership, merges,
ordering. The one session held the whole design in one head.

What the one session did not have, and Slave did: an independent verifier that started the product and tried
every requirement; a record of who decided what; a budget and a stop button; an intake. The blind reviewer also
proved six defects in the one session's product that a requirement check does not see.

So: the building moves to one lead. Slave becomes the control layer around it.

## 2. Rulings (from the conversation, 2026-10-04)

- R-1. Building is done by one lead session that manages its own subordinate sessions. Slave is the control
  layer.
- R-2. Four promises, all in the first version: proven delivery; decisions up front and on record; a budget and a
  time limit that hold; unattended running.
- R-3. The multi-package machinery (package plan, ownership audit, per-package review and merge, hand-offs) is
  removed. Not in this step: here it is switched off for new projects; step 3 deletes it.
- R-4. Persons stay as a catalogue: persons, templates, person cards, skills, memory. Seats, hiring, roles and
  assignment go. A roster is proposed in the spec stage and the lead picks its subordinates from it. Whether a
  roster changes the result is to be measured.
- R-5. The interface is rebuilt from nothing on shadcn/ui, with the theme in variables (step 2).
- R-6. The lead asks the person nothing. Questions are asked in the spec stage only. After approval the lead
  decides what is left open and records each decision with its reason; the person reads them afterwards, and a
  change is a new goal version.
- R-7. The proof loop runs until everything is proven, the budget or the time runs out, or two rounds in a row
  make no progress.
- R-8. The verifier checks the requirements; then a defect hunt runs. How deep, and which severity goes back to
  the lead, is set by the quality level. Two hunt rounds at most.
- R-9. Delivery is a project setting; the default is automatic merge when everything is proven.
- R-10. Approach: convert in place. First this flow and its measurement, then the interface, then the removal.

## 3. The flow

A goal version passes six stages.

| Stage | What happens | Who | The person |
|---|---|---|---|
| 1. Spec | The goal is made precise: requirements with acceptance checks, product decisions, roster, budget, time, quality level | intake model | answers, approves |
| 2. Setup | Repository and work branch; the spec is written into the repository | system | – |
| 3. Build | The lead builds the whole goal, with subordinates from the roster; records its decisions; asks nothing | lead | may watch |
| 4. Proof | An independent verifier checks every requirement on the running product; failures go back to stage 3 | verifier | – |
| 5. Hunt | When all pass, an independent session uses the product, reads the code and lists proven defects; serious ones go back to stage 3 | hunter | – |
| 6. Delivery | The report is written; if everything is proven the branch is merged; otherwise the person decides | system | reads the report |

The state of a goal version is one word: `spec`, `building`, `proving`, `hunting`, `delivered`,
`awaiting_decision`, `stopped`.

Three kinds of thing reach the person, and no other: spec questions (stage 1); one delivery card when something is
not proven; system faults the product cannot work around (disk, git, credentials). No card is raised while the
lead builds.

## 4. The spec stage (S)

- S1. **Questions.** The intake model asks the person the decisions that shape the product: one question at a
  time, with options and its own recommendation. The test for asking: does the answer change behaviour a customer
  sees, or the scope. At most 10 questions. The person may answer "you decide"; that decision is recorded as
  delegated to the lead.
- S2. **The spec document.** Goal (one paragraph); requirements, each with an acceptance check that says how a
  verifier will show it on the running product; decisions (asked and answered; delegated); out of scope; roster;
  budget and time (an estimate range and the person's limit); quality level; delivery setting.
- S3. **Roster.** 8 to 15 persons from the catalogue, each with a one-line reason. The person may add and remove.
- S4. **Quality levels.** `fast`: requirement verification only. `standard` (default): plus one hunt round;
  defects that are security, data loss or break a requirement go back to the lead. `thorough`: plus a second hunt
  round; medium defects go back too.
- S5. **Estimate.** A cost and time range from the number of requirements and the record of finished goal
  versions (`estimate records`: requirements, quality level, spend, time). Until there are records the estimate
  says it is rough. The default limit is one and a half times the upper end; the person sets the limit.
- S6. **Self-check before approval.** The spec is checked before it is shown: every requirement has an acceptance
  check a verifier can run; no requirement contradicts another or a decision; vague verbs ("manages", "supports")
  are made concrete. What fails is asked or fixed before the person sees the spec. (Yesterday's R7, "manages
  certificates on Nginx", would have been caught here.)
- S7. **Lock.** On approval the spec is stored (goal version, requirement set, decisions with source `person`)
  and written to `docs/spec.md` on the work branch. The lead, the verifier and the hunter are bound by the same
  text. A change after approval is a new goal version; running work is not interrupted unless the person stops
  it.
- S8. Requirement extraction moves here from the conductor. The conductor's requirement call is not used by this
  flow.

## 5. The lead (B)

- B1. **One session.** One Claude Code session on the goal's work branch. Its model is a project setting
  (default: the most capable available). No package plan, no per-task review, no ownership audit, no hand-offs.
- B2. **Subordinates.** The subordinate-session tool is allowed (today the permission gate knows it only under
  its old name and denies it). The roster is passed as session definitions: name, one line on when to use it, the
  person's instructions with their skills. The lead may also use a generic subordinate. Which person did which
  work is recorded from the stream. The subordinates' model is a project setting (default: the lead chooses).
- B3. **The lead's instructions.** The whole spec. Rules: stay on the work branch, commit, the README documents
  install, start and use exactly. Nobody answers questions: decide what is open and record each decision with its
  reason in `docs/DECISIONS.md`. How the result is judged: an independent verifier and a hunter; passing tests
  are not enough, the running product must show it. Budget and time left. A closing report: built, not built,
  what a person must do before release.
- B4. **Limits belong to the goal.** The per-run limits (200 tool calls, 30 minutes) do not apply to the lead.
  A goal version has a budget (the sum of lead, subordinates, verifier, hunter) and a time limit. One fifth of
  the budget is reserved for proof and hunt; the lead is told its share. At 80% of its share it is told to wrap
  up (commit, write the report); at 100% it is stopped and proof starts on what is committed.
- B5. **Stall.** No progress for 30 minutes: the session is restarted with a continuation note.
- B6. **Continuation.** After a daemon restart, a crash or a cut session, the same session is resumed. Where no
  transcript exists, a new session starts on the same branch with a note of where the last one stood. Both are
  recorded. A session is never ended while its subordinates are still working.
- B7. **Provider limit.** When the provider's limit is reached the goal waits for the reset and continues. It is
  a line in the report, not a card.
- B8. **Rework.** What the verifier or the hunter found goes, with its evidence, into the lead's same session.
- B9. **Decisions on record.** When the lead finishes, `docs/DECISIONS.md` is read into decision records with
  source `lead`. A missing or unreadable file is said in the report; it stops nothing.
- B10. **Visible while it runs.** What it is doing now, which subordinates are running, the last commits, spend
  and time. No cards.

## 6. Proof and hunt (P)

- P1. **Verifier.** A new independent session each round. It sees the repository and the spec, not the lead's
  closing report. It installs and starts the product from the README and checks each requirement by its
  acceptance check. It cannot change the repository; the existing tamper check stays. Verdict per requirement:
  pass, fail or unverifiable, with the check, its output and the reason.
- P2. **Smoke first.** The lead's smoke script runs before the verifier. If it fails, no verifier is started and
  the failure goes to the lead.
- P3. **A failure is confirmed.** Before a failed requirement goes back to the lead, a second independent session
  re-checks only the failed ones. Both say fail: rework. They disagree: the requirement is `disputed`, it is not
  sent to rework, and the report says so. (On 2026-10-03/04 two verifiers gave opposite verdicts on the same
  requirement of the same product.)
- P4. **Unverifiable does not stop the goal.** It is listed in the report. A requirement that needs a real
  external system is checked against a local stand-in and reported as "not tried against the real system".
- P5. **Rounds.** A round after rework checks the smoke and what failed before. Before delivery a full
  verification always runs on the final commit; the reserved budget always covers it.
- P6. **Hunt** (quality `standard` and `thorough`). Starts when all requirements pass. An independent session
  installs the product, uses it as an operator would and reads the code. Output: proven defects (a request and
  its response, a failing command, a line and why it is wrong), each with a severity; unproven suspicions are
  listed apart and never go to rework. Defects at or above the quality level's threshold go to the lead. After
  the rework each finding is re-checked (closed or not), then the full verification runs. What is left is
  "known issues" in the report.
- P7. **Stop.** Everything proven and no open defect above the threshold; or the budget or the time is spent; or
  two rounds in a row leave the same items failing.
- P8. **Who verifies.** The verifier and the hunter run on a model as capable as the lead's. By default they take
  personas from the catalogue (a reviewer and a security person); measured together with R-4.

## 7. Delivery and the report (D)

- D1. Everything proven (the full verification passed, no open defect above the threshold) and the project is set
  to automatic merge: the work branch is merged into the base branch.
- D2. Otherwise (something failed, disputed or unverifiable; or the stop was budget, time or no progress): the
  branch stays and one delivery card is raised with three decisions: accept as it is, add budget and continue,
  leave it.
- D3. If the base branch moved and the merge conflicts, the lead gets a turn to take the base branch in and
  resolve; the full verification runs again.
- D4. **The report**, one page, the outcome first: outcome and stop reason; requirements with verdict and
  evidence (disputed and unverifiable apart); decisions (the person's, the lead's with reasons); known issues by
  severity; what a person must do before release; who worked (lead, subordinates by person, verifier, hunter);
  spend and time per stage against the estimate; interruptions (limit waits, restarts).
- D5. A change the person wants after the report is a short request that opens a new goal version; the spec stage
  runs for what changes only.

## 8. What this step changes, and what it leaves

**Built here:** the subordinate-session tool in the permission vocabulary and the roster as session definitions
(B2); the spec stage (S1–S8); the lead path with goal-level limits (B1–B5, B8–B10); continuation and limit waits
(B6, B7); the proof loop changes (P1–P5, P7); the hunt and quality levels (P6, S4); the delivery card and the
report (D1–D5); estimate records (S5).

**Switched off for projects opened in this flow, code left in place:** the conductor's package plan and
requirement call, per-task review, ownership audit, per-task merge, hand-offs, seats and hiring, conductor
questions and every card raised while work runs. Projects opened before this change keep running as they do.

**Interface in this step:** only what the flow needs to be driven, inside the present interface and plain: the
spec conversation and approval, the live state (B10), the report and the delivery card. Step 2 rebuilds it.

**Data:** existing tables are reused (goal version, requirement set, decisions, runs, verification, delivery).
Added, all additive migrations: the spec with acceptance checks, quality level, the goal's time limit, the
roster, hunt findings, estimate records, the state word of section 3.

## 9. Edge cases

- The lead ends without a closing report or without `docs/DECISIONS.md`: proof starts anyway; the report says
  what is missing.
- The lead commits nothing: proof does not start; the stop reason is "nothing was built" and a delivery card is
  raised.
- The budget runs out during proof: the full verification of P5 still runs from the reserve; if even that cannot
  be paid, the report says the result is unproven.
- The person stops the goal: sessions are paused; continuing resumes the same sessions (B6).
- A subordinate fails or returns nothing: it is the lead's to handle; the control layer does not step in.
- Text from the person (spec answers) and text from the lead (decisions, report) is bounded and inert wherever it
  is stored, shown or put in a prompt, as person text is today.
- A project opened before this change has no spec: nothing in this flow reads it.

## 10. Testing and the measure of this step

- Unit and integration tests for each part, with the fake CLI.
- One gate that drives the flow from spec approval to delivery with the fake CLI: a requirement that fails once
  and is confirmed, a disputed requirement, a hunt finding above the threshold, a provider-limit wait, a daemon
  restart mid-build.
- The existing suite and gates stay green.

**The measure.** When the step is built, the goal of 2026-10-03 is run through it and judged by the same neutral
verification and blind comparison as on 2026-10-04:

1. Spend and time at most one and a half times the one session's (about 33 USD, 70 minutes).
2. In the blind comparison, not behind the one session; and of its six proven defects, the serious ones caught.
3. Zero questions to the person while it builds.

If these are missed, the control layer's gain is not shown: stop before steps 2 and 3 and take it to the operator.

## 11. Not in this step

The new interface (step 2). The deletion of the multi-package machinery, seats, hiring and their gates (step 3).
Providers other than Claude Code for the lead. Notifications by push or e-mail. More than one lead per goal
version.
