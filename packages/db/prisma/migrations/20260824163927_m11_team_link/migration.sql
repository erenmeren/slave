-- AlterTable
ALTER TABLE "Team" ADD COLUMN     "companyTeamId" TEXT;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_companyTeamId_fkey" FOREIGN KEY ("companyTeamId") REFERENCES "CompanyTeam"("id") ON DELETE SET NULL ON UPDATE CASCADE;
