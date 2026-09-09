-- M39 t2: the mailbox's two data-model changes (spec §2).

-- The draft an `answer_question` decision was made on: the answer text, the citations that
-- verified and the ones that did not, the critical signals, and -- once a human approves with an
-- edit -- what they typed instead. Nullable, and null for every other action: it is the only
-- action that puts a model's words in front of a worker. JSONB, validated at read by the domain's
-- `draftSchema`, the same treatment `situation`/`candidates`/`action` already get on this table.
ALTER TABLE "SupervisorDecision" ADD COLUMN "draft" JSONB;

-- A question re-addressed to a worker who can answer it (`reassignQuestion`). Not a
-- `slave.message_sent`: no message was sent -- the question row itself moved, its
-- `recipientSlaveId` set and its `recipientRole` cleared -- and the log has to say which of the
-- two happened. `IF NOT EXISTS` so a database that already took this value (a re-run, a hand
-- applied fix) is left alone rather than failing the deploy.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'slave.message_reassigned';
