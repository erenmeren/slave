-- The (runId, seq) read path overview.ts:277-285 named as the deferred fix; M18's skill-chain DTO
-- is its third consumer.
-- CreateIndex
CREATE INDEX IF NOT EXISTS "ExecutionEvent_runId_seq_idx" ON "ExecutionEvent"("runId", "seq");
