-- H9b (F11b), the run timeout measures observed working time (2026-09-25).
--
-- TWO columns and nothing else. PURELY ADDITIVE: `observedWorkingMs` defaults to zero and
-- `observedAt` to nothing, so every existing row reads back as a run the sweep has not yet seen --
-- and the next pass measures it from `startedAt`, capped at one beat.
--
-- The sweep adds the gap since its previous look at a live run, capped at `BREAKER_BEAT_MS`, and
-- compares the sum with `runTimeoutMs`. On 2026-09-22 the host slept for fifteen hours; on wake the
-- sweep read `startedAt` against a thirty-minute limit, timed out three runs whose workers had done
-- nothing wrong, and the breaker halted the project for them. A sleep of any length now adds one
-- beat at most.
ALTER TABLE "SlaveRun" ADD COLUMN "observedWorkingMs" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SlaveRun" ADD COLUMN "observedAt" TIMESTAMP(3);
