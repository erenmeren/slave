-- Additive in effect: the column only LOSES a constraint, so every existing row keeps its value
-- and no data is rewritten. The DEFAULT of 20 is deliberately left in place -- a workspace is
-- budgeted unless an operator clears it, and dropping the default would make every new workspace
-- silently unguarded (M12 Task 9, spec §6).
ALTER TABLE "Workspace" ALTER COLUMN "budgetUsd" DROP NOT NULL;
