-- F, talking to the Supervisor (2026-09-20): a conversation table and two provider/model settings
-- (spec R1, R4). Two enums, one table with a unique index and a plain index, one foreign key, and
-- two ALTER TABLE "Workspace" ADD COLUMN. PURELY ADDITIVE: nothing existing changes shape or type,
-- and every current row in every current table reads back exactly as it did.
-- `supervisorProvider`/`supervisorModel` default to NULL, which resolves to the installation
-- default (`SLAVEOFAI_SUPERVISOR_MODEL` or `SUPERVISOR_DEFAULT_MODEL`, provider `claude_code`) --
-- same treatment as E's `supervisorAutonomy` in `20260920150000_self_running_project`.

CREATE TYPE "SupervisorMessageRole" AS ENUM ('human', 'supervisor');
CREATE TYPE "SupervisorMessageStatus" AS ENUM ('sent', 'answering', 'answered', 'failed');

-- "attachments" and "actions" are JSONB, not columns or side tables: "attachments" is
-- `{ path, name, bytes, kind }[]` (R6) and "actions" is the reply's proposed actions
-- `{ action, decisionId, tier }[]` (R3), validated at read the way `SupervisorDecision.action`
-- already is. "unmeasured" is the same honesty rule as `SupervisorDecision.modelCalled` and
-- `Intake.unmeasuredCalls`: a call that was made but reported no cost is never charged at 0.
-- "claimedAt"/"claimedBy" are `tickSupervisorChat`'s claim under SKIP LOCKED, the
-- `Intake`/`tickIntakes` precedent.
CREATE TABLE "SupervisorMessage" (
    "id"            TEXT NOT NULL,
    "workspaceId"   TEXT NOT NULL,
    "seq"           INTEGER NOT NULL,
    "role"          "SupervisorMessageRole" NOT NULL,
    "status"        "SupervisorMessageStatus" NOT NULL DEFAULT 'sent',
    "text"          TEXT NOT NULL,
    "attachments"   JSONB NOT NULL DEFAULT '[]',
    "actions"       JSONB,
    "modelCostUsd"  DOUBLE PRECISION,
    "unmeasured"    BOOLEAN NOT NULL DEFAULT false,
    "claimedAt"     TIMESTAMP(3),
    "claimedBy"     TEXT,
    "failureReason" TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupervisorMessage_pkey" PRIMARY KEY ("id")
);

-- The order of a conversation, and its collision detector: two writers appending at the same
-- "seq" is one insert and one P2002, never two rows claiming to be the same line (the
-- `IntakeMessage_intakeId_seq_key` precedent).
CREATE UNIQUE INDEX "SupervisorMessage_workspaceId_seq_key" ON "SupervisorMessage"("workspaceId", "seq");
-- What `tickSupervisorChat` scans under SKIP LOCKED: the "answering" rows for this workspace.
CREATE INDEX "SupervisorMessage_workspaceId_status_idx" ON "SupervisorMessage"("workspaceId", "status");

-- CASCADE: a conversation is meaningless without the workspace it was about, and deleting a
-- project must not be blocked by its own thread.
ALTER TABLE "SupervisorMessage" ADD CONSTRAINT "SupervisorMessage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- R4: NULL means the installation default. `setSupervisorSettings` writes these, and the chat tick
-- is what resolves them: today they govern the workspace's CONVERSATION and nothing else (erratum
-- E10), while its decisions and its answers to workers take the daemon's own runtime.
ALTER TABLE "Workspace" ADD COLUMN "supervisorProvider" "ProviderKind";
ALTER TABLE "Workspace" ADD COLUMN "supervisorModel" TEXT;
