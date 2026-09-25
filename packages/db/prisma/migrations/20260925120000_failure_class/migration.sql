-- H9b R1, a platform failure is not a worker failure (2026-09-25).
--
-- H4b's `spawnFailed` generalised: a run that failed before the model was ever asked was the first
-- kind of failure that spends nothing, and three more have been measured since -- a run concluded
-- by orphan reconciliation after a daemon crash (F4), a provider `api_error` (F5) and a timeout
-- decided on a sweep pass after the host slept (F11). One column says which side failed.
--
-- The backfill is the honest reading of what the old column knew: a spawn failure was `platform`;
-- every other failed run counted as the worker's, and keeps counting. Nothing can say after the
-- fact whether a failure recorded before today was an orphan or a rate limit, and a failure that
-- counted yesterday keeps counting today -- H4b's own rule for its own column.
CREATE TYPE "FailureClass" AS ENUM ('worker', 'platform');

ALTER TABLE "SlaveRun" ADD COLUMN "failureClass" "FailureClass";

UPDATE "SlaveRun" SET "failureClass" = 'platform' WHERE "spawnFailed";
UPDATE "SlaveRun" SET "failureClass" = 'worker' WHERE status = 'failed' AND NOT "spawnFailed";

ALTER TABLE "SlaveRun" DROP COLUMN "spawnFailed";
