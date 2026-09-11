-- M50 R1-R3: the worker lifecycle.
--
-- Additive, plus the ONE data statement R1 allows. Nothing else is backfilled: `createdAt` reads
-- back the moment this migration ran for every existing row, which is the only honest answer a
-- table that never recorded a hire date can give.

CREATE TYPE "SlaveLifecycle" AS ENUM ('permanent', 'project', 'ephemeral');

ALTER TABLE "Slave" ADD COLUMN "lifecycle"        "SlaveLifecycle" NOT NULL DEFAULT 'project';
ALTER TABLE "Slave" ADD COLUMN "engagementTaskId" TEXT;
ALTER TABLE "Slave" ADD COLUMN "releasedAt"       TIMESTAMP(3);
ALTER TABLE "Slave" ADD COLUMN "releaseReason"    TEXT;
ALTER TABLE "Slave" ADD COLUMN "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "Slave_engagementTaskId_idx" ON "Slave"("engagementTaskId");

ALTER TABLE "Slave" ADD CONSTRAINT "Slave_engagementTaskId_fkey"
    FOREIGN KEY ("engagementTaskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- THE ONE DATA STATEMENT (R1). A roster-linked worker EXISTS in the company roster, which is what
-- `permanent` means; the column default above would call every one of them a project hire, and the
-- Organization view would then say something false about workers nobody hired. Deterministic and
-- idempotent by construction: a constant written over a predicate the statement does not itself
-- change, so a second run writes the same rows to the same value.
UPDATE "Slave" SET "lifecycle" = 'permanent' WHERE "companySlaveId" IS NOT NULL;

-- M47 plan erratum E4's idiom: a situation kind is a Postgres enum member too.
ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'engagement_over';

-- The 53rd event type. The VALUE is the dotted `@map` string, never the Prisma member name (M48
-- plan erratum E5); the idiom is `20260818201422_widen_event_type_for_m3`.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'slave.released';
