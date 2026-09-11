-- M48 t1: the runbook table (R3), the three columns that carry a contract, a stage and an adopted
-- runbook (R1/R2/R5), and the two enum members (R5).
--
-- Additive: one new table, three new columns (all nullable), two new enum values. Nothing is
-- dropped and nothing is backfilled -- a null `handoff` is exactly "this task was planned before
-- contracts existed", and a null `stage` is "no runbook was adopted when this was planned".

CREATE TABLE "RunbookTemplate" (
    "id"                   TEXT NOT NULL,
    "key"                  TEXT NOT NULL,
    "name"                 TEXT NOT NULL,
    "description"          TEXT NOT NULL,
    "keywords"             TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "requiredCapabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "optionalCapabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "stages"               JSONB NOT NULL,
    "source"               TEXT NOT NULL DEFAULT 'seed',
    "sourceTemplateId"     TEXT,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RunbookTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RunbookTemplate_key_key" ON "RunbookTemplate"("key");
CREATE INDEX "RunbookTemplate_source_idx" ON "RunbookTemplate"("source");

ALTER TABLE "RunbookTemplate" ADD CONSTRAINT "RunbookTemplate_sourceTemplateId_fkey"
    FOREIGN KEY ("sourceTemplateId") REFERENCES "SlaveTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Workspace" ADD COLUMN "runbookId" TEXT;
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_runbookId_fkey"
    FOREIGN KEY ("runbookId") REFERENCES "RunbookTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Task" ADD COLUMN "handoff" JSONB;
ALTER TABLE "Task" ADD COLUMN "stage" TEXT;

-- M47 plan erratum E4's idiom: a situation kind is a Postgres enum member too.
ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'runbook_recommended';

-- The 50th event type. The VALUE is the dotted `@map` string, never the Prisma member name (plan
-- erratum E5); the idiom is `20260818201422_widen_event_type_for_m3`.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.runbook_adopted';
