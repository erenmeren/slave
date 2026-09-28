-- Conductor Plan 2 (spec R1, R2, R3, R5, R7), 2026-09-28: the conductor's data.
--
-- A conducted workspace turns each goal version into a numbered requirement set (R1), decides
-- single or partitioned (R2), splits the work into packages that own disjoint files (R3), and
-- every package worker files a structured report (R7). `ConductorCall` is the conductor's own
-- ledger of model calls: its retry cap, its cost (summed into the workspace's spend) and its
-- audit trail. PURELY ADDITIVE: two enum types, one enum-typed column with a default every
-- existing workspace reads as `planned` (today's planner graph, unchanged), one nullable column,
-- four tables, two enum values on existing types. Nothing existing changes shape.
--
-- `ALTER TYPE ... ADD VALUE` runs inside Prisma's per-migration transaction, which Postgres 12+
-- allows so long as the new value is not USED in the same transaction. Nothing here uses them.

CREATE TYPE "Delivery" AS ENUM ('conducted', 'planned');
CREATE TYPE "ConductorStage" AS ENUM ('requirements', 'conduct');
CREATE TYPE "ConductorCallOutcome" AS ENUM ('ok', 'failed');

ALTER TABLE "Workspace" ADD COLUMN "delivery" "Delivery" NOT NULL DEFAULT 'planned';

CREATE TABLE "RequirementSet" (
    "id"           TEXT NOT NULL,
    "workspaceId"  TEXT NOT NULL,
    "goalVersion"  INTEGER NOT NULL,
    "items"        JSONB NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequirementSet_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RequirementSet_workspaceId_goalVersion_key" ON "RequirementSet"("workspaceId", "goalVersion");
ALTER TABLE "RequirementSet" ADD CONSTRAINT "RequirementSet_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WorkPackage" (
    "id"              TEXT NOT NULL,
    "workspaceId"     TEXT NOT NULL,
    "goalVersion"     INTEGER NOT NULL,
    "key"             TEXT NOT NULL,
    "title"           TEXT NOT NULL,
    "requirementKeys" TEXT[] NOT NULL,
    "ownedPaths"      TEXT[] NOT NULL,
    "newPaths"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "interface"       TEXT NOT NULL,
    "dependsOn"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "isIntegration"   BOOLEAN NOT NULL DEFAULT false,
    "templateId"      TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkPackage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkPackage_workspaceId_goalVersion_key_key" ON "WorkPackage"("workspaceId", "goalVersion", "key");
ALTER TABLE "WorkPackage" ADD CONSTRAINT "WorkPackage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Task" ADD COLUMN "workPackageId" TEXT;
CREATE INDEX "Task_workPackageId_idx" ON "Task"("workPackageId");
ALTER TABLE "Task" ADD CONSTRAINT "Task_workPackageId_fkey" FOREIGN KEY ("workPackageId") REFERENCES "WorkPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "RunReport" (
    "id"            TEXT NOT NULL,
    "runId"         TEXT NOT NULL,
    "taskId"        TEXT NOT NULL,
    "workPackageId" TEXT NOT NULL,
    "report"        JSONB NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunReport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RunReport_runId_key" ON "RunReport"("runId");
CREATE INDEX "RunReport_workPackageId_idx" ON "RunReport"("workPackageId");
ALTER TABLE "RunReport" ADD CONSTRAINT "RunReport_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SlaveRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RunReport" ADD CONSTRAINT "RunReport_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RunReport" ADD CONSTRAINT "RunReport_workPackageId_fkey" FOREIGN KEY ("workPackageId") REFERENCES "WorkPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ConductorCall" (
    "id"           TEXT NOT NULL,
    "workspaceId"  TEXT NOT NULL,
    "goalVersion"  INTEGER NOT NULL,
    "stage"        "ConductorStage" NOT NULL,
    "outcome"      "ConductorCallOutcome" NOT NULL,
    "reason"       TEXT,
    "modelCostUsd" DOUBLE PRECISION,
    "unmeasured"   BOOLEAN NOT NULL DEFAULT false,
    "plan"         JSONB,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConductorCall_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ConductorCall_workspaceId_goalVersion_stage_idx" ON "ConductorCall"("workspaceId", "goalVersion", "stage");
ALTER TABLE "ConductorCall" ADD CONSTRAINT "ConductorCall_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'conduct';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.requirements_set';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.conducted';
