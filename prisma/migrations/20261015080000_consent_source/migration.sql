-- Recall consent asked by the bot (see src/recall/recall.ts).
CREATE TYPE "ConsentSource" AS ENUM ('STAFF', 'WHATSAPP');
ALTER TABLE "Consent" ADD COLUMN "source" "ConsentSource" NOT NULL DEFAULT 'STAFF';
ALTER TABLE "Conversation" ADD COLUMN "recallConsentAskedAt" TIMESTAMP(3);
