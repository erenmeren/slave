-- Catalogue capability mapping (2026-09-20), R3: a model-chosen capability set beside the exact
-- matcher's, with the hash that says whether it is stale.
--
-- `capabilityKeys` keeps its meaning for every reader (the scheduler's projection, formTeam, the
-- catalogue filter, the person pool): it becomes the UNION of the exact matcher's keys and
-- `mappedCapabilityKeys`, written by every writer of the column. Keeping the model's half in its
-- own column is what lets `capabilities reconcile` re-derive the exact half without erasing the
-- mapped one, and what lets the drawer mark a chip as matched or mapped.
--
-- No backfill: no row has been mapped yet, so an empty array and a null hash IS the history.
ALTER TABLE "SlaveTemplate" ADD COLUMN "mappedCapabilityKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "SlaveTemplate" ADD COLUMN "capabilityMappingHash" TEXT;
ALTER TABLE "SlaveTemplate" ADD COLUMN "capabilityMappedAt" TIMESTAMP(3);
