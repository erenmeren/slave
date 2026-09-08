-- M35 t2: `done` no longer means "safe to build on". `merge.ts`'s `!autoMerge` path marks a task
-- `done` with NO git merge, on purpose (spec Decision 5) -- the branch and worktree are left for a
-- human. `world.ts`'s old gate was `dep.status <> 'done'` alone, so a dependent was scheduled and
-- provisioned from `workspace.baseBranch` while its dependency's commits were still sitting on
-- that unmerged branch. `integratedAt` is the honest stamp: null until the work has actually
-- reached the base branch, set by `merge.ts`'s real-merge path the moment it merges, or by the new
-- `confirmIntegration` control verb / `orchestrator confirm-integration` when a human has merged
-- it by hand. The gate becomes `dep.status = 'done' AND dep."integratedAt" IS NOT NULL`.
--
-- Additive and nullable: no existing row is required to have an opinion, and no `NOT NULL`
-- constraint is added.
ALTER TABLE "Task" ADD COLUMN "integratedAt" TIMESTAMP(3);

-- `ALTER TYPE ... ADD VALUE` runs inside Prisma's per-migration transaction, which Postgres 12+
-- permits as long as the new value is not USED in the same transaction -- nothing below uses it,
-- only the pre-existing 'task.done' value. `IF NOT EXISTS` makes re-running this a no-op.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'task.integrated';

-- Backfill, decided from counts taken against the dev and test databases before this migration was
-- written: dev held 1 `done` task total, 0 of them in an `autoMerge = true` workspace, 1 in an
-- `autoMerge = false` workspace; test held 0 `done` tasks altogether. The rule below is stated for
-- whatever data a real deployment carries, not tuned to those particular (small) numbers:
--
--   - `autoMerge = true` workspaces: every `done` task there already went through `merge.ts`'s
--     real-merge path -- its commits are ALREADY on the base branch, for real, whether or not this
--     column existed to say so. Leaving `integratedAt` null for these would misrepresent history
--     (the merge did happen) and would freeze every existing dependent of an already-integrated
--     task behind a stamp nothing will ever set retroactively. Backfilled to the latest
--     `task.done` event's own timestamp for that task -- the moment `merge.ts` actually concluded
--     it, the same clock `collectTaskWorktree`'s `terminalTimestamp` (packages/control/src/collect.ts)
--     already reads for the identical reason -- falling back to the task's `createdAt` only for a
--     row with no such event (pre-event-log seed data), so every backfilled row still gets a real,
--     non-null timestamp instead of silently staying unstamped.
--   - `autoMerge = false` workspaces: these tasks were marked `done` with NO git merge, entirely
--     on purpose -- the branch and worktree were left for a human, and nothing has integrated them
--     since this row was written any more than it has since this migration runs. Stamping `now()`
--     (or any other time) here would assert a merge that never happened. Leaving them `null` is
--     not a NEW restriction this migration invents: it is the exact state `merge.ts`'s `!autoMerge`
--     path deliberately leaves EVERY task in, historical or freshly created, both before and after
--     this migration. A dependent of one of these tasks now waits for an operator to run
--     `orchestrator confirm-integration --task <id>` once, by hand -- the same branch that already
--     needed a human's attention to land in the first place, which is exactly what spec Decision 5
--     asked for.
UPDATE "Task" t
SET "integratedAt" = COALESCE(
  (
    SELECT e.ts
    FROM "ExecutionEvent" e
    WHERE e."taskId" = t.id AND e.type = 'task.done'
    ORDER BY e.seq DESC
    LIMIT 1
  ),
  t."createdAt"
)
FROM "Workspace" w
WHERE w.id = t."workspaceId"
  AND w."autoMerge" = true
  AND t.status = 'done';
