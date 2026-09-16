-- The point the circuit breaker counts its failure streak from.
--
-- Nullable and defaulted to nothing: a workspace that has never had a halt cleared counts its
-- streak exactly as it did before, so this migration changes no existing project's state.
ALTER TABLE "Workspace" ADD COLUMN "haltClearedAt" TIMESTAMP(3);
