-- M30: auto-run intent and watermark on a simulation run. Additive only; `decisionCount` keeps
-- its column name and is exposed as `actionCount` by the client (@map), no data change.
ALTER TABLE "SimulationRun" ADD COLUMN "autoRunEveryMs" INTEGER;
ALTER TABLE "SimulationRun" ADD COLUMN "autoRunUntilDay" INTEGER;
ALTER TABLE "SimulationRun" ADD COLUMN "lastAutoStepAt" TIMESTAMP(3);
