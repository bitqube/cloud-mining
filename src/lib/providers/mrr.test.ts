import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import type { MrrApi, Rental, Rig } from "../mrr/api";
import { HASHES_PER_POOL_DIFF, type PoolPort } from "../mrr/selection";
import { MrrProvider, rentalStatus } from "./mrr";

const PORTS: PoolPort[] = [
  { port: 10032, minDiff: 0.04, maxDiff: 16 },
  { port: 10256, minDiff: 1000, maxDiff: 9000 },
];

// optimal pool-diff window for the rig, converted to MRR's hash units.
function rig(id: string, mh: number, btcPerHour: number, diff: [number, number] = [0.25, 1.5]): Rig {
  return {
    id, name: id, owner: "o", type: "kawpow",
    status: { status: "available", hours: 0, rented: false, online: true },
    online: true, xnonce: "no", poolstatus: "online", region: "eu", rpi: "99",
    suggested_diff: "",
    optimal_diff: { min: String(diff[0] * HASHES_PER_POOL_DIFF), max: String(diff[1] * HASHES_PER_POOL_DIFF) },
    ndevices: "1", extensions: true,
    price: { type: "mh", BTC: { currency: "BTC", price: String((btcPerHour * 24) / mh), hour: String(btcPerHour), enabled: true } },
    minhours: "3", maxhours: "168",
    hashrate: { advertised: { hash: mh, type: "mh", nice: "" } },
    description: null, shorturl: "",
  };
}

// In-memory MRR: ids in `stolen` fail on rent (someone else got there first),
// ids in `badPool` fail on the pool repoint.
function fakeApi(market: Rig[], opts: { stolen?: Set<string>; badPool?: Set<string> } = {}) {
  const calls: string[] = [];
  const api = {
    searchRigs: async () => ({ offset: 0, count: market.length, total: String(market.length), records: market.filter((r) => !r.status.rented) }),
    rent: async (p: { rig: number; length: number; profile: number }) => {
      const r = market.find((m) => m.id === String(p.rig))!;
      r.status.rented = true;
      if (opts.stolen?.has(r.id)) throw new Error("Rig is not available");
      calls.push(`rent:${r.id}:profile${p.profile}`);
      return { id: `R${r.id}`, price: { paid: String(Number(r.price.BTC!.hour) * p.length), currency: "BTC", advertised: "0" } } as unknown as Rental;
    },
    setRentalPool: async (ids: string[], _prio: number, t: { port: number; user: string }) => {
      if (opts.badPool?.has(ids[0].slice(1))) throw new Error("MRR down");
      calls.push(`pool:${ids[0]}:${t.port}:${t.user}`);
    },
  } as unknown as MrrApi;
  return { api, calls };
}

const pool = { host: "pool.bitqube.org", port: 10032, user: "Bcustomer", pass: "x" };
const assetUsd = async () => new Decimal(60_000);
const base = { assetUsd, baseProfileId: "985841", ports: PORTS, poolSetAttempts: 2 };
const order = (mh = 100) => ({ algo: "kawpow", hashrateMh: new Decimal(mh), hours: 24, orderRef: "o1", pool, maxCostUsd: new Decimal(100) });

async function quoteAndProvision(p: MrrProvider, mh = 100) {
  const q = await p.quote({ algo: "kawpow", hashrateMh: new Decimal(mh), hours: 24 });
  if (!q.ok) throw new Error(`expected quote: ${q.reason}`);
  return { q, res: await p.provision(order(mh), q) };
}

describe("MrrProvider", () => {
  it("rents on the base profile, then repoints each rental at the customer", async () => {
    const { api, calls } = fakeApi([rig("1", 60, 0.00001), rig("2", 50, 0.00001), rig("3", 500, 0.0001)]);
    const { q, res } = await quoteAndProvision(new MrrProvider({ api, ...base }));
    expect(q.costUsd.toNumber()).toBeCloseTo(0.00002 * 24 * 60_000);
    expect(res.shortfallMh.toNumber()).toBe(0);
    expect(calls).toEqual(["rent:1:profile985841", "pool:R1:10032:Bcustomer", "rent:2:profile985841", "pool:R2:10032:Bcustomer"]);
  });

  it("routes each rig to the port matching its difficulty and skips rigs that fit none", async () => {
    const { api, calls } = fakeApi([
      rig("11", 60, 0.00001, [0.25, 1.5]),
      rig("22", 50, 0.00001, [2000, 8000]),
      rig("33", 50, 0.000001, [60, 350]), // cheapest, but between our ports
    ]);
    const { res } = await quoteAndProvision(new MrrProvider({ api, ...base }));
    expect(res.allocations.map((a) => [a.rigId, a.meta?.port])).toEqual([["11", "10032"], ["22", "10256"]]);
    expect(calls.some((c) => c.includes("rent:33"))).toBe(false);
  });

  it("for another pool, rents any rig on the coin's own profile and keeps that pool's port", async () => {
    const { api, calls } = fakeApi([rig("33", 110, 0.000001, [60, 350])]);
    const p = new MrrProvider({ api, ...base });
    const req = { algo: "kawpow", hashrateMh: new Decimal(100), hours: 24, ports: null };
    const q = await p.quote(req);
    if (!q.ok) throw new Error(q.reason);
    const res = await p.provision({ ...req, orderRef: "d1", maxCostUsd: new Decimal(100), profileId: "777", pool: { ...pool, port: 6060 } }, q);
    expect(res.allocations.map((a) => a.meta?.port)).toEqual(["6060"]);
    expect(calls).toEqual(["rent:33:profile777", "pool:R33:6060:Bcustomer"]);
  });

  it("re-searches when a quoted rig is rented by someone else", async () => {
    const { api } = fakeApi([rig("1", 60, 0.00001), rig("2", 50, 0.00001), rig("4", 55, 0.000012)], { stolen: new Set(["2"]) });
    const { res } = await quoteAndProvision(new MrrProvider({ api, ...base }));
    expect(res.allocations.map((a) => a.rigId).sort()).toEqual(["1", "4"]);
    expect(res.errors.some((e) => e.includes("rig 2"))).toBe(true);
  });

  it("keeps a paid rental whose repoint failed and flags it for the poller", async () => {
    const { api } = fakeApi([rig("1", 110, 0.00001)], { badPool: new Set(["1"]) });
    const { res } = await quoteAndProvision(new MrrProvider({ api, ...base }));
    expect(res.allocations).toHaveLength(1);
    expect(res.allocations[0].meta?.poolPending).toBe("1");
    expect(res.errors[0]).toMatch(/pool not set/);
  });
});

describe("rentalStatus", () => {
  it("maps MRR rental fields, preferring *_unix timestamps", () => {
    const s = rentalStatus({
      id: "9", ended: true, refunded: false, start: "2022-03-02 15:37:03 UTC", end: "2022-03-02 18:37:03 UTC", end_unix: "1646246223",
      hashrate: { advertised: { hash: 17, type: "th", nice: "" }, average: { hash: "11.9", type: "th", nice: "" } },
    } as unknown as Rental);
    expect(s.state).toBe("ENDED");
    expect(s.averageMh?.toNumber()).toBe(11_900_000);
    expect(s.endsAt?.toISOString()).toBe("2022-03-02T18:37:03.000Z");
  });
});
