-- CreateEnum
CREATE TYPE "AftercareAnswer" AS ENUM ('OK', 'HELP');

-- AlterTable
ALTER TABLE "Procedure" ADD COLUMN     "aftercareText" TEXT;

-- CreateTable
CREATE TABLE "AftercareFollowUp" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "instructionsSentAt" TIMESTAMP(3) NOT NULL,
    "checkInSentAt" TIMESTAMP(3),
    "answer" "AftercareAnswer",
    "answeredAt" TIMESTAMP(3),

    CONSTRAINT "AftercareFollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AftercareFollowUp_appointmentId_key" ON "AftercareFollowUp"("appointmentId");

-- CreateIndex
CREATE INDEX "AftercareFollowUp_clinicId_checkInSentAt_idx" ON "AftercareFollowUp"("clinicId", "checkInSentAt");

-- CreateIndex
CREATE INDEX "AftercareFollowUp_patientId_idx" ON "AftercareFollowUp"("patientId");

-- AddForeignKey
ALTER TABLE "AftercareFollowUp" ADD CONSTRAINT "AftercareFollowUp_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AftercareFollowUp" ADD CONSTRAINT "AftercareFollowUp_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AftercareFollowUp" ADD CONSTRAINT "AftercareFollowUp_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

