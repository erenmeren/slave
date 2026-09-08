-- M36 t1: durable, scoped worker-to-worker messages. Extends "SlaveMessage" rather than adding a
-- parallel table -- a human-sent instruction and a worker-sent question are the same shape of
-- fact (someone said something to someone, in a workspace, possibly expecting a reply), and this
-- table already carried the sender (`slaveId`), the content (`body`), and a classification
-- (`category`). Splitting the two into separate tables would have meant two places to scope by
-- workspace, two idempotency schemes, and a UNION for any reader (the web communication graph
-- included) that wants "everything said to this slave" -- for no benefit `sendMessage`
-- (packages/control/src/messaging.ts) actually needs. `category` (`MessageCategory`: instruction,
-- feedback, context, priority_change, question_response) is untouched and now nullable -- it
-- classifies a HUMAN instruction and stays null for every worker-authored row. The new `kind`
-- (`MessageKind`: question, answer, information, blocker, handoff) is the orthogonal axis this
-- task actually needs: the worker-protocol role a message plays, required on every row
-- `sendMessage` writes.
--
-- `SlaveMessage` had zero writers before this task (confirmed: `git grep -n "slaveMessage" --
-- packages apps`), and both the dev and test databases hold zero rows in it, so every column
-- added `NOT NULL` below needs no default and no backfill.
CREATE TYPE "MessageKind" AS ENUM ('question', 'answer', 'information', 'blocker', 'handoff');

ALTER TABLE "SlaveMessage" ADD COLUMN     "expectsReply" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "kind" "MessageKind" NOT NULL,
ADD COLUMN     "readAt" TIMESTAMP(3),
ADD COLUMN     "recipientRole" TEXT,
ADD COLUMN     "recipientSlaveId" TEXT,
ADD COLUMN     "replyToId" TEXT,
ADD COLUMN     "senderRunId" TEXT,
ADD COLUMN     "seq" BIGSERIAL NOT NULL,
ADD COLUMN     "threadId" TEXT NOT NULL,
ADD COLUMN     "workspaceId" TEXT NOT NULL,
ALTER COLUMN "category" DROP NOT NULL;

-- `seq`: `createdAt`'s millisecond resolution is not fine enough to order two messages a fast
-- caller (or a fast test) writes in the same tick -- the same reasoning `ExecutionEvent.seq`
-- (packages/events/src/append.ts) already codifies in this codebase. `listMessagesForSlave` reads
-- a thread back in `seq` order, not `createdAt`'s.
CREATE UNIQUE INDEX "SlaveMessage_seq_key" ON "SlaveMessage"("seq");

-- `workspaceId` + recipient: the two shapes `listMessagesForSlave` actually queries -- messages
-- addressed to a named worker, and messages addressed to a role -- each scoped to one workspace
-- and ready to filter on `readAt IS NULL` for the unread case.
CREATE INDEX "SlaveMessage_workspaceId_recipientSlaveId_readAt_idx" ON "SlaveMessage"("workspaceId", "recipientSlaveId", "readAt");

CREATE INDEX "SlaveMessage_workspaceId_recipientRole_readAt_idx" ON "SlaveMessage"("workspaceId", "recipientRole", "readAt");

-- A thread, in the order it happened.
CREATE INDEX "SlaveMessage_threadId_seq_idx" ON "SlaveMessage"("threadId", "seq");

-- `sendMessage`'s idempotency key, namespaced by verb (`namespacedKey` in
-- packages/control/src/messaging.ts, the same idiom `packages/control/src/simulation/shared.ts`
-- already names) so this task's `send` and Task 3's coming `answer` verb -- both writing into
-- this one column -- cannot collide on a coincidentally-equal caller-supplied key. NULL values are
-- exempt from Postgres's uniqueness check, so every message sent with no key at all coexists
-- freely; the constraint only ever fires on a real replay.
CREATE UNIQUE INDEX "SlaveMessage_workspaceId_idempotencyKey_key" ON "SlaveMessage"("workspaceId", "idempotencyKey");

-- Self-relation for `replyToId`. `ON DELETE SET NULL`, not CASCADE: a reply outliving the message
-- it answered (as an orphaned opener) is a stranger fact than a whole exchange disappearing
-- because one reply in it was removed -- and this codebase has no verb that deletes a
-- `SlaveMessage` at all yet, so this is a future-proofing default, not a path anything exercises
-- today. Deliberately NO foreign key on `recipientSlaveId` or `senderRunId` (see the columns'
-- own doc comments in schema.prisma): `slaveId` (the sender) already cascades this row when its
-- author is deleted, and a second FK with its own `ON DELETE` action reaching the same row through
-- `SlaveRun` would collide with that cascade the moment a slave is deleted (Postgres's "tuple
-- already modified by an operation triggered by the current command").
ALTER TABLE "SlaveMessage" ADD CONSTRAINT "SlaveMessage_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "SlaveMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
