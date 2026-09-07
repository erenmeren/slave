-- M31a Task 4 (review round 1, Minor #4): one usage row per (run, seq). `applyModelDecision`
-- computes its `seq` as `max(seq) + 1` under the run's row lock, so two passes cannot pick the
-- same number today -- this is the database saying so, rather than the lock being the only thing
-- that does, and it is what makes `usageSeq` on a decision row a stable reference.
CREATE UNIQUE INDEX "SimulationModelUsage_simulationId_seq_key" ON "SimulationModelUsage"("simulationId", "seq");
