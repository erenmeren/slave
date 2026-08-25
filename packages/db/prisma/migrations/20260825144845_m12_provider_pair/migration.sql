-- additive: new columns are nullable, and costUsd only loses its NOT NULL and its DEFAULT.
-- Existing rows keep their existing values -- no data is rewritten, no backfill.
ALTER TABLE "Agent"         ADD COLUMN "provider" "ProviderKind";
ALTER TABLE "AgentTemplate" ADD COLUMN "provider" "ProviderKind";
ALTER TABLE "CompanyAgent"  ADD COLUMN "provider" "ProviderKind";
ALTER TABLE "AgentRun"      ADD COLUMN "provider" "ProviderKind";
ALTER TABLE "Checkpoint"    ADD COLUMN "provider" "ProviderKind";
ALTER TABLE "AgentRun"      ALTER COLUMN "costUsd" DROP NOT NULL;
ALTER TABLE "AgentRun"      ALTER COLUMN "costUsd" DROP DEFAULT;
