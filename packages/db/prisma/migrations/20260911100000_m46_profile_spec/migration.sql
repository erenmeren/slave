-- M46 t1: the structured specialist profile (spec R1) and the two source facts R4 adds.
-- Additive, no backfill: a NULL `profileSpec` is what "this row has never been mapped" means, and
-- the next import of its catalog writes one. The Markdown `profile` column is unchanged and is
-- still the only thing a run is given.

ALTER TABLE "SlaveTemplate" ADD COLUMN "profileSpec" JSONB;
ALTER TABLE "SlaveTemplate" ADD COLUMN "profileOverrides" JSONB;
ALTER TABLE "SlaveTemplate" ADD COLUMN "sourceRevision" TEXT;
ALTER TABLE "SlaveTemplate" ADD COLUMN "sourceLicense" TEXT;
