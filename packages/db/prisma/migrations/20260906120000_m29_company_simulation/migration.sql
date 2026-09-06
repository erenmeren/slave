-- M29: company simulation runs beside the software workspaces. Additive only: three tables,
-- five enums, no change to any existing row or column.
CREATE TYPE "SimulationSector" AS ENUM ('trade');
CREATE TYPE "SimulationMode" AS ENUM ('simulation');
CREATE TYPE "DecisionProviderKind" AS ENUM ('rules');
CREATE TYPE "SimulationStatus" AS ENUM ('ready', 'running', 'paused', 'finished', 'halted');
CREATE TYPE "SimulationJournalKind" AS ENUM ('decision', 'action_applied', 'action_rejected', 'event', 'external_event', 'control');

CREATE TABLE "SimulationRun" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sector" "SimulationSector" NOT NULL,
  "mode" "SimulationMode" NOT NULL DEFAULT 'simulation',
  "decisionProvider" "DecisionProviderKind" NOT NULL DEFAULT 'rules',
  "seed" INTEGER NOT NULL,
  "definition" JSONB NOT NULL,
  "state" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "status" "SimulationStatus" NOT NULL DEFAULT 'ready',
  "simTime" INTEGER NOT NULL DEFAULT 0,
  "stepCount" INTEGER NOT NULL DEFAULT 0,
  "decisionCount" INTEGER NOT NULL DEFAULT 0,
  "haltedReason" TEXT,
  "clonedFromId" TEXT,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SimulationRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SimulationRun_companyId_name_key" ON "SimulationRun"("companyId", "name");
CREATE INDEX "SimulationRun_companyId_idx" ON "SimulationRun"("companyId");
ALTER TABLE "SimulationRun" ADD CONSTRAINT "SimulationRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SimulationRun" ADD CONSTRAINT "SimulationRun_clonedFromId_fkey" FOREIGN KEY ("clonedFromId") REFERENCES "SimulationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SimulationRun" ADD CONSTRAINT "SimulationRun_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "SimulationJournalEntry" (
  "id" TEXT NOT NULL,
  "simulationId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "simTime" INTEGER NOT NULL,
  "kind" "SimulationJournalKind" NOT NULL,
  "actorRole" TEXT,
  "payload" JSONB NOT NULL,
  "idempotencyKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SimulationJournalEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SimulationJournalEntry_simulationId_seq_key" ON "SimulationJournalEntry"("simulationId", "seq");
CREATE UNIQUE INDEX "SimulationJournalEntry_simulationId_idempotencyKey_key" ON "SimulationJournalEntry"("simulationId", "idempotencyKey");
CREATE INDEX "SimulationJournalEntry_simulationId_simTime_idx" ON "SimulationJournalEntry"("simulationId", "simTime");
ALTER TABLE "SimulationJournalEntry" ADD CONSTRAINT "SimulationJournalEntry_simulationId_fkey" FOREIGN KEY ("simulationId") REFERENCES "SimulationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SimulationModelUsage" (
  "id" TEXT NOT NULL,
  "simulationId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "provider" "ProviderKind" NOT NULL,
  "costUsd" DOUBLE PRECISION,
  "tokensIn" INTEGER,
  "tokensOut" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SimulationModelUsage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SimulationModelUsage_simulationId_idx" ON "SimulationModelUsage"("simulationId");
ALTER TABLE "SimulationModelUsage" ADD CONSTRAINT "SimulationModelUsage_simulationId_fkey" FOREIGN KEY ("simulationId") REFERENCES "SimulationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
