-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentMethod" ADD VALUE 'CASH';
ALTER TYPE "PaymentMethod" ADD VALUE 'DEBIT_CARD';

-- AlterTable
ALTER TABLE "Installment" ADD COLUMN     "receivedAtClinic" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ClinicPayment" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "procedureId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),

    CONSTRAINT "ClinicPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClinicPayment_clinicId_paidAt_idx" ON "ClinicPayment"("clinicId", "paidAt");

-- CreateIndex
CREATE INDEX "ClinicPayment_patientId_idx" ON "ClinicPayment"("patientId");

-- AddForeignKey
ALTER TABLE "ClinicPayment" ADD CONSTRAINT "ClinicPayment_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicPayment" ADD CONSTRAINT "ClinicPayment_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicPayment" ADD CONSTRAINT "ClinicPayment_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "Procedure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

