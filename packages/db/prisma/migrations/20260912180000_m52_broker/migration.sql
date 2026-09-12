-- M52: permissions become OPERATIONS, a credential becomes an object, and a run gets an identity.
--
-- This is the one milestone in this directory with a destructive data statement, and every clause of
-- it is deliberate. `SlavePermission.tool` is a bare `String` with no check constraint, so the
-- database accepts anything and the six prose values were only ever a TypeScript list. The mapping
-- below is total over those six; everything else is DELETED rather than kept under an `other` kind,
-- because the column is now a closed enum, because under default-deny a dropped row DENIES (the safe
-- direction), and because an `other` kind would invent a grant nobody can name.
--
-- `run tests` and `create branch` both map to `run_commands`, so a worker holding both collapses to
-- one row: DENY WINS, and the redundant row is deleted. That is the only lossy step, it is lossy in
-- the safe direction, and the NOTICE says how many rows it touched.

CREATE TYPE "PermissionKind" AS ENUM ('read_repo', 'write_repo', 'run_commands', 'network_fetch', 'read_secret', 'deploy_release');
CREATE TYPE "CredentialKind" AS ENUM ('deploy_token', 'git_token', 'api_key');

-- 1. The new column, nullable for the length of the data statement below.
ALTER TABLE "SlavePermission" ADD COLUMN "kind" "PermissionKind";
ALTER TABLE "SlavePermission" ADD COLUMN "grantedBy" TEXT;
ALTER TABLE "SlavePermission" ADD COLUMN "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- 2. The deterministic mapping, and the NOTICE that says what it did.
DO $$
DECLARE
  mapped   INTEGER;
  collided INTEGER;
  dropped  INTEGER;
BEGIN
  -- The `WHERE` is what makes `mapped` TRUE: without it `ROW_COUNT` counts every row the statement
  -- touched, including the ones it set to NULL, and the audit line for the one destructive step in
  -- this milestone would overstate what it mapped.
  UPDATE "SlavePermission" SET "kind" = CASE "tool"
    WHEN 'repo read'     THEN 'read_repo'::"PermissionKind"
    WHEN 'source write'  THEN 'write_repo'::"PermissionKind"
    WHEN 'run tests'     THEN 'run_commands'::"PermissionKind"
    WHEN 'create branch' THEN 'run_commands'::"PermissionKind"
    WHEN 'deploy prod'   THEN 'deploy_release'::"PermissionKind"
    WHEN 'read secrets'  THEN 'read_secret'::"PermissionKind"
    ELSE NULL
  END
  WHERE "tool" IN ('repo read', 'source write', 'run tests', 'create branch', 'deploy prod', 'read secrets');
  GET DIAGNOSTICS mapped = ROW_COUNT;

  -- `run tests` and `create branch` collapse onto one kind. Keep the DENY where a worker holds both
  -- with different modes, and the lower id where they agree, so the result is deterministic.
  WITH ranked AS (
    SELECT "id",
           ROW_NUMBER() OVER (
             PARTITION BY "slaveId", "kind"
             ORDER BY CASE WHEN "mode" = 'deny' THEN 0 ELSE 1 END, "id"
           ) AS rank
    FROM "SlavePermission"
    WHERE "kind" IS NOT NULL
  )
  DELETE FROM "SlavePermission" WHERE "id" IN (SELECT "id" FROM ranked WHERE rank > 1);
  GET DIAGNOSTICS collided = ROW_COUNT;

  DELETE FROM "SlavePermission" WHERE "kind" IS NULL;
  GET DIAGNOSTICS dropped = ROW_COUNT;

  RAISE NOTICE 'm52: mapped % permission rows, dropped % collapsed duplicates, dropped % unmapped permission rows', mapped, collided, dropped;
END $$;

-- 3. The swap.
ALTER TABLE "SlavePermission" ALTER COLUMN "kind" SET NOT NULL;
DROP INDEX IF EXISTS "SlavePermission_slaveId_tool_key";
ALTER TABLE "SlavePermission" DROP COLUMN "tool";
CREATE UNIQUE INDEX "SlavePermission_slaveId_kind_key" ON "SlavePermission"("slaveId", "kind");

-- 4. The credential and the binding.
CREATE TABLE "Credential" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "kind"        "CredentialKind" NOT NULL,
  "envVar"      TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Credential_workspaceId_name_key" ON "Credential"("workspaceId", "name");
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "BrokerBinding" (
  "id"           TEXT NOT NULL,
  "workspaceId"  TEXT NOT NULL,
  "op"           TEXT NOT NULL,
  "command"      TEXT[],
  "credentialId" TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrokerBinding_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BrokerBinding_workspaceId_op_key" ON "BrokerBinding"("workspaceId", "op");
ALTER TABLE "BrokerBinding" ADD CONSTRAINT "BrokerBinding_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrokerBinding" ADD CONSTRAINT "BrokerBinding_credentialId_fkey"
  FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 5. The run's identity.
ALTER TABLE "SlaveRun" ADD COLUMN "runTokenHash" TEXT;
CREATE UNIQUE INDEX "SlaveRun_runTokenHash_key" ON "SlaveRun"("runTokenHash");

-- `IF NOT EXISTS`, and each on its own statement: Postgres refuses `ALTER TYPE ... ADD VALUE` inside
-- a transaction block that then uses the new value, and Prisma runs a migration file as one
-- transaction -- the idiom every earlier migration in this directory uses for the same reason.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'broker.executed';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'broker.refused';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'permission.changed';
ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'permission_blocked';
