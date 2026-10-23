import Decimal from "decimal.js";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createOrderFromQuote, markPaid } from "../lib/order-service";
import { ProviderRouter } from "../lib/providers/router";
import type { AllocationStatus, HashrateProvider, ProvisionRequest, StratumTarget } from "../lib/providers/types";
import {
  bookPaidOrders,
  completeFinishedOrders,
  finishRigDays,
  pollActiveRentals,
  rentRigDays,
  switchSlots,
  type WorkerDeps,
} from "./jobs";

// Runs against a real Postgres: TEST_DATABASE_URL=postgresql://.../bitqube_test npm run test:int
const url = process.env.TEST_DATABASE_URL;
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : (undefined as unknown as PrismaClient);
process.env.ADMIN_ALERT_EMAIL = "ops@bitqube.test";
process.env.MRR_PROFILE_ID = "985841";

const HOUSE = "BC2MHYXdTCtNSHhbxoPfra9hi2t2Vng5jY";
const CUSTOMER = "BC2MHYXdTCtNSHhbxoPfra9hi2t2Vng5jY";
const RIG_DAY_USD = 40; // one 1 GH/s BTQ rig for 24h at the fake market
const H = 3_600_000;

// Fake MRR: a 1 GH/s rig for 24h costs $40; remembers rentals and every pool switch.
function fakeProvider() {
  const rentals = new Map<string, AllocationStatus>();
  const pools: Array<{ ids: string[]; target: StratumTarget }> = [];
  const rented: ProvisionRequest[] = [];
  let n = 0;
  const p: HashrateProvider = {
    id: "MRR",
    async quote(req) {
      return { ok: true, provider: "MRR", hashrateMh: req.hashrateMh, costUsd: req.hashrateMh.div(1000).mul(RIG_DAY_USD).mul(req.hours / 24) };
    },
    async provision(req: ProvisionRequest) {
      rented.push(req);
      const id = `R${++n}`;
      rentals.set(id, { externalId: id, state: "ACTIVE" });
      return {
        allocations: [{ provider: "MRR", externalId: id, rigId: "1", advertisedMh: req.hashrateMh, costUsd: new Decimal(RIG_DAY_USD), meta: { port: "10032" } }],
        shortfallMh: new Decimal(0),
        errors: [],
      };
    },
    async status(ids) {
      return ids.map((id) => rentals.get(id)!);
    },
    async setPool(ids, target) {
      pools.push({ ids, target });
    },
  };
  return { p, rentals, pools, rented, lastUser: () => pools.at(-1)?.target.user };
}

const deps = (provider: HashrateProvider): WorkerDeps => ({ db, router: new ProviderRouter([provider]), provider, log: () => {} });

const setting = (key: string, value: string) => db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });

// A paid BTQ order for `sharePct` of a 1 GH/s rig for `days`, priced at 2× the rig cost.
async function paidOrder(sharePct: number, days = 1) {
  const user = await db.user.create({ data: { email: `u${Date.now()}${Math.random()}@x.io`, passwordHash: "x" } });
  const cost = (RIG_DAY_USD * sharePct * days) / 100;
  const quote = await db.quote.create({
    data: {
      userId: user.id, coinId: "BTQ", sharePct, days, rigMh: 1000, rigCostUsd: RIG_DAY_USD, hashrateMh: (1000 * sharePct) / 100,
      hours: 24 * days, costUsd: cost, multiplier: 2, multiplierSource: "global", priceUsd: cost * 2, expiresAt: new Date(Date.now() + 60_000),
    },
  });
  const order = await createOrderFromQuote(db, { quoteId: quote.id, userId: user.id, payoutAddress: CUSTOMER, method: "USDT", btqSharePct: 0 });
  await markPaid(db, order.id, { method: "MANUAL", by: "test" });
  return order;
}

const order = (id: string) => db.order.findUniqueOrThrow({ where: { id }, include: { slots: { orderBy: { startsAt: "asc" } } } });
const emailKinds = async (orderId: string) =>
  (await db.email.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } })).map((e) => `${e.kind}:${e.to.startsWith("ops@") ? "ops" : "customer"}`);

describe.skipIf(!url)("worker jobs (integration)", () => {
  beforeEach(async () => {
    await db.$executeRawUnsafe(
      `TRUNCATE "Email","PasswordReset","OrderEvent","Rental","Slot","RigDay","Payment","Order","Quote","Session","PricingChange","User","Setting" CASCADE`,
    );
    await db.coin.update({
      where: { id: "BTQ" },
      data: { enabled: true, rigMh: 1000, poolHost: "pool.bitqube.org", poolPort: 10032, poolUser: "{address}", houseAddress: HOUSE, mrrProfileId: null },
    });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  it("books paid orders onto one shared rig day but rents nothing while provisioning is off", async () => {
    const a = await paidOrder(25);
    const b = await paidOrder(25);
    const f = fakeProvider();
    expect(await bookPaidOrders(deps(f.p))).toBe(2);
    const days = await db.rigDay.findMany({ include: { slots: true } });
    expect(days).toHaveLength(1);
    expect(days[0].bookedMinutes).toBe(720);
    expect(days[0].maxCostUsd.toNumber()).toBeGreaterThanOrEqual(RIG_DAY_USD * 1.2);
    expect((await order(a.id)).status).toBe("QUEUED");
    expect((await order(b.id)).slots[0].startsAt).toBeNull(); // timed once the rig is rented
    expect(await rentRigDays(deps(f.p))).toBe(0);
    expect(f.rented).toHaveLength(0);
  });

  it("rents a rig day once enough is sold, runs each slot on the customer's address, then the house", async () => {
    await setting("provisioning.enabled", "true");
    const a = await paidOrder(25);
    const b = await paidOrder(25);
    const f = fakeProvider();
    const t0 = new Date();
    await bookPaidOrders(deps(f.p), t0);
    expect(await rentRigDays(deps(f.p), t0)).toBe(1);
    expect(f.rented[0]).toMatchObject({ algo: "kawpow", profileId: "985841", pool: { user: HOUSE } });
    expect(f.rented[0].hashrateMh.toNumber()).toBe(1000);

    const [sa] = (await order(a.id)).slots;
    const [sb] = (await order(b.id)).slots;
    expect(sa.startsAt!.getTime()).toBe(t0.getTime());
    expect(sb.startsAt!.getTime()).toBe(t0.getTime() + 6 * H); // back to back

    await switchSlots(deps(f.p), new Date(t0.getTime() + 60_000));
    expect(f.lastUser()).toBe(CUSTOMER);
    expect((await order(a.id)).status).toBe("ACTIVE");
    expect((await order(a.id)).slots[0].status).toBe("MINING");

    await switchSlots(deps(f.p), new Date(t0.getTime() + 6 * H + 60_000));
    expect((await order(a.id)).slots[0].status).toBe("DONE");
    expect((await order(b.id)).slots[0].status).toBe("MINING");

    await switchSlots(deps(f.p), new Date(t0.getTime() + 12 * H + 60_000));
    expect(f.lastUser()).toBe(HOUSE); // unsold half of the day
    const switches = f.pools.length;
    await switchSlots(deps(f.p), new Date(t0.getTime() + 13 * H));
    expect(f.pools).toHaveLength(switches); // nothing to change

    f.rentals.set("R1", { externalId: "R1", state: "ENDED", averageMh: new Decimal(1000) });
    await pollActiveRentals(deps(f.p));
    expect(await finishRigDays(deps(f.p), new Date(t0.getTime() + 24 * H))).toBe(1);
    expect(await completeFinishedOrders(deps(f.p))).toBe(2);
    expect((await order(a.id)).status).toBe("COMPLETED");
    expect(await emailKinds(a.id)).toEqual(["order.placed:customer", "order.paid:customer", "order.scheduled:customer", "order.active:customer", "order.completed:customer"]);
  });

  it("waits for more buyers, then rents anyway once the first one has waited long enough", async () => {
    await setting("provisioning.enabled", "true");
    await setting("slots.maxWaitHours", "4");
    await paidOrder(10);
    const f = fakeProvider();
    const t0 = new Date();
    await bookPaidOrders(deps(f.p), t0);
    expect(await rentRigDays(deps(f.p), new Date(t0.getTime() + 3 * H))).toBe(0);
    expect(await rentRigDays(deps(f.p), new Date(t0.getTime() + 4 * H + 60_000))).toBe(1);
  });

  it("holds a rig day for a coin that isn't set up, and alerts after three tries", async () => {
    await setting("provisioning.enabled", "true");
    await setting("slots.minBookedPct", "10");
    await db.coin.update({ where: { id: "BTQ" }, data: { houseAddress: null } });
    await paidOrder(10);
    const f = fakeProvider();
    let t = Date.now();
    await bookPaidOrders(deps(f.p), new Date(t));
    for (let i = 0; i < 3; i++, t += 11 * 60_000) await rentRigDays(deps(f.p), new Date(t));
    const day = await db.rigDay.findFirstOrThrow();
    expect(day.status).toBe("OPEN");
    expect(day.attempts).toBe(3);
    expect(day.failureReason).toMatch(/house address/);
    expect(f.rented).toHaveLength(0);
    expect(await db.email.count({ where: { kind: "admin.alert" } })).toBe(1);
  });

  it("books the rest of a slot again when the rig stops early", async () => {
    await setting("provisioning.enabled", "true");
    await setting("slots.minBookedPct", "10");
    const a = await paidOrder(25);
    const f = fakeProvider();
    const t0 = new Date();
    await bookPaidOrders(deps(f.p), t0);
    await rentRigDays(deps(f.p), t0);
    await switchSlots(deps(f.p), new Date(t0.getTime() + 60_000));

    // The rig dies two hours into a six-hour slot.
    f.rentals.set("R1", { externalId: "R1", state: "ENDED", averageMh: new Decimal(1000) });
    await pollActiveRentals(deps(f.p));
    await finishRigDays(deps(f.p), new Date(t0.getTime() + 2 * H));

    const o = await order(a.id);
    expect(o.status).toBe("ACTIVE");
    const done = o.slots.find((s) => s.status === "DONE")!;
    const again = o.slots.find((s) => s.status === "BOOKED")!;
    expect(done.minutes).toBe(360);
    expect(again.minutes).toBe(241); // started a minute in, ran to 2h
    expect(again.rigDayId).not.toBe(done.rigDayId);
    expect(await completeFinishedOrders(deps(f.p))).toBe(0);
    expect((await db.orderEvent.findMany({ where: { orderId: a.id } })).map((e) => e.type)).toContain("slot.rebooked");
  });
});
