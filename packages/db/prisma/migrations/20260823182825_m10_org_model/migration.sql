-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "companyAgentId" TEXT,
ADD COLUMN     "model" TEXT;

-- AlterTable
ALTER TABLE "Checkpoint" ADD COLUMN     "model" TEXT;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "companyId" TEXT;

-- CreateTable
CREATE TABLE "AgentTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "defaultModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyTeam" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "CompanyTeam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyAgent" (
    "id" TEXT NOT NULL,
    "companyTeamId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "model" TEXT,

    CONSTRAINT "CompanyAgent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentTemplate_name_key" ON "AgentTemplate"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Company_name_key" ON "Company"("name");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyTeam_companyId_name_key" ON "CompanyTeam"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyAgent_companyTeamId_name_key" ON "CompanyAgent"("companyTeamId", "name");

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_companyAgentId_fkey" FOREIGN KEY ("companyAgentId") REFERENCES "CompanyAgent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyTeam" ADD CONSTRAINT "CompanyTeam_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyAgent" ADD CONSTRAINT "CompanyAgent_companyTeamId_fkey" FOREIGN KEY ("companyTeamId") REFERENCES "CompanyTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyAgent" ADD CONSTRAINT "CompanyAgent_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "AgentTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
