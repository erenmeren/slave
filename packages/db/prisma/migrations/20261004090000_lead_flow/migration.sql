-- Lead-flow spec (2026-10-04), plan A: one lead builds a goal version and Slave proves it.
--
-- `Workspace.flow` is the switch: `packages` is every project as it runs today, `lead` hands the
-- whole goal to one lead session. `goalTimeLimitMs` is the goal version's working-time limit
-- (null: none). `leadRoster` is the person ids the lead's subordinate sessions are defined from.
--
-- `GoalDelivery.leadState` is the one-word state of spec section 3 for a lead-flow version (null on
-- every other); `stopReason` is why its loop ended; `leadProgress` is what the proof loop carries
-- between rounds (validated at read by `leadProgressSchema`).
--
-- `SlaveRun.leadTurn` marks a run as one turn of a lead's session and says what the turn is for;
-- `leadResumed` says the turn was spawned onto the previous turn's session. `verificationKeys` are
-- the requirement keys a verification run checks (empty: the whole set); `confirmsRunId` is the
-- verification run whose failures a confirmation run re-checks.
--
-- `GoalDecisionSource.lead`: a decision the lead recorded in docs/DECISIONS.md.
--
-- PURELY ADDITIVE: three enum types, nullable or defaulted columns, three enum values unused
-- inside this transaction. No existing row changes.

CREATE TYPE "WorkspaceFlow" AS ENUM ('packages', 'lead');
CREATE TYPE "LeadState" AS ENUM ('building', 'proving', 'delivered', 'awaiting_decision', 'stopped');
CREATE TYPE "LeadTurn" AS ENUM ('build', 'rework', 'wrap_up', 'continue', 'answer', 'base');

ALTER TABLE "Workspace"
    ADD COLUMN "flow"            "WorkspaceFlow" NOT NULL DEFAULT 'packages',
    ADD COLUMN "goalTimeLimitMs" INTEGER,
    ADD COLUMN "leadRoster"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "GoalDelivery"
    ADD COLUMN "leadState"    "LeadState",
    ADD COLUMN "stopReason"   TEXT,
    ADD COLUMN "leadProgress" JSONB;

ALTER TABLE "SlaveRun"
    ADD COLUMN "leadTurn"         "LeadTurn",
    ADD COLUMN "leadResumed"      BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "verificationKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "confirmsRunId"    TEXT;

ALTER TYPE "GoalDecisionSource" ADD VALUE IF NOT EXISTS 'lead';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.lead_state';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.lead_noted';
