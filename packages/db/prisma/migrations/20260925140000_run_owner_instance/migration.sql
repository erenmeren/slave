-- H9b (F2), every run names the process that owns it (2026-09-25).
--
-- ONE nullable column. `<pid>/<uuid>`, minted once per process and written when the row is created
-- and when a resume spawns it. A run whose owner is gone -- a daemon that was killed, a one-shot
-- `tick` that crashed -- has a live child nobody reads, or no child at all; the sweep kills and
-- concludes it as a platform failure instead of waiting out the run timeout. Null on every row
-- written before this, which the sweep leaves to the arms that existed then.
ALTER TABLE "SlaveRun" ADD COLUMN "ownerInstance" TEXT;
