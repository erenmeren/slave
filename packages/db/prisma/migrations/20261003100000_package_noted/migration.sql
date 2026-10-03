-- Human-cards spec H4 (plan B D9): information a worker reports that needs no decision ("the vendor
-- key is a placeholder") is a note -- written to the activity feed and the goal report, never a
-- question or a card.
--
-- PURELY ADDITIVE: one enum value, unused inside this transaction.

ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.package_noted';
