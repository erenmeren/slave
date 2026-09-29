-- Conductor Plan 4b (controller rulings Q5/Q6), 2026-09-29: what a verification run checked out and
-- the state its worktree was in when the verifier started. The tip becomes the goal version's
-- `verifiedCommit` on a pass; the baseline is what the tamper check compares the worktree against
-- at the conclusion (recorded after the setup commands, so a setup that dirties a tracked file does
-- not discard every verification). On the run row, where a verifier's shell cannot rewrite it.
-- PURELY ADDITIVE: two nullable columns, no default, no backfill.

ALTER TABLE "SlaveRun" ADD COLUMN "verificationTip" TEXT;
ALTER TABLE "SlaveRun" ADD COLUMN "verificationBaseline" JSONB;
