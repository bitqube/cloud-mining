import Decimal from "decimal.js";
import type { Payment, PrismaClient } from "@prisma/client";
import { queueAdminAlert } from "../email/outbox";
import { logEvent, markPaid, OrderError } from "../order-service";
import { getSettings, type Settings } from "../settings";
import type { BtqWallet } from "./wallet";

// BTQ payments: each order gets its own address from the node's wallet and the customer
// sends the quoted amount there. The worker watches those addresses and confirms the BTQ
// part once enough has arrived with btq.confirmations confirmations. An order can be paid
// partly in BTQ (up to btq.maxSharePct) and partly another way; it counts as paid once
// every part is confirmed.
//
// The BitQube network is small, so a payment can be reversed cheaply after confirming.
// btq.maxOrderUsd bounds what one reversal could cost, and a payment that disappears
// after confirming raises an admin alert.

// Customers' wallets sometimes take the fee out of the amount sent; this much short still
// counts as paid.
export const UNDERPAY_TOLERANCE = new Decimal("0.005");
// Late or unexpected payments to addresses of orders this old are still noticed.
const WATCH_DAYS = 14;
// Confirmed payments are re-checked for reversal (reorg / double spend) this long.
const REVERSAL_WATCH_MS = 48 * 3_600_000;

export class BtqUnavailableError extends Error {}

// USD price → BTQ at the admin-set rate, rounded up to 0.01 BTQ so we never undercharge.
export function btqAmount(priceUsd: Decimal.Value, rateUsd: Decimal.Value): Decimal {
  const rate = new Decimal(rateUsd);
  if (rate.lte(0)) throw new BtqUnavailableError("BTQ price not set");
  return new Decimal(priceUsd).div(rate).toDecimalPlaces(2, Decimal.ROUND_UP);
}

export const isPaidInFull = (received: Decimal.Value, due: Decimal.Value) =>
  new Decimal(received).gte(new Decimal(due).mul(new Decimal(1).minus(UNDERPAY_TOLERANCE)));

// Why BTQ can't be used for this amount right now, or null if it can. Without an amount,
// only whether BTQ is offered at all.
export function btqUnavailableReason(wallet: BtqWallet | null, settings: Settings, btqUsd?: Decimal.Value): string | null {
  if (!settings["btq.enabled"] || !wallet || settings["btq.usdRate"].lte(0)) return "BTQ payments are not available right now.";
  if (btqUsd !== undefined && new Decimal(btqUsd).gt(settings["btq.maxOrderUsd"]))
    return `At most $${settings["btq.maxOrderUsd"]} of an order can be paid in BTQ.`;
  return null;
}

// "bitqube:ADDR?amount=X", which the BitQube wallet understands (also as a QR code).
export const paymentUri = (address: string, amount: Decimal.Value) => `bitqube:${address}?amount=${new Decimal(amount).toFixed()}`;

export interface BtqPaymentTerms {
  address: string;
  amountAsset: Decimal;
  rateUsd: Decimal;
  expiresAt: Date;
}

// Called at checkout, before the order row exists; the address is labelled with the id
// the order is about to get, so the node's wallet shows which order each payment is for.
export async function newBtqPaymentTerms(
  wallet: BtqWallet | null,
  settings: Settings,
  priceUsd: Decimal.Value,
  orderId: string,
  now = new Date(),
): Promise<BtqPaymentTerms> {
  const reason = btqUnavailableReason(wallet, settings, priceUsd);
  if (reason) throw new BtqUnavailableError(reason);
  const rateUsd = settings["btq.usdRate"];
  let address: string;
  try {
    address = await wallet!.newAddress(`order ${orderId}`);
  } catch (e) {
    console.error("getnewaddress failed", e);
    throw new BtqUnavailableError("BTQ payments are temporarily unavailable. Please try another method or try again shortly.");
  }
  return {
    address,
    amountAsset: btqAmount(priceUsd, rateUsd),
    rateUsd,
    expiresAt: new Date(now.getTime() + settings["btq.paymentWindowMinutes"] * 60_000),
  };
}

async function once(db: PrismaClient, orderId: string, type: string, run: () => Promise<void>) {
  if (await db.orderEvent.findFirst({ where: { orderId, type }, select: { id: true } })) return;
  await run();
}

const hasEvent = async (db: PrismaClient, orderId: string, types: string[]) =>
  !!(await db.orderEvent.findFirst({ where: { orderId, type: { in: types } }, select: { id: true } }));

// Worker job: compare every watched deposit address with what the node has received.
export async function watchBtqPayments(db: PrismaClient, wallet: BtqWallet, log: (m: string) => void, now = new Date()): Promise<number> {
  const settings = await getSettings(db);
  const minConf = settings["btq.confirmations"];
  const watched = await db.payment.findMany({
    where: {
      method: "BTQ",
      providerRef: { not: null },
      OR: [
        { status: { in: ["PENDING", "EXPIRED"] }, createdAt: { gt: new Date(now.getTime() - WATCH_DAYS * 86_400_000) } },
        { status: "CONFIRMED", confirmedAt: { gt: new Date(now.getTime() - REVERSAL_WATCH_MS) } },
      ],
    },
    include: { order: { select: { id: true, status: true } } },
  });
  if (!watched.length) return 0;

  const received = await wallet.listReceived();
  let changed = 0;
  for (const p of watched) {
    const r = received.get(p.providerRef!);
    const ref = p.orderId.slice(-8);

    if (p.status === "CONFIRMED") {
      // Still there with at least one confirmation? Otherwise it was reversed.
      const still = r ? await wallet.receivedBy(p.providerRef!, 1) : new Decimal(0);
      if (!isPaidInFull(still, p.amountAsset!)) {
        await once(db, p.orderId, "payment.reversed", async () => {
          await logEvent(
            db,
            p.orderId,
            "payment.reversed",
            `Confirmed BTQ payment no longer on chain: ${still} of ${p.amountAsset} BTQ remains`,
          );
          await queueAdminAlert(
            db,
            `BTQ payment for order ${ref} was reversed`,
            `The deposit address ${p.providerRef} now holds ${still} BTQ with 1+ confirmations, but ${p.amountAsset} BTQ had confirmed and the order was marked paid. This looks like a chain reorganisation or double spend. Check the order and stop its rentals if needed.`,
            p.orderId,
          );
          log(`btq: order ${ref} payment reversed`);
        });
      }
      continue;
    }

    if (!r || r.amount.lte(0)) continue;
    const before = p.receivedAsset ?? new Decimal(0);
    changed += await recordProgress(db, p, r.amount, r.confirmations, r.txids, now);
    const seenAt = p.seenAt ?? now;
    const due = p.amountAsset!;
    const windowClosed = !!p.expiresAt && now > p.expiresAt;

    // Sent after the window closed, or to an order already cancelled: never provision
    // automatically, because the locked price may no longer cover the hashrate.
    if (p.status === "EXPIRED" || p.order.status !== "PENDING_PAYMENT" || (p.expiresAt && seenAt > p.expiresAt)) {
      await once(db, p.orderId, "payment.late", async () => {
        await logEvent(db, p.orderId, "payment.late", `${r.amount} BTQ received after the payment window`);
        await queueAdminAlert(
          db,
          `Late BTQ payment for order ${ref}`,
          `${r.amount} BTQ (of ${due} due) arrived at ${p.providerRef} after the payment window closed (order is ${p.order.status}). It was not accepted automatically. Accept it from the order page, or refund it from the node's wallet.`,
          p.orderId,
        );
      });
      continue;
    }

    // Short when the window closed, topped up since: the locked price has lapsed, so an
    // admin decides, as for a late payment. Once flagged, it stays flagged.
    if (
      windowClosed &&
      isPaidInFull(r.amount, due) &&
      (!isPaidInFull(before, due) || (await hasEvent(db, p.orderId, ["payment.underpaid", "payment.completedLate"])))
    ) {
      await once(db, p.orderId, "payment.completedLate", async () => {
        await logEvent(db, p.orderId, "payment.completedLate", `${r.amount} of ${due} BTQ received, completed after the payment window`);
        await queueAdminAlert(
          db,
          `BTQ payment for order ${ref} completed late`,
          `${r.amount} BTQ (of ${due} due) has now arrived at ${p.providerRef}, but only part of it came before the payment window closed. It was not accepted automatically. Accept it from the order page, or refund it from the node's wallet.`,
          p.orderId,
        );
      });
      continue;
    }

    if (!isPaidInFull(r.amount, due)) {
      if (windowClosed) {
        await once(db, p.orderId, "payment.underpaid", async () => {
          await logEvent(db, p.orderId, "payment.underpaid", `Underpaid: ${r.amount} of ${due} BTQ received`);
          await queueAdminAlert(
            db,
            `BTQ underpayment on order ${ref}`,
            `Only ${r.amount} of ${due} BTQ arrived at ${p.providerRef} before the payment window closed. The order was not provisioned. Contact the customer: accept it from the order page, or refund from the node's wallet.`,
            p.orderId,
          );
        });
      }
      continue;
    }

    const confirmed = r.confirmations >= minConf ? r.amount : await wallet.receivedBy(p.providerRef!, minConf);
    if (!isPaidInFull(confirmed, due)) continue;
    let orderPaid: boolean;
    try {
      orderPaid = await markPaid(db, p.orderId, { method: "BTQ", providerRef: p.providerRef!, txid: r.txids.join(",") });
    } catch (e) {
      if (e instanceof OrderError) continue; // another worker got there first
      throw e;
    }
    log(`btq: order ${ref} ${orderPaid ? "paid" : "BTQ part paid"} (${r.amount} BTQ, ${r.confirmations} conf)`);
    changed++;
    if (r.amount.gt(new Decimal(due).mul(new Decimal(1).plus(UNDERPAY_TOLERANCE)))) {
      await logEvent(db, p.orderId, "payment.overpaid", `Overpaid: ${r.amount} BTQ received, ${due} due`);
      await queueAdminAlert(
        db,
        `BTQ overpayment on order ${ref}`,
        `${r.amount} BTQ arrived for ${due} BTQ due. The order was provisioned; refund the difference if the customer asks.`,
        p.orderId,
      );
    }
  }
  return changed;
}

// Save what the node reports for a deposit address; the first sighting is logged for the
// customer's timeline. Returns 1 if anything changed.
async function recordProgress(
  db: PrismaClient,
  p: Payment,
  amount: Decimal,
  confirmations: number,
  txids: string[],
  now: Date,
): Promise<number> {
  const txid = txids.join(",");
  if (p.receivedAsset?.equals(amount) && p.confirmations === confirmations && p.txid === txid) return 0;
  await db.payment.update({ where: { id: p.id }, data: { receivedAsset: amount, confirmations, txid, seenAt: p.seenAt ?? now } });
  if (!p.seenAt) await logEvent(db, p.orderId, "payment.seen", `${amount} BTQ received, waiting for confirmations`);
  p.seenAt ??= now;
  return 1;
}
