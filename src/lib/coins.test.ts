import { describe, expect, it } from "vitest";
import type { Coin } from "@prisma/client";
import Decimal from "decimal.js";
import { coinHashrate } from "./coin-format";
import { coinProblems, houseTarget, isValidPayoutAddress, mrrProfileFor, orderTarget, parseOwnPool } from "./coins";

const coin = (over: Partial<Coin> = {}): Coin => ({
  id: "RVN",
  name: "Ravencoin",
  algo: "kawpow",
  unit: "MH/s",
  unitMh: new Decimal(1) as never,
  rigMh: new Decimal(1000) as never,
  enabled: true,
  sortOrder: 0,
  poolHost: "rvn.2miners.com",
  poolPort: 6060,
  poolUser: "{address}.{worker}",
  poolPass: "x",
  portsByDifficulty: false,
  ownPoolAllowed: true,
  houseAddress: "RVaG8KbMDWkQ4NRHcBxxkfuAgPWsUdNjJh",
  mrrProfileId: null,
  updatedAt: new Date(),
  ...over,
});

const order = { id: "cmorder123456", payoutAddress: "RVaG8KbMDWkQ4NRHcBxxkfuAgPWsUdNjJh", poolHost: null, poolPort: null, poolUser: null, poolPass: null };

describe("payout addresses", () => {
  it.each([
    ["BTC", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"],
    ["BTC", "1BoatSLRHtKNngkdXEeobR76b53LETtpyT"],
    ["LTC", "ltc1qg82cvq0e4q4xahy8vh6z0dr0a4d2k5dmk5rlz5"],
    ["DOGE", "DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L"],
    ["ETC", "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"],
    ["RVN", "RVaG8KbMDWkQ4NRHcBxxkfuAgPWsUdNjJh"],
    ["DASH", "XpESxaUmonkq8RaLLp46Brx2K39ggQe226"],
    ["ZEC", "t1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU"],
  ])("accepts a %s address", (c, a) => expect(isValidPayoutAddress(c, a)).toBe(true));

  it("rejects an address for the wrong coin", () => {
    expect(isValidPayoutAddress("RVN", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).toBe(false);
    expect(isValidPayoutAddress("ETC", "0x742d35")).toBe(false);
    expect(isValidPayoutAddress("BTQ", "RVaG8KbMDWkQ4NRHcBxxkfuAgPWsUdNjJh")).toBe(false);
  });
});

describe("pool targets", () => {
  it("fills the coin's username template with the customer's address", () => {
    expect(orderTarget(coin(), order)).toEqual({ host: "rvn.2miners.com", port: 6060, user: `${order.payoutAddress}.bq123456`, pass: "x" });
  });

  it("uses the customer's own pool when they gave one", () => {
    const own = { ...order, poolHost: "my.pool.io", poolPort: 3333, poolUser: "me.rig1", poolPass: "" };
    expect(orderTarget(coin(), own)).toEqual({ host: "my.pool.io", port: 3333, user: "me.rig1", pass: "x" });
  });

  it("house time needs a house address", () => {
    expect(houseTarget(coin())?.user).toBe("RVaG8KbMDWkQ4NRHcBxxkfuAgPWsUdNjJh.house");
    expect(houseTarget(coin({ houseAddress: null }))).toBeNull();
  });

  it("cleans up a pasted stratum URL", () => {
    expect(parseOwnPool({ host: "stratum+tcp://rvn.2miners.com", port: "6060", user: "R.rig", pass: "" })).toEqual({
      ok: true,
      host: "rvn.2miners.com",
      port: 6060,
      user: "R.rig",
      pass: "x",
    });
    expect(parseOwnPool({ host: "localhost", port: "6060", user: "x", pass: "" }).ok).toBe(false);
  });
});

describe("readiness", () => {
  it("KawPOW coins fall back to the env profile; others need their own", () => {
    expect(mrrProfileFor(coin(), { MRR_PROFILE_ID: "985841" })).toBe("985841");
    expect(mrrProfileFor(coin({ algo: "sha256" }), { MRR_PROFILE_ID: "985841" })).toBeNull();
    expect(coinProblems(coin({ algo: "sha256", poolHost: null, houseAddress: null }), {})).toEqual([
      "no pool set",
      "no house address for unsold time",
      "no MRR pool profile for sha256",
    ]);
    expect(coinProblems(coin(), { MRR_PROFILE_ID: "1" })).toEqual([]);
  });

  it("formats hashrate in the coin's unit", () => {
    expect(coinHashrate(100_000_000, { unit: "TH/s", unitMh: 1_000_000 })).toBe("100 TH/s");
    expect(coinHashrate(0.01, { unit: "KH/s", unitMh: 0.001 })).toBe("10 KH/s");
    expect(coinHashrate(250, { unit: "MH/s", unitMh: 1 })).toBe("250 MH/s");
  });
});
