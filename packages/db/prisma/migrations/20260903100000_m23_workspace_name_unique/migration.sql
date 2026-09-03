-- M23 A1: a workspace is addressed by name from the CLI and the Settings form; two rows with
-- one name would make `--workspace` ambiguity a permanent condition. Additive: an index only.
--
-- Final review one-liner: this fails on a pre-M23 database holding duplicate workspace names.
-- Pre-flight query an operator should run before migrating: `SELECT name FROM "Workspace" GROUP BY
-- name HAVING count(*) > 1` -- rename one of any pair the query returns, then migrate.
CREATE UNIQUE INDEX IF NOT EXISTS "Workspace_name_key" ON "Workspace"("name");
