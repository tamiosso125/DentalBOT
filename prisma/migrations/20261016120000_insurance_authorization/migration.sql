-- CreateEnum
CREATE TYPE "AuthorizationStatus" AS ENUM ('AUTHORIZED', 'DENIED');

-- CreateTable
CREATE TABLE "InsuranceAuthorization" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "insurancePlanId" TEXT NOT NULL,
    "status" "AuthorizationStatus" NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "notifiedAt" TIMESTAMP(3),
    "privateChosenAt" TIMESTAMP(3),

    CONSTRAINT "InsuranceAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InsuranceAuthorization_appointmentId_key" ON "InsuranceAuthorization"("appointmentId");

-- CreateIndex
CREATE INDEX "InsuranceAuthorization_clinicId_decidedAt_idx" ON "InsuranceAuthorization"("clinicId", "decidedAt");

-- AddForeignKey
ALTER TABLE "InsuranceAuthorization" ADD CONSTRAINT "InsuranceAuthorization_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceAuthorization" ADD CONSTRAINT "InsuranceAuthorization_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceAuthorization" ADD CONSTRAINT "InsuranceAuthorization_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceAuthorization" ADD CONSTRAINT "InsuranceAuthorization_insurancePlanId_fkey" FOREIGN KEY ("insurancePlanId") REFERENCES "InsurancePlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

