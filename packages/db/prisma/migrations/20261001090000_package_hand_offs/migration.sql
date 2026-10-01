-- Supervisor-as-conductor spec C2/C3, plan A (2026-10-01): hand-offs reach the package that owns
-- them, and shared decisions are made up front.
--
-- `PackageHandOff` is one request a package (or, from Plan B, the conductor's answer) made of
-- another package in the same goal version, with where it was delivered: shown in the target's
-- next prompt (`shownInRunId`), or the target's finished task reopened (`reopenedAt`), or a
-- conductor question (`questionMessageId`) when it has no target. `sourceKey` is unique per
-- workspace, so a replayed report routes nothing twice. `WorkPackage.handOffReopens` is the loop
-- guard's count (at most two per package per version).
--
-- `GoalDecision` is one shared decision of a goal version -- written by the conductor with its plan,
-- later (Plan B) by its answers -- listed in every package's contract. Unique by title per version.
--
-- PURELY ADDITIVE: three enum types, two tables, one defaulted column, one enum value unused inside
-- this transaction.

CREATE TYPE "PackageHandOffSource" AS ENUM ('report', 'answer');
CREATE TYPE "PackageHandOffStatus" AS ENUM ('pending', 'delivered', 'reopened', 'duplicate', 'own', 'to_conductor', 'expired');

CREATE TABLE "PackageHandOff" (
    "id"                TEXT NOT NULL,
    "workspaceId"       TEXT NOT NULL,
    "goalVersion"       INTEGER NOT NULL,
    "source"            "PackageHandOffSource" NOT NULL,
    "sourceKey"         TEXT NOT NULL,
    "fromRunId"         TEXT NOT NULL,
    "fromPackageKey"    TEXT,
    "toPackageKey"      TEXT,
    "path"              TEXT,
    "packageKey"        TEXT,
    "change"            TEXT NOT NULL,
    "fingerprint"       TEXT NOT NULL,
    "status"            "PackageHandOffStatus" NOT NULL,
    "note"              TEXT,
    "shownInRunId"      TEXT,
    "reopenedAt"        TIMESTAMP(3),
    "questionMessageId" TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PackageHandOff_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PackageHandOff_workspaceId_sourceKey_key" ON "PackageHandOff"("workspaceId", "sourceKey");
CREATE INDEX "PackageHandOff_workspaceId_goalVersion_toPackageKey_idx" ON "PackageHandOff"("workspaceId", "goalVersion", "toPackageKey");
ALTER TABLE "PackageHandOff" ADD CONSTRAINT "PackageHandOff_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TYPE "GoalDecisionSource" AS ENUM ('conductor_plan', 'conductor_answer', 'person');

CREATE TABLE "GoalDecision" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "goalVersion" INTEGER NOT NULL,
    "title"       TEXT NOT NULL,
    "titleKey"    TEXT NOT NULL,
    "decision"    TEXT NOT NULL,
    "source"      "GoalDecisionSource" NOT NULL,
    "questionId"  TEXT,
    "decisionId"  TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalDecision_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GoalDecision_workspaceId_goalVersion_titleKey_key" ON "GoalDecision"("workspaceId", "goalVersion", "titleKey");
ALTER TABLE "GoalDecision" ADD CONSTRAINT "GoalDecision_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkPackage" ADD COLUMN "handOffReopens" INTEGER NOT NULL DEFAULT 0;

ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.package_handed_off';
