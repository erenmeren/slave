-- Supervisor-as-conductor spec C4, plan B (2026-10-01): a question to the conductor is its own
-- situation, answered from the goal version's plan in one batched call per version and tick.
--
-- `conductor_question` replaces `unanswerable_question` for questions to the conductor role, which no
-- seat holds by design. `ConductorStage.answer` is the batched call's ledger stage, and
-- `ConductorCall.questionIds` names the questions a call carried -- the retry cap counts the calls a
-- question was in since it was last decided.
--
-- PURELY ADDITIVE: two enum values unused inside this transaction, one defaulted column.

ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'conductor_question';
ALTER TYPE "ConductorStage" ADD VALUE IF NOT EXISTS 'answer';
ALTER TABLE "ConductorCall" ADD COLUMN "questionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
