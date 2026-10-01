# Human cards: a card carries a decision, every decision closes the question, a wait has an end

Date: 2026-10-01. Status: design approved in conversation, awaiting the operator's read of this file.
Builds on the Supervisor-as-conductor spec (`2026-09-30-supervisor-as-conductor-design.md`, merged 08ddcdde)
and the skeleton spec (`2026-09-29-skeleton-and-smoke-design.md`). Third of the follow-ups from the first real
conducted project.

## 1. Why

In the observed project (`/home/meren/slaveofai-logs/observations.md`):

- OBS-8: a card could only approve or reject the one action the machine had picked. When the integration
  package asked "may I add a start script to core-domain's package.json?", the person had no way to say "yes,
  core-domain: add it" — approving sent a non-answer, rejecting left the run paused.
- OBS-9: approving or rejecting an escalation closed the card, not the question. Fifteen minutes later the same
  question was observed again and produced a new card — three cards for one question, each a model call.
- The integration run paused on a question had no end to its wait; the whole version depended on a person
  clicking.
- OBS-14: about nine cards in thirty-five minutes, none of which changed the work.

The Supervisor-as-conductor spec removed most of the conductor-question traffic. What is left — questions a
person must decide, the escalations of every other situation, parked runs — still has these four faults.

## 2. Rulings (from the conversation, 2026-10-01)

1. **A card offers concrete decisions**: send this answer, write my own answer, give a package work (hand-off),
   give a file to a package, record a shared decision, change a requirement, dismiss and close. Every decision
   closes the question.
2. **A wait has an end**: after a configurable time (default 2 hours) a run paused on an unanswered question
   continues on its own best judgement; the card stays open; a later decision reaches the work as a hand-off.
3. **One queue per goal version, grouped by subject**: what blocks the version first; cards on one subject merge;
   information that needs no action is not a card.

## 3. Design

### H1 — A question closes

`SlaveMessage` gains `closedAt`, `closedReason` (`answered` | `decided` | `dismissed` | `timed_out` |
`superseded`) and `closedBy` (a user id or `system`). `stillPendingQuestion` treats a closed question as not
pending; the Supervisor's world, the inbox and the answer box read the same rule. The conductor path's narrow
"done task, settled decision" filter is replaced by it.

Every decision a person takes on a card closes the card's question in the same transaction. A question closed
by any path (an answer, the answer box, a timeout, a dismissal) retires every open card about it. A question has
at most one open card: cards are keyed by the question, not by situation kind, so `conductor_question` and
`waiting_stale` on one message share one card.

A closed question is never observed again. If the subject comes back, a worker or the conductor asks a new
question. Closing is a recorded decision, shown on the goal report.

### H2 — The decisions a card offers

A card shows the decisions that fit its subject; each is one click or a short form:

1. **Send this answer** — the drafted answer as is; a conductor draft's shared decision and hand-off apply, and
   the card says what will apply.
2. **Write my own answer** — free text to the asking run; the draft's decision and hand-off do not apply, and
   the card says so.
3. **Give a package work** — target package (or a file path, resolved by ownership) and the request; routed by the
   hand-off machinery with source `person` (prompt section for a package not started, rework for a finished one).
4. **Give a file to a package** — moves one owned path to another package. The only path in the system that
   changes ownership. Validated against the version's packages: disjointness, the manifest-family rule, a
   concrete path or the package's own registration directory. Takes effect at the next run's gate and diff
   audit; recorded on the report.
5. **Record a shared decision** — title and decision, source `person`, into the version's decisions and every
   later contract.
6. **Change a requirement** — through the existing goal-change path, which opens a new goal version; the card
   says so. There is no in-place edit of a requirement set.
7. **Dismiss and close** — with a reason. If a run is parked on the question, it continues with: "A person closed
   your question without an answer: <reason>. Continue on your safest assumption and say which in your report."

Cards whose action is the machine's (hiring, retrying a task, lifting a halt) keep approve and reject; approving
or rejecting them now also closes their question.

### H3 — A wait has an end

`Workspace.questionTimeoutMs` (default 2 hours; 15 minutes to 72 hours) is set through the existing limits path.
Each tick, a pass finds runs paused `waiting_for_answer` past it and resumes them through the existing resume path
with: "No answer came in <duration>. Continue on your safest assumption, and say in your report which assumption
you made." The question closes `timed_out`; its card stays open, marked "continued without an answer".

A decision taken later on such a card is not lost: an answer or a decision becomes a hand-off (or rework) to the
package that asked, and the card says where it will go. When the workspace is halted or the budget is spent the
resume is refused, the run keeps waiting, and the card says why. The goal report lists each question a run
continued past, with the wait and the assumption reported.

### H4 — One queue per goal version

Cards are listed per goal version. Within a version, those blocking it (a paused run, `needs_human`) come first.
Cards on one subject — the same question, task, package or file — merge into one card. Situations that need no
decision (for example a worker's note that a vendor key is a placeholder) are written to the activity feed and the
report, not raised as cards. The Simple-mode strip and Home read the same queue; a one-click approve is not offered
on an answer card with no draft. No push or e-mail notification in this spec; the sidebar count shows the blocking
cards separately.

## 4. Errors and safety

- A decision claims its card conditionally; if the question was closed or the card resolved meanwhile, nothing is
  written and the person sees who resolved it and when.
- **Give a file to a package** runs under the goal delivery lock, only while the version is integrating with no
  smoke or verification claim and the target package has no running run. It is refused, with the reason, on
  overlap, a split manifest family, or a version being verified. A refused decision does not close the question.
- A person's hand-off follows the hand-off rules unchanged (dedup, reopen cap, expiry), idempotent by
  `person:<cardId>:0`. A person's shared decision is bound by the same cap and title uniqueness as the
  conductor's.
- A timeout and an answer in the same tick: one resume wins by claim; the other becomes a hand-off.
- Text a person writes reaches a worker's prompt bounded, stripped of control characters, under its own
  "from the operator" heading (distinct from the hand-off block's "not from the operator" line). The web renders
  every string as plain text. Every decision goes through the existing authorisation.
- Cards open before this spec keep working; approving or rejecting them now closes their question. A question with
  no `closedAt` follows today's rule.

## 5. Testing

- Unit: close reasons; each decision's validation (ownership overlap, manifest family, decision cap); the card
  grouping key.
- Integration: each decision closes its question and no new card appears after the cooldown (OBS-9); an answer
  given directly retires the cards; a timeout resumes the run with the message and a later answer becomes a
  hand-off; after **give a file**, the next run's gate enforces the new ownership; one card per question.
- Web: the decision forms, the grouped queue, no one-click approve on a draftless answer card.
- End to end (fake CLI): the observed integration question — the person gives core-domain the start-script work;
  core-domain is reopened; the version passes its smoke.
- Gates: m56a counts if the event or situation sets move.

## 6. Out of scope

Push and e-mail notifications; cross-package review after integration; requirement-extraction stability; staffing
and parallelism; workers' own use of host Docker.
