import { describe, expect, it } from "vitest";
import type { Rig } from "./api";
import { selectRigs, toUnit, type SelectionCriteria } from "./selection";

function rig(id: string, mh: number, btcPerHour: number, over: Partial<Rig> = {}): Rig {
  return {
    id,
    name: `rig ${id}`,
    owner: "o",
    type: "kawpow",
    status: { status: "available", hours: 0, rented: false, online: true },
    online: true,
    xnonce: "no",
    poolstatus: "online",
    region: "eu",
    rpi: "95.00",
    suggested_diff: "",
    optimal_diff: { min: "0", max: "0" },
    ndevices: "1",
    extensions: true,
    price: {
      type: "mh",
      BTC: { currency: "BTC", price: "0", hour: String(btcPerHour), minhrs: "0", maxhrs: "0", enabled: true },
    },
    minhours: "3",
    maxhours: "168",
    hashrate: { advertised: { hash: mh, type: "mh", nice: `${mh}M` } },
    description: null,
    shorturl: "",
    ...over,
  };
}

const base: SelectionCriteria = { targetMh: 100, hours: 24, currency: "BTC", minRpi: 80, maxOverfillPct: 20, maxRigs: 10 };

describe("toUnit", () => {
  it("converts between hash units", () => {
    expect(toUnit(1.5, "gh", "mh").toNumber()).toBe(1500);
    expect(toUnit(500, "kh", "mh").toNumber()).toBe(0.5);
  });
});

describe("selectRigs", () => {
  it("fills the target with the cheapest rigs per MH", () => {
    const res = selectRigs([rig("a", 60, 0.0006), rig("b", 60, 0.0003), rig("c", 50, 0.0002)], base);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rigs.map((r) => r.rigId)).toEqual(["c", "b"]);
    expect(res.totalMh.toNumber()).toBe(110);
    expect(res.totalCost.toNumber()).toBeCloseTo((0.0002 + 0.0003) * 24, 10);
  });

  it("skips rigs that would overshoot the overfill ceiling", () => {
    const res = selectRigs([rig("big", 500, 0.001), rig("a", 50, 0.0005), rig("b", 55, 0.0006)], base);
    expect(res.ok && res.rigs.map((r) => r.rigId)).toEqual(["a", "b"]);
  });

  it("filters out rented, offline, low-RPI and wrong-length rigs", () => {
    const rigs = [
      rig("rented", 200, 0.0001, { status: { status: "rented", hours: 5, rented: true, online: true } }),
      rig("offline", 200, 0.0001, { online: false }),
      rig("lowrpi", 200, 0.0001, { rpi: "40" }),
      rig("newrig", 200, 0.0001, { rpi: "new" }),
      rig("tooShort", 200, 0.0001, { maxhours: "12" }),
      rig("ok", 100, 0.001),
    ];
    const res = selectRigs(rigs, base);
    expect(res.ok && res.rigs.map((r) => r.rigId)).toEqual(["ok"]);
  });

  it("fails with the best achievable hashrate when supply is short", () => {
    const res = selectRigs([rig("a", 40, 0.0001)], base);
    expect(res).toMatchObject({ ok: false });
    expect(!res.ok && res.bestMh.toNumber()).toBe(40);
  });

  it("enforces the cost ceiling", () => {
    const res = selectRigs([rig("a", 100, 0.01)], { ...base, maxTotalCost: 0.1 });
    expect(res.ok).toBe(false);
  });
});

describe("hourlyCost / portFor", () => {
  it("derives the hourly cost when MRR omits `hour` (rigs embedded in /rental)", async () => {
    const { hourlyCost } = await import("./selection");
    // Live rental 5821873: 0.04371961 ETH per GH/day on a 205 MH rig.
    const r = rig("157289", 205, 0);
    r.price = { type: "gh", ETH: { currency: "ETH", price: "0.04371961", enabled: true } };
    expect(hourlyCost(r, "ETH")?.toNumber()).toBeCloseTo((0.04371961 * 0.205) / 24, 12);
  });

  it("matches the live 205 MH rig to port 10032 and a 50 GH rig to neither low port", async () => {
    const { portFor } = await import("./selection");
    const ports = [{ port: 10032, minDiff: 0.04, maxDiff: 16 }, { port: 10256, minDiff: 1000, maxDiff: 9000 }];
    const small = rig("157289", 205, 0, { optimal_diff: { min: "1025000000.000", max: "6150000000.000" } });
    const big = rig("326323", 50000, 0, { optimal_diff: { min: "250000000000.000", max: "1500000000000.000" } });
    expect(portFor(small, ports)).toBe(10032);
    expect(portFor(big, ports)).toBeUndefined();
  });

  it("respects a per-currency min_rental_length above minhours", () => {
    const r = rig("a", 100, 0.001);
    r.price.BTC!.min_rental_length = 48;
    expect(selectRigs([r], base).ok).toBe(false);
  });
});
