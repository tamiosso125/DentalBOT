-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AccessAction" ADD VALUE 'VIEW_CLINICAL_RECORD';
ALTER TYPE "AccessAction" ADD VALUE 'ADD_CLINICAL_ENTRY';

-- CreateTable
CREATE TABLE "ClinicalEntry" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "amendsId" TEXT,
    "dataEncrypted" TEXT NOT NULL,
    "staffUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClinicalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClinicalEntry_patientId_createdAt_idx" ON "ClinicalEntry"("patientId", "createdAt");

-- CreateIndex
CREATE INDEX "ClinicalEntry_appointmentId_idx" ON "ClinicalEntry"("appointmentId");

-- AddForeignKey
ALTER TABLE "ClinicalEntry" ADD CONSTRAINT "ClinicalEntry_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalEntry" ADD CONSTRAINT "ClinicalEntry_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalEntry" ADD CONSTRAINT "ClinicalEntry_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalEntry" ADD CONSTRAINT "ClinicalEntry_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalEntry" ADD CONSTRAINT "ClinicalEntry_amendsId_fkey" FOREIGN KEY ("amendsId") REFERENCES "ClinicalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

