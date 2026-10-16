-- CreateEnum
CREATE TYPE "AccessAction" AS ENUM ('SEARCH_PATIENTS', 'VIEW_RECORD', 'VIEW_DATA', 'EXPORT_DATA', 'ANONYMIZE', 'VIEW_NOTES', 'ADD_NOTE', 'DELETE_NOTE', 'VIEW_INSURANCE', 'SET_INSURANCE', 'SET_CONSENT', 'VIEW_APPOINTMENT', 'VIEW_QUOTE', 'VIEW_QUOTE_PDF', 'RECEIVE_INSTALLMENT', 'REGISTER_CLINIC_PAYMENT', 'VIEW_ACCESS_LOG');

-- CreateTable
CREATE TABLE "AccessLog" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "action" "AccessAction" NOT NULL,
    "patientId" TEXT,
    "targetId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccessLog_clinicId_at_idx" ON "AccessLog"("clinicId", "at");

-- CreateIndex
CREATE INDEX "AccessLog_clinicId_patientId_at_idx" ON "AccessLog"("clinicId", "patientId", "at");

-- AddForeignKey
ALTER TABLE "AccessLog" ADD CONSTRAINT "AccessLog_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

