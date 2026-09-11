-- M49 t1: organisational memory (R1), its two events (R4) and the 14th situation (R2).
--
-- Additive: four new enums, two new tables, two new EventType values, one new
-- SupervisorSituationKind value. Nothing is dropped and nothing is backfilled -- an organisation
-- that has learnt nothing yet has an empty table, which is the honest state of every project that
-- existed before this milestone.

CREATE TYPE "MemoryType" AS ENUM ('fact', 'decision', 'procedure', 'lesson', 'observation', 'hypothesis');
CREATE TYPE "MemoryScope" AS ENUM ('company', 'workspace', 'worker');
CREATE TYPE "MemoryStatus" AS ENUM ('candidate', 'verified', 'superseded', 'removed');
CREATE TYPE "MemorySourceKind" AS ENUM ('run_output', 'verification', 'review', 'decision', 'goal', 'human', 'condensation');

CREATE TABLE "Memory" (
    "id"              TEXT NOT NULL,
    "type"            "MemoryType" NOT NULL,
    "scope"           "MemoryScope" NOT NULL,
    "companyId"       TEXT,
    "workspaceId"     TEXT,
    "slaveId"         TEXT,
    "title"           TEXT NOT NULL,
    "body"            TEXT NOT NULL,
    "status"          "MemoryStatus" NOT NULL DEFAULT 'candidate',
    "confidence"      TEXT NOT NULL DEFAULT 'interpretation',
    "sourceKind"      "MemorySourceKind" NOT NULL,
    "sourceRef"       TEXT,
    "createdBy"       "Actor" NOT NULL,
    "createdByUserId" TEXT,
    "taskId"          TEXT,
    "runId"           TEXT,
    "goalVersion"     INTEGER,
    "capabilities"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "verifiedAt"      TIMESTAMP(3),
    "verifiedBy"      TEXT,
    "supersededById"  TEXT,
    "removedReason"   TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Memory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Memory_workspaceId_status_type_createdAt_idx" ON "Memory"("workspaceId", "status", "type", "createdAt");
CREATE INDEX "Memory_slaveId_status_type_createdAt_idx" ON "Memory"("slaveId", "status", "type", "createdAt");
CREATE INDEX "Memory_companyId_status_type_createdAt_idx" ON "Memory"("companyId", "status", "type", "createdAt");
CREATE INDEX "Memory_taskId_idx" ON "Memory"("taskId");

ALTER TABLE "Memory" ADD CONSTRAINT "Memory_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_slaveId_fkey"
    FOREIGN KEY ("slaveId") REFERENCES "Slave"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "SlaveRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_supersededById_fkey"
    FOREIGN KEY ("supersededById") REFERENCES "Memory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "MemorySource" (
    "memoryId"       TEXT NOT NULL,
    "sourceMemoryId" TEXT NOT NULL,

    CONSTRAINT "MemorySource_pkey" PRIMARY KEY ("memoryId", "sourceMemoryId")
);

CREATE INDEX "MemorySource_sourceMemoryId_idx" ON "MemorySource"("sourceMemoryId");

ALTER TABLE "MemorySource" ADD CONSTRAINT "MemorySource_memoryId_fkey"
    FOREIGN KEY ("memoryId") REFERENCES "Memory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemorySource" ADD CONSTRAINT "MemorySource_sourceMemoryId_fkey"
    FOREIGN KEY ("sourceMemoryId") REFERENCES "Memory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- M47 plan erratum E4's idiom: a situation kind is a Postgres enum member too.
ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'memory_candidates_piling';

-- The 51st and 52nd event types. The VALUE is the dotted `@map` string, never the Prisma member
-- name (M48 plan erratum E5); the idiom is `20260818201422_widen_event_type_for_m3`.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'memory.recorded';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'memory.changed';
