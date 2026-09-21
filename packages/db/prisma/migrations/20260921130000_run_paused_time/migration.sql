-- H8, paused time is not running time (2026-09-21).
--
-- TWO columns and nothing else. PURELY ADDITIVE: `pausedAt` is nullable and defaulted to nothing,
-- `pausedMs` defaults to zero, so every existing row reads back as a run that has never been
-- parked -- which is the reading the sweep's run-timeout arithmetic gave it before this existed.
--
-- `pausedAt` is written by the three pause routes (the gate pause and the Cursor pause in
-- `pump.ts`, the waiting-for-answer pause in `ask.ts`) at the moment the row becomes `paused`, and
-- cleared by `claimResume`, which adds the elapsed span to `pausedMs` in the same statement. The
-- sweep's `runTimeoutMs` check then subtracts both: on 2026-09-21 three runs that had worked for
-- four minutes were killed together on resume, because they had sat `paused` for four hours behind
-- a halt and `startedAt` was the only clock the timeout read.
ALTER TABLE "SlaveRun" ADD COLUMN "pausedAt" TIMESTAMP(3);
ALTER TABLE "SlaveRun" ADD COLUMN "pausedMs" INTEGER NOT NULL DEFAULT 0;
