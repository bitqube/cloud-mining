import Decimal from "decimal.js";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getSettings, setSetting } from "../settings";
import { readFeedState, refreshBtqPrice, STALE_MS, type Ticker } from "./price-feed";

// Runs against a real Postgres: TEST_DATABASE_URL=postgresql://.../bitqube_test npm run test:int
const url = process.env.TEST_DATABASE_URL;
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : (undefined as unknown as PrismaClient);
process.env.ADMIN_ALERT_EMAIL = "ops@bitqube.test";

const ticker = (last: string, bid: string): Ticker => ({
  last: new Decimal(last),
  bid: new Decimal(bid),
  ask: new Decimal("0.021"),
  volumeUsd: new Decimal("9.9"),
});
const quote = (t: Ticker) => async () => t;
const down = async (): Promise<Ticker> => {
  throw new Error("fetch failed");
};
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 28, 12, 0) + minutes * 60_000);
const refresh = (now: Date, fetchTicker: () => Promise<Ticker>) => refreshBtqPrice(db, () => {}, now, fetchTicker);
const rate = async () => (await getSettings(db))["btq.usdRate"].toFixed();
const alerts = () => db.email.findMany({ where: { kind: "admin.alert" }, orderBy: { createdAt: "asc" } });

describe.skipIf(!url)("BTQ price feed (integration)", () => {
  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE "Email","Setting" CASCADE`);
    await setSetting(db, "btq.usdRate", "0.01");
    await db.setting.update({ where: { key: "btq.usdRate" }, data: { updatedAt: at(-1) } }); // set by hand just before the test starts
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  it("does nothing while the feed is off", async () => {
    expect(await refresh(at(0), quote(ticker("0.02", "0.02")))).toBe(0);
    expect(await rate()).toBe("0.01");
    expect(await readFeedState(db)).toBeNull();
  });

  it("sets the price to the lower of last trade and bid, and records the check", async () => {
    await setSetting(db, "btq.priceAuto", "true");
    expect(await refresh(at(0), quote(ticker("0.021", "0.00785")))).toBe(1);
    expect(await rate()).toBe("0.00785");
    expect(await readFeedState(db)).toMatchObject({ ok: true, price: "0.00785", last: "0.021", bid: "0.00785", okAt: at(0).toISOString() });
    expect(await refresh(at(10), quote(ticker("0.021", "0.00785")))).toBe(0); // unchanged
  });

  it("keeps the previous price through a short outage without alerting, then turns BTQ off when stale", async () => {
    await setSetting(db, "btq.priceAuto", "true");
    await refresh(at(0), quote(ticker("0.009", "0.009")));
    await refresh(at(10), down);
    expect(await rate()).toBe("0.009");
    expect(await alerts()).toHaveLength(0);
    expect(await readFeedState(db)).toMatchObject({ ok: false, error: "fetch failed", okAt: at(0).toISOString() });

    await refresh(at(STALE_MS / 60_000), down);
    expect(await rate()).toBe("0");
    const sent = await alerts();
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/BTQ checkout is off/);

    // Recovers on the next good price.
    await refresh(at(STALE_MS / 60_000 + 10), quote(ticker("0.0095", "0.0095")));
    expect(await rate()).toBe("0.0095");
  });

  it("rejects a price outside the bounds, alerting at most every 6 hours", async () => {
    await setSetting(db, "btq.priceAuto", "true");
    await setSetting(db, "btq.priceMaxUsd", "0.015");
    await refresh(at(0), quote(ticker("0.03", "0.02")));
    expect(await rate()).toBe("0.01");
    expect(await readFeedState(db)).toMatchObject({ ok: false, error: "price $0.02 is above the ceiling of $0.015" });
    await refresh(at(10), quote(ticker("0.03", "0.02")));
    expect(await alerts()).toHaveLength(1);
    expect((await alerts())[0].subject).toMatch(/BTQ price not updated$/);
  });

  it("treats a price set by hand as the last good one, so switching the feed on doesn't drop it at once", async () => {
    await setSetting(db, "btq.priceAuto", "true");
    await refresh(at(0), down);
    expect(await rate()).toBe("0.01");
    await refresh(at(STALE_MS / 60_000), down);
    expect(await rate()).toBe("0");
  });
});
