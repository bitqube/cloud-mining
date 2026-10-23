-- AlterTable
ALTER TABLE "public"."Payment" ADD COLUMN     "confirmations" INTEGER,
ADD COLUMN     "receivedAsset" DECIMAL(24,8),
ADD COLUMN     "seenAt" TIMESTAMP(3);
