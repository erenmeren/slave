-- Skeleton spec S7, 2026-09-30: the smoke gate. Before a goal version is verified the orchestrator
-- runs the project's own `scripts/smoke.sh` -- no model -- in a fresh checkout of the integration
-- tip, and a version is accepted only after a passing one.
--
-- `SmokeAttempt` is one attempt: its round, the commit it checked, its outcome, exit code, duration
-- and trimmed output, the process group it ran in and the process that owns it (so a daemon that
-- died mid-smoke can be told from one still running it). `GoalDelivery.activeSmokeId` is the claim
-- (the `activeRunId` idiom); `smokeRequired` is set for a delivery whose requirement set carries
-- RUN, so versions conducted before this migration are verified as they were.
-- `Workspace.smokeTimeoutMs` bounds one attempt (spec: 15 minutes). PURELY ADDITIVE: one enum type,
-- one table, defaulted or nullable columns, two enum values unused inside this transaction.

CREATE TYPE "SmokeOutcome" AS ENUM ('running', 'passed', 'missing', 'stub', 'failed', 'timed_out', 'error');

CREATE TABLE "SmokeAttempt" (
    "id"             TEXT NOT NULL,
    "workspaceId"    TEXT NOT NULL,
    "goalDeliveryId" TEXT NOT NULL,
    "goalVersion"    INTEGER NOT NULL,
    "round"          INTEGER NOT NULL,
    "tip"            TEXT NOT NULL,
    "status"         "SmokeOutcome" NOT NULL DEFAULT 'running',
    "exitCode"       INTEGER,
    "signal"         TEXT,
    "durationMs"     INTEGER,
    "output"         TEXT NOT NULL DEFAULT '',
    "pid"            INTEGER,
    "ownerInstance"  TEXT,
    "worktreePath"   TEXT,
    "reworkedTaskId" TEXT,
    "handOffTaskId"  TEXT,
    "handOffPath"    TEXT,
    "handOffChange"  TEXT,
    "startedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt"        TIMESTAMP(3),

    CONSTRAINT "SmokeAttempt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SmokeAttempt_goalDeliveryId_startedAt_idx" ON "SmokeAttempt"("goalDeliveryId", "startedAt");
ALTER TABLE "SmokeAttempt" ADD CONSTRAINT "SmokeAttempt_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SmokeAttempt" ADD CONSTRAINT "SmokeAttempt_goalDeliveryId_fkey" FOREIGN KEY ("goalDeliveryId") REFERENCES "GoalDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GoalDelivery" ADD COLUMN "activeSmokeId" TEXT;
CREATE UNIQUE INDEX "GoalDelivery_activeSmokeId_key" ON "GoalDelivery"("activeSmokeId");
ALTER TABLE "GoalDelivery" ADD COLUMN "smokeRequired" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Workspace" ADD COLUMN "smokeTimeoutMs" INTEGER NOT NULL DEFAULT 900000;

ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.smoke_run';
-- User ruling 2026-09-30 (plan B D11): the integration package handed a failed smoke's fix to the
-- skeleton, once per attempt; `SmokeAttempt.handOff*` records it.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.smoke_handed_off';
