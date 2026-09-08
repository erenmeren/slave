-- M34 t2: a project department name is unique by index. `createProjectTeam`/`renameTeam`'s
-- read-then-write pre-check names the sibling in a friendly refusal, but only this index closes
-- the race between two concurrent creates/renames of the same name -- both verbs also catch the
-- resulting P2002 and return `duplicate_name`, the rule `org.ts`'s catalog verbs already follow.
CREATE UNIQUE INDEX "Team_workspaceId_name_key" ON "Team"("workspaceId", "name");
