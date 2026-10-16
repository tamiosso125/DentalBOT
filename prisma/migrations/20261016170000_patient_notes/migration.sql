-- CreateEnum
CREATE TYPE "NoteAuthor" AS ENUM ('RECEPTION', 'DENTIST');

-- CreateTable
CREATE TABLE "PatientNote" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "author" "NoteAuthor" NOT NULL,
    "textEncrypted" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PatientNote_patientId_createdAt_idx" ON "PatientNote"("patientId", "createdAt");

-- AddForeignKey
ALTER TABLE "PatientNote" ADD CONSTRAINT "PatientNote_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientNote" ADD CONSTRAINT "PatientNote_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

