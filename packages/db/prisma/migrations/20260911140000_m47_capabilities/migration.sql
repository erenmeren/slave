-- M47 t1: the capability taxonomy (R1), the advisory collaboration edges (R5), and the four
-- columns that let a task ask for a capability and a worker provide one (R2/R4).
--
-- Additive: two new tables, five new columns with defaults, one new enum member. Nothing is
-- dropped, nothing is backfilled, and every existing row reads back exactly as it did -- an empty
-- `requiredCapabilities` is what "this task was planned before capabilities existed" means, and
-- `requiredRole` still decides its dispatch.

CREATE TABLE "Capability" (
    "key"       TEXT NOT NULL,
    "label"     TEXT NOT NULL,
    "domain"    TEXT NOT NULL,
    "role"      TEXT NOT NULL,
    "synonyms"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdBy" TEXT NOT NULL DEFAULT 'seed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Capability_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "Capability_domain_idx" ON "Capability"("domain");

CREATE TABLE "CollaborationHint" (
    "id"               TEXT NOT NULL,
    "templateId"       TEXT NOT NULL,
    "text"             TEXT NOT NULL,
    "targetTemplateId" TEXT,
    "capability"       TEXT,
    "source"           TEXT NOT NULL DEFAULT 'import',

    CONSTRAINT "CollaborationHint_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CollaborationHint_templateId_text_key" ON "CollaborationHint"("templateId", "text");
CREATE INDEX "CollaborationHint_targetTemplateId_idx" ON "CollaborationHint"("targetTemplateId");

ALTER TABLE "CollaborationHint" ADD CONSTRAINT "CollaborationHint_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "SlaveTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CollaborationHint" ADD CONSTRAINT "CollaborationHint_targetTemplateId_fkey"
    FOREIGN KEY ("targetTemplateId") REFERENCES "SlaveTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Task" ADD COLUMN "requiredCapabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "Slave" ADD COLUMN "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Slave" ADD COLUMN "selectionRationale" TEXT;
ALTER TABLE "Slave" ADD COLUMN "hiredFromTemplateId" TEXT;
ALTER TABLE "Slave" ADD CONSTRAINT "Slave_hiredFromTemplateId_fkey"
    FOREIGN KEY ("hiredFromTemplateId") REFERENCES "SlaveTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SlaveTemplate" ADD COLUMN "capabilityKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "SlaveTemplate" ADD COLUMN "unresolvedCapabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Plan erratum E4: a situation kind is a Postgres enum member, not only a TypeScript union member.
-- `ALTER TYPE ... ADD VALUE` runs inside Prisma's per-migration transaction, which Postgres 12+
-- permits as long as the new value is not USED in the same transaction. Nothing here uses it.
-- (The idiom is `20260910120000_m40_requirement_versioning`'s own, for `stale_task`.)
ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'capability_unstaffed';
