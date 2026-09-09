-- M38 t1: the Supervisor's data model (spec §2). A Supervisor is a control-layer SERVICE, not a
-- `Slave` row, and its only output is a decision record -- every effect on the world goes through
-- an existing control verb (spec §1, "a decision is not work"). This table plus the five
-- `supervisor.*` events below are the whole audit trail.

-- The four closed vocabularies the decision row is typed on. `SupervisorSituationKind` mirrors
-- `SITUATION_KINDS` and the tier/status/decider enums mirror `TIERS`, `DECISION_STATUSES` and
-- `DECIDERS` in `packages/domain/src/supervisor/` -- member for member, in the same order. Nothing
-- in TypeScript enforces that; `packages/db/test/integration/enum-parity.test.ts` reads all four
-- back out of Postgres and compares them to the domain arrays, which is what keeps it honest.
CREATE TYPE "SupervisorSituationKind" AS ENUM ('no_reviewer', 'no_planner', 'review_cap_blocked', 'task_failed', 'task_blocked_human', 'waiting_stale', 'unanswerable_question', 'ready_unstaffed', 'done_not_integrated_stale', 'workspace_halted');

CREATE TYPE "SupervisorTier" AS ENUM ('applied', 'proposed', 'escalated', 'noop');

CREATE TYPE "SupervisorDecisionStatus" AS ENUM ('applied', 'pending', 'approved', 'rejected', 'expired', 'failed');

CREATE TYPE "SupervisorDecider" AS ENUM ('model', 'rules');

-- `situation`, `candidates` and `action` are JSONB rather than columns or side tables: they are
-- domain shapes (`Situation`, `Candidate[]`, `Action`), validated at READ by the zod schemas in
-- `@slave-of-ai/domain` -- the same treatment `RunContext.sections` (M37) gets. Storing the
-- catalogue exactly as it was offered is the point: a human reading this row months later must see
-- the choice that was actually available, not the one today's rules would rebuild.
--
-- `modelCostUsd` NULL is UNMEASURED, never zero -- the rule `SlaveRun.costUsd` already sets. An
-- unmeasured decision call is charged at `SUPERVISOR_PER_CALL_CAP_USD` when spend is summed, so a
-- cost-blind runtime can never make Supervisor calls look free to the budget guardrail.
CREATE TABLE "SupervisorDecision" (
    "id"               TEXT NOT NULL,
    "workspaceId"      TEXT NOT NULL,
    "situationKind"    "SupervisorSituationKind" NOT NULL,
    "subjectId"        TEXT NOT NULL,
    "situation"        JSONB NOT NULL,
    "candidates"       JSONB NOT NULL,
    "chosenIndex"      INTEGER NOT NULL,
    "action"           JSONB NOT NULL,
    "rationale"        TEXT NOT NULL,
    "tier"             "SupervisorTier" NOT NULL,
    "status"           "SupervisorDecisionStatus" NOT NULL,
    "decidedBy"        "SupervisorDecider" NOT NULL,
    "modelCostUsd"     DOUBLE PRECISION,
    "failureReason"    TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"        TIMESTAMP(3),
    "resolvedAt"       TIMESTAMP(3),
    "resolvedByUserId" TEXT,

    CONSTRAINT "SupervisorDecision_pkey" PRIMARY KEY ("id")
);

-- "recent decisions for this project, newest first" -- the web panel, the CLI listing, and the
-- window the world loader reads for `filterFresh` and `summarise`.
CREATE INDEX "SupervisorDecision_workspaceId_createdAt_idx" ON "SupervisorDecision"("workspaceId", "createdAt");

-- The situation KEY `(workspaceId, situationKind, subjectId)` plus time: what `recordDecision`
-- reads to refuse a second decision while one is open, or inside `COOLDOWN_MS` of the last one.
CREATE INDEX "SupervisorDecision_workspaceId_situationKind_subjectId_crea_idx" ON "SupervisorDecision"("workspaceId", "situationKind", "subjectId", "createdAt");

-- CASCADE: a decision is meaningless without the workspace it was about, and deleting a project
-- must not be blocked by its Supervisor's history. Deliberately NO foreign key on
-- `resolvedByUserId` -- the row must survive the deletion of the account that approved it, the
-- same reasoning `Workspace.goalSetByUserId` documents (which uses SetNull because it HAS a
-- relation; this column is a plain record of who, with no relation to keep in step).
ALTER TABLE "SupervisorDecision" ADD CONSTRAINT "SupervisorDecision_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A workspace can only NARROW the Supervisor, never widen it (spec §1): `supervisorEnabled=false`
-- makes it report-only and `recordDecision` refuses `supervisor_disabled`. DEFAULT true, so every
-- existing project gets a Supervisor when this lands -- which is the milestone's whole point.
-- `supervisorProfile` is the persona prepended to the decision prompt, under M37's profile rules
-- (`PROFILE_MAX_CHARS` on write, `neutraliseMarkers` on render).
ALTER TABLE "Workspace" ADD COLUMN     "supervisorEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "supervisorProfile" TEXT;

-- The Supervisor's five events. `ALTER TYPE ... ADD VALUE` runs inside Prisma's per-migration
-- transaction, which Postgres 12+ permits as long as the new value is not USED in the same
-- transaction -- nothing above or below uses any of them. `IF NOT EXISTS` makes re-running this a
-- no-op. (Same shape as `20260908200000_m37_profile_role_events`.)
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'supervisor.decided';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'supervisor.proposed';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'supervisor.applied';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'supervisor.resolved';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'supervisor.failed';
