-- M53: the fact table, the staffing decision, and one event type.
--
-- ADDITIVE ONLY, and with NO DATA STATEMENT AT ALL -- the one difference from M52's migration in
-- this directory. Two enums, two tables, three indexes and one `EventType` member; every existing
-- row, column, index and constraint is untouched. The HISTORY arrives from
-- `scripts/backfill-evidence.mjs` (R7), run once by an operator, which calls the same
-- `recordRunEvidence` the pipeline calls -- so there is one derivation rather than a second one
-- written in SQL that could disagree with it. That is ADR 0003's discipline and not a style choice.

CREATE TYPE "EvidenceOutcome" AS ENUM ('succeeded', 'failed', 'stopped');
CREATE TYPE "EvidenceCostProvenance" AS ENUM ('reported', 'estimated', 'unmeasured');

CREATE TABLE "EvidenceRecord" (
  "id"                 TEXT NOT NULL,
  "runId"              TEXT NOT NULL,
  "workspaceId"        TEXT NOT NULL,
  "slaveId"            TEXT NOT NULL,
  "taskId"             TEXT,
  "profileKey"         TEXT NOT NULL,
  "profileName"        TEXT NOT NULL,
  "model"              TEXT,
  "repositoryKey"      TEXT NOT NULL,
  "domains"            TEXT[],
  "runKind"            "RunKind" NOT NULL,
  "attempt"            INTEGER NOT NULL,
  "outcome"            "EvidenceOutcome" NOT NULL,
  "verifiedFirstPass"  BOOLEAN,
  "reviewRejected"     BOOLEAN,
  "integrated"         BOOLEAN,
  "reworkCycles"       INTEGER NOT NULL DEFAULT 0,
  "humanInterventions" INTEGER NOT NULL DEFAULT 0,
  "recoveries"         INTEGER NOT NULL DEFAULT 0,
  "durationMs"         INTEGER,
  "actualCostUsd"      DOUBLE PRECISION,
  "costProvenance"     "EvidenceCostProvenance" NOT NULL,
  "recordedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt"          TIMESTAMP(3),
  CONSTRAINT "EvidenceRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EvidenceRecord_runId_key" ON "EvidenceRecord"("runId");
CREATE INDEX "EvidenceRecord_profileKey_model_repositoryKey_idx" ON "EvidenceRecord"("profileKey", "model", "repositoryKey");
CREATE INDEX "EvidenceRecord_workspaceId_idx" ON "EvidenceRecord"("workspaceId");
-- The first GIN index in this schema. A btree cannot answer `domains && ARRAY[...]`, which is the
-- only way the domain facet is ever read.
CREATE INDEX "EvidenceRecord_domains_idx" ON "EvidenceRecord" USING GIN ("domains" array_ops);
ALTER TABLE "EvidenceRecord" ADD CONSTRAINT "EvidenceRecord_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StaffingPreference" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "capability"  TEXT NOT NULL,
  "templateId"  TEXT,
  "model"       TEXT,
  "setBy"       TEXT,
  "setAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StaffingPreference_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StaffingPreference_workspaceId_capability_key" ON "StaffingPreference"("workspaceId", "capability");
ALTER TABLE "StaffingPreference" ADD CONSTRAINT "StaffingPreference_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- `IF NOT EXISTS`, and on its own statement: Postgres refuses `ALTER TYPE ... ADD VALUE` inside a
-- transaction block that then uses the new value, and Prisma runs a migration file as one
-- transaction -- the idiom every earlier migration in this directory uses for the same reason.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'staffing.preference_changed';
