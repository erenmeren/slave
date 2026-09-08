-- M36 t3: the answer arrives and the worker resumes.
--
-- Two columns, no new table and no new enum value: the resume itself runs entirely on state that
-- already exists (`SlaveRun.resumeRequestedAt`/`queuedMessage`, claimed by `claimResume`), and an
-- answer is an ordinary `SlaveMessage` row with `kind = 'answer'` and `replyToId` pointing at the
-- question. What was missing was a place to record two facts a debugger cannot otherwise recover.

-- 1. Which answer woke which run, and when. This is a CLAIM column, not a log line: delivery
--    claims an answer with `UPDATE ... WHERE "deliveredAt" IS NULL`, so two deliveries racing over
--    the same answer -- two ticks, a daemon and a CLI, a replayed answer -- produce ONE resume
--    intent between them. Null on every question, every human instruction, and every answer not
--    yet delivered; cleared again when the resume it was claimed for is refused, so a transient
--    refusal does not permanently swallow an answer. Nullable with no default: the column is
--    "not yet", which is exactly what NULL means, and `SlaveMessage` needs no backfill (M36 t1's
--    own migration records that this table had zero writers before that task).
ALTER TABLE "SlaveMessage" ADD COLUMN "deliveredAt" TIMESTAMP(3);

-- 2. Which messages a run's prompt actually carried. The milestone's constraint keeps the
--    injection minimal -- only unanswered messages addressed to this slave -- and asks that the
--    ids be recorded so a later debugger can reconstruct the run's inputs. A column on the run,
--    not an event, because the question a debugger asks starts from a run id.
--
--    `NOT NULL DEFAULT ARRAY[]::TEXT[]`, the same DDL `Workspace.verifyCommands`/`setupCommands`
--    got in 20260818202734: an empty list is the honest reading for a run whose slave had no
--    pending messages (nearly every run), and a nullable array would make "carried nothing" and
--    "never recorded" the same value.
ALTER TABLE "SlaveRun" ADD COLUMN "suppliedMessageIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Delivery's own query: the answers to a given question. `replyToId` carried no index before this
-- (M36 t1 indexed the recipient, thread and idempotency shapes it needed, not this one), and
-- `deliverAnswers` reads by it on every tick that has a waiting run.
CREATE INDEX "SlaveMessage_replyToId_idx" ON "SlaveMessage"("replyToId");
