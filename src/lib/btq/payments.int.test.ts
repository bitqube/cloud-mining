import Decimal from "decimal.js";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { cancelUnpaidOrders, type WorkerDeps } from "../../worker/jobs";
import { createOrderFromQuote, markPaid, OrderError } from "../order-service";
import { watchBtqPayments } from "./payments";
import type { BtqWallet, Received } from "./wallet";

// Runs against a real Postgres: TEST_DATABASE_URL=postgresql://.../bitqube_test npm run test:int
const url = process.env.TEST_DATABASE_URL;
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : (undefined as unknown as PrismaClient);
process.env.ADMIN_ALERT_EMAIL = "ops@bitqube.test";

// Fake node wallet: hands out addresses and reports what the test says each one received.
function fakeWallet() {
  const labels = new Map<string, string>();
  // address → transactions as [amount, confirmations]
  const txs = new Map<string, Array<[string, number]>>();
  let n = 0;
  const w: BtqWallet = {
    async newAddress(label) {
      const a = `Btest${++n}`;
      labels.set(a, label);
      return a;
    },
    async listReceived() {
      const out = new Map<string, Received>();
      for (const [a, list] of txs) {
        if (!list.length) continue;
        out.set(a, {
          amount: list.reduce((s, [v]) => s.plus(v), new Decimal(0)),
          confirmations: Math.min(...list.map(([, c]) => c)),
          txids: list.map((_, i) => `${a}-tx${i}`),
        });
      }
      return out;
    },
    async receivedBy(a, minConf) {
      return (txs.get(a) ?? []).filter(([, c]) => c >= minConf).reduce((s, [v]) => s.plus(v), new Decimal(0));
    },
  };
  const pay = (a: string, amount: string, conf = 0) => txs.set(a, [...(txs.get(a) ?? []), [amount, conf]]);
  const confirm = (a: string, conf: number) =>
    txs.set(
      a,
      (txs.get(a) ?? []).map(([v]) => [v, conf]),
    );
  const reverse = (a: string) => txs.set(a, []);
  return { w, labels, pay, confirm, reverse };
}

const setting = (key: string, value: string) => db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });

// A BTQ order for $50 at $0.01/BTQ = 5000 BTQ; with btqShare < 100 the rest is paid by card.
async function btqOrder(f: ReturnType<typeof fakeWallet>, priceUsd = 50, btqShare = 100) {
  const user = await db.user.create({ data: { email: `u${Date.now()}${Math.random()}@x.io`, passwordHash: "x" } });
  const quote = await db.quote.create({
    data: {
      userId: user.id,
      coinId: "BTQ",
      sharePct: 25,
      days: 1,
      rigMh: 1000,
      rigCostUsd: (priceUsd / 3) * 4,
      hashrateMh: 250,
      hours: 24,
      costUsd: priceUsd / 3,
      multiplier: 3,
      multiplierSource: "global",
      priceUsd,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    },
  });
  const order = await createOrderFromQuote(db, {
    quoteId: quote.id,
    userId: user.id,
    payoutAddress: "BC2MHYXdTCtNSHhbxoPfra9hi2t2Vng5jY",
    method: btqShare < 100 ? "STRIPE" : null,
    btqSharePct: btqShare,
    btqWallet: f.w,
  });
  const payment = await db.payment.findFirstOrThrow({ where: { orderId: order.id, method: "BTQ" } });
  return { order, payment, address: payment.providerRef! };
}

const status = async (orderId: string) => (await db.order.findUniqueOrThrow({ where: { id: orderId } })).status;
const events = async (orderId: string) =>
  (await db.orderEvent.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } })).map((e) => e.type);
const alerts = async (orderId: string) => (await db.email.findMany({ where: { orderId, kind: "admin.alert" } })).map((e) => e.subject);
const watch = (f: ReturnType<typeof fakeWallet>, now?: Date) => watchBtqPayments(db, f.w, () => {}, now);

describe.skipIf(!url)("BTQ payments (integration)", () => {
  beforeEach(async () => {
    await db.$executeRawUnsafe(
      `TRUNCATE "Email","PasswordReset","OrderEvent","Rental","Slot","RigDay","Payment","Order","Quote","Session","PricingChange","User","Setting" CASCADE`,
    );
    await setting("btq.usdRate", "0.01");
    await setting("btq.enabled", "true");
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  it("gives each order its own labelled address, the BTQ amount and a payment window", async () => {
    const f = fakeWallet();
    const a = await btqOrder(f);
    const b = await btqOrder(f);
    expect(a.address).not.toBe(b.address);
    expect(f.labels.get(a.address)).toBe(`order ${a.order.id}`);
    expect(a.payment.amountAsset!.toFixed()).toBe("5000");
    expect(a.payment.rateUsd!.toFixed()).toBe("0.01");
    const windowMin = (a.payment.expiresAt!.getTime() - a.payment.createdAt.getTime()) / 60_000;
    expect(Math.round(windowMin)).toBe(60);
    const placed = await db.email.findFirstOrThrow({ where: { orderId: a.order.id, kind: "order.placed" } });
    expect(placed.subject).toContain("send 5000 BTQ");
    expect(placed.text).toContain(a.address);
  });

  it("refuses BTQ when it is off, unpriced, over the share or over the cap", async () => {
    const f = fakeWallet();
    await setting("btq.maxOrderUsd", "40");
    await expect(btqOrder(f, 50)).rejects.toThrow(/At most \$40/);
    await setting("btq.maxSharePct", "50");
    await expect(btqOrder(f, 30, 60)).rejects.toThrow(/At most 50%/);
    await setting("btq.usdRate", "0");
    await expect(btqOrder(f, 30)).rejects.toThrow(OrderError);
    await setting("btq.usdRate", "0.01");
    await setting("btq.enabled", "false");
    await expect(btqOrder(f, 30, 50)).rejects.toThrow(/not available/);
    expect(f.labels.size).toBe(0); // no address handed out for a refused order
  });

  it("splits a price between BTQ and card, and is paid only when both parts are", async () => {
    const f = fakeWallet();
    const { order, address, payment } = await btqOrder(f, 50, 40);
    expect(payment.amountUsd.toFixed(2)).toBe("20.00");
    expect(payment.amountAsset!.toFixed()).toBe("2000");
    const card = await db.payment.findFirstOrThrow({ where: { orderId: order.id, method: "STRIPE" } });
    expect(card.amountUsd.toFixed(2)).toBe("30.00");

    f.pay(address, "2000", 6);
    await watch(f);
    expect(await status(order.id)).toBe("PENDING_PAYMENT");
    expect(await events(order.id)).toContain("payment.part");

    await markPaid(db, order.id, { method: "MANUAL", by: "test" });
    expect(await status(order.id)).toBe("PAID");
    const parts = await db.payment.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" } });
    // The card part was settled by hand: it expires and a manual payment covers the $30.
    expect(parts.map((p) => `${p.method}:${p.status}:${p.amountUsd.toFixed(2)}`).sort()).toEqual([
      "BTQ:CONFIRMED:20.00",
      "MANUAL:CONFIRMED:30.00",
      "STRIPE:EXPIRED:30.00",
    ]);
  });

  it("shows the payment as seen, then marks the order paid at 6 confirmations", async () => {
    const f = fakeWallet();
    const { order, address } = await btqOrder(f);
    expect(await watch(f)).toBe(0);

    f.pay(address, "5000", 0);
    await watch(f);
    let p = await db.payment.findFirstOrThrow({ where: { orderId: order.id } });
    expect(p.receivedAsset!.toFixed()).toBe("5000");
    expect(p.seenAt).not.toBeNull();
    expect(await status(order.id)).toBe("PENDING_PAYMENT");

    f.confirm(address, 5);
    await watch(f);
    expect(await status(order.id)).toBe("PENDING_PAYMENT");
    expect((await db.payment.findFirstOrThrow({ where: { orderId: order.id } })).confirmations).toBe(5);

    f.confirm(address, 6);
    await watch(f);
    expect(await status(order.id)).toBe("PAID");
    p = await db.payment.findFirstOrThrow({ where: { orderId: order.id } });
    expect(p.status).toBe("CONFIRMED");
    expect(p.txid).toBe(`${address}-tx0`);
    expect(await events(order.id)).toEqual(["order.created", "payment.seen", "payment.confirmed"]);
    expect(await alerts(order.id)).toEqual([]);
  });

  it("counts top-ups and honours the confirmations setting", async () => {
    const f = fakeWallet();
    await setting("btq.confirmations", "2");
    const { order, address } = await btqOrder(f);
    f.pay(address, "3000", 3);
    await watch(f);
    expect(await status(order.id)).toBe("PENDING_PAYMENT");
    f.pay(address, "1980", 1); // 4980 of 5000: within 0.5%
    await watch(f);
    expect(await status(order.id)).toBe("PENDING_PAYMENT"); // top-up has 1 of 2 confirmations
    f.confirm(address, 2);
    await watch(f);
    expect(await status(order.id)).toBe("PAID");
  });

  it("does not provision a short payment and alerts once when the window closes", async () => {
    const f = fakeWallet();
    const { order, address, payment } = await btqOrder(f);
    f.pay(address, "4000", 10);
    await watch(f);
    expect(await alerts(order.id)).toEqual([]); // the customer can still top up
    const after = new Date(payment.expiresAt!.getTime() + 60_000);
    await watch(f, after);
    await watch(f, after);
    expect(await status(order.id)).toBe("PENDING_PAYMENT");
    expect(await alerts(order.id)).toEqual([`[BitQube admin] BTQ underpayment on order ${order.id.slice(-8)}`]);
  });

  it("does not accept a payment first seen after the window, but alerts", async () => {
    const f = fakeWallet();
    const { order, address, payment } = await btqOrder(f);
    f.pay(address, "5000", 10);
    await watch(f, new Date(payment.expiresAt!.getTime() + 60_000));
    expect(await status(order.id)).toBe("PENDING_PAYMENT");
    expect(await alerts(order.id)).toEqual([`[BitQube admin] Late BTQ payment for order ${order.id.slice(-8)}`]);
  });

  it("notices a payment to an order already cancelled for non-payment", async () => {
    const f = fakeWallet();
    const { order, address } = await btqOrder(f);
    await db.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
    await db.payment.updateMany({ where: { orderId: order.id }, data: { status: "EXPIRED" } });
    f.pay(address, "5000", 10);
    await watch(f);
    expect(await status(order.id)).toBe("CANCELLED");
    expect(await alerts(order.id)).toHaveLength(1);
  });

  it("accepts an overpayment and tells the admins", async () => {
    const f = fakeWallet();
    const { order, address } = await btqOrder(f);
    f.pay(address, "6000", 6);
    await watch(f);
    expect(await status(order.id)).toBe("PAID");
    expect(await alerts(order.id)).toEqual([`[BitQube admin] BTQ overpayment on order ${order.id.slice(-8)}`]);
  });

  it("alerts once if a confirmed payment disappears from the chain", async () => {
    const f = fakeWallet();
    const { order, address } = await btqOrder(f);
    f.pay(address, "5000", 6);
    await watch(f);
    expect(await status(order.id)).toBe("PAID");
    f.reverse(address);
    await watch(f);
    await watch(f);
    expect(await alerts(order.id)).toEqual([`[BitQube admin] BTQ payment for order ${order.id.slice(-8)} was reversed`]);
  });

  it("never cancels an order whose BTQ payment has been seen", async () => {
    const f = fakeWallet();
    const seen = await btqOrder(f);
    const unpaid = await btqOrder(f);
    // Both quotes and payment windows ended well past the 2-hour grace.
    const past = new Date(Date.now() - 5 * 3_600_000);
    for (const o of [seen, unpaid]) {
      await db.quote.update({ where: { id: o.order.quoteId }, data: { expiresAt: past } });
      await db.payment.update({ where: { id: o.payment.id }, data: { expiresAt: past } });
    }
    f.pay(seen.address, "5000", 1);
    await watch(f, new Date(past.getTime() - 60_000)); // seen inside its window
    expect(await cancelUnpaidOrders({ db, log: () => {} } as unknown as WorkerDeps)).toBe(1);
    expect(await status(seen.order.id)).toBe("PENDING_PAYMENT");
    expect(await status(unpaid.order.id)).toBe("CANCELLED");
  });
});
