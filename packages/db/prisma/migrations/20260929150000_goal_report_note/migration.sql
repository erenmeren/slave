-- Conductor Plan 5 (spec R10), 2026-09-29: the goal-version report's summary in the Supervisor chat.
--
-- A note is a Supervisor message no model wrote: the orchestrator posts a goal version's report
-- summary when the version comes to rest (merged, needs a person, abandoned, verified and waiting
-- for a hand merge). `noteKey` makes each note once-only per workspace, and `goalReportVersion` is
-- the version the panel links to. `GoalDelivery.reportNotedKey` is the resting point the last note
-- was posted for. It is BACKFILLED here for every delivery already at rest, so upgrading posts no
-- note for versions that came to rest before this migration. PURELY ADDITIVE: nullable columns,
-- one unique index (Postgres allows many NULLs under it), and one write to a new column.

ALTER TABLE "SupervisorMessage" ADD COLUMN "noteKey" TEXT;
ALTER TABLE "SupervisorMessage" ADD COLUMN "goalReportVersion" INTEGER;
CREATE UNIQUE INDEX "SupervisorMessage_workspaceId_noteKey_key" ON "SupervisorMessage"("workspaceId", "noteKey");

ALTER TABLE "GoalDelivery" ADD COLUMN "reportNotedKey" TEXT;
UPDATE "GoalDelivery" SET "reportNotedKey" = CASE
  WHEN "mergedAt" IS NOT NULL THEN 'merged'
  WHEN "status" = 'abandoned' THEN 'abandoned'
  WHEN "status" = 'needs_human' THEN 'needs_human:r' || "round"
  WHEN "status" = 'accepted' THEN 'awaiting_merge:r' || "round"
  ELSE NULL
END;
