-- M37 t1: the recorded run context (spec §2) -- "record before spawn": this row exists before
-- the child process starts (`buildRunContext`, Task 2); a run without one never spawned.
-- `sections` carries the `Manifest` shape (`@slave-of-ai/domain`'s `runContextManifestSchema`
-- validates it at read); `prompt` is the exact text the model saw, in full. One row per run
-- (`runId` unique), cascading with it.
CREATE TABLE "RunContext" (
    "id"        TEXT NOT NULL,
    "runId"     TEXT NOT NULL,
    "prompt"    TEXT NOT NULL,
    "sections"  JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunContext_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RunContext_runId_key" ON "RunContext"("runId");

ALTER TABLE "RunContext" ADD CONSTRAINT "RunContext_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SlaveRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- `SlaveRun.suppliedMessageIds` (M36 t3) is superseded by `RunContext`'s `inbox` manifest
-- section, which is a strict superset (message ids plus the profile/skills/task/rejection
-- provenance the M36 column never carried). Its only readers were `apps/orchestrator/src/tick.ts`
-- (the write, ~line 615) and `tick.test.ts` (two assertions); M37 Task 1 removes both, leaving
-- the run's inbox ids UNRECORDED for the one commit between this task and Task 2, which restores
-- them via the `RunContext` row's `inbox` section -- see the M37 Task 1 commit body.
ALTER TABLE "SlaveRun" DROP COLUMN "suppliedMessageIds";
