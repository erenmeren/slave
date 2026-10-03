# Human cards, Plan A of 2: a question closes, a wait has an end

> **For workers carrying this out:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship spec H1 and H3. A question (`SlaveMessage` of kind `question`) can be closed, with a reason (`answered | decided | dismissed | timed_out | superseded`), a time, who closed it and the note its asker continues with. A closed question is never pending again: not in the Supervisor's world, not in the inbox, not in the answer box. An answer, an approval, a rejection and an expired card each close the question of the card, and every other open card about that question is retired, so OBS-9 (three cards for one question) cannot recur. A question has at most one open card. A run paused on an unanswered question for longer than the project's question timeout (default 2 hours, 15 minutes to 72 hours, set through the existing limits path) continues on its own best judgement. Its question closes `timed_out`, and its card stays open, marked "continued without an answer". An answer that arrives after that becomes a hand-off to the asking package. When the workspace is halted or the budget is spent, the run keeps waiting and the card says why. The goal report says how each question closed.

**Architecture:** One migration adds the close columns to `SlaveMessage`, `Workspace.questionTimeoutMs`, the `person` hand-off source and one event (`slave.question_closed`), and closes the questions Plan B's C5 filter already treats as settled. A new control module, `packages/control/src/questions.ts`, owns closing (`closeQuestionIn`, `closeQuestion`), the event, retiring cards (`retireQuestionCards`, `retireClosedQuestionCards`) and the card's question read (`loadQuestionCards`). `stillPendingQuestion` gains `closedAt: null`, which is how every reader (the world, the inbox, the answer box, re-addressing) learns the rule. The C5 decided-set in `dropUnusableReportQuestions` is deleted: the verbs that settled a question now close it. Pure rules live in `packages/domain/src/messaging/close.ts` (the reasons, the bounds) and `packages/domain/src/supervisor/cards.ts` (the card key, the resume messages, the late-answer text). The orchestrator gains one tick pass, `continueWaitingRuns` (`apps/orchestrator/src/questionTimeout.ts`), after `deliverAnswers`, and the goal pass gains `routeLateAnswers` beside `routeStoredHandOffs`. Plan B adds the decisions a card offers (H2) and the per-version queue (H4).

**Tech Stack:** TypeScript monorepo (npm workspaces, ESM, `.js` import suffixes), Prisma/Postgres, vitest, Next.js (`apps/web`).

**Spec:** `docs/superpowers/specs/2026-10-01-human-cards-design.md` (H1, H3, §4, §5). Motivation: `/home/meren/slaveofai-logs/observations.md` (OBS-8, 9, 14, 18). **Requires** `feature/human-cards` at `653d9652` (main `08ddcdde`: skeleton-and-smoke A+B, Supervisor-as-conductor A+B). **Plan B** (`2026-10-01-human-cards-b.md`) depends on this plan's `closeQuestionIn`, `announceQuestionClosed`, `retireQuestionCards`, `QuestionCard`, `loadQuestionCards`, `continueWaitingRuns`, `PERSON_CARD_TEXT_MAX_CHARS`, `personText` and the `person` hand-off source.

## Decisions this plan makes (read before starting)

- **D1. Closing is five columns on `SlaveMessage`, and the first close wins.** `closedAt TIMESTAMP(3)?`, `closedReason QuestionCloseReason?` (a new Postgres enum `answered | decided | dismissed | timed_out | superseded`), `closedBy TEXT?` (a user id, `operator` for a person with no account (the CLI), or `system`), `closedNote TEXT?` (≤ 4000 characters: what the asker is told when its run continues; null for `answered`), and `timeoutRefusal TEXT?` (why the timeout pass could not continue the run, cleared once it does). Every close is one `updateMany ... where closedAt IS NULL`, so two closers race to one winner and the loser writes nothing. A question with `closedAt` null follows today's rule (spec §4). *Cost if wrong:* a reason that should overwrite an earlier one (a late answer after a timeout) does not. The report shows the first close, and the late answer is routed as a hand-off (D9) and shown in the report's answer line.
- **D2. One open card per question, by a dedup in `recordDecision`, with no new column.** Every question situation kind (`waiting_stale`, `unanswerable_question`, `conductor_question`, now `QUESTION_SITUATION_KINDS`) already uses the message id as its `subjectId`. `recordDecision`'s open-card check therefore reads `(workspaceId, subjectId, situationKind IN QUESTION_SITUATION_KINDS, status pending)` for those kinds, and `(workspaceId, situationKind, subjectId)` for the rest. `filterFresh` does the same: a pending card on a question holds every question kind of it. `recordDecision` also refuses `question_closed` for a closed question, and its cooldown now honours `COOLDOWN_BY_KIND` as `filterFresh` does (the mismatch noted at `supervisor.ts:217`). **Effect on existing rows:** none written. A question that already has two open cards (a `conductor_question` and a `waiting_stale`, possible before this plan) keeps both until one is resolved. Resolving it closes the question, and `retireQuestionCards` expires the other. While such an old card is open it holds its question, so the conductor batch does not take it. The timeout (D7) still ends a parked run's wait. *Cost if wrong:* a future question kind whose subject is not the message id would be deduped wrongly. `QUESTION_SITUATION_KINDS` is the one list such a kind must join or stay out of.
- **D3. `waiting_stale` is no longer raised for a question to the conductor.** Plan B D2 raised it beside `conductor_question` only to make a parked run visible. With one card per question, it would either be refused (and a later conductor draft lost to its open card) or merged. Two things now make a parked conductor question visible: the timeout (D7), and the batch's own escalation after three failed calls. A `waiting_stale` for a question to anyone else is unchanged (it never coexists with `unanswerable_question`: `observe` raises one or the other). Old open `waiting_stale` cards on conductor questions are retired when their question closes (D5). *Cost if wrong:* a parked conductor question whose batch keeps succeeding with a `proposed` answer shows one card, the `conductor_question` one, which is the card that carries the draft.
- **D4. The C5 filter is replaced by closing, and the migration closes what it already hid.** Every status the C5 decided-set counted as settled now closes the question when it happens: an applied or approved answer (`answerQuestion`, reason `answered`), an approved escalation or other non-answer action (`decided`, except `reassign_question`, which moves the question to somebody who can answer it), a rejection (`dismissed`, with the person's reason), and an expiry (`timed_out`). `failed`, `noop` and `pending` close nothing, as C5 left them pending. The migration backfills `decided` for the rows the C5 predicate hides today (a conductor report question of a `done` task with a settled decision and no answer), so nothing that is hidden today reappears. The decided-set and its query (`supervisorWorld.ts:819-846`) are deleted. The Plan 4b D13 part of `dropUnusableReportQuestions` (failed or cancelled task, accepted or abandoned version) is not C5 and stays. *Cost if wrong:* a pre-migration settled decision whose task was not `done` at migration time stays pending until a person decides it again. That is one card, and the decision closes the question.
- **D5. Retiring cards.** `retireQuestionCards(workspaceId, messageId, reason, now, except)` expires every pending card of a question kind about one message, except the card being resolved (the generalisation of `retireAnsweredWaitingStale`, which is deleted and whose two callers move to it). Card verbs call it directly. A tick backstop, `retireClosedQuestionCards`, runs right after `expirePendingDecisions` and retires every pending question card whose question is closed for any reason but `timed_out`. That covers every other path: the web answer box, the CLI `answer`, the Supervisor's own applied answer. A `timed_out` question's card stays open (spec H3). Expired, not rejected: nobody decided against the card. The situation ended, as `retireAnsweredWaitingStale` already ruled.
- **D6. An answer closes the question, and a closed question refuses an answer, except after a timeout.** `answerQuestion` closes the question `answered` in the transaction that writes the answer. `closedBy` is the principal's user id, `operator` for a person with none, and `system` for the Supervisor. Inside the same transaction, before anything is written, it refuses `question_closed` (naming the reason, who and when) for a question closed `decided`, `dismissed` or `superseded`. An `answered` question takes a second answer as today (a second human answer was always allowed, and `deliverAnswers` supersedes the loser). A `timed_out` question takes a late answer (D9). Its reason stays `timed_out`.
- **D7. The timeout pass runs after `deliverAnswers` and claims by the question row.** `continueWaitingRuns(workspaceId, now)` takes every run that is `paused`, `waiting_for_answer`, with no resume requested and no stop, and its latest question (`deliverToOneRun`'s match). It skips the run when the task check fails or when any answer to the question exists (the answer is `deliverAnswers`'s to deliver). An open question older than `Workspace.questionTimeoutMs` is measured from `SlaveRun.pausedAt`, falling back to the question's `createdAt`. Under `SELECT ... FOR UPDATE` on the question row, the mutex `claimTheAnswer` takes, the pass re-checks for an answer and closes the question `timed_out` with the resume message as `closedNote`. Then, for every question closed with a reason other than `answered` (a timeout, and Plan B's dismissals and decisions), it calls `requestResume` with `closedNote` and a new option, `onlyIfNotRequested`, whose claim adds `resumeRequestedAt: null`. `deliverAnswers` passes the same option. So when a timeout and an answer meet in one window, exactly one intent is written and the other is refused `resume_already_requested`. A refused answer is un-claimed (today's code) and becomes a late answer (D9). A halted workspace or a spent budget refuses the resume: the run keeps waiting, the refusal's text is stored on `timeoutRefusal`, and the next tick tries again. Wired in both tick branches, beside `deliverAnswers`. *Cost if wrong:* a run that an operator had asked to resume by hand (an intent already standing) is not given the timeout message. Its intent wins, as it should.
- **D8. The resume message is the spec's sentence, plus the question.** "No answer came in 2 hours. Continue on your safest assumption, and say in your report which assumption you made." follows a blank line and "You asked:" with the question (bounded, sanitised), like `deliverAnswers`'s own `resumePrompt`. The duration reads in hours and minutes (`formatWait`).
- **D9. A late answer becomes a hand-off to the asking package, routed by the goal pass.** `routeLateAnswers(deliveryId)`, called at the end of `routeStoredHandOffs`, routes every answer that never woke anyone to the asking package. Such an answer is undelivered and not superseded, its question is closed `timed_out`, and its asking run is no longer parked on it. The routing source is `person` for a human answer and `answer` otherwise. The source key is `late:<answerId>` (one item, `late:<answerId>:0`, the replay guard), `fromRunId` is the asking run, `fromPackageKey` is null (so the asker's own package is a real target), and the change is `lateAnswerChange(question, answer)`. A package that is still running reads it in its next prompt, and a finished one is reopened (Plan A of supervisor-as-conductor, D4). The source enum gains `person` in this plan's migration, because the late human answer is its first writer. Plan B's person hand-offs are its second. A question with no package (planned delivery) keeps the answer in its thread, as today.
- **D10. A person's words reach a worker's prompt under their own heading.** `HandOffView` gains `fromOperator`, set for `source = person`. `renderAskedOfYou` and `renderHandOffRework` put operator items first under "From the operator (a person decided this on a card; do it in your own files):", then the workers' items under the existing `HANDOFF_TRUST_LINE`. A worker-only block is byte-identical to today's. Each operator item's line reads "from the operator". `personText` bounds, strips C0 controls and sanitises every person string (`storableText`, then `sanitisePersonText`, then `trimToFit`).
- **D11. One event, `slave.question_closed`.** Payload `{ messageId, reason, by, decisionId|null, note ≤ 500|null }`, envelope `taskId` and `slaveId` the question's own, actor `human` for a person's close and `system` otherwise. Lane `work`. Its activity card says how the question closed, and the report trail reads it. `LANE_BY_TYPE` goes from 76 to 77, and m56a stage 12 follows. `workspace.settings_changed.field` gains `questionTimeoutMs`. `workspace.package_handed_off.source` gains `person`. No situation kind and no action kind change (25 / 25).
- **D12. The question timeout is a fourth dispatch limit.** `WorkspaceLimitField` gains `questionTimeoutMs`, bounds 15 to 4320 minutes, a whole number of minutes. `QUESTION_TIMEOUT_DEFAULT_MS = 7_200_000` is the column default. `setWorkspaceLimits`, the `/limits` route, `set-limits --question-timeout-min` and the Runtime panel all take it. A raised timeout reaches every waiting run on the next tick.
- **D13. The card knows its question.** `DecisionView` gains an optional `card: QuestionCard | null` for the question kinds, read in one batch by `listDecisions` (`loadQuestionCards`). The card holds the question, its version and package, whether the asker is still parked, the close, and `timeoutRefusal`. `ProposalRow` shows "continued without an answer after 2 hours: a decision now reaches the <pkg> package as a hand-off", or "the wait is over, but the run cannot continue: <refusal>". Plan B grows `QuestionCard` with the version's packages and the decisions offered.
- **Left out on purpose:** the decisions a card offers (Plan B: give work, give a file, record a shared decision, change a requirement, write my own answer, dismiss with a reason through one decide route); the per-version queue and its grouping, the blocking count and the one-click guard (Plan B); worker notes (Plan B).

## Global Constraints

- Vocabulary: the product says "slave", never "agent" (`node scripts/gate-m26-vocabulary.mjs`). Never write the external persona catalogue's repository name anywhere tracked (`git grep -nE "agency-agent[s]"` prints nothing).
- Never run prettier. The repository has no prettier config, and `prettier --write` reformats against the codebase's style. Match surrounding code: WHY doc comments, `readonly`, explicit return types, `.js` import suffixes (not in `apps/web`), `Result`/`ok`/`err`. `packages/control` does not depend on zod: validate with the domain's exported schemas.
- Tests: `set -a; . ./.env; set +a; export DATABASE_URL=$TEST_DATABASE_URL` in the shell first. That export also applies to any scratch Prisma script: a script's `PrismaClient` reads `DATABASE_URL`, which is the dev DB unless exported. Any `prisma migrate diff` passes the database URL explicitly (`--from-url "$TEST_DATABASE_URL"`), never the dev DB. Run ONE vitest process at a time, and stop any daemon first: concurrent runs TRUNCATE each other's tables, and a running daemon breaks `subscribe.test.ts`. Iterate per file. Run `npx tsc --build` after changing a package another package's test imports. Run `npm run typecheck` before every commit, not `tsc --build`: the script also checks every `tsconfig.test.json` and `apps/web`. Run the whole suite once, at the end, in the background.
- `apps/web` changes gate on `npm run web:build`, with no `next dev` running, then `rm -rf apps/web/.next`. Tasks 1, 5 and 8 change `apps/web`.
- Never touch the dev DB. Never `db:seed`. Gates run only on `DATABASE_URL="$GATE_DATABASE_URL"`, with the fake-CLI env exactly as `.github/workflows/ci.yml` sets it (`SLAVEOFAI_CLAUDE_BIN`/`SLAVEOFAI_CURSOR_BIN` from `scripts/gate-fakes`, `SLAVEOFAI_REQUIRE_FAKE_CLI=1`), with the host daemon stopped, under `systemd-inhibit --what=sleep:idle`. Red on main today, not regressions: m44 m46 m47 m48 m49 m50 m52 m54 m55 m57 m58.
- Migrations: hand-written, purely additive in schema (the one data statement is the D4 backfill, marked), WHY header, dated name; `npm run db:generate && npm run db:migrate:test`. The schema must mirror the SQL exactly, or m56a stage 12's `prisma migrate diff` fails.
- Inside a Prisma interactive transaction a refusal must THROW to roll back; a returned value commits what was written. A refusal returned before the first write is safe, and each such site says so.
- `vi.spyOn` on a Prisma delegate breaks later tests: assign a wrapper and restore it in `finally`.
- Never `TRUNCATE "SlaveTemplate" CASCADE` in a test; delete your own template rows by id.
- The hook plane (`scripts/pause-gate.sh`, `scripts/cursor-shell-gate.sh`, `scripts/tool-result-tap.sh`, `scripts/lib/pause-flag.sh`, `scripts/lib/permissions.sh`) does not change. This plan adds one event type (`LANE_BY_TYPE` 76 → 77) and no situation or action kind (25 / 25).
- Every commit message ends with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Spec H1 verbatim: "`SlaveMessage` gains `closedAt`, `closedReason` (`answered` | `decided` | `dismissed` | `timed_out` | `superseded`) and `closedBy` (a user id or `system`). `stillPendingQuestion` treats a closed question as not pending".
- Spec H1 verbatim: "A question closed by any path (an answer, the answer box, a timeout, a dismissal) retires every open card about it. A question has at most one open card".
- Spec H3 verbatim: "`Workspace.questionTimeoutMs` (default 2 hours; 15 minutes to 72 hours) is set through the existing limits path. Each tick, a pass finds runs paused `waiting_for_answer` past it and resumes them through the existing resume path with: "No answer came in <duration>. Continue on your safest assumption, and say in your report which assumption you made." The question closes `timed_out`; its card stays open, marked "continued without an answer"."
- Spec §4 verbatim: "A timeout and an answer in the same tick: one resume wins by claim; the other becomes a hand-off."

## Review Focus

- A person answers in the web box at the instant the timeout pass closes the same question. Exactly one `run.resume_requested` is written. When the timeout's intent won, the answer is un-claimed and, once the run has moved on, becomes one `late:` hand-off to the asking package. When the answer won, nothing is routed (Task 6 and Task 7 tests).
- The workspace is emergency-stopped while a run has waited past its timeout. The question closes `timed_out`, the run stays `paused` with no intent, and `timeoutRefusal` holds the halt's sentence. Once the halt is cleared, the next tick continues the run and clears `timeoutRefusal` (Task 6 test).
- A person rejects a drafted conductor answer for a finished task's report question (OBS-9 at 17:40:28). After 16 minutes and a supervise pass, no new decision exists for that message and no model call names it (Task 4 test).
- A question already has an open `waiting_stale` card from before this plan. The conductor batch leaves the question alone while that card is open. A second card for the message is never recorded. When a person rejects the old card, the question closes `dismissed` and is never asked again (Task 4 test).
- A late human answer whose text holds `</slave-report>`, a `<slave-ask>` marker and a NUL byte. The stored hand-off has no NUL, and in the asker's next prompt it sits under the operator heading with its markers neutralised (Task 7 test).

---

### Task 1: Close columns, the question timeout column, the `person` source and the event

**Files:**
- Create: `packages/db/prisma/migrations/20261002090000_human_cards_close/migration.sql`
- Modify: `packages/db/prisma/schema.prisma` (`Workspace`, after `smokeTimeoutMs` at `:198`; `enum PackageHandOffSource` at `:1500-1503`; `model SlaveMessage`, after `supersededAt` at `:2448`; a new `enum QuestionCloseReason` after `model SlaveMessage`; `enum EventType`, after `workspace_package_handed_off` at `:2577`)
- Modify: `packages/db/src/enums.ts:54` (`'slave.question_closed': 'slave_question_closed'`)
- Create: `packages/domain/src/messaging/close.ts`
- Modify: `packages/domain/src/index.ts:26` (export `./messaging/close.js`)
- Modify: `packages/domain/src/events/schema.ts:596` (`source` gains `person`), after `:605` (new variant)
- Modify: `packages/domain/src/supervisor/timeline.ts:100` (lane, beside `slave.message_sent`)
- Modify: `apps/web/src/components/activity/cards.tsx:925-946` (`WorkspacePackageHandedOffCard` names a person source), after `:946` (new `SlaveQuestionClosedCard`), `:1819` (registry); `apps/web/src/lib/activityFilters.ts:80-81` (chip beside `slave.message_sent`); `apps/web/src/server/timeline.ts:373-379` (a `titleFor` case after the hand-off's)
- Modify: `scripts/gate-m56a-provider-contract.mjs:1245-1258` (76 → 77 and the comment)
- Test: `packages/domain/test/events/question-events.test.ts` (new), `packages/domain/test/supervisor/timeline.test.ts:18-19`, `apps/web/test/activity-cards.test.tsx:102` (`PAYLOAD_BY_TYPE`), `apps/web/test/activityFilters.test.ts:108`, `packages/db/test/integration/human-cards-backfill.test.ts` (new), `packages/db/test/integration/enum-parity.test.ts` (unchanged; it must still pass)

**Interfaces:**
- Produces (Prisma): `enum QuestionCloseReason { answered decided dismissed timed_out superseded }`; `SlaveMessage.closedAt DateTime?`, `closedReason QuestionCloseReason?`, `closedBy String?`, `closedNote String?`, `timeoutRefusal String?`; `Workspace.questionTimeoutMs Int @default(7200000)`; `PackageHandOffSource.person`.
- Produces (domain, `messaging/close.ts`): `QUESTION_CLOSE_REASONS`, `type QuestionCloseReason`, `CLOSED_BY_SYSTEM = 'system'`, `CLOSED_BY_OPERATOR = 'operator'`, `CLOSED_NOTE_MAX_CHARS = 4000`, `QUESTION_CLOSED_EVENT_NOTE_MAX_CHARS = 500`, `PERSON_CARD_TEXT_MAX_CHARS = 2000`.
- Produces (event): `slave.question_closed { messageId: string, reason: QuestionCloseReason, by: string(1..200), decisionId: string|null, note: string ≤ 500 | null }`; `workspace.package_handed_off.payload.source: 'report'|'answer'|'person'`.

- [ ] **Step 1: Migration**

```sql
-- Human-cards spec H1/H3, plan A (2026-10-02): a question closes, and a wait has an end.
--
-- `SlaveMessage` gains its close: when, why (`QuestionCloseReason`), by whom (a user id,
-- `operator`, or `system`), and the note its asker continues with. `stillPendingQuestion` reads
-- `closedAt IS NULL`, so a closed question is pending nowhere. `timeoutRefusal` is why the timeout
-- pass could not continue a run (a halt, a spent budget), shown on the card until it can.
--
-- `Workspace.questionTimeoutMs` is how long a run waits on an unanswered question before it
-- continues on its own judgement (2 hours; 15 minutes to 72 hours, `WORKSPACE_LIMIT_BOUNDS`).
--
-- `PackageHandOffSource.person`: an answer that arrived after its run continued is routed to the
-- asking package as a person's hand-off (plan A D9); plan B's card decisions are the next writers.
--
-- PURELY ADDITIVE in schema: one enum type, five nullable columns, one defaulted column, two enum
-- values unused inside this transaction. ONE data statement, between the BACKFILL markers: it closes
-- the questions Supervisor-as-conductor plan B's C5 filter hides today (plan A D4), so deleting that
-- filter brings none of them back.

CREATE TYPE "QuestionCloseReason" AS ENUM ('answered', 'decided', 'dismissed', 'timed_out', 'superseded');

ALTER TABLE "SlaveMessage"
    ADD COLUMN "closedAt"       TIMESTAMP(3),
    ADD COLUMN "closedReason"   "QuestionCloseReason",
    ADD COLUMN "closedBy"       TEXT,
    ADD COLUMN "closedNote"     TEXT,
    ADD COLUMN "timeoutRefusal" TEXT;

ALTER TABLE "Workspace" ADD COLUMN "questionTimeoutMs" INTEGER NOT NULL DEFAULT 7200000;

ALTER TYPE "PackageHandOffSource" ADD VALUE IF NOT EXISTS 'person';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'slave.question_closed';

-- BACKFILL BEGIN
UPDATE "SlaveMessage" m
SET "closedAt" = CURRENT_TIMESTAMP,
    "closedReason" = 'decided',
    "closedBy" = 'system',
    "closedNote" = 'Closed when human cards shipped: a decision had already settled this question.'
WHERE m.kind = 'question'
  AND m."closedAt" IS NULL
  AND m."recipientRole" = 'conductor'
  AND m."senderRunId" IS NOT NULL
  AND m."idempotencyKey" LIKE 'send:report:%'
  AND NOT EXISTS (SELECT 1 FROM "SlaveMessage" a WHERE a."replyToId" = m.id AND a.kind = 'answer')
  AND EXISTS (SELECT 1 FROM "Task" t WHERE t.id = m."taskId" AND t.status = 'done')
  AND EXISTS (
    SELECT 1 FROM "SupervisorDecision" s
    WHERE s."workspaceId" = m."workspaceId"
      AND s."subjectId" = m.id
      AND s."situationKind" IN ('conductor_question', 'unanswerable_question', 'waiting_stale')
      AND s.status NOT IN ('failed', 'pending')
      AND s.tier <> 'noop'
  );
-- BACKFILL END
```

- [ ] **Step 2: Schema.** In `model Workspace`, after `smokeTimeoutMs`:

```prisma
  /// Human-cards spec H3 (plan A D12): how long a run paused on an unanswered question waits before it
  /// continues on its own judgement -- 2 hours; 15 minutes to 72 hours (`WORKSPACE_LIMIT_BOUNDS`).
  questionTimeoutMs Int @default(7200000)
```

`enum PackageHandOffSource { report answer person }`, with `person` documented: "Human-cards plan A D9 / plan B: a person's decision on a card -- a late answer, or work given to a package."

In `model SlaveMessage`, after `supersededAt`:

```prisma
  /// Human-cards spec H1 (plan A D1): when this question stopped waiting. Null is open, and a
  /// question with no close follows the pre-H1 rule. The first close wins (`updateMany where
  /// closedAt IS NULL`). Null on every row that is not a question.
  closedAt         DateTime?
  closedReason     QuestionCloseReason?
  /// A user id, `operator` (a person with no account to name), or `system`.
  closedBy         String?
  /// What the asker is told when its run continues (`timed_out`, `dismissed`, `decided`,
  /// `superseded`); null for `answered`, whose answer is what it is told.
  closedNote       String?
  /// Plan A D7: why the timeout pass could not continue the asking run (a halt, a spent budget);
  /// cleared once it does.
  timeoutRefusal   String?
```

After `model SlaveMessage { ... }`:

```prisma
/// Human-cards spec H1: why a question stopped waiting.
enum QuestionCloseReason {
  answered
  decided
  dismissed
  timed_out
  superseded
}
```

`enum EventType`, after `workspace_package_handed_off`:

```prisma
  slave_question_closed          @map("slave.question_closed")
```

Run `npm run db:generate && npm run db:migrate:test`.

- [ ] **Step 3: Domain constants.** Create `packages/domain/src/messaging/close.ts`:

```ts
/**
 * Human-cards spec H1: how a question stops waiting. A leaf module (no imports), because the event
 * schema reads the reasons and must not import the Supervisor's modules to do it.
 */

/** Why a question was closed. The first close wins (plan A D1). */
export const QUESTION_CLOSE_REASONS = ['answered', 'decided', 'dismissed', 'timed_out', 'superseded'] as const
export type QuestionCloseReason = (typeof QUESTION_CLOSE_REASONS)[number]

/** `closedBy` for a close nobody made by hand: a timeout, an expiry, the Supervisor's own answer. */
export const CLOSED_BY_SYSTEM = 'system'
/** `closedBy` for a person with no account to name (the CLI acts with no session). */
export const CLOSED_BY_OPERATOR = 'operator'

/** Bounds `SlaveMessage.closedNote`, the turn a continued run opens with. */
export const CLOSED_NOTE_MAX_CHARS = 4000
/** Bounds the note `slave.question_closed` carries. */
export const QUESTION_CLOSED_EVENT_NOTE_MAX_CHARS = 500
/** Bounds every free text a person writes on a card: an answer, a reason, a request. */
export const PERSON_CARD_TEXT_MAX_CHARS = 2000
```

Add `export * from './messaging/close.js'` to `packages/domain/src/index.ts` after `./messaging/answer.js`.

- [ ] **Step 4: Failing tests.** Create `packages/domain/test/events/question-events.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { executionEventSchema } from '../../src/events/schema.js'
import { LANE_BY_TYPE } from '../../src/supervisor/timeline.js'

const BASE = { seq: 1, ts: '2026-10-02T09:00:00.000Z', workspaceId: 'w1', taskId: 't1', slaveId: 's1', actor: 'human' } as const
const closed = (payload: object) => executionEventSchema.safeParse({ ...BASE, type: 'slave.question_closed', payload }).success

describe('slave.question_closed (human cards H1)', () => {
  it('reads a close with every reason, and a null decision and note', () => {
    for (const reason of ['answered', 'decided', 'dismissed', 'timed_out', 'superseded']) {
      expect(closed({ messageId: 'm1', reason, by: 'u1', decisionId: null, note: null })).toBe(true)
    }
  })

  it('refuses an unknown reason and a note over 500 characters', () => {
    expect(closed({ messageId: 'm1', reason: 'forgotten', by: 'u1', decisionId: null, note: null })).toBe(false)
    expect(closed({ messageId: 'm1', reason: 'dismissed', by: 'u1', decisionId: 'd1', note: 'x'.repeat(501) })).toBe(false)
  })

  it('reads a person as a hand-off source', () => {
    const payload = { version: 1, handOffId: 'h1', source: 'person', fromPackage: null, toPackage: 'skeleton', path: null, package: 'skeleton', delivery: 'rework', change: 'add a start script' }
    expect(executionEventSchema.safeParse({ ...BASE, type: 'workspace.package_handed_off', payload }).success).toBe(true)
  })

  it('files the close on the work lane', () => {
    expect(LANE_BY_TYPE['slave.question_closed']).toBe('work')
  })
})
```

(`executionEventSchema` is what `conductor-events.test.ts` parses with.) In `packages/domain/test/supervisor/timeline.test.ts:18-19` raise the expected count from 76 to 77. In `apps/web/test/activity-cards.test.tsx`'s `PAYLOAD_BY_TYPE` add `'slave.question_closed': { messageId: 'm1', reason: 'timed_out', by: 'system', decisionId: null, note: 'No answer came in 2 hours.' }`. In `apps/web/test/activityFilters.test.ts:108`'s list add `'slave.question_closed'` beside `slave.message_sent`.

Create `packages/db/test/integration/human-cards-backfill.test.ts`. It runs the migration's own BACKFILL statement on seeded rows, so the SQL that shipped is the SQL that is tested:

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { prisma } from '../../src/client.js'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

const SQL = readFileSync(fileURLToPath(new URL('../../prisma/migrations/20261002090000_human_cards_close/migration.sql', import.meta.url)), 'utf8')
const BACKFILL = SQL.slice(SQL.indexOf('-- BACKFILL BEGIN') + '-- BACKFILL BEGIN'.length, SQL.indexOf('-- BACKFILL END'))

afterAll(async () => {
  await prisma.$disconnect()
})

describe('the C5 backfill (human cards plan A D4)', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "SupervisorDecision", "SlaveMessage", "SlaveRun", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE')
  })

  it('closes a done task\'s settled conductor report question, and nothing else', async () => {
    const ws = await prisma.workspace.create({ data: { name: 'Backfill', repoPath: '/x', verifyCommands: ['true'], setupCommands: [] } })
    const team = await prisma.team.create({ data: { workspaceId: ws.id, name: 'E' } })
    const seat = await prisma.slave.create({ data: { teamId: team.id, role: 'Implementer', runtimeRoles: ['implementer'], personId: (await prisma.person.create({ data: { name: 'Ivo' } })).id } })
    const task = async (status: 'done' | 'rework') => (await prisma.task.create({ data: { workspaceId: ws.id, title: status, description: 'x', status, requiredRole: 'implementer', maxAttempts: 3 } })).id
    const done = await task('done')
    const live = await task('rework')
    let n = 0
    const question = async (taskId: string) => {
      const run = await prisma.slaveRun.create({ data: { slaveId: seat.id, taskId, status: 'succeeded' } })
      n += 1
      return (await prisma.slaveMessage.create({ data: { id: `q${String(n)}`, threadId: `q${String(n)}`, workspaceId: ws.id, taskId, slaveId: seat.id, senderRunId: run.id, recipientRole: 'conductor', kind: 'question', body: 'which?', expectsReply: true, idempotencyKey: `send:report:${run.id}:0`, actor: 'slave' } })).id
    }
    const decide = (subjectId: string, status: 'rejected' | 'pending' | 'failed') =>
      prisma.supervisorDecision.create({ data: { workspaceId: ws.id, situationKind: 'conductor_question', subjectId, situation: {}, candidates: [], chosenIndex: 0, action: { kind: 'escalate_to_human', summary: 'x' }, rationale: 'x', tier: 'escalated', status, decidedBy: 'rules' } })
    const settled = await question(done)
    const pending = await question(done)
    const failed = await question(done)
    const running = await question(live)
    const undecided = await question(done)
    await decide(settled, 'rejected')
    await decide(pending, 'pending')
    await decide(failed, 'failed')
    await decide(running, 'rejected')
    await prisma.$executeRawUnsafe(BACKFILL)
    const closed = await prisma.slaveMessage.findMany({ where: { closedAt: { not: null } }, select: { id: true, closedReason: true, closedBy: true } })
    expect(closed).toEqual([{ id: settled, closedReason: 'decided', closedBy: 'system' }])
    expect(undecided).toBeDefined()
  })
})
```

Run `npx vitest run packages/domain/test/events/question-events.test.ts` → FAIL (unknown type).

- [ ] **Step 5: Event schema.** In `packages/domain/src/events/schema.ts` import `QUESTION_CLOSE_REASONS` from `'../messaging/close.js'`. At `:596` write `source: z.enum(['report', 'answer', 'person']),`. After the `workspace.package_handed_off` variant:

```ts
  // Human-cards spec H1 (plan A D11): a question stopped waiting -- answered, decided on a card,
  // dismissed, past its timeout, or superseded by a new goal version. `by` is a user id, `operator`
  // or `system`; `note` is the head of what the asker continues with.
  z.object({
    ...envelope,
    type: z.literal('slave.question_closed'),
    payload: z.object({
      messageId: z.string().min(1),
      reason: z.enum(QUESTION_CLOSE_REASONS),
      by: z.string().min(1).max(200),
      decisionId: z.string().min(1).nullable(),
      // `QUESTION_CLOSED_EVENT_NOTE_MAX_CHARS`, spelled here the way this file spells every stored bound.
      note: z.string().max(500).nullable(),
    }),
  }),
```

`packages/db/src/enums.ts`: `'slave.question_closed': 'slave_question_closed',` after `'workspace.package_handed_off'`. `packages/domain/src/supervisor/timeline.ts`, after `'slave.message_sent': 'work',`:

```ts
  'slave.question_closed': 'work', // Human cards H1: a question stopped waiting, beside the message that answered it.
```

- [ ] **Step 6: Web.** In `apps/web/src/components/activity/cards.tsx`, in `WorkspacePackageHandedOffCard`, read `source: string` from the payload and write `const from = payload.source === 'person' ? 'a person' : (payload.fromPackage ?? 'the conductor')`. After it:

```tsx
const QUESTION_CLOSED_WORDS: Readonly<Record<string, string>> = {
  answered: 'answered',
  decided: 'decided on a card',
  dismissed: 'closed without an answer',
  timed_out: 'continued without an answer',
  superseded: 'superseded by a new goal version',
}

/** Human cards H1: a question stopped waiting. `note` is what the asker was told, quoted as a child. */
function SlaveQuestionClosedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { reason: string; by: string; note: string | null }
  const who = payload.by === 'system' ? 'Slave' : 'a person'
  return (
    <ActivityCard {...props}>
      <Transition tone={payload.reason === 'timed_out' ? 'warn' : 'working'} label={`question ${QUESTION_CLOSED_WORDS[payload.reason] ?? payload.reason} (${who})`}>
        {payload.note !== null && <span data-testid="question-closed-note">{payload.note}</span>}
      </Transition>
    </ActivityCard>
  )
}
```

Add `'slave.question_closed': SlaveQuestionClosedCard,` to the registry at `:1819`. `apps/web/src/lib/activityFilters.ts`: add `'slave.question_closed',` after `'slave.message_reassigned',`. `apps/web/src/server/timeline.ts`, after the `workspace.package_handed_off` case:

```ts
    // Human cards H1: a question stopped waiting.
    case 'slave.question_closed': {
      const reason = payload['reason']
      return `question ${typeof reason === 'string' ? reason.replace('_', ' ') : 'closed'}`
    }
```

- [ ] **Step 7: m56a.** In `scripts/gate-m56a-provider-contract.mjs` stage 12, append to the comment "Human-cards Plan A added one event, `slave.question_closed`." and change `76` to `77` in both the condition and the message.

- [ ] **Step 8: Run.** `npx vitest run packages/domain/test/events/question-events.test.ts packages/domain/test/supervisor/timeline.test.ts` → PASS. Then `npx vitest run packages/db/test/integration/human-cards-backfill.test.ts packages/db/test/integration/enum-parity.test.ts` → PASS, then `npx vitest run apps/web/test/activity-cards.test.tsx apps/web/test/activityFilters.test.ts` → PASS. Run `npm run typecheck`. Then run the drift check with the URL explicit: `npx prisma migrate diff --from-url "$TEST_DATABASE_URL" --to-schema-datamodel packages/db/prisma/schema.prisma --exit-code`, which prints no difference.

- [ ] **Step 9: Commit**

```bash
git add packages/db/prisma packages/db/src/enums.ts packages/db/test/integration/human-cards-backfill.test.ts packages/domain/src/messaging/close.ts packages/domain/src/index.ts packages/domain/src/events/schema.ts packages/domain/src/supervisor/timeline.ts packages/domain/test apps/web/src/components/activity/cards.tsx apps/web/src/lib/activityFilters.ts apps/web/src/server/timeline.ts apps/web/test scripts/gate-m56a-provider-contract.mjs
git commit -m "feat(db): a question can be closed, a project has a question timeout, and a person can be a hand-off source

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The rules: question cards, resume messages, the late answer, one card per question

**Files:**
- Create: `packages/domain/src/supervisor/cards.ts`
- Modify: `packages/domain/src/supervisor/index.ts` (export `./cards.js`)
- Modify: `packages/domain/src/supervisor/report.ts:6-8` (`QUESTION_KINDS` becomes the imported `QUESTION_SITUATION_KINDS`)
- Modify: `packages/domain/src/supervisor/observe.ts:465-472` (delete the conductor `waiting_stale`), `:843-856` (`filterFresh`)
- Test: `packages/domain/test/supervisor/cards.test.ts` (new), `packages/domain/test/supervisor/observe.test.ts:368-374` (rewritten), plus one new `filterFresh` case

**Interfaces:**
- Consumes: `CLOSED_NOTE_MAX_CHARS`, `PERSON_CARD_TEXT_MAX_CHARS` (Task 1); `storableText` (`conduct/storable.ts`), `trimToFit` (`conduct/verification.ts:66`), `sanitisePersonText` (`handoff/contract.ts`), `HANDOFF_CHANGE_MAX_CHARS` (`conduct/constants.ts`).
- Produces: `QUESTION_SITUATION_KINDS: readonly SituationKind[]`; `isQuestionSituation(kind: SituationKind): boolean`; `cardKey(kind: SituationKind, subjectId: string): string`; `personText(raw: string, max?: number): string`; `formatWait(ms: number): string`; `timeoutResumeMessage(waitedMs: number, question: string): string`; `dismissResumeMessage(reason: string | null): string`; `DECIDED_WITHOUT_ANSWER: string`; `lateAnswerChange(question: string, answer: string): string`.

- [ ] **Step 1: Failing tests.** Create `packages/domain/test/supervisor/cards.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  DECIDED_WITHOUT_ANSWER,
  QUESTION_SITUATION_KINDS,
  cardKey,
  dismissResumeMessage,
  formatWait,
  isQuestionSituation,
  lateAnswerChange,
  personText,
  timeoutResumeMessage,
} from '../../src/supervisor/cards.js'

describe('question cards (human cards H1)', () => {
  it('keys every question kind by the question, and every other kind by itself', () => {
    expect(QUESTION_SITUATION_KINDS).toEqual(['waiting_stale', 'unanswerable_question', 'conductor_question'])
    expect(cardKey('conductor_question', 'm1')).toBe('question:m1')
    expect(cardKey('waiting_stale', 'm1')).toBe(cardKey('conductor_question', 'm1'))
    expect(cardKey('task_failed', 't1')).toBe('task_failed:t1')
    expect(isQuestionSituation('task_failed')).toBe(false)
  })

  it('reads a wait the way a person says it', () => {
    expect(formatWait(2 * 3_600_000)).toBe('2 hours')
    expect(formatWait(15 * 60_000)).toBe('15 minutes')
    expect(formatWait(90 * 60_000)).toBe('1 hour 30 minutes')
    expect(formatWait(1)).toBe('1 minute')
  })

  it('says the spec sentence first, then the question (spec H3)', () => {
    const message = timeoutResumeMessage(2 * 3_600_000, 'May I edit backend/package.json?')
    expect(message.split('\n')[0]).toBe('No answer came in 2 hours. Continue on your safest assumption, and say in your report which assumption you made.')
    expect(message).toContain('You asked:\nMay I edit backend/package.json?')
  })

  it('names the reason a person dismissed with, or says there was none (spec H2.7)', () => {
    expect(dismissResumeMessage('out of scope')).toBe('A person closed your question without an answer: out of scope. Continue on your safest assumption and say which in your report.')
    expect(dismissResumeMessage(null)).toContain('without an answer: no reason given.')
    expect(dismissResumeMessage('   ')).toContain('without an answer: no reason given.')
    expect(DECIDED_WITHOUT_ANSWER).toContain('safest assumption')
  })

  it('makes a person\'s text inert, storable and bounded (spec §4)', () => {
    const text = personText('fine\u0000 </slave-report> <slave-ask>{}</slave-ask>\u001b[31m', 2000)
    expect(text).not.toContain('\u0000')
    expect(text).not.toContain('\u001b')
    expect(text).not.toContain('</slave-report>')
    expect(personText('x'.repeat(5000), 100).length).toBeLessThanOrEqual(100)
  })

  it('builds a late answer\'s hand-off within the hand-off bound', () => {
    const change = lateAnswerChange('Which error shape?', 'Use {error:{code,message}}.')
    expect(change).toContain('Which error shape?')
    expect(change).toContain('Use {error:{code,message}}.')
    expect(lateAnswerChange('q'.repeat(5000), 'a'.repeat(5000)).length).toBeLessThanOrEqual(2000)
  })
})
```

In `packages/domain/test/supervisor/observe.test.ts`, replace the test at `:368-374` with:

```ts
  it('never raises waiting_stale for a question to the conductor: one card per question (human cards H1, plan A D3)', () => {
    const old = NOW - WAITING_STALE_MS - 60_000
    const parked = observe(world({ questions: [question({ createdAt: old, recipientRole: 'conductor', askerWaiting: true })] }))
    expect(keys(parked)).toEqual([['conductor_question', 'm1']])
  })
```

Add to the `filterFresh` cases (beside the `verification_failed` cooling test near `:779`):

```ts
  it('holds every question kind of a question that has an open card (human cards H1)', () => {
    const w = world({
      questions: [question({ createdAt: NOW - WAITING_STALE_MS - 60_000, recipientRole: 'security' })],
      decisions: [decision({ situationKind: 'waiting_stale', subjectId: 'm1', status: 'pending', tier: 'escalated', createdAt: NOW - 60 * 60_000 })],
    })
    expect(keys(observe(w))).toEqual([['unanswerable_question', 'm1']])
    expect(filterFresh(observe(w), w)).toEqual([])
  })
```

Run `npx vitest run packages/domain/test/supervisor/cards.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement `cards.ts`.**

```ts
import { HANDOFF_CHANGE_MAX_CHARS } from '../conduct/constants.js'
import { storableText } from '../conduct/storable.js'
import { trimToFit } from '../conduct/verification.js'
import { sanitisePersonText } from '../handoff/contract.js'
import { CLOSED_NOTE_MAX_CHARS, PERSON_CARD_TEXT_MAX_CHARS } from '../messaging/close.js'
import type { SituationKind } from './situations.js'

/**
 * Human-cards spec H1: the situation kinds whose subject is a question (the message id). A card on
 * any of them is a card on that question, and a question has at most one open card (plan A D2).
 */
export const QUESTION_SITUATION_KINDS: readonly SituationKind[] = ['waiting_stale', 'unanswerable_question', 'conductor_question']

export function isQuestionSituation(kind: SituationKind): boolean {
  return QUESTION_SITUATION_KINDS.includes(kind)
}

/** The key a card is held under: the question for the question kinds, the situation key otherwise. */
export function cardKey(kind: SituationKind, subjectId: string): string {
  return isQuestionSituation(kind) ? `question:${subjectId}` : `${kind}:${subjectId}`
}

/**
 * Spec §4: text a person wrote, on its way to a worker's prompt or the record -- storable (no NUL,
 * no C0 control but tab and newline), defused (markers and routing literals), trimmed and bounded.
 */
export function personText(raw: string, max: number = PERSON_CARD_TEXT_MAX_CHARS): string {
  return trimToFit(sanitisePersonText(storableText(raw)).trim(), max)
}

/** A wait in hours and minutes, at least one minute: "2 hours", "1 hour 30 minutes". */
export function formatWait(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const parts = [
    ...(hours === 0 ? [] : [`${String(hours)} hour${hours === 1 ? '' : 's'}`]),
    ...(rest === 0 ? [] : [`${String(rest)} minute${rest === 1 ? '' : 's'}`]),
  ]
  return parts.join(' ')
}

/** Spec H3 (plan A D8): what a run continued past its question timeout is told. */
export function timeoutResumeMessage(waitedMs: number, question: string): string {
  return trimToFit(
    [
      `No answer came in ${formatWait(waitedMs)}. Continue on your safest assumption, and say in your report which assumption you made.`,
      '',
      'You asked:',
      personText(question, PERSON_CARD_TEXT_MAX_CHARS),
    ].join('\n'),
    CLOSED_NOTE_MAX_CHARS,
  )
}

/** Spec H2.7: what a run is told when a person dismissed its question. */
export function dismissResumeMessage(reason: string | null): string {
  const said = reason === null ? '' : personText(reason)
  return `A person closed your question without an answer: ${said === '' ? 'no reason given' : said}. Continue on your safest assumption and say which in your report.`
}

/** Plan A D4: what a run is told when a person approved a card that sends it no answer. */
export const DECIDED_WITHOUT_ANSWER =
  'A person read your question and settled it without an answer for you. Continue on your safest assumption and say which in your report.'

/** Plan A D9: the hand-off a late answer becomes, addressed to the package that asked. */
export function lateAnswerChange(question: string, answer: string): string {
  return trimToFit(
    [
      'Your package asked a question and continued on its own assumption when no answer came. The answer arrived later.',
      `Question: ${personText(question, 600)}`,
      `Answer: ${personText(answer, 1000)}`,
      'Check your work against the answer, and change what it changes.',
    ].join('\n'),
    HANDOFF_CHANGE_MAX_CHARS,
  )
}
```

Add `export * from './cards.js'` to `packages/domain/src/supervisor/index.ts`. In `report.ts`, delete the local `QUESTION_KINDS` and `import { QUESTION_SITUATION_KINDS } from './cards.js'`, then replace its uses (`grep -n QUESTION_KINDS packages/domain/src/supervisor/report.ts`).

- [ ] **Step 3: `observe` and `filterFresh`.** In `observe.ts`, delete the inner `if (question.askerWaiting && world.now - question.createdAt > WAITING_STALE_MS) { add({ kind: 'waiting_stale', ... }) }` at `:465-472`. Change the comment above it to: "Human cards plan A D3: a parked asker is not raised again as `waiting_stale`. The question has one card, and its wait ends at the project's question timeout." Rewrite `filterFresh`'s body:

```ts
  const key = (kind: SituationKind, subjectId: string): string => `${kind} ${subjectId}`
  const blocked = new Set<string>()
  // Human cards H1 (plan A D2): a question has at most one open card, whatever kind raised it.
  const openQuestions = new Set<string>()
  for (const decision of world.decisions) {
    const anchor = decision.resolvedAt ?? decision.createdAt
    const cooldownMs = COOLDOWN_BY_KIND[decision.situationKind] ?? COOLDOWN_MS
    const cooling = decision.status === 'pending' || world.now - anchor <= cooldownMs
    if (cooling) blocked.add(key(decision.situationKind, decision.subjectId))
    if (decision.status === 'pending' && isQuestionSituation(decision.situationKind)) openQuestions.add(decision.subjectId)
  }
  return situations.filter(
    (situation) => !blocked.has(key(situation.kind, situation.subjectId)) && !(isQuestionSituation(situation.kind) && openQuestions.has(situation.subjectId)),
  )
```

Import `isQuestionSituation` from `'./cards.js'`. Remove `WAITING_STALE_MS` from the import only if nothing else in `observe.ts` reads it (the general `waiting_stale` branch at `:497` still does).

- [ ] **Step 4: Run.** `npx vitest run packages/domain/test/supervisor/cards.test.ts packages/domain/test/supervisor/observe.test.ts packages/domain/test/supervisor/report.test.ts` → PASS. Run `npx tsc --build` and `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/supervisor packages/domain/test/supervisor
git commit -m "feat(domain): one card per question, the resume messages, and no second card for a parked conductor question

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Closing a question in control, and the readers that honour it

**Files:**
- Create: `packages/control/src/questions.ts`
- Modify: `packages/control/src/index.ts` (export `./questions.js`)
- Modify: `packages/control/src/messaging.ts:315-335` (`stillPendingQuestion`), `:458-538` (`answerQuestion`)
- Modify: `packages/control/src/refusal.ts:499` (new kind `question_closed`), `:954` (its sentence)
- Modify: `packages/control/src/supervisorWorld.ts:784-857` (delete the C5 decided-set and its doc paragraph)
- Test: `packages/control/test/integration/questions.test.ts` (new), `packages/control/test/integration/supervisorWorld.test.ts:2373-2405` (rewritten)

**Interfaces:**
- Consumes: Task 1 columns and constants.
- Produces (control):
  - `interface CloseQuestionInput { readonly messageId: string; readonly reason: QuestionCloseReason; readonly by: string; readonly note: string | null; readonly decisionId: string | null }`
  - `closeQuestionIn(tx: Prisma.TransactionClient, input: CloseQuestionInput, now: Date): Promise<boolean>` (conditional; true when this call closed it)
  - `announceQuestionClosed(question: { readonly workspaceId: string; readonly taskId: string | null; readonly slaveId: string }, input: CloseQuestionInput, actor: 'human' | 'system', userId: string | null): Promise<void>`
  - `closeQuestion(input: Omit<CloseQuestionInput, 'note'> & { readonly note: (question: { readonly body: string; readonly createdAt: Date }) => string | null }, actor: 'human' | 'system', userId: string | null, now?: Date): Promise<boolean>`
  - `closedByOf(principal: Principal | undefined): string`
  - `retireQuestionCards(workspaceId: string, messageId: string, reason: string, now: Date, except?: string | null): Promise<number>`
  - `retireClosedQuestionCards(workspaceId: string, now: Date): Promise<number>`
  - `ControlRefusal` gains `{ kind: 'question_closed'; messageId: string; reason: QuestionCloseReason; by: string; at: string }`
  - `stillPendingQuestion(...)` gains `closedAt: null`.

- [ ] **Step 1: Failing tests.** Create `packages/control/test/integration/questions.test.ts`:

```ts
/**
 * Human-cards plan A, Task 3: a question closes once, a closed question is pending nowhere, an answer
 * closes its question, and the cards of a closed question are retired.
 */
import { prisma } from '@slave-of-ai/db/client'
import { CONDUCTOR_ROLE } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { answerQuestion, listPendingQuestions, reportQuestionKey, sendMessage } from '../../src/messaging.js'
import { closeQuestion, retireClosedQuestionCards, retireQuestionCards } from '../../src/questions.js'
import { loadSupervisorWorld } from '../../src/supervisorWorld.js'

const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "SlaveMessage", "SlaveRun", "Task", "WorkPackage", "GoalDelivery", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE'

interface Fixture { readonly workspaceId: string; readonly seatId: string; readonly taskId: string }

async function seed(): Promise<Fixture> {
  const ws = await prisma.workspace.create({ data: { name: `Questions ${String(Date.now())}`, repoPath: '/nonexistent', verifyCommands: ['true'], setupCommands: [], delivery: 'conducted' } })
  const team = await prisma.team.create({ data: { workspaceId: ws.id, name: 'E' } })
  const seat = await prisma.slave.create({ data: { teamId: team.id, role: 'Implementer', runtimeRoles: ['implementer'], personId: (await prisma.person.create({ data: { name: 'Ivo' } })).id } })
  const task = await prisma.task.create({ data: { workspaceId: ws.id, title: 'report', description: 'x', status: 'done', requiredRole: 'implementer', maxAttempts: 3, goalVersion: 1 } })
  return { workspaceId: ws.id, seatId: seat.id, taskId: task.id }
}

async function reportQuestion(f: Fixture, body = 'Which error shape?'): Promise<string> {
  const run = await prisma.slaveRun.create({ data: { slaveId: f.seatId, taskId: f.taskId, status: 'succeeded' } })
  const sent = await sendMessage(run.id, { kind: 'question', body, recipientRole: CONDUCTOR_ROLE, expectsReply: true, taskId: f.taskId, idempotencyKey: reportQuestionKey(run.id, 0) })
  if (!sent.ok) throw new Error(JSON.stringify(sent.error))
  return sent.value.id
}

const card = (f: Fixture, subjectId: string, situationKind: 'conductor_question' | 'waiting_stale' | 'unanswerable_question', status: 'pending' | 'rejected' = 'pending') =>
  prisma.supervisorDecision.create({ data: { workspaceId: f.workspaceId, situationKind, subjectId, situation: {}, candidates: [], chosenIndex: 0, action: { kind: 'escalate_to_human', summary: 'x' }, rationale: 'x', tier: 'escalated', status, decidedBy: 'rules' } })

afterAll(async () => {
  await prisma.$disconnect()
})

describe('closing a question (human cards H1)', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('closes once: the second close writes nothing and the first reason stays', async () => {
    const f = await seed()
    const q = await reportQuestion(f)
    expect(await closeQuestion({ messageId: q, reason: 'dismissed', by: 'u1', decisionId: null, note: () => 'n' }, 'human', 'u1')).toBe(true)
    expect(await closeQuestion({ messageId: q, reason: 'timed_out', by: 'system', decisionId: null, note: () => null }, 'system', null)).toBe(false)
    expect(await prisma.slaveMessage.findUniqueOrThrow({ where: { id: q } })).toMatchObject({ closedReason: 'dismissed', closedBy: 'u1', closedNote: 'n' })
    const events = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'slave_question_closed' } })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ actor: 'human', taskId: f.taskId })
  })

  it('is pending nowhere once closed: not in the answer box, not in the world', async () => {
    const f = await seed()
    const open = await reportQuestion(f, 'open one')
    const closed = await reportQuestion(f, 'closed one')
    await closeQuestion({ messageId: closed, reason: 'decided', by: 'u1', decisionId: null, note: () => null }, 'human', 'u1')
    const pending = await listPendingQuestions(f.workspaceId)
    expect(pending.ok && pending.value.map((m) => m.id)).toEqual([open])
    const { world } = await loadSupervisorWorld(f.workspaceId, new Date())
    expect(world.questions.map((one) => one.messageId)).toEqual([open])
  })

  it('closes a question answered, naming who; and a dismissed one refuses an answer', async () => {
    const f = await seed()
    const answered = await reportQuestion(f, 'a')
    const result = await answerQuestion(answered, { body: 'camelCase', answeredBy: 'web operator', principal: { userId: 'u9' } })
    expect(result.ok).toBe(true)
    expect(await prisma.slaveMessage.findUniqueOrThrow({ where: { id: answered } })).toMatchObject({ closedReason: 'answered', closedBy: 'u9', closedNote: null })
    const cli = await reportQuestion(f, 'b')
    await answerQuestion(cli, { body: 'yes', answeredBy: 'cli' })
    expect((await prisma.slaveMessage.findUniqueOrThrow({ where: { id: cli } })).closedBy).toBe('operator')
    const dismissed = await reportQuestion(f, 'c')
    await closeQuestion({ messageId: dismissed, reason: 'dismissed', by: 'u1', decisionId: null, note: () => 'x' }, 'human', 'u1')
    const refused = await answerQuestion(dismissed, { body: 'late', answeredBy: 'web operator' })
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.error.kind).toBe('question_closed')
    expect(await prisma.slaveMessage.count({ where: { replyToId: dismissed } })).toBe(0)
  })

  it('takes a late answer on a timed-out question and keeps its reason (plan A D6)', async () => {
    const f = await seed()
    const q = await reportQuestion(f)
    await closeQuestion({ messageId: q, reason: 'timed_out', by: 'system', decisionId: null, note: () => 'No answer came in 2 hours.' }, 'system', null)
    expect((await answerQuestion(q, { body: 'late', answeredBy: 'web operator' })).ok).toBe(true)
    expect((await prisma.slaveMessage.findUniqueOrThrow({ where: { id: q } })).closedReason).toBe('timed_out')
  })

  it('retires every open card of a question but the one named, and the backstop leaves a timed-out question\'s card open', async () => {
    const f = await seed()
    const q = await reportQuestion(f)
    const keep = await card(f, q, 'conductor_question')
    const other = await card(f, q, 'waiting_stale')
    expect(await retireQuestionCards(f.workspaceId, q, 'answered elsewhere', new Date(), keep.id)).toBe(1)
    expect((await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('expired')
    expect((await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: keep.id } })).status).toBe('pending')

    const timedOut = await reportQuestion(f, 'waits')
    const stays = await card(f, timedOut, 'conductor_question')
    await closeQuestion({ messageId: timedOut, reason: 'timed_out', by: 'system', decisionId: null, note: () => null }, 'system', null)
    await closeQuestion({ messageId: q, reason: 'answered', by: 'u1', decisionId: null, note: () => null }, 'human', 'u1')
    expect(await retireClosedQuestionCards(f.workspaceId, new Date())).toBe(1)
    expect((await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: keep.id } })).status).toBe('expired')
    expect((await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: stays.id } })).status).toBe('pending')
  })
})
```

Rewrite `supervisorWorld.test.ts:2373-2405` ("drops a done task's report question once it was decided about…") as the same fixture with the decision rows replaced by closes, so the C5 cases now hold through closing:

```ts
  // Human cards plan A D4: the C5 filter is closing now -- a decided question is closed when it is
  // decided, and a closed question is pending nowhere. A settled decision with no close (only a row
  // written by hand) no longer hides a question; the migration closed every such row that existed.
  it('drops a closed question and keeps an open one, whatever decisions are on record (human cards D4)', async (): Promise<void> => {
    // ...the same seed, worker, delivery, pkg, task(), ask() helpers as before...
    const done = await task('done')
    const closed = await ask(done, 'closed by a person')
    const open = await ask(done, 'never decided')
    const live = await ask(await task('rework'), 'task live, open')
    await prisma.slaveMessage.update({ where: { id: closed }, data: { closedAt: new Date(), closedReason: 'dismissed', closedBy: 'u1' } })
    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.questions.map((q) => q.messageId).sort()).toEqual([open, live].sort())
  })
```

Keep the seed, worker, delivery, package, `task()` and `ask()` lines of the old test verbatim. Delete its decision-row loop.

Run `npx vitest run packages/control/test/integration/questions.test.ts` → FAIL (module missing).

- [ ] **Step 2: `questions.ts`.**

```ts
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  CLOSED_BY_OPERATOR,
  CLOSED_BY_SYSTEM,
  CLOSED_NOTE_MAX_CHARS,
  QUESTION_CLOSED_EVENT_NOTE_MAX_CHARS,
  QUESTION_SITUATION_KINDS,
  storableText,
  trimToFit,
  type QuestionCloseReason,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import type { Principal } from './principal.js'

/**
 * Human-cards spec H1: a question closes once, and a closed question is pending nowhere. Every close
 * goes through {@link closeQuestionIn}, a conditional write, so two closers race to one winner (plan
 * A D1). The event is appended after the commit ({@link announceQuestionClosed}): `appendEvent` owns
 * its own transaction.
 */

export interface CloseQuestionInput {
  readonly messageId: string
  readonly reason: QuestionCloseReason
  /** A user id, `operator`, or `system` ({@link closedByOf}). */
  readonly by: string
  /** What the asker continues with; null for `answered`. */
  readonly note: string | null
  /** The card the close came from, when it came from one. */
  readonly decisionId: string | null
}

/** `closedBy` for a person's act: their user id, or `operator` when no account can be named. */
export function closedByOf(principal: Principal | undefined): string {
  return principal?.userId ?? CLOSED_BY_OPERATOR
}

/** Closes an open question inside `tx`; false when it was already closed (or is not a question). */
export async function closeQuestionIn(tx: Prisma.TransactionClient, input: CloseQuestionInput, now: Date): Promise<boolean> {
  const closed = await tx.slaveMessage.updateMany({
    where: { id: input.messageId, kind: 'question', closedAt: null },
    data: {
      closedAt: now,
      closedReason: input.reason,
      closedBy: input.by,
      closedNote: input.note === null ? null : trimToFit(storableText(input.note), CLOSED_NOTE_MAX_CHARS),
      timeoutRefusal: null,
    },
  })
  return closed.count === 1
}

/** Plan A D11: the close's one event, after the commit that closed it. */
export async function announceQuestionClosed(
  question: { readonly workspaceId: string; readonly taskId: string | null; readonly slaveId: string },
  input: CloseQuestionInput,
  actor: 'human' | 'system',
  userId: string | null,
): Promise<void> {
  await appendEvent({
    type: 'slave.question_closed',
    workspaceId: question.workspaceId,
    taskId: question.taskId,
    slaveId: question.slaveId,
    actor,
    payload: {
      messageId: input.messageId,
      reason: input.reason,
      by: input.by,
      decisionId: input.decisionId,
      note: input.note === null ? null : trimToFit(storableText(input.note), QUESTION_CLOSED_EVENT_NOTE_MAX_CHARS),
    },
    userId,
  })
}

/**
 * Closes one question on its own (a card verb, an expiry, a timeout): the question row is locked
 * first (`claimTheAnswer`'s mutex), the note is built from the question as stored, and the event
 * follows the commit. True when this call closed it.
 */
export async function closeQuestion(
  input: Omit<CloseQuestionInput, 'note'> & { readonly note: (question: { readonly body: string; readonly createdAt: Date }) => string | null },
  actor: 'human' | 'system',
  userId: string | null,
  now: Date = new Date(),
): Promise<boolean> {
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "SlaveMessage" WHERE id = ${input.messageId} FOR UPDATE`
    const question = await tx.slaveMessage.findUnique({
      where: { id: input.messageId },
      select: { workspaceId: true, taskId: true, slaveId: true, body: true, createdAt: true },
    })
    if (question === null) return null
    const close: CloseQuestionInput = { ...input, note: input.note(question) }
    return (await closeQuestionIn(tx, close, now)) ? { question, close } : null
  })
  if (outcome === null) return false
  await announceQuestionClosed(outcome.question, outcome.close, actor, userId)
  return true
}

/**
 * Plan A D5: expires every pending card about one question -- of any question kind -- except
 * `except` (the card being resolved). Each row is claimed conditionally, so a person resolving one in
 * the same instant wins it. Expired, not rejected: nobody decided against the card.
 */
export async function retireQuestionCards(workspaceId: string, messageId: string, reason: string, now: Date, except: string | null = null): Promise<number> {
  const open = await prisma.supervisorDecision.findMany({
    where: { workspaceId, subjectId: messageId, situationKind: { in: [...QUESTION_SITUATION_KINDS] }, status: 'pending', ...(except === null ? {} : { id: { not: except } }) },
    select: { id: true },
  })
  let retired = 0
  for (const row of open) {
    const claimed = await prisma.supervisorDecision.updateMany({ where: { id: row.id, status: 'pending' }, data: { status: 'expired', resolvedAt: now } })
    if (claimed.count === 0) continue
    retired += 1
    await appendEvent({ type: 'supervisor.resolved', workspaceId, actor: 'system', payload: { decisionId: row.id, outcome: 'expired', reason } })
  }
  return retired
}

/** The words a retired card's event gives, by how its question closed. */
const RETIRED_BECAUSE: Readonly<Record<QuestionCloseReason, string>> = {
  answered: 'The question was answered.',
  decided: 'A person decided the question on another card.',
  dismissed: 'A person closed the question without an answer.',
  timed_out: 'The asking run continued without an answer.',
  superseded: 'A new goal version superseded the question.',
}

/**
 * Plan A D5, the tick's backstop: every pending question card whose question is closed for any
 * reason but `timed_out` (whose card stays open, spec H3) is retired. One query, and nothing else
 * when there is nothing to retire.
 */
export async function retireClosedQuestionCards(workspaceId: string, now: Date): Promise<number> {
  const rows = await prisma.$queryRaw<{ messageId: string; reason: QuestionCloseReason }[]>`
    SELECT DISTINCT d."subjectId" AS "messageId", m."closedReason"::text AS reason
    FROM "SupervisorDecision" d
    JOIN "SlaveMessage" m ON m.id = d."subjectId"
    WHERE d."workspaceId" = ${workspaceId}
      AND d.status = 'pending'
      AND d."situationKind" IN ('waiting_stale', 'unanswerable_question', 'conductor_question')
      AND m."closedAt" IS NOT NULL
      AND m."closedReason" <> 'timed_out'`
  let retired = 0
  for (const row of rows) retired += await retireQuestionCards(workspaceId, row.messageId, RETIRED_BECAUSE[row.reason], now)
  return retired
}

export { CLOSED_BY_SYSTEM }
```

Add `export * from './questions.js'` to `packages/control/src/index.ts` (after `./messaging.js`'s line). The SQL's kind list repeats `QUESTION_SITUATION_KINDS`. A test in `questions.test.ts` asserts the two agree: `expect(QUESTION_SITUATION_KINDS).toEqual(['waiting_stale', 'unanswerable_question', 'conductor_question'])`. Add that line to the last test.

- [ ] **Step 3: `stillPendingQuestion`.** In `messaging.ts:315-335`, add `closedAt: null` to the return type and the value:

```ts
export function stillPendingQuestion(waitingRunIds: string[]): {
  kind: 'question'
  expectsReply: true
  closedAt: null
  replies: { none: Record<string, never> }
  AND: [{ OR: [{ senderRunId: { in: string[] } }, { senderRunId: { not: null }; idempotencyKey: { startsWith: string } }] }]
} {
  return {
    kind: 'question' as const,
    expectsReply: true as const,
    // Human cards H1: a closed question is pending nowhere -- the world, the inbox, the answer box
    // and a re-address all read this one rule. A question with no close follows the rule below.
    closedAt: null,
    replies: { none: {} },
    // ...the AND clause unchanged...
  }
}
```

Add to the doc comment above it: "Human cards H1: and it is not closed (`closedAt`)."

- [ ] **Step 4: `answerQuestion`.** In `messaging.ts`, import `closeQuestionIn`, `announceQuestionClosed`, `closedByOf` from `'./questions.js'` and `CLOSED_BY_SYSTEM` from `@slave-of-ai/domain`. Inside the transaction, after the replay check (`if (seen !== null) return ...`) and before `tx.slaveMessage.create`:

```ts
      // Human cards plan A D6: a question a person decided, dismissed or superseded takes no answer.
      // Refused before anything is written, so returning is safe here (nothing to roll back). An
      // `answered` question takes a second answer as before; a `timed_out` one takes a late answer,
      // which the goal pass routes to the asking package (D9).
      const state = await tx.slaveMessage.findUniqueOrThrow({ where: { id: question.id }, select: { closedAt: true, closedReason: true, closedBy: true } })
      if (state.closedAt !== null && state.closedReason !== null && state.closedReason !== 'answered' && state.closedReason !== 'timed_out') {
        return { refused: { kind: 'question_closed' as const, messageId: question.id, reason: state.closedReason, by: state.closedBy ?? CLOSED_BY_SYSTEM, at: state.closedAt.toISOString() } }
      }
```

After the `create`:

```ts
      const close = { messageId: question.id, reason: 'answered' as const, by: origin === 'human' ? closedByOf(input.principal) : CLOSED_BY_SYSTEM, note: null, decisionId: null }
      const closed = await closeQuestionIn(tx, close, new Date())
      return { replayed: false as const, row, closed: closed ? close : null }
```

The replay branch returns `{ replayed: true as const, row: seen, closed: null }`. After the transaction:

```ts
  if ('refused' in outcome) return err(outcome.refused)
  if (!outcome.replayed) {
    // ...the existing slave.message_sent append, unchanged...
    if (outcome.closed !== null) {
      await announceQuestionClosed(question, outcome.closed, origin, input.principal?.userId ?? null)
    }
  }
```

In `refusal.ts`, add `| { readonly kind: 'question_closed'; readonly messageId: string; readonly reason: QuestionCloseReason; readonly by: string; readonly at: string }` after `question_answered`, import the type from `@slave-of-ai/domain`, and in `refusalText`:

```ts
    case 'question_closed':
      return `question ${refusal.messageId} was closed (${refusal.reason.replace('_', ' ')}) by ${refusal.by === 'system' ? 'Slave' : refusal.by} at ${refusal.at}: nothing was written`
```

- [ ] **Step 5: Delete the C5 filter.** In `supervisorWorld.ts`, `dropUnusableReportQuestions`, delete the `doneReportIds` constant, the `decided` set and its query (`:819-846`), and the line `if (task.status === 'done' && decided.has(row.id)) return false` in `stillUseful`. Change the doc comment's last two sentences to: "Human cards plan A D4: the C5 filter (a done task's decided report question) is closing now -- the verbs that settle a question close it, and `stillPendingQuestion` reads the close. At most two bounded reads, and none on a mailbox with no report question in it." Remove `CONDUCTOR_ROLE` from the imports only if nothing else in the file reads it.

- [ ] **Step 6: Run.** `npx tsc --build`, then `npx vitest run packages/control/test/integration/questions.test.ts`, then `npx vitest run packages/control/test/integration/supervisorWorld.test.ts`, then `npx vitest run packages/control/test/integration/messaging.test.ts packages/control/test/integration/answer.test.ts` → PASS. Run `npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add packages/control/src/questions.ts packages/control/src/index.ts packages/control/src/messaging.ts packages/control/src/refusal.ts packages/control/src/supervisorWorld.ts packages/control/test/integration/questions.test.ts packages/control/test/integration/supervisorWorld.test.ts
git commit -m "feat(control): a closed question is pending nowhere, an answer closes its question, and C5 is closing now

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: A card closes its question, and a question has one card

**Files:**
- Modify: `packages/control/src/supervisor.ts:147-290` (`recordDecision`), `:476-489` (the answer arm's retire), `:963-1028` (`approveDecision`), `:1036-1064` (`rejectDecision`), `:1133-1153` (`claimPending`'s lost-race refusal), `:1226-1251` (`expirePendingDecisions`), `:1253-1284` (delete `retireAnsweredWaitingStale`)
- Modify: `packages/control/src/refusal.ts:534` (`decision_not_pending` gains `resolvedAt`, `resolvedByUserId`), `:966` (its sentence)
- Modify: `apps/orchestrator/src/conductorAnswers.ts:1`, `:284-286` (`retireQuestionCards`)
- Modify: `apps/orchestrator/src/supervisor.ts:209` (the backstop after `expirePendingDecisions`)
- Test: `packages/control/test/integration/supervisor.test.ts` (new describe at the end), `apps/orchestrator/test/integration/conductor-answers.test.ts:331-352` (two tests rewritten), `:212-223` (unchanged; must still pass)

**Interfaces:**
- Consumes: `closeQuestion`, `closedByOf`, `retireQuestionCards`, `retireClosedQuestionCards` (Task 3); `isQuestionSituation`, `QUESTION_SITUATION_KINDS`, `DECIDED_WITHOUT_ANSWER`, `dismissResumeMessage`, `timeoutResumeMessage`, `COOLDOWN_BY_KIND` (domain).
- Produces: `recordDecision` refuses `question_closed` and a second open card on a question; `approveDecision`/`rejectDecision`/`expirePendingDecisions` close the card's question; `decision_not_pending` carries `resolvedAt: string | null` and `resolvedByUserId: string | null`.

- [ ] **Step 1: Failing tests.** At the end of `packages/control/test/integration/supervisor.test.ts` add a describe that reuses that file's own workspace and seat seed helpers (read its top: `grep -n "^async function\|^function" packages/control/test/integration/supervisor.test.ts`). A local `askConductor(workspaceId, seatId, taskId)` sends a report question with `reportQuestionKey`, as Task 3's test does:

```ts
describe('a card closes its question (human cards H1)', () => {
  const situation = (kind: 'conductor_question' | 'waiting_stale', subjectId: string) => ({ kind, subjectId, summary: 'x', facts: {} })
  const escalate = [{ action: { kind: 'escalate_to_human' as const, summary: 'x' }, tier: 'escalated' as const, why: 'x' }]
  const record = (workspaceId: string, kind: 'conductor_question' | 'waiting_stale', subjectId: string, now = new Date()) =>
    recordDecision({ workspaceId, situation: situation(kind, subjectId), candidates: escalate, chosenIndex: 0, rationale: 'r', decidedBy: 'rules', modelCostUsd: null, now })

  it('records one open card per question, whatever kind raised it', async () => {
    const f = await seedQuestion()
    expect((await record(f.workspaceId, 'conductor_question', f.questionId)).ok).toBe(true)
    const second = await record(f.workspaceId, 'waiting_stale', f.questionId)
    expect(!second.ok && second.error.kind).toBe('supervisor_cooldown')
  })

  it('refuses a card on a closed question', async () => {
    const f = await seedQuestion()
    await prisma.slaveMessage.update({ where: { id: f.questionId }, data: { closedAt: new Date(), closedReason: 'dismissed', closedBy: 'u1' } })
    const refused = await record(f.workspaceId, 'conductor_question', f.questionId)
    expect(!refused.ok && refused.error.kind).toBe('question_closed')
  })

  it('closes the question decided on an approved escalation, dismissed on a rejection, and retires the other card', async () => {
    const f = await seedQuestion()
    const old = await prisma.supervisorDecision.create({ data: { workspaceId: f.workspaceId, situationKind: 'waiting_stale', subjectId: f.questionId, situation: {}, candidates: [], chosenIndex: 0, action: { kind: 'escalate_to_human', summary: 'x' }, rationale: 'x', tier: 'escalated', status: 'pending', decidedBy: 'rules' } })
    const card = await prisma.supervisorDecision.create({ data: { workspaceId: f.workspaceId, situationKind: 'conductor_question', subjectId: f.questionId, situation: situation('conductor_question', f.questionId), candidates: escalate, chosenIndex: 0, action: { kind: 'escalate_to_human', summary: 'x' }, rationale: 'x', tier: 'escalated', status: 'pending', decidedBy: 'rules' } })
    expect((await rejectDecision(card.id, { userId: 'u1' }, 'out of scope')).ok).toBe(true)
    expect(await prisma.slaveMessage.findUniqueOrThrow({ where: { id: f.questionId } })).toMatchObject({ closedReason: 'dismissed', closedBy: 'u1' })
    expect((await prisma.slaveMessage.findUniqueOrThrow({ where: { id: f.questionId } })).closedNote).toContain('out of scope')
    expect((await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: old.id } })).status).toBe('expired')

    const g = await seedQuestion()
    const yes = await prisma.supervisorDecision.create({ data: { workspaceId: g.workspaceId, situationKind: 'conductor_question', subjectId: g.questionId, situation: situation('conductor_question', g.questionId), candidates: escalate, chosenIndex: 0, action: { kind: 'escalate_to_human', summary: 'x' }, rationale: 'x', tier: 'escalated', status: 'pending', decidedBy: 'rules' } })
    expect((await approveDecision(yes.id)).ok).toBe(true)
    expect(await prisma.slaveMessage.findUniqueOrThrow({ where: { id: g.questionId } })).toMatchObject({ closedReason: 'decided', closedBy: 'operator' })
  })

  it('closes the question timed out when its card expires unanswered (C5\'s expired, plan A D4)', async () => {
    const f = await seedQuestion()
    const now = new Date()
    await prisma.supervisorDecision.create({ data: { workspaceId: f.workspaceId, situationKind: 'conductor_question', subjectId: f.questionId, situation: situation('conductor_question', f.questionId), candidates: escalate, chosenIndex: 0, action: { kind: 'escalate_to_human', summary: 'x' }, rationale: 'x', tier: 'escalated', status: 'pending', decidedBy: 'rules', expiresAt: new Date(now.getTime() - 1000) } })
    expect(await expirePendingDecisions(f.workspaceId, now)).toBe(1)
    expect(await prisma.slaveMessage.findUniqueOrThrow({ where: { id: f.questionId } })).toMatchObject({ closedReason: 'timed_out', closedBy: 'system' })
  })

  it('leaves the question open when an approved card moves it to somebody who can answer', async () => {
    const f = await seedQuestion({ answerer: true })
    const move = await prisma.supervisorDecision.create({ data: { workspaceId: f.workspaceId, situationKind: 'unanswerable_question', subjectId: f.questionId, situation: { kind: 'unanswerable_question', subjectId: f.questionId, summary: 'x', facts: {} }, candidates: [{ action: { kind: 'reassign_question', messageId: f.questionId, toSlaveId: f.answererId }, tier: 'proposed', why: 'x' }], chosenIndex: 0, action: { kind: 'reassign_question', messageId: f.questionId, toSlaveId: f.answererId }, rationale: 'x', tier: 'proposed', status: 'pending', decidedBy: 'rules' } })
    expect((await approveDecision(move.id)).ok).toBe(true)
    expect((await prisma.slaveMessage.findUniqueOrThrow({ where: { id: f.questionId } })).closedAt).toBeNull()
  })

  it('names who resolved a card that was taken first', async () => {
    const f = await seedQuestion()
    const card = await prisma.supervisorDecision.create({ data: { workspaceId: f.workspaceId, situationKind: 'conductor_question', subjectId: f.questionId, situation: situation('conductor_question', f.questionId), candidates: escalate, chosenIndex: 0, action: { kind: 'escalate_to_human', summary: 'x' }, rationale: 'x', tier: 'escalated', status: 'pending', decidedBy: 'rules' } })
    await rejectDecision(card.id, { userId: 'u1' })
    const late = await approveDecision(card.id, { userId: 'u2' })
    expect(!late.ok && late.error).toMatchObject({ kind: 'decision_not_pending', status: 'rejected', resolvedByUserId: 'u1' })
  })
})
```

`seedQuestion(options?: { answerer?: boolean })` returns `{ workspaceId, questionId, answererId }`: a conducted workspace, a `done` task, a report question to the conductor (`unanswerable_question`'s reassign case addresses the question to role `security` instead, with an `answerer` seat holding `security`). Write it in the describe from the file's existing seed helpers.

In `apps/orchestrator/test/integration/conductor-answers.test.ts` replace the two tests at `:331-352` with:

```ts
  it('raises no waiting_stale for a run parked on the conductor: one card per question (human cards plan A D3)', async () => {
    const f = await seed()
    const late = new Date(f.now.getTime() + WAITING_STALE_MS + 60_000)
    const model = scripted(() => ({ kind: 'failed', reason: 'down', costUsd: null, tokens: null }))
    await supervise({ workspaceId: f.workspaceId, decider: model.decider, model: 'm', now: () => late })
    expect(await prisma.supervisorDecision.count({ where: { subjectId: f.qPaused, situationKind: 'waiting_stale' } })).toBe(0)
  })

  it('holds a question while an old waiting_stale card is open, and never asks it again once a person rejects that card (spec §4 compatibility)', async () => {
    const f = await seed()
    const stale = await prisma.supervisorDecision.create({ data: { workspaceId: f.workspaceId, situationKind: 'waiting_stale', subjectId: f.qPaused, situation: { kind: 'waiting_stale', subjectId: f.qPaused, summary: 'x', facts: {} }, candidates: [{ action: { kind: 'escalate_to_human', summary: 'x' }, tier: 'escalated', why: 'x' }], chosenIndex: 0, action: { kind: 'escalate_to_human', summary: 'x' }, rationale: 'x', tier: 'escalated', status: 'pending', decidedBy: 'rules' } })
    const up = scripted((prompt) => answerJson(idsIn(prompt).map((id) => ok(id))))
    await supervise({ workspaceId: f.workspaceId, decider: up.decider, model: 'm', now: () => f.now })
    // The open card holds the question (one card per question): the batch does not take it.
    expect(up.prompts.flatMap((prompt) => idsIn(prompt))).not.toContain(f.qPaused)
    expect((await rejectDecision(stale.id)).ok).toBe(true)
    expect((await prisma.slaveMessage.findUniqueOrThrow({ where: { id: f.qPaused } })).closedReason).toBe('dismissed')
    await supervise({ workspaceId: f.workspaceId, decider: up.decider, model: 'm', now: () => new Date(f.now.getTime() + COOLDOWN_MS + 60_000) })
    expect(up.prompts.flatMap((prompt) => idsIn(prompt))).not.toContain(f.qPaused)
    expect(await prisma.supervisorDecision.count({ where: { subjectId: f.qPaused } })).toBe(1)
  })
```

The second test pins the compatibility ruling (D2): an open pre-spec card holds its question, and resolving it closes the question for good.

Run `npx vitest run packages/control/test/integration/supervisor.test.ts -t "closes its question"` → FAIL.

- [ ] **Step 2: `recordDecision`.** Import `COOLDOWN_BY_KIND`, `QUESTION_SITUATION_KINDS`, `isQuestionSituation` from `@slave-of-ai/domain`. Inside the transaction, after the `supervisorEnabled` check, replace the `open` lookup and the cooldown read with:

```ts
    const key = { workspaceId: input.workspaceId, situationKind: situation.kind, subjectId: situation.subjectId }
    const onQuestion = isQuestionSituation(situation.kind)
    if (onQuestion) {
      // Human cards H1: a closed question is never decided again. Refused before any write.
      const message = await tx.slaveMessage.findUnique({ where: { id: situation.subjectId }, select: { closedAt: true, closedReason: true, closedBy: true } })
      if (message?.closedAt != null && message.closedReason !== null) {
        return { ok: false as const, error: { kind: 'question_closed', messageId: situation.subjectId, reason: message.closedReason, by: message.closedBy ?? 'system', at: message.closedAt.toISOString() } as ControlRefusal }
      }
    }
    // Plan A D2: one open card per question, whatever kind raised it; per situation key otherwise.
    const open = await tx.supervisorDecision.findFirst({
      where: onQuestion
        ? { workspaceId: input.workspaceId, subjectId: situation.subjectId, situationKind: { in: [...QUESTION_SITUATION_KINDS] }, status: 'pending' }
        : { ...key, status: 'pending' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, expiresAt: true },
    })
```

and, in the cooldown block, `const cooldownMs = COOLDOWN_BY_KIND[situation.kind] ?? COOLDOWN_MS` replaces `COOLDOWN_MS` in both places (the comparison and the `until`). Update the doc comment's "cools its key for `COOLDOWN_MS`" sentence to "for its kind's cooldown (`COOLDOWN_BY_KIND`, else `COOLDOWN_MS`), as `filterFresh` does".

- [ ] **Step 3: The card verbs close their question.** Add, after `rememberDecision`:

```ts
/**
 * Human cards H1 (plan A D4): what a person's verdict on a card does to its question. An approved
 * answer closed it already (`answerQuestion`); an approved re-address moved it to somebody who can
 * answer it; any other approval decides it without an answer, a rejection dismisses it with the
 * person's reason, and an expiry times it out. The other cards about it are retired. Said and
 * swallowed: the verdict already reached the world, and the backstop retires what this missed.
 */
async function closeCardQuestion(
  decisionId: string,
  verdict: 'approved' | 'rejected' | 'expired',
  reason: string | null,
  principal: Principal | undefined,
  now: Date,
): Promise<void> {
  try {
    const row = await prisma.supervisorDecision.findUnique({ where: { id: decisionId }, select: { workspaceId: true, situationKind: true, subjectId: true, action: true } })
    if (row === null || !isQuestionSituation(row.situationKind)) return
    const action = parsedOrThrow(actionSchema.safeParse(row.action), `SupervisorDecision ${decisionId}.action`)
    if (verdict === 'approved' && (action.kind === 'answer_question' || action.kind === 'reassign_question')) return
    const human = verdict !== 'expired'
    await closeQuestion(
      {
        messageId: row.subjectId,
        reason: verdict === 'approved' ? 'decided' : verdict === 'rejected' ? 'dismissed' : 'timed_out',
        by: human ? closedByOf(principal) : CLOSED_BY_SYSTEM,
        decisionId,
        note: (question) =>
          verdict === 'approved' ? DECIDED_WITHOUT_ANSWER : verdict === 'rejected' ? dismissResumeMessage(reason) : timeoutResumeMessage(now.getTime() - question.createdAt.getTime(), question.body),
      },
      human ? 'human' : 'system',
      principal?.userId ?? null,
      now,
    )
    await retireQuestionCards(row.workspaceId, row.subjectId, verdict === 'expired' ? 'The question timed out with its card.' : 'A person decided the question on another card.', now, decisionId)
  } catch (error) {
    console.error(`[supervisor] decision ${decisionId}: its question was not closed:`, error)
  }
}
```

In `approveDecision`, after the `supervisor.resolved` append and before `rememberDecision`: `await closeCardQuestion(decisionId, 'approved', null, principal, new Date())`. In `rejectDecision`, at the same place: `await closeCardQuestion(decisionId, 'rejected', trimmed === undefined || trimmed === '' ? null : trimmed, principal, new Date())`. In `expirePendingDecisions`, after each row's append: `await closeCardQuestion(row.id, 'expired', null, undefined, now)`. In `carryOut`'s `answer_question` arm (`:476-489`), replace the `retireAnsweredWaitingStale` call with `await retireQuestionCards(decision.workspaceId, action.messageId, 'The question was answered.', new Date(), decision.id)`. Make it unconditional on `sent.ok` (drop the `conductor !== undefined` test), because any answer ends every other card. Delete `retireAnsweredWaitingStale` (`:1253-1284`).

- [ ] **Step 4: Who took the card first.** In `claimPending`, re-read `{ status: true, resolvedAt: true, resolvedByUserId: true }` on both refusal paths and return `{ kind: 'decision_not_pending', decisionId, status, resolvedAt: row.resolvedAt?.toISOString() ?? null, resolvedByUserId: row.resolvedByUserId }`. In `refusal.ts`:

```ts
  | { readonly kind: 'decision_not_pending'; readonly decisionId: string; readonly status: string; readonly resolvedAt?: string | null; readonly resolvedByUserId?: string | null }
```

```ts
    case 'decision_not_pending':
      return `supervisor decision ${refusal.decisionId} is ${refusal.status}, not pending${refusal.resolvedAt == null ? '' : ` (resolved ${refusal.resolvedByUserId == null ? 'by Slave' : `by ${refusal.resolvedByUserId}`} at ${refusal.resolvedAt})`}: there is nothing left to approve or reject`
```

(Optional fields keep every other writer of the kind compiling.)

- [ ] **Step 5: The orchestrator.** `apps/orchestrator/src/conductorAnswers.ts`: import `retireQuestionCards` in place of `retireAnsweredWaitingStale`, and at `:286` call `await retireQuestionCards(input.workspaceId, situation.subjectId, 'The question was answered.', input.now, recorded.value.id)`. `apps/orchestrator/src/supervisor.ts`: import `retireClosedQuestionCards` from `@slave-of-ai/control`, and after `await expirePendingDecisions(deps.workspaceId, now)`:

```ts
  // Human cards plan A D5: a question closed anywhere -- the answer box, the CLI, an applied answer --
  // retires its open cards before the world is read, so no card asks about a closed question.
  await retireClosedQuestionCards(deps.workspaceId, now)
```

- [ ] **Step 6: Run.** `npx tsc --build`, then `npx vitest run packages/control/test/integration/supervisor.test.ts`, then `npx vitest run packages/control/test/integration/conductor-answer.test.ts`, then `npx vitest run apps/orchestrator/test/integration/conductor-answers.test.ts` → PASS. The test at `conductor-answers.test.ts:212` (a rejected card never comes back after the cooldown) passes through closing now. Run `npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add packages/control/src/supervisor.ts packages/control/src/refusal.ts apps/orchestrator/src/conductorAnswers.ts apps/orchestrator/src/supervisor.ts packages/control/test/integration/supervisor.test.ts apps/orchestrator/test/integration/conductor-answers.test.ts
git commit -m "feat(supervisor): approving, rejecting or expiring a card closes its question, and a question has one open card (OBS-9)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The question timeout is a setting

**Files:**
- Modify: `packages/domain/src/guardrails/limits.ts:21-51`
- Modify: `packages/domain/src/events/schema.ts:672-684` (`settings_changed.field` gains `questionTimeoutMs`)
- Modify: `packages/control/src/workspace.ts:175-235` (`WorkspaceLimitsPatch`, the field list, the select)
- Modify: `apps/web/src/app/api/w/[workspaceId]/limits/route.ts:14-20`, `:44-48`
- Modify: `apps/orchestrator/src/cli.ts:715` (usage), `:3878-3905` (`set-limits`)
- Modify: `apps/web/src/server/projectSettings.ts:18-20`, `:62-64`; `apps/web/src/components/project/ProjectSettingsClient.tsx:167`; `apps/web/src/components/project/RuntimePanel.tsx:54-58`, `:159`, `:225-310`
- Test: `packages/domain/test/guardrails/limits.test.ts` (or the file that tests `isWorkspaceLimitAllowed`: `grep -rln isWorkspaceLimitAllowed packages/domain/test`), `packages/control/test/integration/workspace-limits.test.ts` (the file that tests `setWorkspaceLimits`: `grep -rln setWorkspaceLimits packages/control/test`)

**Interfaces:**
- Produces: `WorkspaceLimitField` gains `'questionTimeoutMs'`; `WORKSPACE_LIMIT_BOUNDS.questionTimeoutMs = { min: 900_000, max: 259_200_000 }`; `QUESTION_TIMEOUT_DEFAULT_MS = 7_200_000`; `WorkspaceLimitsPatch.questionTimeoutMs?: number`.

- [ ] **Step 1: Failing tests.** In the domain limits test:

```ts
  it('bounds the question timeout to 15 minutes .. 72 hours in whole minutes (human cards H3)', () => {
    expect(QUESTION_TIMEOUT_DEFAULT_MS).toBe(2 * 3_600_000)
    expect(isWorkspaceLimitAllowed('questionTimeoutMs', 15 * 60_000)).toBe(true)
    expect(isWorkspaceLimitAllowed('questionTimeoutMs', 72 * 3_600_000)).toBe(true)
    expect(isWorkspaceLimitAllowed('questionTimeoutMs', 14 * 60_000)).toBe(false)
    expect(isWorkspaceLimitAllowed('questionTimeoutMs', 72 * 3_600_000 + 60_000)).toBe(false)
    expect(isWorkspaceLimitAllowed('questionTimeoutMs', 15 * 60_000 + 1)).toBe(false)
    expect(WORKSPACE_LIMIT_RULE.questionTimeoutMs).toBe('a question timeout must be a whole number of minutes from 15 to 4320')
  })
```

In the control limits test:

```ts
  it('sets the question timeout and says so once (human cards H3)', async () => {
    const ws = await seedWorkspace()
    const moved = await setWorkspaceLimits(ws.id, { questionTimeoutMs: 30 * 60_000 })
    expect(moved.ok && moved.value.moved).toEqual([{ field: 'questionTimeoutMs', from: 7_200_000, to: 1_800_000 }])
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: ws.id } })).questionTimeoutMs).toBe(1_800_000)
    const refused = await setWorkspaceLimits(ws.id, { questionTimeoutMs: 60_000 })
    expect(!refused.ok && refused.error).toEqual({ kind: 'invalid_limit', field: 'questionTimeoutMs' })
  })
```

(`seedWorkspace` is that file's own helper; use whatever it already calls.) Run the domain test → FAIL.

- [ ] **Step 2: Domain.** In `limits.ts`:

```ts
export type WorkspaceLimitField = 'runTimeoutMs' | 'maxConcurrentRuns' | 'maxAttempts' | 'questionTimeoutMs'

/** Human cards H3: a run waits this long on an unanswered question before it continues on its own judgement. */
export const QUESTION_TIMEOUT_DEFAULT_MS = 2 * 60 * MINUTE_MS
```

Add `questionTimeoutMs: { min: 15 * MINUTE_MS, max: 72 * 60 * MINUTE_MS },` to the bounds and, to the rules, `` questionTimeoutMs: `a question timeout must be a whole number of minutes from ${String(WORKSPACE_LIMIT_BOUNDS.questionTimeoutMs.min / MINUTE_MS)} to ${String(WORKSPACE_LIMIT_BOUNDS.questionTimeoutMs.max / MINUTE_MS)}`, ``. The last line of `isWorkspaceLimitAllowed` becomes `return (field !== 'runTimeoutMs' && field !== 'questionTimeoutMs') || value % MINUTE_MS === 0`. Extend the module comment with: "Human cards H3 adds the question timeout: fifteen minutes is shorter than a person's lunch, seventy-two hours spans a weekend." In `events/schema.ts`, add `'questionTimeoutMs',` after `'maxAttempts',` in the `settings_changed` field enum, and add to its doc: "Human cards H3 adds `questionTimeoutMs` on the same terms."

- [ ] **Step 3: Control.** In `workspace.ts`, add `readonly questionTimeoutMs?: number` to `WorkspaceLimitsPatch`, add `'questionTimeoutMs'` to the `fields` array, add `questionTimeoutMs: true` to the select, and add a bullet to the doc: "`questionTimeoutMs` is read by the tick's timeout pass, so it reaches every waiting run on the next tick."

- [ ] **Step 4: Route and CLI.** Route: add `questionTimeoutMs: z.number().optional(),`, add it to `BODY_ERROR`'s text, and add `...(body.data.questionTimeoutMs === undefined ? {} : { questionTimeoutMs: body.data.questionTimeoutMs }),` to the patch. CLI: the usage line gains `[--question-timeout-min <n>]`. In `set-limits`, add `const questionText = flagText(flags, 'question-timeout-min')` and include it in the "one of" check and its message. Add `...(questionText === undefined ? {} : { questionTimeoutMs: Number(questionText) * 60_000 }),` to the patch, `questionTimeoutMs: 'question timeout'` to `said`, and in `figure` write `field === 'runTimeoutMs' || field === 'questionTimeoutMs' ? ... min`.

- [ ] **Step 5: Web.** `projectSettings.ts`: add `readonly questionTimeoutMs: number` and `questionTimeoutMs: workspace.questionTimeoutMs,`. `ProjectSettingsClient.tsx:167`: add `questionTimeoutMs: workspace.questionTimeoutMs`. `RuntimePanel.tsx`: add `readonly questionTimeoutMs: number` to the props' `limits` and to `type Limits`, append `|${String(limits.questionTimeoutMs)}` to the key, and add `'questionTimeoutMs'` to `LIMIT_FIELDS`. In `LimitsForm`, add `const [questionMin, setQuestionMin] = useState(String(limits.questionTimeoutMs / 60_000))`, add `questionTimeoutMs: Number(questionMin) * 60_000,` to the patch, and after the attempts field:

```tsx
      {field('question timeout (min)', 'runtime-question-timeout', 'question timeout in minutes', questionMin, setQuestionMin, {
        min: WORKSPACE_LIMIT_BOUNDS.questionTimeoutMs.min / 60_000,
        max: WORKSPACE_LIMIT_BOUNDS.questionTimeoutMs.max / 60_000,
      })}
```

The footnote becomes "a longer timeout reaches a run already working; attempts reach tasks planned from now on; a run waiting on a question continues on its own after the question timeout".

- [ ] **Step 6: Run.** The two test files → PASS. `npm run typecheck`. `npm run web:build`, then `rm -rf apps/web/.next`.

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/guardrails/limits.ts packages/domain/src/events/schema.ts packages/domain/test packages/control/src/workspace.ts packages/control/test apps/web/src apps/orchestrator/src/cli.ts
git commit -m "feat(settings): the question timeout is a dispatch limit -- 2 hours, from 15 minutes to 72 hours

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The timeout pass

**Files:**
- Create: `apps/orchestrator/src/questionTimeout.ts`
- Modify: `packages/control/src/resume.ts:50-161` (`requestResume` option `onlyIfNotRequested`)
- Modify: `packages/control/src/refusal.ts` (kind `resume_already_requested`)
- Modify: `apps/orchestrator/src/deliver.ts:162-180` (pass the option)
- Modify: `apps/orchestrator/src/tick.ts:352-354` (halted branch) and `:422-424` (ordinary branch)
- Test: `apps/orchestrator/test/integration/question-timeout.test.ts` (new)

**Interfaces:**
- Consumes: `closeQuestionIn`, `announceQuestionClosed` (Task 3); `timeoutResumeMessage`, `DECIDED_WITHOUT_ANSWER`, `CLOSED_BY_SYSTEM` (domain); `Workspace.questionTimeoutMs`, `SlaveMessage.timeoutRefusal` (Task 1).
- Produces:
  - `requestResume(runId, rawMessage, requestedBy, principal?, actor?, options?: { readonly onlyIfNotRequested?: boolean })`
  - `ControlRefusal` gains `{ kind: 'resume_already_requested'; runId: string }`
  - `continueWaitingRuns(workspaceId: string, now?: Date): Promise<readonly ContinuedRun[]>` with `interface ContinuedRun { readonly runId: string; readonly questionId: string; readonly reason: QuestionCloseReason }`

- [ ] **Step 1: Failing tests.** Create `apps/orchestrator/test/integration/question-timeout.test.ts`:

```ts
/**
 * Human-cards spec H3 (plan A D7): a run paused on an unanswered question past the project's question
 * timeout continues on its own judgement; a halt keeps it waiting and says why; an answer and the
 * timeout in one window produce one resume.
 */
import { answerQuestion } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deliverAnswers } from '../../src/deliver.js'
import { continueWaitingRuns } from '../../src/questionTimeout.js'

const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "SlaveMessage", "Checkpoint", "SlaveRun", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE'
const HOUR = 3_600_000
const T0 = new Date('2026-10-02T08:00:00.000Z')

interface Fixture { readonly workspaceId: string; readonly runId: string; readonly taskId: string; readonly questionId: string }

/** A run parked on a question at T0, with a checkpoint (a resume needs one) and a dead pid. */
async function seed(options: { readonly timeoutMs?: number; readonly haltedReason?: string } = {}): Promise<Fixture> {
  const ws = await prisma.workspace.create({ data: { name: `Timeout ${String(Math.random())}`, repoPath: '/nonexistent', verifyCommands: ['true'], setupCommands: [], ...(options.timeoutMs === undefined ? {} : { questionTimeoutMs: options.timeoutMs }), ...(options.haltedReason === undefined ? {} : { haltedReason: options.haltedReason, haltedAt: T0 }) } })
  const team = await prisma.team.create({ data: { workspaceId: ws.id, name: 'E' } })
  const seat = await prisma.slave.create({ data: { teamId: team.id, role: 'Implementer', runtimeRoles: ['implementer'], personId: (await prisma.person.create({ data: { name: 'Ivo' } })).id } })
  const task = await prisma.task.create({ data: { workspaceId: ws.id, title: 'integration', description: 'x', status: 'waiting', requiredRole: 'implementer', maxAttempts: 3, assigneeId: seat.id } })
  const run = await prisma.slaveRun.create({ data: { slaveId: seat.id, taskId: task.id, status: 'paused', pauseReason: 'waiting_for_answer', pausedAt: T0, provider: 'claude_code' } })
  await prisma.task.update({ where: { id: task.id }, data: { activeRunId: run.id } })
  await prisma.checkpoint.create({ data: { runId: run.id, sessionId: 's1', worktreePath: '/tmp/w', pauseFlagPath: '/tmp/p', deniedToolUseIds: [], headCommit: 'a'.repeat(40), dirtyFiles: [] } })
  const q = await prisma.slaveMessage.create({ data: { id: `q-${run.id}`, threadId: `q-${run.id}`, workspaceId: ws.id, taskId: task.id, slaveId: seat.id, senderRunId: run.id, recipientRole: 'conductor', kind: 'question', body: 'May I add a start script to backend/package.json?', expectsReply: true, actor: 'slave', createdAt: T0 } })
  return { workspaceId: ws.id, runId: run.id, taskId: task.id, questionId: q.id }
}

const runOf = (f: Fixture) => prisma.slaveRun.findUniqueOrThrow({ where: { id: f.runId } })
const questionOf = (f: Fixture) => prisma.slaveMessage.findUniqueOrThrow({ where: { id: f.questionId } })

afterAll(async () => {
  await prisma.$disconnect()
})

describe('the question timeout (human cards H3)', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('does nothing before the timeout', async () => {
    const f = await seed()
    expect(await continueWaitingRuns(f.workspaceId, new Date(T0.getTime() + 2 * HOUR - 1000))).toEqual([])
    expect((await questionOf(f)).closedAt).toBeNull()
  })

  it('continues the run past the timeout with the spec sentence, and closes the question timed out', async () => {
    const f = await seed()
    const now = new Date(T0.getTime() + 2 * HOUR + 1000)
    expect(await continueWaitingRuns(f.workspaceId, now)).toEqual([{ runId: f.runId, questionId: f.questionId, reason: 'timed_out' }])
    expect(await questionOf(f)).toMatchObject({ closedReason: 'timed_out', closedBy: 'system' })
    const run = await runOf(f)
    expect(run.resumeRequestedAt).not.toBeNull()
    expect(run.queuedMessage?.split('\n')[0]).toBe('No answer came in 2 hours. Continue on your safest assumption, and say in your report which assumption you made.')
    expect(run.queuedMessage).toContain('backend/package.json')
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'slave_question_closed' } })).toBe(1)
    // Once: a second pass finds the run already continuing.
    expect(await continueWaitingRuns(f.workspaceId, now)).toEqual([])
  })

  it('honours the project\'s own timeout', async () => {
    const f = await seed({ timeoutMs: 15 * 60_000 })
    expect(await continueWaitingRuns(f.workspaceId, new Date(T0.getTime() + 16 * 60_000))).toHaveLength(1)
  })

  it('keeps a halted project\'s run waiting and says why, then continues it once the halt is cleared', async () => {
    const f = await seed({ haltedReason: 'emergency_stop' })
    const now = new Date(T0.getTime() + 3 * HOUR)
    expect(await continueWaitingRuns(f.workspaceId, now)).toEqual([])
    expect((await runOf(f)).resumeRequestedAt).toBeNull()
    expect(await questionOf(f)).toMatchObject({ closedReason: 'timed_out' })
    expect((await questionOf(f)).timeoutRefusal).toContain('halted')
    await prisma.workspace.update({ where: { id: f.workspaceId }, data: { haltedReason: null, haltedAt: null } })
    expect(await continueWaitingRuns(f.workspaceId, now)).toHaveLength(1)
    expect((await questionOf(f)).timeoutRefusal).toBeNull()
  })

  it('leaves an answered question to deliverAnswers', async () => {
    const f = await seed()
    await answerQuestion(f.questionId, { body: 'Yes, core-domain adds it.', answeredBy: 'web operator' })
    expect(await continueWaitingRuns(f.workspaceId, new Date(T0.getTime() + 3 * HOUR))).toEqual([])
    expect((await questionOf(f)).closedReason).toBe('answered')
  })

  it('writes one resume when the timeout and an answer meet: the timeout first, the answer left undelivered (spec §4)', async () => {
    const f = await seed()
    expect(await continueWaitingRuns(f.workspaceId, new Date(T0.getTime() + 3 * HOUR))).toHaveLength(1)
    // The answer lands after the timeout closed the question and wrote the run's intent.
    expect((await answerQuestion(f.questionId, { body: 'late', answeredBy: 'web operator' })).ok).toBe(true)
    expect(await deliverAnswers(f.workspaceId)).toEqual([])
    const answer = await prisma.slaveMessage.findFirstOrThrow({ where: { replyToId: f.questionId, kind: 'answer' } })
    expect(answer.deliveredAt).toBeNull()
    expect((await runOf(f)).queuedMessage?.startsWith('No answer came in')).toBe(true)
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'run_resume_requested' } })).toBe(1)
  })

  it('writes one resume when the answer goes first: the timeout pass then finds the run continuing (spec §4)', async () => {
    const f = await seed()
    await answerQuestion(f.questionId, { body: 'Yes.', answeredBy: 'web operator' })
    expect(await deliverAnswers(f.workspaceId)).toHaveLength(1)
    expect(await continueWaitingRuns(f.workspaceId, new Date(T0.getTime() + 3 * HOUR))).toEqual([])
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'run_resume_requested' } })).toBe(1)
  })
})
```

Add one control test for the claim to `packages/control/test/integration/resume.test.ts` (the file that tests `requestResume`: `grep -rln "requestResume" packages/control/test`):

```ts
  it('refuses a second intent when asked only if none stands (human cards plan A D7)', async () => {
    const run = await pausedRunWithCheckpoint()
    expect((await requestResume(run.id, 'first', 'a', undefined, 'system', { onlyIfNotRequested: true })).ok).toBe(true)
    const second = await requestResume(run.id, 'second', 'b', undefined, 'system', { onlyIfNotRequested: true })
    expect(!second.ok && second.error.kind).toBe('resume_already_requested')
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })).queuedMessage).toBe('first')
  })
```

(`pausedRunWithCheckpoint` is that file's own helper; reuse what it calls.) Run `npx vitest run apps/orchestrator/test/integration/question-timeout.test.ts` → FAIL (module missing).

- [ ] **Step 2: `requestResume`.** Add the sixth parameter:

```ts
  /** Human cards plan A D7: claim only when no intent stands (`resumeRequestedAt IS NULL`), so the
   *  timeout pass and `deliverAnswers` write one resume between them; the loser is refused
   *  `resume_already_requested`. Off by default: a person's Resume button still overwrites. */
  options: { readonly onlyIfNotRequested?: boolean } = {},
```

The claim becomes `where: { id: run.id, status: 'paused', ...(options.onlyIfNotRequested === true ? { resumeRequestedAt: null } : {}) }`. On `claimed.count === 0`:

```ts
    if (options.onlyIfNotRequested === true) {
      const now = await prisma.slaveRun.findUnique({ where: { id: run.id }, select: { status: true, resumeRequestedAt: true } })
      if (now?.status === 'paused' && now.resumeRequestedAt !== null) return err({ kind: 'resume_already_requested', runId: run.id })
    }
    return err({ kind: 'wrong_status', runId: run.id, status: run.status, needed: RESUMABLE_STATUSES })
```

`refusal.ts`: add `| { readonly kind: 'resume_already_requested'; readonly runId: string }` and `case 'resume_already_requested': return \`run ${refusal.runId} already has a resume waiting: the first one stands\``.

- [ ] **Step 3: `deliverAnswers`.** In `deliverToOneRun`, pass `{ onlyIfNotRequested: true }` as the sixth argument to `requestResume`. The refusal branch already releases the claim (`deliveredAt: null`). Add to its comment: "A resume that lost to the timeout pass (human cards plan A D7) is released the same way, and the goal pass routes the answer to the asking package (`routeLateAnswers`)."

- [ ] **Step 4: The pass.** Create `apps/orchestrator/src/questionTimeout.ts`:

```ts
import { announceQuestionClosed, closeQuestionIn, refusalText, requestResume } from '@slave-of-ai/control'
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import { CLOSED_BY_SYSTEM, DECIDED_WITHOUT_ANSWER, timeoutResumeMessage, type QuestionCloseReason } from '@slave-of-ai/domain'
import { WAITING_FOR_ANSWER } from './ask.js'

/** One waiting run this pass continued. */
export interface ContinuedRun {
  readonly runId: string
  readonly questionId: string
  readonly reason: QuestionCloseReason
}

/**
 * Human-cards spec H3 (plan A D7): one pass per tick, right after `deliverAnswers`. A run parked on a
 * question that nobody answered within the project's question timeout continues on its own
 * judgement: the question closes `timed_out` (under the question row's lock, `claimTheAnswer`'s
 * mutex, re-checking for an answer), and the run is resumed with the closed note. A question a
 * person closed without an answer (plan B's dismissal and decisions) continues the same way. An
 * answered question is `deliverAnswers`' to deliver, whatever its close says.
 *
 * Every resume asks `onlyIfNotRequested`, as `deliverAnswers` does, so a timeout and an answer in
 * one window write one intent between them. A refused resume (a halt, a spent budget) leaves the run
 * waiting and its reason on the question (`timeoutRefusal`), which the card shows; the next tick
 * tries again.
 */
export async function continueWaitingRuns(workspaceId: string, now: Date = new Date()): Promise<readonly ContinuedRun[]> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { questionTimeoutMs: true } })
  if (workspace === null) return []
  const waiting = await prisma.slaveRun.findMany({
    where: { status: 'paused', pauseReason: WAITING_FOR_ANSWER, resumeRequestedAt: null, stopRequestedBy: null, slave: { team: { workspaceId } } },
    select: { id: true, taskId: true, pausedAt: true },
  })
  const continued: ContinuedRun[] = []
  for (const run of waiting) {
    const one = await continueOne(workspaceId, run, workspace.questionTimeoutMs, now)
    if (one !== null) continued.push(one)
  }
  return continued
}

const answered = (questionId: string, client: Pick<Prisma.TransactionClient, 'slaveMessage'> = prisma): Promise<number> =>
  client.slaveMessage.count({ where: { replyToId: questionId, kind: 'answer', supersededAt: null } })

async function continueOne(
  workspaceId: string,
  run: { readonly id: string; readonly taskId: string | null; readonly pausedAt: Date | null },
  timeoutMs: number,
  now: Date,
): Promise<ContinuedRun | null> {
  // `deliverToOneRun`'s match: a waiting run waits on the last question it sent.
  const question = await prisma.slaveMessage.findFirst({
    where: { senderRunId: run.id, kind: 'question', expectsReply: true },
    orderBy: { seq: 'desc' },
    select: { id: true, body: true, createdAt: true, taskId: true, slaveId: true, closedAt: true, closedReason: true, closedNote: true, timeoutRefusal: true },
  })
  if (question === null) return null
  if (run.taskId !== null) {
    const task = await prisma.task.findUnique({ where: { id: run.taskId }, select: { status: true, activeRunId: true } })
    if (task === null || task.status !== 'waiting' || task.activeRunId !== run.id) return null
  }
  if ((await answered(question.id)) > 0) return null

  let reason = question.closedReason
  let note = question.closedNote
  if (question.closedAt === null) {
    const waitedMs = now.getTime() - (run.pausedAt ?? question.createdAt).getTime()
    if (waitedMs < timeoutMs) return null
    const close = { messageId: question.id, reason: 'timed_out' as const, by: CLOSED_BY_SYSTEM, note: timeoutResumeMessage(waitedMs, question.body), decisionId: null }
    const closed = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "SlaveMessage" WHERE id = ${question.id} FOR UPDATE`
      // An answer that landed since the read above wins: it is deliverAnswers' to deliver.
      if ((await answered(question.id, tx)) > 0) return false
      return closeQuestionIn(tx, close, now)
    })
    if (!closed) return null
    await announceQuestionClosed({ workspaceId, taskId: question.taskId, slaveId: question.slaveId }, close, 'system', null)
    reason = 'timed_out'
    note = close.note
  }
  if (reason === null || reason === 'answered') return null

  const requested = await requestResume(
    run.id,
    note ?? DECIDED_WITHOUT_ANSWER,
    reason === 'timed_out' ? 'the question timeout' : 'a decision on its question',
    undefined,
    'system',
    { onlyIfNotRequested: true },
  )
  if (!requested.ok) {
    if (requested.error.kind === 'resume_already_requested') return null
    const why = refusalText(requested.error)
    if (question.timeoutRefusal !== why) await prisma.slaveMessage.updateMany({ where: { id: question.id }, data: { timeoutRefusal: why } })
    console.warn(`[question-timeout] run ${run.id} waits on question ${question.id}: it cannot continue -- ${why}`)
    return null
  }
  await prisma.slaveMessage.updateMany({ where: { id: question.id, timeoutRefusal: { not: null } }, data: { timeoutRefusal: null } })
  return { runId: run.id, questionId: question.id, reason }
}
```

- [ ] **Step 5: Wire it.** In `tick.ts` import `continueWaitingRuns` from `'./questionTimeout.js'`. In the halted branch, inside `if (breachRefusingResume(breaches) === null) {`, after `await deliverAnswers(deps.workspaceId)`, add `await continueWaitingRuns(deps.workspaceId)`. In the ordinary branch, after `await deliverAnswers(deps.workspaceId)` and before `resumeRequestedRuns`:

```ts
  // Human cards H3 (plan A D7): a run whose question nobody answered within the question timeout,
  // or whose question a person closed without an answer, continues -- after delivery, so a real
  // answer always goes first, and before the resume pass, so it continues in this tick.
  await continueWaitingRuns(deps.workspaceId)
```

Under an emergency stop, `breachRefusingResume` is not null, so the pass does not run and the run keeps waiting. The test above calls the pass directly to pin `timeoutRefusal`.

- [ ] **Step 6: Run.** `npx tsc --build`, then `npx vitest run apps/orchestrator/test/integration/question-timeout.test.ts`, then the resume test file, then `npx vitest run apps/orchestrator/test/integration/answer.test.ts`, then `npx vitest run apps/orchestrator/test/integration/tick.test.ts` → PASS. Run `npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add apps/orchestrator/src/questionTimeout.ts apps/orchestrator/src/deliver.ts apps/orchestrator/src/tick.ts packages/control/src/resume.ts packages/control/src/refusal.ts apps/orchestrator/test/integration/question-timeout.test.ts packages/control/test
git commit -m "feat(orchestrator): a run waiting on an unanswered question continues on its own after the question timeout

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: A late answer becomes a hand-off, under the operator's heading

**Files:**
- Modify: `packages/domain/src/conduct/handOff.ts:127-213` (`HandOffView.fromOperator`, `itemLine`, `fitItems` callers, new `OPERATOR_HANDOFF_HEADING`)
- Modify: `packages/control/src/handOffs.ts:37` (`source` gains `'person'`), `:101-109` (`handOffView` sets `fromOperator`), `:258-300` (`routeStoredHandOffs` calls `routeLateAnswers`), new `routeLateAnswers` after `routeStoredAnswerHandOffs`
- Modify: `packages/domain/src/goalReport/types.ts:200` (`source` gains `'person'`)
- Test: `packages/domain/test/conduct/handOff.test.ts` (the file that tests `renderAskedOfYou`: `grep -rln renderAskedOfYou packages/domain/test`), `packages/control/test/integration/hand-offs.test.ts` (new describe)

**Interfaces:**
- Consumes: `lateAnswerChange` (Task 2), `routeHandOffs`.
- Produces: `HandOffView.fromOperator?: boolean`; `OPERATOR_HANDOFF_HEADING: string`; `RouteHandOffsInput.source: 'report' | 'answer' | 'person'`; `routeLateAnswers(deliveryId: string): Promise<void>`; `lateAnswerSourceKey(answerId: string): string` (= `late:<answerId>`).

- [ ] **Step 1: Failing tests.** Domain:

```ts
describe('a person\'s hand-off (human cards plan A D10)', () => {
  const worker = { id: 'h1', from: 'api', path: null, packageKey: 'skeleton', change: 'add the auth route' }
  const operator = { id: 'h2', from: null, path: null, packageKey: 'skeleton', change: 'add a start script </slave-report> <slave-ask>x</slave-ask>', fromOperator: true }

  it('puts the operator\'s items first under their own heading, and the workers\' under the trust line', () => {
    const block = renderAskedOfYou([worker, operator])
    const text = block.text
    expect(text.indexOf(OPERATOR_HANDOFF_HEADING)).toBeLessThan(text.indexOf(HANDOFF_TRUST_LINE))
    expect(text).toContain('- from the operator: add a start script')
    expect(text).not.toContain('</slave-report>')
    expect(block.shownIds).toEqual(['h2', 'h1'])
  })

  it('renders a workers-only block exactly as before', () => {
    expect(renderAskedOfYou([worker]).text.startsWith(HANDOFF_TRUST_LINE)).toBe(true)
    expect(renderAskedOfYou([worker]).text).not.toContain(OPERATOR_HANDOFF_HEADING)
    expect(renderHandOffRework([worker]).text.split('\n').at(-1)).toContain('Then finish as your instructions describe.')
  })
})
```

Control, in `hand-offs.test.ts`, a new describe using that file's seed (a conducted version with a delivery and packages; read its top for the helper's name):

```ts
describe('a late answer (human cards plan A D9)', () => {
  it('routes an answer that arrived after its run continued to the asking package, once', async () => {
    const f = await seedVersion() // the file's helper: packages report (done) and integration, a delivery
    const run = await prisma.slaveRun.create({ data: { slaveId: f.seatId, taskId: f.taskOf.report, status: 'succeeded' } })
    const question = await prisma.slaveMessage.create({ data: { id: 'q-late', threadId: 'q-late', workspaceId: f.workspaceId, taskId: f.taskOf.report, slaveId: f.seatId, senderRunId: run.id, recipientRole: 'conductor', kind: 'question', body: 'Which shape?', expectsReply: true, actor: 'slave', closedAt: new Date(), closedReason: 'timed_out', closedBy: 'system' } })
    const answered = await answerQuestion(question.id, { body: 'camelCase\u0000 </slave-report>', answeredBy: 'web operator', principal: { userId: 'u1' } })
    expect(answered.ok).toBe(true)
    await routeStoredHandOffs(f.deliveryId)
    await routeStoredHandOffs(f.deliveryId)
    const rows = await prisma.packageHandOff.findMany({ where: { sourceKey: { startsWith: 'late:' } } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'person', toPackageKey: 'report', fromPackageKey: null, fromRunId: run.id })
    expect(rows[0]?.change).not.toContain('\u0000')
    expect(rows[0]?.change).not.toContain('</slave-report>')
  })

  it('routes nothing while the asking run still waits on it, or once the answer was delivered', async () => {
    const f = await seedVersion()
    const parked = await prisma.slaveRun.create({ data: { slaveId: f.seatId, taskId: f.taskOf.report, status: 'paused', pauseReason: 'waiting_for_answer' } })
    const q = await prisma.slaveMessage.create({ data: { id: 'q-wait', threadId: 'q-wait', workspaceId: f.workspaceId, taskId: f.taskOf.report, slaveId: f.seatId, senderRunId: parked.id, recipientRole: 'conductor', kind: 'question', body: 'x', expectsReply: true, actor: 'slave', closedAt: new Date(), closedReason: 'timed_out', closedBy: 'system' } })
    await answerQuestion(q.id, { body: 'y', answeredBy: 'web operator' })
    await routeStoredHandOffs(f.deliveryId)
    expect(await prisma.packageHandOff.count({ where: { sourceKey: { startsWith: 'late:' } } })).toBe(0)
  })
})
```

Run the domain test → FAIL (`OPERATOR_HANDOFF_HEADING` missing).

- [ ] **Step 2: Domain renderers.** In `handOff.ts`:

```ts
export interface HandOffView {
  // ...the existing fields...
  /** Human cards plan A D10: a person's request (`source = person`), rendered under its own heading. */
  readonly fromOperator?: boolean
}

/** Human cards plan A D10: the heading a person's requests sit under -- the operator's words, unlike
 *  the workers' requests below {@link HANDOFF_TRUST_LINE}. */
export const OPERATOR_HANDOFF_HEADING = 'From the operator (a person decided this on a card; do it in your own files):'
```

In `itemLine`, `const from = view.fromOperator === true ? 'the operator' : view.from === null ? 'the conductor' : sanitisePersonText(storableText(view.from))`. Add:

```ts
/**
 * Plan A D10: a person's items first, under {@link OPERATOR_HANDOFF_HEADING}, then the workers' under
 * `workerHead`, then `tail`; each part fitted whole by {@link fitItems} within what the part before it
 * left. A block with no operator item is byte-identical to `fitItems(workerHead, items, tail, budget)`.
 */
function fitBlocks(workerHead: string, items: readonly HandOffView[], tail: readonly string[], budget: number): HandOffBlock {
  const operator = items.filter((view) => view.fromOperator === true)
  const workers = items.filter((view) => view.fromOperator !== true)
  if (operator.length === 0) return fitItems(workerHead, workers, tail, budget)
  const first = fitItems(OPERATOR_HANDOFF_HEADING, operator, workers.length === 0 ? tail : [], budget)
  if (workers.length === 0) return first
  const second = fitItems(workerHead, workers, tail, Math.max(0, budget - first.text.length))
  return { text: `${first.text}\n${second.text}`, shownIds: [...first.shownIds, ...second.shownIds] }
}
```

`renderAskedOfYou` and `renderHandOffRework` call `fitBlocks(...)` with the arguments they pass `fitItems` today. Export `OPERATOR_HANDOFF_HEADING` from the conduct index if `handOff.ts`'s exports are listed there (`grep -n handOff packages/domain/src/conduct/index.ts`).

- [ ] **Step 3: Control routing.** In `handOffs.ts`, change `RouteHandOffsInput.source` to `'report' | 'answer' | 'person'` and its `sourceKey` doc to `` `report:<runId>`, `answer:<decisionId>`, `late:<answerId>` or (plan B) `person:<decisionId>` ``. `handOffView` takes `readonly source?: string` and returns `fromOperator: row.source === 'person'`. Every call passes a full row, so it carries `source`. Add after `routeStoredAnswerHandOffs`:

```ts
/** Plan A D9: the key a late answer's hand-off is stored under; its one item is `late:<answerId>:0`. */
export function lateAnswerSourceKey(answerId: string): string {
  return `late:${answerId}`
}

/**
 * Human-cards spec H3, §4 (plan A D9): an answer that never woke anyone because its run had already
 * continued past the question timeout is routed, as a hand-off, to the package that asked. Its
 * question is closed `timed_out`, the answer is neither delivered nor superseded, and its run is not
 * still parked on it (then `deliverAnswers` delivers it). The goal pass's backstop shape, like
 * {@link routeStoredAnswerHandOffs}: one query, idempotent by {@link lateAnswerSourceKey}, no lock held.
 */
export async function routeLateAnswers(deliveryId: string): Promise<void> {
  const late = await prisma.$queryRaw<
    { answerId: string; workspaceId: string; goalVersion: number; senderRunId: string; packageKey: string; question: string; answer: string; actor: string }[]
  >`
    SELECT a.id AS "answerId", d."workspaceId", d."goalVersion", q."senderRunId", p.key AS "packageKey", q.body AS question, a.body AS answer, a.actor::text AS actor
    FROM "GoalDelivery" d
    JOIN "WorkPackage" p ON p."workspaceId" = d."workspaceId" AND p."goalVersion" = d."goalVersion"
    JOIN "Task" t ON t."workPackageId" = p.id
    JOIN "SlaveMessage" q ON q."taskId" = t.id AND q.kind = 'question' AND q."closedReason" = 'timed_out'
    JOIN "SlaveMessage" a ON a."replyToId" = q.id AND a.kind = 'answer' AND a."deliveredAt" IS NULL AND a."supersededAt" IS NULL
    WHERE d.id = ${deliveryId}
      AND q."senderRunId" IS NOT NULL
      AND NOT (
        EXISTS (SELECT 1 FROM "SlaveRun" r WHERE r.id = q."senderRunId" AND r.status = 'paused' AND r."pauseReason" = 'waiting_for_answer' AND r."resumeRequestedAt" IS NULL)
        AND NOT EXISTS (SELECT 1 FROM "SlaveMessage" n WHERE n."senderRunId" = q."senderRunId" AND n.kind = 'question' AND n.seq > q.seq)
      )
      AND NOT EXISTS (SELECT 1 FROM "PackageHandOff" h WHERE h."workspaceId" = d."workspaceId" AND h."sourceKey" = 'late:' || a.id || ':0')
    ORDER BY a."createdAt", a.id`
  for (const row of late) {
    try {
      await routeHandOffs({
        workspaceId: row.workspaceId,
        goalVersion: row.goalVersion,
        source: row.actor === 'human' ? 'person' : 'answer',
        sourceKey: lateAnswerSourceKey(row.answerId),
        fromRunId: row.senderRunId,
        fromPackageKey: null,
        items: [{ package: row.packageKey, change: lateAnswerChange(row.question, row.answer) }],
      })
    } catch (error) {
      console.error(`[hand-off] answer ${row.answerId}: its late answer was not routed this pass:`, error)
    }
  }
}
```

Call `await routeLateAnswers(deliveryId)` at the end of `routeStoredHandOffs`, after `routeStoredAnswerHandOffs`. Import `lateAnswerChange` from `@slave-of-ai/domain`. In `goalReport/types.ts:200`, write `readonly source: 'report' | 'answer' | 'person'`. Check the report's own reader compiles: `grep -n "source:" packages/control/src/goalReport.ts`.

- [ ] **Step 4: Run.** `npx tsc --build`, then the domain hand-off test, then `npx vitest run packages/control/test/integration/hand-offs.test.ts` → PASS. Run `npx vitest run apps/orchestrator/test/integration/runContext.test.ts` (or the file that pins `renderAskedOfYou` in a prompt: `grep -rln "Asked of your package" apps/orchestrator/test`) → PASS unchanged. Run `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/conduct/handOff.ts packages/domain/src/conduct/index.ts packages/domain/src/goalReport/types.ts packages/domain/test packages/control/src/handOffs.ts packages/control/test/integration/hand-offs.test.ts
git commit -m "feat(hand-off): an answer that came after its run continued reaches the asking package, under the operator's heading

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The report and the card say how a question closed

**Files:**
- Modify: `packages/domain/src/goalReport/types.ts:128-135` (`GoalReportQuestion.closed`)
- Modify: `packages/domain/src/goalReport/markdown.ts:17` (words), `:200-214` (questions)
- Modify: `packages/control/src/goalReportTrail.ts:421-452` (`versionQuestions` selects the close)
- Modify: `packages/control/src/questions.ts` (`QuestionCard`, `loadQuestionCards`)
- Modify: `packages/control/src/supervisor.ts:1350-1408` (`DecisionView.card`, `listDecisions`)
- Modify: `apps/web/src/components/project/GoalReportView.tsx:436-456`
- Modify: `apps/web/src/components/supervisor/ProposalRow.tsx:325-389` (`QuestionState`)
- Modify: `apps/web/src/app/api/w/[workspaceId]/messages/[messageId]/answer/route.ts:46-52` (retire the cards at once)
- Test: `packages/domain/test/goalReport/markdown.test.ts`, `packages/control/test/integration/goal-report.test.ts` (the file that tests `loadGoalReport`'s questions: `grep -rln versionQuestions\\\|loadGoalReport packages/control/test`), `packages/control/test/integration/questions.test.ts` (one case), `apps/web/test/proposal-row.test.tsx` (the file that renders `ProposalRow`: `grep -rln ProposalRow apps/web/test`)

**Interfaces:**
- Produces:
  - `GoalReportQuestion.closed: { readonly at: string; readonly reason: QuestionCloseReason; readonly by: 'person' | 'system'; readonly note: string | null; readonly waitedMs: number } | null`
  - `GOAL_REPORT_CLOSE_WORDS: Readonly<Record<QuestionCloseReason, string>>`
  - `interface QuestionCard { readonly messageId: string; readonly body: string; readonly goalVersion: number | null; readonly askerPackageKey: string | null; readonly askerRunId: string | null; readonly askerWaiting: boolean; readonly closed: { readonly reason: QuestionCloseReason; readonly at: string; readonly by: string } | null; readonly timeoutRefusal: string | null }`
  - `loadQuestionCards(workspaceId: string, messageIds: readonly string[]): Promise<ReadonlyMap<string, QuestionCard>>`
  - `DecisionView.card?: QuestionCard | null`

- [ ] **Step 1: Failing tests.** Domain markdown:

```ts
  it('says how each question closed, and how long a run waited before it continued (human cards H1/H3)', () => {
    const q = { id: 'm1', at: '2026-10-02T08:00:00.000Z', packageKey: 'integration', askedBy: 'Ivo', question: 'May I edit package.json?', answer: null }
    const md = renderGoalReportMarkdown({ ...baseReport(), questions: [
      { ...q, closed: { at: '2026-10-02T10:00:00.000Z', reason: 'timed_out', by: 'system', note: 'No answer came in 2 hours.', waitedMs: 7_200_000 } },
      { ...q, id: 'm2', closed: { at: '2026-10-02T09:00:00.000Z', reason: 'dismissed', by: 'person', note: null, waitedMs: 3_600_000 } },
      { ...q, id: 'm3', closed: null },
    ] })
    expect(md).toContain('  Closed: continued without an answer after 2 hours (Slave, 2026-10-02T10:00:00.000Z).')
    expect(md).toContain('  Closed: closed without an answer (a person, 2026-10-02T09:00:00.000Z).')
    expect(md.match(/Closed:/g)).toHaveLength(2)
  })
```

(`baseReport()` is that test file's own report fixture; use its name.) Control `questions.test.ts`:

```ts
  it('reads a card\'s question: its package, whether the asker waits, its close and why the run cannot continue', async () => {
    const f = await seed()
    const q = await reportQuestion(f)
    await prisma.slaveMessage.update({ where: { id: q }, data: { closedAt: new Date('2026-10-02T10:00:00.000Z'), closedReason: 'timed_out', closedBy: 'system', timeoutRefusal: 'the project is halted' } })
    const cards = await loadQuestionCards(f.workspaceId, [q, 'not-a-message'])
    expect(cards.get(q)).toMatchObject({ messageId: q, askerWaiting: false, closed: { reason: 'timed_out', by: 'system', at: '2026-10-02T10:00:00.000Z' }, timeoutRefusal: 'the project is halted', goalVersion: 1 })
    expect(cards.has('not-a-message')).toBe(false)
  })
```

Web (`proposal-row.test.tsx`; use its render helper and decision fixture):

```tsx
  it('marks a card whose run continued without an answer, and one whose run cannot continue (human cards H3)', () => {
    const base = { messageId: 'm1', body: 'q', goalVersion: 1, askerPackageKey: 'integration', askerRunId: 'r1' }
    const { getByTestId, rerender } = render(<ProposalRow {...props} decision={{ ...decision, card: { ...base, askerWaiting: false, closed: { reason: 'timed_out', at: '2026-10-02T10:00:00.000Z', by: 'system' }, timeoutRefusal: null } }} />)
    expect(getByTestId('card-question-state').textContent).toContain('continued without an answer')
    expect(getByTestId('card-question-state').textContent).toContain('integration package as a hand-off')
    rerender(<ProposalRow {...props} decision={{ ...decision, card: { ...base, askerWaiting: true, closed: { reason: 'timed_out', at: '2026-10-02T10:00:00.000Z', by: 'system' }, timeoutRefusal: 'workspace halted: emergency_stop' } }} />)
    expect(getByTestId('card-question-state').textContent).toContain('cannot continue: workspace halted: emergency_stop')
  })
```

Run the markdown test → FAIL.

- [ ] **Step 2: Report.** `types.ts`, in `GoalReportQuestion`:

```ts
  /** Human cards H1/H3: how the question stopped waiting, or null while it waits. `waitedMs` is from
   *  the question to its close -- for `timed_out`, how long the run waited before it continued. */
  readonly closed: { readonly at: string; readonly reason: QuestionCloseReason; readonly by: 'person' | 'system'; readonly note: string | null; readonly waitedMs: number } | null
```

`markdown.ts`:

```ts
/** Human cards H1: how a question closed, in words (shared with the web page). */
export const GOAL_REPORT_CLOSE_WORDS = {
  answered: 'answered',
  decided: 'decided on a card',
  dismissed: 'closed without an answer',
  timed_out: 'continued without an answer',
  superseded: 'superseded by a new goal version',
} as const satisfies Readonly<Record<QuestionCloseReason, string>>
```

In the questions loop, after the answer/"Not answered." lines:

```ts
    if (q.closed !== null && q.closed.reason !== 'answered') {
      const words = q.closed.reason === 'timed_out' ? `${GOAL_REPORT_CLOSE_WORDS.timed_out} after ${formatWait(q.closed.waitedMs)}` : GOAL_REPORT_CLOSE_WORDS[q.closed.reason]
      lines.push(`  Closed: ${words} (${q.closed.by === 'system' ? 'Slave' : 'a person'}, ${mdInline(q.closed.at)}).`, '')
    }
```

(`formatWait` from `'../supervisor/cards.js'`.) `goalReportTrail.ts` `versionQuestions`: add `closedAt: true, closedReason: true, closedBy: true, closedNote: true` to the select, and map:

```ts
      closed:
        row.closedAt === null || row.closedReason === null
          ? null
          : {
              at: row.closedAt.toISOString(),
              reason: row.closedReason,
              by: row.closedBy === CLOSED_BY_SYSTEM ? 'system' : 'person',
              note: row.closedNote === null ? null : trimEvidence(row.closedNote, GOAL_REPORT_DETAIL_MAX_CHARS),
              waitedMs: row.closedAt.getTime() - row.createdAt.getTime(),
            },
```

`GoalReportView.tsx`, after the answer block in the questions map:

```tsx
            {q.closed !== null && q.closed.reason !== 'answered' && (
              <p data-testid="goal-report-question-closed" className="text-t3">
                Closed: {q.closed.reason === 'timed_out' ? `${GOAL_REPORT_CLOSE_WORDS.timed_out} after ${formatWait(q.closed.waitedMs)}` : GOAL_REPORT_CLOSE_WORDS[q.closed.reason]} ({q.closed.by === 'system' ? 'Slave' : 'a person'}, {q.closed.at})
              </p>
            )}
```

- [ ] **Step 3: The card's question.** In `questions.ts`:

```ts
/** Human cards plan A D13: what a card on a question shows of it. Plan B adds the version's
 *  packages and the decisions the card offers. */
export interface QuestionCard {
  readonly messageId: string
  readonly body: string
  readonly goalVersion: number | null
  readonly askerPackageKey: string | null
  /** The run that asked (`senderRunId`): plan B routes a person's hand-off from it. */
  readonly askerRunId: string | null
  /** The asking run is still parked on this question (`deliverToOneRun`'s match). */
  readonly askerWaiting: boolean
  readonly closed: { readonly reason: QuestionCloseReason; readonly at: string; readonly by: string } | null
  readonly timeoutRefusal: string | null
}

/** Every card's question in one read (plan A D13); a message that is gone is simply absent. */
export async function loadQuestionCards(workspaceId: string, messageIds: readonly string[]): Promise<ReadonlyMap<string, QuestionCard>> {
  if (messageIds.length === 0) return new Map()
  const rows = await prisma.slaveMessage.findMany({
    where: { workspaceId, id: { in: [...messageIds] }, kind: 'question' },
    select: {
      id: true, body: true, senderRunId: true, seq: true, closedAt: true, closedReason: true, closedBy: true, timeoutRefusal: true,
      task: { select: { goalVersion: true, workPackage: { select: { key: true, goalVersion: true } } } },
    },
  })
  const runIds = rows.flatMap((row) => (row.senderRunId === null ? [] : [row.senderRunId]))
  const parked = new Set(
    (await prisma.slaveRun.findMany({ where: { id: { in: runIds }, status: 'paused', pauseReason: 'waiting_for_answer' }, select: { id: true } })).map((run) => run.id),
  )
  const latest = new Map(
    (
      await prisma.slaveMessage.groupBy({ by: ['senderRunId'], where: { senderRunId: { in: runIds }, kind: 'question' }, _max: { seq: true } })
    ).map((group) => [group.senderRunId, group._max.seq] as const),
  )
  return new Map(
    rows.map((row) => [
      row.id,
      {
        messageId: row.id,
        body: row.body,
        goalVersion: row.task?.workPackage?.goalVersion ?? row.task?.goalVersion ?? null,
        askerPackageKey: row.task?.workPackage?.key ?? null,
        askerRunId: row.senderRunId,
        askerWaiting: row.senderRunId !== null && parked.has(row.senderRunId) && latest.get(row.senderRunId) === row.seq,
        closed: row.closedAt === null || row.closedReason === null ? null : { reason: row.closedReason, at: row.closedAt.toISOString(), by: row.closedBy ?? CLOSED_BY_SYSTEM },
        timeoutRefusal: row.timeoutRefusal,
      },
    ]),
  )
}
```

In `supervisor.ts`, add `readonly card?: QuestionCard | null` to `DecisionView`, documented "Human cards plan A D13: the question a question card is about; null for every other card". In `listDecisions`, after the `findMany`:

```ts
  const cards = await loadQuestionCards(workspaceId, rows.filter((row) => isQuestionSituation(row.situationKind)).map((row) => row.subjectId))
```

Add `card: isQuestionSituation(row.situationKind) ? (cards.get(row.subjectId) ?? null) : null,` to each view.

- [ ] **Step 4: The card's mark.** In `ProposalRow.tsx`, after the rationale span:

```tsx
      {decision.card != null && <QuestionState card={decision.card} />}
```

and before `ProposalRow`:

```tsx
/** Human cards H3: whether the question's run continued without an answer, or cannot continue. */
function QuestionState({ card }: { readonly card: NonNullable<Decision['card']> }): React.JSX.Element | null {
  if (card.askerWaiting && card.timeoutRefusal !== null) {
    return (
      <span data-testid="card-question-state" className="text-[11px] text-tone-blocked">
        The wait is over, but the run cannot continue: {card.timeoutRefusal}
      </span>
    )
  }
  if (card.closed?.reason !== 'timed_out') return null
  return (
    <span data-testid="card-question-state" className="text-[11px] text-tone-waiting">
      The run continued without an answer at {card.closed.at}
      {card.askerPackageKey === null ? '; an answer stays in its thread.' : `; a decision now reaches the ${card.askerPackageKey} package as a hand-off.`}
    </span>
  )
}
```

- [ ] **Step 5: The answer box retires at once.** In the answer route, replace the `messageControlResponse` call's body with:

```ts
  return messageControlResponse(workspaceId, messageId, async () => {
    const answered = await answerQuestion(messageId, { body: answer, answeredBy: 'web operator', ...(gate.principal !== null ? { principal: gate.principal } : {}) })
    // Human cards plan A D5: the cards about it go now, not on the next tick's backstop.
    if (answered.ok) await retireQuestionCards(workspaceId, messageId, 'The question was answered.', new Date())
    return answered
  })
```

Import `retireQuestionCards` from `@slave-of-ai/control`.

- [ ] **Step 6: Run.** The markdown, `questions.test.ts`, goal-report and proposal-row tests → PASS. `npm run typecheck`. `npm run web:build`, then `rm -rf apps/web/.next`.

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/goalReport packages/domain/test packages/control/src/goalReportTrail.ts packages/control/src/questions.ts packages/control/src/supervisor.ts packages/control/test apps/web/src apps/web/test
git commit -m "feat(report): the goal report and the card say how a question closed, and a card says when its run continued without an answer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Verification

**Files:** none new. Fixes go in the task they belong to, as fix commits.

- [ ] **Step 1: Hygiene.** `git grep -nE "agency-agent[s]"` prints nothing. `node scripts/gate-m26-vocabulary.mjs` passes. `git grep -n "retireAnsweredWaitingStale"` prints nothing. `git log --format=%B 653d9652..HEAD | grep -c "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"` equals the number of commits since `653d9652`.
- [ ] **Step 2: Types and build.** `npm run typecheck`. `npm run web:build` with no `next dev` running, then `rm -rf apps/web/.next`.
- [ ] **Step 3: The whole suite, once, in the background.** Stop any daemon. `set -a; . ./.env; set +a; export DATABASE_URL=$TEST_DATABASE_URL; npx vitest run > /tmp/human-cards-a-suite.log 2>&1` with `run_in_background` and a 600 s budget. Wait on the log's summary line, not on `pgrep`. A failure in `daemon-cli` alone is re-run alone before it is believed (memory: daemon CLI flakes under load).
- [ ] **Step 4: Gates on the gate database.** With the host daemon stopped, the fake-CLI env as `ci.yml` sets it, and `systemd-inhibit --what=sleep:idle`: `DATABASE_URL="$GATE_DATABASE_URL" npm run gate:m56a` (stage 12 now reads 25 / 25 / 77 and `prisma migrate diff` stays clean), then `DATABASE_URL="$GATE_DATABASE_URL" npm run gate:m38`, `gate:m39` and `gate:m36` (the Supervisor, the drafted answer, the mailbox). Gates red on main before this plan (m44 m46 m47 m48 m49 m50 m52 m54 m55 m57 m58) are not regressions; any other red gate is.
- [ ] **Step 5: Spec check, H1 and H3.** Walk spec §3 H1 and H3 and §4 line by line against the tests, and name the test for each sentence in the task report: close columns (Task 1, 3), `stillPendingQuestion` (Task 3), C5 replaced (Task 3, 4), card decisions close the question for approve/reject (Task 4; Plan B adds the rest), any close retires every card (Task 3, 4, 8), one card per question (Task 2, 4), timeout default and bounds (Task 5), the pass and its message (Task 6), the card stays open and is marked (Task 3, 8), a late answer becomes a hand-off (Task 7), a halt keeps the run waiting and the card says why (Task 6, 8), the report lists continued questions (Task 8), and old cards and old questions keep working (Task 1 backfill, Task 4).

## Self-review (done while writing)

- **Spec coverage.** H1: columns, reasons and `closedBy` (Tasks 1 and 3). `stillPendingQuestion` and its readers (Task 3). The C5 filter replaced (Tasks 1, 3 and 4). Approve and reject close the question (Task 4). Any close retires every card (Tasks 3, 4 and 8). One card per question (Tasks 2 and 4). A closed question is never observed (Task 3). Closing is shown on the report (Task 8). H2's "every decision closes the question" for the new decisions is Plan B. H3: the setting (Task 5), the pass and the message (Task 6), the card staying open and its mark (Tasks 3 and 8), the late answer as a hand-off (Task 7), halted and budget (Tasks 6 and 8), and the report (Task 8). §4: the conditional claim (Task 6), bounded and sanitised person text under its own heading (Tasks 2 and 7), and old cards and questions (Tasks 1 and 4). The H4 queue and the H2 decisions are Plan B by design.
- **Placeholder scan.** The test seed helpers that live in existing files are named by the grep that finds them. Every new function has its code.
- **Type consistency.** `closeQuestionIn(tx, CloseQuestionInput, now)` and `announceQuestionClosed(question, input, actor, userId)` are used the same way in Tasks 3, 4 and 6. `closeQuestion`'s `note` is a function of the question in Tasks 3 and 4. `QuestionCloseReason` comes from `messaging/close.ts` everywhere. `requestResume`'s sixth parameter is the same in Tasks 6 and 7. `routeHandOffs`'s `source` has `'person'` from Task 7 on, and the enum value exists from Task 1.
- **Review Focus.** The answer-and-timeout race (Task 6 test). A halt with `timeoutRefusal` (Task 6 test). OBS-9 after a rejection (Task 4 control test, and `conductor-answers.test.ts:212` kept). An old `waiting_stale` card meeting the batch (Task 4 orchestrator test). A late answer's markers and NUL (Task 7 test).
