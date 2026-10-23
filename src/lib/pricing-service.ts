import Decimal from "decimal.js";
import type { Coin, PrismaClient } from "@prisma/client";
import { parseMultiplier, priceQuote } from "./pricing";
import { coinPorts } from "./providers";
import type { ProviderRouter } from "./providers/router";
import { getSettings } from "./settings";

// Database-backed pricing operations used by the admin panel and the checkout.

const GLOBAL_KEY = "pricing.globalMultiplier";

export class QuoteUnavailableError extends Error {}

export async function getGlobalMultiplier(db: PrismaClient): Promise<Decimal | null> {
  const row = await db.setting.findUnique({ where: { key: GLOBAL_KEY } });
  return row ? new Decimal(row.value) : null;
}

export async function setGlobalMultiplier(db: PrismaClient, adminId: string, value: Decimal.Value, note?: string) {
  const next = parseMultiplier(value);
  const prev = await getGlobalMultiplier(db);
  await db.$transaction([
    db.setting.upsert({ where: { key: GLOBAL_KEY }, create: { key: GLOBAL_KEY, value: next.toString() }, update: { value: next.toString() } }),
    db.pricingChange.create({ data: { targetUserId: null, oldValue: prev?.toString(), newValue: next.toString(), changedBy: adminId, note } }),
  ]);
  return next;
}

// value null removes the override so the customer falls back to the global multiplier.
export async function setUserMultiplier(db: PrismaClient, adminId: string, userId: string, value: Decimal.Value | null, note?: string) {
  const next = value === null ? null : parseMultiplier(value);
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { priceMultiplier: true } });
  await db.$transaction([
    db.user.update({ where: { id: userId }, data: { priceMultiplier: next?.toString() ?? null } }),
    db.pricingChange.create({
      data: {
        targetUserId: userId,
        oldValue: user.priceMultiplier?.toString(),
        newValue: next?.toString(),
        changedBy: adminId,
        note,
      },
    }),
  ]);
  return next;
}

// What one shared rig of this coin costs for 24 hours at MRR right now, scaled to exactly
// the coin's rig size (the rented basket can be up to 20% bigger). Cached briefly per coin
// because the buy page shows estimates from it.
const RIG_COST_TTL_MS = 5 * 60_000;
const rigCostCache = new Map<string, { at: number; costUsd: Decimal }>();

export async function rigDayCost(router: ProviderRouter, coin: Coin, now = Date.now()): Promise<Decimal> {
  const hit = rigCostCache.get(coin.id);
  if (hit && now - hit.at < RIG_COST_TTL_MS) return hit.costUsd;
  const rigMh = new Decimal(coin.rigMh.toString());
  const [best] = router.rank(await router.quoteAll({ algo: coin.algo, hashrateMh: rigMh, hours: 24, ports: coinPorts(coin) }));
  if (!best) throw new QuoteUnavailableError(`no ${coin.name} rigs of that size are free on the market right now`);
  const costUsd = best.costUsd.mul(rigMh).div(best.hashrateMh);
  rigCostCache.set(coin.id, { at: now, costUsd });
  return costUsd;
}

export async function createQuote(
  db: PrismaClient,
  router: ProviderRouter,
  req: { userId: string; coinId: string; planId: string; days: number },
) {
  const [user, global, coin, plan, settings] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: req.userId }, select: { priceMultiplier: true } }),
    getGlobalMultiplier(db),
    db.coin.findUnique({ where: { id: req.coinId } }),
    db.plan.findUnique({ where: { id: req.planId } }),
    getSettings(db),
  ]);
  if (!coin?.enabled) throw new QuoteUnavailableError("that coin is not available");
  if (!plan?.active) throw new QuoteUnavailableError("that package is not available");
  if (!Number.isInteger(req.days) || req.days < 1 || req.days > settings["orders.maxDays"]) {
    throw new QuoteUnavailableError(`choose between 1 and ${settings["orders.maxDays"]} days`);
  }

  const rigCost = await rigDayCost(router, coin);
  const share = new Decimal(plan.sharePct.toString()).div(100);
  const rigMh = new Decimal(coin.rigMh.toString());
  const priced = priceQuote(rigCost.mul(share).mul(req.days), { global, user: user.priceMultiplier });
  return db.quote.create({
    data: {
      userId: req.userId,
      planId: plan.id,
      coinId: coin.id,
      sharePct: plan.sharePct,
      days: req.days,
      rigMh: rigMh.toString(),
      rigCostUsd: rigCost.toDecimalPlaces(2, Decimal.ROUND_UP).toString(),
      hashrateMh: rigMh.mul(share).toDecimalPlaces(6).toString(),
      hours: req.days * 24,
      costUsd: priced.costUsd.toDecimalPlaces(2, Decimal.ROUND_UP).toString(),
      multiplier: priced.multiplier.toString(),
      multiplierSource: priced.multiplierSource,
      priceUsd: priced.priceUsd.toString(),
      expiresAt: priced.expiresAt,
    },
  });
}

// Checkout guard: a quote can be paid once, by its owner, before it expires.
export async function claimQuote(db: PrismaClient, quoteId: string, userId: string, now = new Date()) {
  const quote = await db.quote.findUnique({ where: { id: quoteId }, include: { order: { select: { id: true } } } });
  if (!quote || quote.userId !== userId) throw new QuoteUnavailableError("quote not found");
  if (quote.order) throw new QuoteUnavailableError("quote already used");
  if (quote.expiresAt <= now) throw new QuoteUnavailableError("quote expired; please refresh the price");
  return quote;
}
