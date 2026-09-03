-- M23 A1: a workspace is addressed by name from the CLI and the Settings form; two rows with
-- one name would make `--workspace` ambiguity a permanent condition. Additive: an index only.
CREATE UNIQUE INDEX IF NOT EXISTS "Workspace_name_key" ON "Workspace"("name");
