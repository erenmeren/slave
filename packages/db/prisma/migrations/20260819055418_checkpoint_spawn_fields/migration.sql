/*
  Warnings:

  - Added the required column `gitAuthorEmail` to the `Checkpoint` table without a default value. This is not possible if the table is not empty.
  - Added the required column `gitAuthorName` to the `Checkpoint` table without a default value. This is not possible if the table is not empty.
  - Added the required column `hookPath` to the `Checkpoint` table without a default value. This is not possible if the table is not empty.
  - Added the required column `settingsPath` to the `Checkpoint` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Checkpoint" ADD COLUMN     "gitAuthorEmail" TEXT NOT NULL,
ADD COLUMN     "gitAuthorName" TEXT NOT NULL,
ADD COLUMN     "hookPath" TEXT NOT NULL,
ADD COLUMN     "settingsPath" TEXT NOT NULL;
