-- M51: the behavioural circuit breaker's state, and the model half of a run's runtime pair.
--
-- Additive throughout, and with NO DATA STATEMENT: every column is nullable or carries a default,
-- and no existing row means anything different under the new schema. A run recorded before M51 is
-- `breakerLevel = 'none'` with zero trips, which is exactly what it was.

CREATE TYPE "BreakerLevel" AS ENUM ('none', 'steered', 'constrained');

ALTER TABLE "SlaveRun" ADD COLUMN "breakerLevel" "BreakerLevel" NOT NULL DEFAULT 'none';
ALTER TABLE "SlaveRun" ADD COLUMN "breakerTrips" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SlaveRun" ADD COLUMN "breakerSteers" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SlaveRun" ADD COLUMN "breakerBeatAt" TIMESTAMP(3);
ALTER TABLE "SlaveRun" ADD COLUMN "breakerQuietBeats" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SlaveRun" ADD COLUMN "toolCallCap" INTEGER;
ALTER TABLE "SlaveRun" ADD COLUMN "model" TEXT;

-- `IF NOT EXISTS`, and each on its own statement: Postgres refuses `ALTER TYPE ... ADD VALUE`
-- inside a transaction block that then uses the new value, and Prisma runs a migration file as one
-- transaction -- the idiom every earlier migration in this directory uses for the same reason.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'run.tool_result';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'run.breaker';
ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'run_looping';
