import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { ProviderRouter } from "./router";
import type { HashrateProvider, ProviderId, ProvisionRequest, Quote } from "./types";

// Only MRR exists in production; a second fake id exercises the multi-provider paths.
const ALT = "ALT" as ProviderId;

// Fake provider: sells up to `capacityMh` at `usdPerMh` and records what it was asked.
function fake(id: ProviderId, usdPerMh: number, capacityMh: number, opts: { throwOnQuote?: boolean } = {}) {
  const provisioned: number[] = [];
  let left = capacityMh;
  const p: HashrateProvider = {
    id,
    async quote(req): Promise<Quote> {
      if (opts.throwOnQuote) throw new Error(`${id} down`);
      if (left <= 0) return { ok: false, provider: id, reason: "sold out", availableMh: new Decimal(0) };
      const mh = Decimal.min(req.hashrateMh, left);
      return { ok: true, provider: id, hashrateMh: mh, costUsd: mh.mul(usdPerMh) };
    },
    async provision(req) {
      const mh = Decimal.min(req.hashrateMh, left);
      left -= mh.toNumber();
      provisioned.push(mh.toNumber());
      return {
        allocations: mh.gt(0)
          ? [{ provider: id, externalId: `${id}-${provisioned.length}`, advertisedMh: mh, costUsd: mh.mul(usdPerMh) }]
          : [],
        shortfallMh: req.hashrateMh.sub(mh),
        errors: [],
      };
    },
    async status() {
      return [];
    },
    async setPool() {},
  };
  return { p, provisioned };
}

const req = (mh: number, maxUsd = 1e6): ProvisionRequest => ({
  algo: "kawpow",
  hashrateMh: new Decimal(mh),
  hours: 24,
  orderRef: "o1",
  pool: { host: "pool.bitqube.org", port: 10032, user: "Baddr", pass: "x" },
  maxCostUsd: new Decimal(maxUsd),
});

describe("ProviderRouter", () => {
  it("uses the cheaper provider for the whole order", async () => {
    const mrr = fake("MRR", 1.0, 1000);
    const alt = fake(ALT, 1.05, 1000);
    const res = await new ProviderRouter([mrr.p, alt.p]).fulfil(req(100));
    expect(res.allocations.map((a) => a.provider)).toEqual(["MRR"]);
    expect(res.shortfallMh.toNumber()).toBe(0);
    expect(alt.provisioned).toEqual([]);
  });

  it("tops up a shortfall from the second provider", async () => {
    const mrr = fake("MRR", 1.0, 60);
    const alt = fake(ALT, 1.05, 1000);
    const res = await new ProviderRouter([mrr.p, alt.p]).fulfil(req(100));
    expect(mrr.provisioned).toEqual([60]);
    expect(alt.provisioned).toEqual([40]);
    expect(res.shortfallMh.toNumber()).toBe(0);
    expect(res.costUsd.toNumber()).toBeCloseTo(60 + 40 * 1.05);
  });

  it("falls back when one provider's API is down", async () => {
    const mrr = fake("MRR", 1.0, 1000, { throwOnQuote: true });
    const alt = fake(ALT, 1.05, 1000);
    const res = await new ProviderRouter([mrr.p, alt.p]).fulfil(req(100));
    expect(res.allocations.map((a) => a.provider)).toEqual([ALT]);
    expect(res.errors).toContainEqual({ provider: "MRR", message: "MRR down" });
  });

  it("refuses quotes over budget and reports the shortfall", async () => {
    const mrr = fake("MRR", 1.0, 1000);
    const res = await new ProviderRouter([mrr.p]).fulfil(req(100, 50));
    expect(res.allocations).toEqual([]);
    expect(res.shortfallMh.toNumber()).toBe(100);
  });

  it("treats a shortfall within tolerance as filled", async () => {
    const mrr = fake("MRR", 1.0, 97);
    const res = await new ProviderRouter([mrr.p], { toleratedShortfallPct: 5 }).fulfil(req(100));
    expect(res.shortfallMh.toNumber()).toBe(0);
  });
});
