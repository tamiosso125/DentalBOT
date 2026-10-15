-- LGPD erasure requests (see src/panel/patient-data.ts).
ALTER TABLE "Patient" ADD COLUMN "anonymizedAt" TIMESTAMP(3);
