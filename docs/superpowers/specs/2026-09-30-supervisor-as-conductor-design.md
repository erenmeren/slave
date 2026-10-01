# The Supervisor as conductor: hand-offs reach their owner, questions are answered from the plan

Date: 2026-09-30. Status: design approved in conversation, awaiting the operator's read of this file.
Builds on the conductor spec (`2026-09-27-conductor-supervisor-design.md`, Plans 1–5) and the skeleton
spec (`2026-09-29-skeleton-and-smoke-design.md`, merged 90b16010). Second of the follow-ups from the first
real conducted project; the human cards (closing questions, deciding on a card, timeouts) are the next spec.

## 1. Why

In the observed project (`/home/meren/slaveofai-logs/observations.md`) every package wrote "questions" to the
role `conductor`. Almost none were questions:

- OBS-4/5/15: most were hand-offs to another package ("please add `node --test backend/src/security/` to
  scripts/verify.sh", "the integration package needs to expose GET /api/v1/certificates with
  `{data,nextCursor}`", "move my migrations into backend/migrations/"). No channel put them into the owning
  or dependent package's prompt; the integration package started blind to every one of them.
- OBS-3: a `conductor` question is observed as `unanswerable_question` ("no slave holds that role") and,
  whenever the per-tick model budget or the quote check fails, goes to a person.
- OBS-6/12/20: the sourced-answer path reads the asker's own prompt and the goal text only — never the
  requirement set, the packages, their ownership or earlier answers (conductor spec R11 promised this world;
  it was not built). It answered "the owner is unknown" about a file the plan assigns, auto-applied a wrong
  answer that pushed a worker onto a file it does not own, and later auto-applied the opposite of an answer a
  person had approved two minutes earlier.
- OBS-6/12: answers to a finished task's report questions go nowhere (they surface only in that seat's next
  run on the same task).
- OBS-13: cross-cutting design decisions (API field naming, where routes register, persistence, error shape)
  had no owner; workers worked around the ownership rule by degrading the product (provider config in memory,
  migrations outside the migrate directory).
- #7: the per-tick cap of 3 model calls made three questions of one kind get three treatments (applied,
  proposed, escalated) in one tick.

This spec makes the conductor behave like one: a hand-off reaches the package that owns the change, design
questions are answered from the plan and bind later answers, and a person is asked only when an answer would
change a requirement, the ownership or the budget.

## 2. Rulings (from the conversation, 2026-09-30)

1. **Routing is rule plus model.** A structured hand-off is routed by the ownership rule, never by a model. The
   model answers only real questions (decisions, design), with the plan in view.
2. **Authority.** A conductor answer is applied without a person when its basis verifies against the plan
   (requirement keys, package keys, decision titles that exist) and it changes no requirement, no ownership and
   no budget. Otherwise it goes to a person. The existing critical word list is unchanged.
3. **Shared decisions are made up front.** The conductor writes a `decisions` list with the package plan; every
   package's contract carries it; later answers are checked against it and may extend it.

## 3. Design

### C1 — The report separates hand-offs from questions

`<slave-report>` gains `handOffs` (at most 10). Each is `{ path, change }` or `{ package, change }`
(`change` ≤ 2000 characters; exactly one of `path`/`package`). `questions` stays (at most 10), now meant only
for decisions and design. The single `handOff` field the smoke gate added stays as it is and keeps its meaning
(a smoke rework's skeleton hand-off). A report in the old shape parses as before: `handOffs` absent reads as
none, and every question is a conductor question.

The package contract and the report protocol say which to use: a change in a file you do not own, or work
another package must do, is a hand-off (with the path when there is one); a choice nobody has made is a
question. The contract line that today sends cross-package changes to the conductor as questions is replaced.

### C2 — Hand-offs are routed by ownership

When a report is filed (`fileRunReport`), each hand-off is resolved over the version's packages:

- `path`: cleaned exactly as the smoke hand-off cleans it (refuse globs, `..`, absolute paths, `./`, empty
  segments); the target is the package whose rule owns it (`ownershipRuleFor` / `isOwned`, integration owns
  what no other package owns).
- `package`: the package with that key.
- The reporting package itself, an invalid path, or an unknown package key: the item becomes a conductor
  question carrying the note "no target found" (never dropped), or, for its own package, is ignored and recorded.

Delivery depends on the target's state:

- **Not started** (its tasks are `pending`/`queued`): the request is stored and shown in the target's prompt in a
  new section, "Asked of your package", listing each request with the package it came from.
- **Running or waiting**: stored and shown in its next run's prompt; if its current run concludes `done`
  without a later run, it is reworked as below.
- **Done**: the target's task moves `done → rework` with the request as the reason, no attempt charged — the
  path the verification rework and the smoke hand-off already use. A request identical to one already delivered
  from the same source to the same target does not open a second rework.

Every routed hand-off is an event (`workspace.package_handed_off`: from, to, path or package, delivery kind,
trimmed change) and is listed on the goal report page and in the Markdown export.

**Loop guard.** Within one goal version a package is reopened by other packages' hand-offs at most twice; a
third becomes a conductor question naming the chain.

**Dependency leads.** A dependent package's prompt also carries its dependencies' latest reports as leads
(questions, requirements not done, workflow notes) — the same `leadFromReport` digest the verifier already
receives — so a package learns what the one before it could not finish.

### C3 — Shared decisions in the plan

The conductor's answer gains `decisions` (at most 15; each `{ title ≤ 80, decision ≤ 600 }`). They are stored
per goal version in a new `GoalDecision` table (`title`, `decision`, `source`: `conductor-plan` |
`conductor-answer` | `person`, the question it answered when it came from one, `createdAt`). Every package
contract gets a "Shared decisions" section listing them. The conductor prompt asks for the decisions every
package would otherwise have to guess: API shape and naming, where routes, handlers and dependency injection
register, persistence (no in-memory stand-ins for data the product stores), error shape, configuration.

A decision never moves ownership; `ownedPaths` alone does. Plans stored before this spec read as having no
decisions.

### C4 — Conductor questions get their own path

A pending question to `conductor` is observed as a new situation kind, `conductor_question`, not as
`unanswerable_question`. The Supervisor's world gains, for goal versions with packages, the requirement set,
the packages with their owned paths, key and interface, the shared decisions, the conductor's earlier answers in
this version, and the packages' latest reports (the R11 world).

All conductor questions of one goal version pending in a tick are answered in **one** model call (at most 10
questions; the rest wait for the next tick), outside the general per-tick cap of 3, with one call per version
per tick. Paused runs' questions go first. The call returns, per question:

- `answer` (text),
- `basis`: requirement keys, package keys and decision titles it rests on,
- `changes`: `none` | `requirement` | `ownership` | `budget`,
- optionally `newDecision` `{ title, decision }`,
- optionally `handOff` `{ path | package, change }` when the answer means work for a package.

Checks: every basis item must exist in this version; an answer with an empty or unverifiable basis, or with
`changes` other than `none`, goes to a person (tier `proposed`/`escalated`, as today). Otherwise it is applied:
the answer is recorded as a reply, `newDecision` is added to the decisions (source `conductor-answer`) and reaches
later prompts, and `handOff` is routed by C2.

Delivery of an applied answer: a paused run resumes with it (the existing delivery); for a report question of a
finished task, the answer is recorded and, when it carries a `handOff`, routed — it is never sent to a task that
will not run again.

A failed batch (unparseable output, model error) writes nothing and is retried next tick; after 3 failed batches
for the same questions they go to a person with the real reason in the card.

### C5 — Finished tasks' report questions stop re-escalating

A report question whose task is `done` and that has been answered, turned into a decision or a hand-off, or sent
to a person no longer counts as pending for the conductor path. (Closing a question from a person's approve or
reject in general is the human-cards spec.) A run paused on a `conductor` question for more than 30 minutes
raises the existing `waiting_stale` situation so it is visible.

## 4. Compatibility

Planned delivery and conducted versions from before this spec are unchanged in behaviour except C4/C5 (their
`conductor` questions are answered by the new path, with an empty decisions list). Old-shape reports parse. No
existing requirement set, plan or report is rewritten.

## 5. Error handling and safety

- Every worker-written string (`change`, questions) is sanitised (`sanitisePersonText`) and bounded before it
  enters any prompt, and escaped on the report page and in the export.
- A hand-off never grants a file: the target changes its own files; if the target does not own the path either,
  the item becomes a conductor question.
- Stored text is stripped of NUL and other C0 controls (as the smoke gate does).

## 6. Testing

- Unit: report schema (old and new shape); hand-off routing for every target state and the invalid, own and
  unknown cases; the loop guard; `decisions` validation; the batched answer parser; the apply-or-ask rule.
- Integration: a filed report routes a hand-off into a not-yet-started package's prompt section and reworks a done
  package; a paused run resumes with a batched answer; an answer with `changes: ownership` goes to a person; a done
  task's question does not come back; `newDecision` reaches the next package's contract.
- End to end (fake CLI): the observed project's shape — a package leaves the integration package an endpoint
  contract (visible in its prompt), a package hands the skeleton a manifest change (skeleton reworked), a design
  question becomes a shared decision seen by the next package.
- Gates: m56a stage-12 counts move for the new situation kind and events.

## 7. Out of scope

Deciding on a card, closing a question on approve/reject, timeouts for questions waiting on a person (the
human-cards spec); cross-package review after integration; requirement-extraction stability; staffing and
parallelism; workers' own use of host Docker.
