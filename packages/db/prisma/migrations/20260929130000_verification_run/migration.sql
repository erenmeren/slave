-- Conductor Plan 4b (spec R8), 2026-09-29: the verification run. A run of kind `verification` has
-- no task; `goalDeliveryId` is the goal version it verifies. PURELY ADDITIVE: one enum value (unused
-- here), one nullable column with its foreign key, one foreign key on a table Plan 4b's first
-- migration created empty.

ALTER TYPE "RunKind" ADD VALUE IF NOT EXISTS 'verification';
ALTER TABLE "SlaveRun" ADD COLUMN "goalDeliveryId" TEXT;
ALTER TABLE "SlaveRun" ADD CONSTRAINT "SlaveRun_goalDeliveryId_fkey" FOREIGN KEY ("goalDeliveryId") REFERENCES "GoalDelivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "SlaveRun_goalDeliveryId_idx" ON "SlaveRun"("goalDeliveryId");
ALTER TABLE "VerificationResult" ADD CONSTRAINT "VerificationResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SlaveRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
