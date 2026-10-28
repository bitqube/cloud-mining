import { randomBytes } from "node:crypto";
import Decimal from "decimal.js";
import type { OrderStatus, PaymentMethod, Prisma, PrismaClient } from "@prisma/client";
import { BtqUnavailableError, newBtqPaymentTerms, type BtqPaymentTerms } from "./btq/payments";
import type { BtqWallet } from "./btq/wallet";
import { planMinutes } from "./coin-format";
import { addressHint, isValidPayoutAddress, parseOwnPool } from "./coins";
import { queueOrderEmail } from "./email/outbox";
import { kycBlockReason } from "./kyc/service";
import { claimQuote, QuoteUnavailableError } from "./pricing-service";
import { getSettings } from "./settings";

// Order lifecycle operations shared by the customer pages, the admin panel and the worker.

export class OrderError extends Error {}

export async function logEvent(
  db: PrismaClient | Prisma.TransactionClient,
  orderId: string,
  type: string,
  message: string,
  data?: Prisma.InputJsonValue,
) {
  await db.orderEvent.create({ data: { orderId, type, message, data } });
}

export interface OrderInput {
  quoteId: string;
  userId: string;
  payoutAddress: string;
  // The customer's own pool, as typed; null = the coin's pool with payoutAddress as worker.
  ownPool?: { host: string; port: string; user: string; pass: string } | null;
  // Pays the part not covered by BTQ; null when BTQ covers the whole price.
  method: PaymentMethod | null;
  btqSharePct: number; // 0–100, at most btq.maxSharePct
  btqWallet?: BtqWallet | null;
}

// The BTQ part of a price, rounded up to the cent; the rest is paid another way.
export function splitPrice(priceUsd: Decimal.Value, btqSharePct: number): { btqUsd: Decimal; restUsd: Decimal } {
  const price = new Decimal(priceUsd);
  const btqUsd = btqSharePct >= 100 ? price : price.mul(btqSharePct).div(100).toDecimalPlaces(2, Decimal.ROUND_UP);
  return { btqUsd, restUsd: price.sub(btqUsd) };
}

export async function createOrderFromQuote(db: PrismaClient, opts: OrderInput) {
  if (opts.method === "MANUAL" || opts.method === "BTQ") throw new OrderError("Choose how to pay the rest of the price.");
  const settings = await getSettings(db);
  const kycBlock = kycBlockReason(settings, await db.user.findUniqueOrThrow({ where: { id: opts.userId }, select: { kycStatus: true } }));
  if (kycBlock) throw new OrderError(kycBlock);
  const share = opts.btqSharePct;
  if (!Number.isInteger(share) || share < 0 || share > 100) throw new OrderError("Choose how much to pay in BTQ.");
  if (share > 0 && !settings["btq.enabled"]) throw new OrderError("BTQ payments are not available right now.");
  if (share > settings["btq.maxSharePct"]) throw new OrderError(`At most ${settings["btq.maxSharePct"]}% of a price can be paid in BTQ.`);

  let quote;
  try {
    quote = await claimQuote(db, opts.quoteId, opts.userId);
  } catch (e) {
    if (e instanceof QuoteUnavailableError) throw new OrderError(e.message);
    throw e;
  }
  const coin = await db.coin.findUniqueOrThrow({ where: { id: quote.coinId } });

  let pool: { host: string; port: number; user: string; pass: string } | null = null;
  let address = opts.payoutAddress.trim();
  if (opts.ownPool) {
    if (!coin.ownPoolAllowed) throw new OrderError(`${coin.name} can only be mined on our pool.`);
    const parsed = parseOwnPool(opts.ownPool);
    if (!parsed.ok) throw new OrderError(parsed.error);
    pool = parsed;
    address = "";
  } else {
    if (!isValidPayoutAddress(coin.id, address)) {
      throw new OrderError(`That is not a valid ${coin.name} address (${addressHint(coin.id)}).`);
    }
    if (!coin.poolHost || !coin.poolPort) throw new OrderError(`${coin.name} mining is not available right now.`);
  }

  const { btqUsd, restUsd } = splitPrice(quote.priceUsd.toString(), share);
  if (restUsd.gt(0) && opts.method === null) throw new OrderError("Choose how to pay the rest of the price.");

  // Same shape as Prisma's cuid ids; chosen here so the BTQ deposit address can be
  // labelled with it before the row exists.
  const id = `c${Date.now().toString(36)}${randomBytes(8).toString("hex")}`;
  let btq: BtqPaymentTerms | undefined;
  if (btqUsd.gt(0)) {
    try {
      btq = await newBtqPaymentTerms(opts.btqWallet ?? null, settings, btqUsd, id);
    } catch (e) {
      if (e instanceof BtqUnavailableError) throw new OrderError(e.message);
      throw e;
    }
  }

  const payments: Prisma.PaymentCreateWithoutOrderInput[] = [];
  if (btq) {
    payments.push({
      method: "BTQ",
      amountUsd: btqUsd.toString(),
      amountAsset: btq.amountAsset.toString(),
      rateUsd: btq.rateUsd.toString(),
      providerRef: btq.address,
      expiresAt: btq.expiresAt,
    });
  }
  if (restUsd.gt(0)) payments.push({ method: opts.method!, amountUsd: restUsd.toString(), expiresAt: quote.expiresAt });

  return db.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        id,
        userId: opts.userId,
        quoteId: quote.id,
        coinId: coin.id,
        sharePct: quote.sharePct,
        days: quote.days,
        rigMh: quote.rigMh,
        slotMinutes: planMinutes(quote.sharePct, quote.days),
        hashrateMh: quote.hashrateMh,
        hours: quote.hours,
        priceUsd: quote.priceUsd,
        quotedCostUsd: quote.costUsd,
        quotedRigCostUsd: quote.rigCostUsd,
        multiplier: quote.multiplier,
        payoutAddress: address,
        poolHost: pool?.host,
        poolPort: pool?.port,
        poolUser: pool?.user,
        poolPass: pool?.pass,
        payments: { create: payments },
      },
    });
    if (address) {
      const user = await tx.user.findUniqueOrThrow({ where: { id: opts.userId }, select: { payoutAddresses: true } });
      const saved = { ...((user.payoutAddresses as Record<string, string>) ?? {}), [coin.id]: address };
      await tx.user.update({ where: { id: opts.userId }, data: { payoutAddresses: saved } });
    }
    const how = payments.map((p) => `$${p.amountUsd} by ${p.method}`).join(" + ");
    await logEvent(tx, order.id, "order.created", `Order placed, paying ${how}`);
    await queueOrderEmail(
      tx,
      order.id,
      "order.placed",
      btq && { btq: { amount: btq.amountAsset.toFixed(), address: btq.address, until: btq.expiresAt, usd: btqUsd.toFixed(2) } },
    );
    return order;
  });
}

// Confirms one part of an order's payment (called by payment watchers/webhooks), or for
// MANUAL, an admin settling whatever is still owed. The order is PAID once the confirmed
// parts cover its price. Returns whether it is now paid.
export async function markPaid(
  db: PrismaClient,
  orderId: string,
  opts: { method: PaymentMethod; providerRef?: string; txid?: string; by?: string },
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: true } });
    if (order.status !== "PENDING_PAYMENT" && order.status !== "CANCELLED") {
      throw new OrderError(`order is ${order.status}, not awaiting payment`);
    }
    const price = new Decimal(order.priceUsd.toString());
    const confirmedSum = (ps: typeof order.payments) =>
      ps.filter((p) => p.status === "CONFIRMED").reduce((s, p) => s.add(p.amountUsd.toString()), new Decimal(0));
    const owed = price.sub(confirmedSum(order.payments));
    const now = new Date();
    const confirm = { status: "CONFIRMED" as const, confirmedAt: now, providerRef: opts.providerRef, txid: opts.txid };

    // The pending part for this method, or for a late BTQ payment accepted by an admin,
    // the expired one for the same deposit address. MANUAL always settles the balance.
    const part =
      opts.method === "MANUAL"
        ? undefined
        : order.payments.find(
            (p) =>
              p.method === opts.method &&
              p.status !== "CONFIRMED" &&
              (p.status === "PENDING" || (opts.providerRef !== undefined && p.providerRef === opts.providerRef)),
          );
    if (part) {
      await tx.payment.update({ where: { id: part.id }, data: confirm });
    } else if (owed.gt(0)) {
      await tx.payment.create({ data: { orderId, method: opts.method, amountUsd: owed.toString(), ...confirm } });
    }

    const after = await tx.payment.findMany({ where: { orderId } });
    const paid = confirmedSum(after);
    const by = opts.by ? ` by admin ${opts.by}` : "";
    if (paid.lt(price)) {
      await logEvent(tx, orderId, "payment.part", `${opts.method} part confirmed${by}: $${paid.toFixed(2)} of $${price.toFixed(2)} paid`);
      return false;
    }
    // Any other part still pending (e.g. the card payment the customer started before
    // paying by bank transfer) is superseded.
    await tx.payment.updateMany({ where: { orderId, status: "PENDING" }, data: { status: "EXPIRED" } });
    await tx.order.update({ where: { id: orderId }, data: { status: "PAID" } });
    await logEvent(tx, orderId, "payment.confirmed", `Payment confirmed (${opts.method})${by}`);
    await queueOrderEmail(tx, orderId, "order.paid");
    return true;
  });
}

const ADMIN_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> = {
  PENDING_PAYMENT: ["CANCELLED"],
  PAID: ["CANCELLED", "REFUNDED"],
  QUEUED: ["REFUNDED"], // only while none of its rigs is rented yet
  FAILED: ["PAID", "REFUNDED"], // PAID = retry provisioning
  PARTIAL: ["REFUNDED"],
  COMPLETED: ["REFUNDED"],
};

export async function adminSetStatus(db: PrismaClient, orderId: string, to: OrderStatus, admin: string, note?: string) {
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  if (!ADMIN_TRANSITIONS[order.status]?.includes(to)) {
    throw new OrderError(`cannot move an order from ${order.status} to ${to}`);
  }
  await db.$transaction(async (tx) => {
    if (order.status === "QUEUED") await releaseSlots(tx, orderId);
    await tx.order.update({
      where: { id: orderId },
      data: { status: to, lockedUntil: null, failureReason: to === "PAID" ? null : undefined },
    });
    await logEvent(tx, orderId, "admin.status", `Admin ${admin} moved order ${order.status} → ${to}${note ? `: ${note}` : ""}`);
    if (to === "REFUNDED") await queueOrderEmail(tx, orderId, "order.refunded");
    if (to === "CANCELLED") await queueOrderEmail(tx, orderId, "order.cancelled");
  });
}

// Gives a queued order's booked minutes back to rig days that are not rented yet.
async function releaseSlots(tx: Prisma.TransactionClient, orderId: string) {
  const slots = await tx.slot.findMany({ where: { orderId }, include: { rigDay: { select: { status: true } } } });
  if (slots.some((s) => s.rigDay.status !== "OPEN")) {
    throw new OrderError("Part of this order is on a rig that is already rented. Refund it once that rig day has finished.");
  }
  for (const s of slots) {
    await tx.slot.delete({ where: { id: s.id } });
    const day = await tx.rigDay.update({ where: { id: s.rigDayId }, data: { bookedMinutes: { decrement: s.minutes } } });
    if (day.bookedMinutes <= 0) await tx.rigDay.delete({ where: { id: day.id } });
  }
}

export function allowedAdminTransitions(status: OrderStatus): OrderStatus[] {
  return ADMIN_TRANSITIONS[status] ?? [];
}
