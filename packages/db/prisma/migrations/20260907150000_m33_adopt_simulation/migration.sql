-- M33: the simulation run a workspace's organisation was adopted from (design §2). Additive and
-- nullable: every workspace assigned by hand reads back null, and ON DELETE SET NULL keeps a
-- project alive when the run it was adopted from is deleted.
ALTER TABLE "Workspace" ADD COLUMN "adoptedFromSimulationId" TEXT;
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_adoptedFromSimulationId_fkey" FOREIGN KEY ("adoptedFromSimulationId") REFERENCES "SimulationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Workspace_adoptedFromSimulationId_idx" ON "Workspace"("adoptedFromSimulationId");
