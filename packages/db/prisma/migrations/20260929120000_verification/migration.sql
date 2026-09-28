-- Conductor Plan 4b (spec R8, R9, R11), 2026-09-29: nothing reaches the base branch until every
-- requirement is verified.
--
-- A goal version whose packages are integrated is verified by a run of its own (`verifying`); its
-- per-requirement evidence is `VerificationResult` (the check the verifier wrote, its trimmed
-- output, the reason). `round` counts verification rounds, `roundBase` is where the round cap
-- counts from after a person's `retry-goal`, `roundRunFailures` counts verification runs of the
-- current round that produced no usable verdict. `activeRunId` is the claim on the live
-- verification run. `needs_human` is where a cap ends the loop. PURELY ADDITIVE: enum values
-- unused inside this transaction (Postgres 12+ rule for `ADD VALUE`), nullable or defaulted columns,
-- one enum type, one table.

ALTER TYPE "GoalDeliveryStatus" ADD VALUE IF NOT EXISTS 'verifying';
ALTER TYPE "GoalDeliveryStatus" ADD VALUE IF NOT EXISTS 'needs_human';

ALTER TABLE "GoalDelivery" ADD COLUMN "round" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GoalDelivery" ADD COLUMN "roundBase" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GoalDelivery" ADD COLUMN "roundRunFailures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GoalDelivery" ADD COLUMN "activeRunId" TEXT;
ALTER TABLE "GoalDelivery" ADD COLUMN "needsHumanReason" TEXT;
ALTER TABLE "GoalDelivery" ADD COLUMN "verifierSlaveId" TEXT;
-- Controller ruling Q6: the integration tip the latest PASSING verification checked -- the final
-- merge lands only this commit (spec ruling 5). No code reads or writes it yet (Task 5/6).
ALTER TABLE "GoalDelivery" ADD COLUMN "verifiedCommit" TEXT;
CREATE UNIQUE INDEX "GoalDelivery_activeRunId_key" ON "GoalDelivery"("activeRunId");

ALTER TABLE "Workspace" ADD COLUMN "verificationRoundCap" INTEGER NOT NULL DEFAULT 3;

CREATE TYPE "VerificationStatus" AS ENUM ('pass', 'fail', 'unverifiable');

CREATE TABLE "VerificationResult" (
    "id"             TEXT NOT NULL,
    "workspaceId"    TEXT NOT NULL,
    "goalDeliveryId" TEXT NOT NULL,
    "goalVersion"    INTEGER NOT NULL,
    "round"          INTEGER NOT NULL,
    "runId"          TEXT NOT NULL,
    "key"            TEXT NOT NULL,
    "status"         "VerificationStatus" NOT NULL,
    "check"          TEXT NOT NULL,
    "output"         TEXT NOT NULL,
    "reason"         TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationResult_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VerificationResult_runId_key_key" ON "VerificationResult"("runId", "key");
CREATE INDEX "VerificationResult_goalDeliveryId_round_idx" ON "VerificationResult"("goalDeliveryId", "round");
ALTER TABLE "VerificationResult" ADD CONSTRAINT "VerificationResult_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VerificationResult" ADD CONSTRAINT "VerificationResult_goalDeliveryId_fkey" FOREIGN KEY ("goalDeliveryId") REFERENCES "GoalDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.verification_started';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.verified';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.goal_needs_human';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.goal_retried';

ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'verification_failed';
ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'goal_needs_human';
