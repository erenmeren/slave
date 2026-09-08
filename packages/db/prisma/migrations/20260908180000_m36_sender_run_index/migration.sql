-- M36 final review: an index for "the messages this run sent, latest first".
--
-- Three readers already share that shape and none of `SlaveMessage`'s existing indexes starts with
-- `senderRunId`: `deliverAnswers` (apps/orchestrator/src/deliver.ts) matches a waiting run to the
-- last question it asked on every tick that has one, and the two web surfaces that render
-- `waiting for <whoever was asked>` (apps/web/src/server/overview.ts, .../tasks.ts) read the same
-- rows for every waiting run on the board. All three filter on `senderRunId` and order by `seq`.
CREATE INDEX "SlaveMessage_senderRunId_seq_idx" ON "SlaveMessage"("senderRunId", "seq");
