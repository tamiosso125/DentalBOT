-- Recall invitations (see src/recall/recall.ts).
ALTER TABLE "Patient" ADD COLUMN "recallInvitedAt" TIMESTAMP(3);
