-- WHY: without this row a database that is MIGRATED to M12 rather than reseeded stops dispatching.
-- `workspaceDefaultProvider` returns null for a workspace with no `ProviderConfiguration` row, no
-- workspace that predates M12 has one, and every `startRun`/`dispatchPlanning`/`dispatchReview`
-- then throws "no runtime could be resolved" -- which `failToStart` counts as an attempt, so within
-- a few ticks every task on the board is `blocked` with nothing naming the missing row.
--
-- Additive, in the sense the milestone's constraint means: one INSERT, no UPDATE, no DELETE, no
-- column touched, and no existing row rewritten. What it records is a historical FACT, not a
-- guess -- the same one the branch already applies in code at `resume.ts`, `sweep.ts` and
-- `pause.ts` (`run.provider ?? 'claude_code'`): before M12 there was no second adapter that could
-- have produced these workspaces' runs. A workspace that has already chosen a provider is skipped,
-- and re-running this migration is a no-op, because `NOT EXISTS` -- not the (workspaceId, kind)
-- unique index -- is what makes it idempotent.
--
-- `gen_random_uuid()::text` matches the shape Prisma's own `@id @default(uuid())` writes into this
-- TEXT column from the client side; the cast is required because the column is TEXT, not UUID.
INSERT INTO "ProviderConfiguration" ("id", "workspaceId", "kind", "settings")
SELECT gen_random_uuid()::text, w."id", 'claude_code', '{}'::jsonb
FROM "Workspace" w
WHERE NOT EXISTS (
    SELECT 1 FROM "ProviderConfiguration" p WHERE p."workspaceId" = w."id"
);
