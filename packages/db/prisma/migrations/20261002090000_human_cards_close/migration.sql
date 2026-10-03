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
  AND NOT EXISTS (SELECT 1 FROM "SlaveRun" r WHERE r.id = m."senderRunId" AND r.status = 'paused' AND r."pauseReason" = 'waiting_for_answer')
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
