-- M54: the mapping, the delivery fact table, one Json column and two event types.
--
-- ADDITIVE ONLY, with NO DATA STATEMENT AT ALL. Four enums, two tables, five indexes (three unique
-- -- `ExternalRepository.hookId`, `(source, repositoryFullName)` and `(hookId, deliveryId)` -- and
-- two secondary), one nullable `Json` column on `GoalVersion`, and two `EventType` members. Every
-- existing row, column, index and constraint is untouched, and no row anywhere is written by this
-- file: a mapping is made by an operator with `triggers map`, and an `InboundEvent` is written by a
-- delivery. That is ADR 0003's discipline and not a style choice.

CREATE TYPE "ExternalSource" AS ENUM ('github');
CREATE TYPE "ExternalEventKind" AS ENUM ('issue_opened', 'ci_failure', 'pr_event', 'deployment_failure', 'custom');
CREATE TYPE "InboundEventStatus" AS ENUM ('received', 'ignored', 'actioned');
CREATE TYPE "ExternalIgnoredReason" AS ENUM ('unmapped_repository', 'unrecognised_event', 'workspace_archived', 'request_refused');

CREATE TABLE "ExternalRepository" (
  "id"                 TEXT NOT NULL,
  "workspaceId"        TEXT NOT NULL,
  "source"             "ExternalSource" NOT NULL,
  "repositoryFullName" TEXT NOT NULL,
  "hookId"             TEXT NOT NULL,
  "secretEnvVar"       TEXT NOT NULL,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExternalRepository_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExternalRepository_hookId_key" ON "ExternalRepository"("hookId");
CREATE UNIQUE INDEX "ExternalRepository_source_repositoryFullName_key" ON "ExternalRepository"("source", "repositoryFullName");
CREATE INDEX "ExternalRepository_workspaceId_idx" ON "ExternalRepository"("workspaceId");
ALTER TABLE "ExternalRepository" ADD CONSTRAINT "ExternalRepository_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "InboundEvent" (
  "id"            TEXT NOT NULL,
  "hookId"        TEXT NOT NULL,
  "source"        "ExternalSource" NOT NULL,
  "deliveryId"    TEXT NOT NULL,
  "eventKind"     "ExternalEventKind" NOT NULL,
  "receivedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "workspaceId"   TEXT,
  "status"        "InboundEventStatus" NOT NULL DEFAULT 'received',
  "ignoredReason" "ExternalIgnoredReason",
  "goalVersion"   INTEGER,
  "payload"       JSONB NOT NULL,
  CONSTRAINT "InboundEvent_pkey" PRIMARY KEY ("id")
);
-- The replay guard. Not a pre-read: a pre-query-then-insert has a race between the two steps that
-- the constraint itself cannot have (`packages/control/src/prisma-errors.ts`'s own reasoning).
CREATE UNIQUE INDEX "InboundEvent_hookId_deliveryId_key" ON "InboundEvent"("hookId", "deliveryId");
CREATE INDEX "InboundEvent_workspaceId_receivedAt_idx" ON "InboundEvent"("workspaceId", "receivedAt");
-- No foreign key on "hookId" and none on "workspaceId": a delivery's record must survive its mapping
-- being removed, and a delivery for an unmapped repository has no workspace to point at.

ALTER TABLE "GoalVersion" ADD COLUMN "origin" JSONB;

-- `IF NOT EXISTS`, and each on its own statement: Postgres refuses `ALTER TYPE ... ADD VALUE` inside
-- a transaction block that then uses the new value, and Prisma runs a migration file as one
-- transaction -- the idiom every earlier migration in this directory uses for the same reason.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'external.received';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'external.actioned';
