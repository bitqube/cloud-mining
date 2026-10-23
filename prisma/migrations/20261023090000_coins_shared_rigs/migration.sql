-- Coins, shared 24-hour rigs (RigDay) split into customer slots, and plans as a share
-- of a rig day. Existing quotes and orders are treated as BTQ orders for a whole rig.

-- CreateEnum
CREATE TYPE "RigDayStatus" AS ENUM ('OPEN', 'RENTING', 'ACTIVE', 'ENDED', 'FAILED');
CREATE TYPE "SlotStatus" AS ENUM ('BOOKED', 'MINING', 'DONE', 'MISSED');
ALTER TYPE "OrderStatus" ADD VALUE 'QUEUED' AFTER 'PAID';

-- Coins. Only BTQ starts enabled. The 2Miners pools are a starting point: check each
-- one with "Test pool" in Admin → Coins before enabling the coin.
CREATE TABLE "Coin" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "algo" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "unitMh" DECIMAL(24,12) NOT NULL,
    "rigMh" DECIMAL(24,6) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "poolHost" TEXT,
    "poolPort" INTEGER,
    "poolUser" TEXT NOT NULL DEFAULT '{address}.{worker}',
    "poolPass" TEXT NOT NULL DEFAULT 'x',
    "portsByDifficulty" BOOLEAN NOT NULL DEFAULT false,
    "ownPoolAllowed" BOOLEAN NOT NULL DEFAULT true,
    "houseAddress" TEXT,
    "mrrProfileId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Coin_pkey" PRIMARY KEY ("id")
);

INSERT INTO "Coin" ("id", "name", "algo", "unit", "unitMh", "rigMh", "enabled", "sortOrder", "poolHost", "poolPort", "poolUser", "portsByDifficulty", "ownPoolAllowed", "updatedAt") VALUES
  ('BTQ',  'BitQube',          'kawpow',      'MH/s',  1,       1000,      true,  1,  'pool.bitqube.org', 10032, '{address}',          true,  false, CURRENT_TIMESTAMP),
  ('BTC',  'Bitcoin',          'sha256',      'TH/s',  1000000, 100000000, false, 2,  NULL,               NULL,  '{address}.{worker}', false, true,  CURRENT_TIMESTAMP),
  ('LTC',  'Litecoin',         'scrypt',      'GH/s',  1000,    10000,     false, 3,  NULL,               NULL,  '{address}.{worker}', false, true,  CURRENT_TIMESTAMP),
  ('DOGE', 'Dogecoin',         'scrypt',      'GH/s',  1000,    10000,     false, 4,  NULL,               NULL,  '{address}.{worker}', false, true,  CURRENT_TIMESTAMP),
  ('KAS',  'Kaspa',            'kheavyhash',  'TH/s',  1000000, 1000000,   false, 5,  'kas.2miners.com',  2020,  '{address}.{worker}', false, true,  CURRENT_TIMESTAMP),
  ('ETC',  'Ethereum Classic', 'etchash',     'GH/s',  1000,    1000,      false, 6,  'etc.2miners.com',  1010,  '{address}.{worker}', false, true,  CURRENT_TIMESTAMP),
  ('XMR',  'Monero',           'randomx',     'KH/s',  0.001,   0.1,       false, 7,  'xmr.2miners.com',  2222,  '{address}.{worker}', false, true,  CURRENT_TIMESTAMP),
  ('ZEC',  'Zcash',            'equihash',    'kSol/s', 0.001,  0.1,       false, 8,  NULL,               NULL,  '{address}.{worker}', false, true,  CURRENT_TIMESTAMP),
  ('RVN',  'Ravencoin',        'kawpow',      'MH/s',  1,       1000,      false, 9,  'rvn.2miners.com',  6060,  '{address}.{worker}', false, true,  CURRENT_TIMESTAMP),
  ('DASH', 'Dash',             'x11',         'GH/s',  1000,    1000000,   false, 10, NULL,               NULL,  '{address}.{worker}', false, true,  CURRENT_TIMESTAMP),
  ('ERG',  'Ergo',             'autolykosv2', 'MH/s',  1,       1000,      false, 11, 'erg.2miners.com',  8888,  '{address}.{worker}', false, true,  CURRENT_TIMESTAMP);

-- Plans become a share of one rig day.
UPDATE "Quote" SET "planId" = NULL;
DELETE FROM "Plan";
ALTER TABLE "Plan" DROP COLUMN "hashrateMh", DROP COLUMN "hours", ADD COLUMN "sharePct" DECIMAL(5,2) NOT NULL;
INSERT INTO "Plan" ("id", "name", "sharePct", "active", "sortOrder") VALUES
  ('plan_starter',  'Starter',  10, true, 1),
  ('plan_standard', 'Standard', 25, true, 2),
  ('plan_plus',     'Plus',     50, true, 3);

-- Quote
ALTER TABLE "Quote" DROP COLUMN "basket", DROP COLUMN "deliveredMh",
  ADD COLUMN "coinId" TEXT, ADD COLUMN "days" INTEGER, ADD COLUMN "rigCostUsd" DECIMAL(12,2),
  ADD COLUMN "rigMh" DECIMAL(24,6), ADD COLUMN "sharePct" DECIMAL(5,2),
  ALTER COLUMN "hashrateMh" SET DATA TYPE DECIMAL(24,6);
UPDATE "Quote" SET "coinId" = 'BTQ', "days" = GREATEST(1, "hours" / 24), "rigCostUsd" = "costUsd", "rigMh" = "hashrateMh", "sharePct" = 100;
ALTER TABLE "Quote" ALTER COLUMN "coinId" SET NOT NULL, ALTER COLUMN "days" SET NOT NULL, ALTER COLUMN "rigCostUsd" SET NOT NULL,
  ALTER COLUMN "rigMh" SET NOT NULL, ALTER COLUMN "sharePct" SET NOT NULL;

-- Order
ALTER TABLE "Order"
  ADD COLUMN "coinId" TEXT, ADD COLUMN "days" INTEGER, ADD COLUMN "quotedRigCostUsd" DECIMAL(12,2),
  ADD COLUMN "rigMh" DECIMAL(24,6), ADD COLUMN "sharePct" DECIMAL(5,2), ADD COLUMN "slotMinutes" INTEGER,
  ADD COLUMN "poolHost" TEXT, ADD COLUMN "poolPass" TEXT, ADD COLUMN "poolPort" INTEGER, ADD COLUMN "poolUser" TEXT,
  ALTER COLUMN "hashrateMh" SET DATA TYPE DECIMAL(24,6);
UPDATE "Order" SET "coinId" = 'BTQ', "days" = GREATEST(1, "hours" / 24), "quotedRigCostUsd" = "quotedCostUsd",
  "rigMh" = "hashrateMh", "sharePct" = 100, "slotMinutes" = "hours" * 60;
ALTER TABLE "Order" ALTER COLUMN "coinId" SET NOT NULL, ALTER COLUMN "days" SET NOT NULL, ALTER COLUMN "quotedRigCostUsd" SET NOT NULL,
  ALTER COLUMN "rigMh" SET NOT NULL, ALTER COLUMN "sharePct" SET NOT NULL, ALTER COLUMN "slotMinutes" SET NOT NULL;

-- Rental: legacy rentals belong to an order, new ones to a rig day.
ALTER TABLE "Rental" DROP CONSTRAINT "Rental_orderId_fkey";
ALTER TABLE "Rental" ADD COLUMN "rigDayId" TEXT,
  ALTER COLUMN "orderId" DROP NOT NULL,
  ALTER COLUMN "advertisedMh" SET DATA TYPE DECIMAL(24,6),
  ALTER COLUMN "averageMh" SET DATA TYPE DECIMAL(24,6);

-- User
ALTER TABLE "User" ADD COLUMN "payoutAddresses" JSONB NOT NULL DEFAULT '{}';
UPDATE "User" SET "payoutAddresses" = jsonb_build_object('BTQ', "btqAddress") WHERE "btqAddress" IS NOT NULL;

-- CreateTable
CREATE TABLE "RigDay" (
    "id" TEXT NOT NULL,
    "coinId" TEXT NOT NULL,
    "status" "RigDayStatus" NOT NULL DEFAULT 'OPEN',
    "rigMh" DECIMAL(24,6) NOT NULL,
    "minutes" INTEGER NOT NULL DEFAULT 1440,
    "bookedMinutes" INTEGER NOT NULL DEFAULT 0,
    "maxCostUsd" DECIMAL(12,2) NOT NULL,
    "costUsd" DECIMAL(12,2),
    "forceRent" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "target" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RigDay_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Slot" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "rigDayId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "minutes" INTEGER NOT NULL,
    "status" "SlotStatus" NOT NULL DEFAULT 'BOOKED',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "deliveredMhHours" DECIMAL(24,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Slot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RigDay_coinId_status_idx" ON "RigDay"("coinId", "status");
CREATE INDEX "Slot_orderId_idx" ON "Slot"("orderId");
CREATE UNIQUE INDEX "Slot_rigDayId_seq_key" ON "Slot"("rigDayId", "seq");

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RigDay" ADD CONSTRAINT "RigDay_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Slot" ADD CONSTRAINT "Slot_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Slot" ADD CONSTRAINT "Slot_rigDayId_fkey" FOREIGN KEY ("rigDayId") REFERENCES "RigDay"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Rental" ADD CONSTRAINT "Rental_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Rental" ADD CONSTRAINT "Rental_rigDayId_fkey" FOREIGN KEY ("rigDayId") REFERENCES "RigDay"("id") ON DELETE SET NULL ON UPDATE CASCADE;
