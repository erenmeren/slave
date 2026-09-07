-- M31a: an `llm` decision provider for a simulation run. Additive only.
ALTER TYPE "DecisionProviderKind" ADD VALUE IF NOT EXISTS 'llm';
ALTER TABLE "SimulationRun" ADD COLUMN "modelProvider" "ProviderKind", ADD COLUMN "model" TEXT, ADD COLUMN "maxModelCostUsd" DOUBLE PRECISION;
ALTER TABLE "SimulationModelUsage" ADD COLUMN "simTime" INTEGER, ADD COLUMN "role" TEXT;
