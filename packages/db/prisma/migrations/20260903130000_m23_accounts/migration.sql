-- M23 F2: local accounts. The table only; the event and task columns that point at it come with
-- the attribution task (m23_event_user), so this migration is safe on its own.
CREATE TABLE IF NOT EXISTS "User" (
  "id" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username");
