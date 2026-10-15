-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "installmentCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "notes" TEXT;

