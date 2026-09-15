-- M59: the conversation a project begins as, and the first installation-level row.
--
-- PURELY ADDITIVE and with NO DATA STATEMENT at all. Two enums, three tables, four indexes (two
-- unique) and four foreign keys. Nothing is dropped, no column changes type, and every existing
-- row in every existing table reads back byte for byte as it did -- the only touch to an existing
-- table is the two FOREIGN KEYs pointing AT "Workspace" and "User" from the new one, which change
-- neither of them.
--
-- The proof is M42 erratum E23's: `npx prisma migrate diff --from-config-datasource --to-schema
-- packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts` must report "No
-- difference detected" after this runs, so nothing here may be a shape the Prisma schema cannot
-- express.

CREATE TYPE "IntakeStatus" AS ENUM ('open', 'awaiting_reply', 'replying', 'drafted', 'creating', 'created', 'failed', 'abandoned');
CREATE TYPE "IntakeRole" AS ENUM ('human', 'assistant', 'fact');

CREATE TABLE "Intake" (
  "id"              TEXT NOT NULL,
  "status"          "IntakeStatus" NOT NULL DEFAULT 'open',
  "draft"           JSONB,
  "modelCalls"      INTEGER NOT NULL DEFAULT 0,
  "modelCostUsd"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  "unmeasuredCalls" INTEGER NOT NULL DEFAULT 0,
  "claimedAt"       TIMESTAMP(3),
  "claimedBy"       TEXT,
  "workspaceId"     TEXT,
  "stepLog"         JSONB NOT NULL DEFAULT '[]',
  "failureReason"   TEXT,
  "userId"          TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Intake_pkey" PRIMARY KEY ("id")
);

-- One intake creates at most one project, and a project is created by at most one intake. The
-- unique is what makes `workspaceSpend`'s intake term a single indexed read rather than an
-- aggregate (M59 plan erratum E2).
CREATE UNIQUE INDEX "Intake_workspaceId_key" ON "Intake"("workspaceId");
-- What `claimIntakes` scans under its row lock: due rows, oldest first.
CREATE INDEX "Intake_status_updatedAt_idx" ON "Intake"("status", "updatedAt");

ALTER TABLE "Intake" ADD CONSTRAINT "Intake_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Intake" ADD CONSTRAINT "Intake_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "IntakeMessage" (
  "id"        TEXT NOT NULL,
  "intakeId"  TEXT NOT NULL,
  "seq"       INTEGER NOT NULL,
  "role"      "IntakeRole" NOT NULL,
  "text"      TEXT NOT NULL,
  "facts"     JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "IntakeMessage_pkey" PRIMARY KEY ("id")
);

-- The order of a conversation, and its collision detector: two writers appending at the same
-- `seq` is one insert and one P2002, never two rows claiming to be the same line.
CREATE UNIQUE INDEX "IntakeMessage_intakeId_seq_key" ON "IntakeMessage"("intakeId", "seq");

ALTER TABLE "IntakeMessage" ADD CONSTRAINT "IntakeMessage_intakeId_fkey"
  FOREIGN KEY ("intakeId") REFERENCES "Intake"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "InstallationSettings" (
  "id"        TEXT NOT NULL DEFAULT 'installation',
  "reposRoot" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "InstallationSettings_pkey" PRIMARY KEY ("id")
);
