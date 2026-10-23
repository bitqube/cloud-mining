import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  customerPrice,
  displayRatePerMhDay,
  MultiplierError,
  parseMultiplier,
  priceQuote,
  provisioningBudget,
  QUOTE_TTL_MS,
  resolveMultiplier,
} from "./pricing";

describe("multiplier", () => {
  it("prefers the per-user override over the global value", () => {
    expect(resolveMultiplier({ global: 3, user: 2 })).toMatchObject({ source: "user" });
    expect(resolveMultiplier({ global: 3, user: 2 }).multiplier.toNumber()).toBe(2);
    expect(resolveMultiplier({ global: 3, user: null })).toMatchObject({ source: "global" });
    expect(resolveMultiplier({ global: null }).multiplier.toNumber()).toBe(3); // default
  });

  it("rejects loss-making, typo-sized and non-numeric values", () => {
    expect(parseMultiplier("2.5").toNumber()).toBe(2.5);
    expect(parseMultiplier(1).toNumber()).toBe(1);
    expect(() => parseMultiplier(0.9)).toThrow(MultiplierError);
    expect(() => parseMultiplier(300)).toThrow(MultiplierError);
    expect(() => parseMultiplier("abc")).toThrow(MultiplierError);
    expect(() => parseMultiplier("Infinity")).toThrow(MultiplierError);
  });
});

describe("prices", () => {
  it("applies the multiplier: 1 per MH/s at 3× is 3", () => {
    expect(displayRatePerMhDay(1, 3).toNumber()).toBe(3);
    expect(customerPrice(11.86, 3).toNumber()).toBe(35.58);
  });

  it("rounds customer prices up to the cent", () => {
    expect(customerPrice("10.001", 1).toString()).toBe("10.01");
  });

  it("caps the provisioning budget at what the customer paid", () => {
    expect(provisioningBudget(100, 300).toNumber()).toBe(110); // quoted cost + 10% slippage
    expect(provisioningBudget(100, 105).toNumber()).toBe(105); // 1.05× markup: never spend past the price
  });

  it("snapshots cost, multiplier, margin and expiry in a quote", () => {
    const q = priceQuote(new Decimal("11.86"), { global: 3, user: "2.5" }, 0);
    expect(q).toMatchObject({ multiplierSource: "user" });
    expect(q.priceUsd.toNumber()).toBe(29.65);
    expect(q.marginUsd.toNumber()).toBeCloseTo(17.79);
    expect(q.expiresAt.getTime()).toBe(QUOTE_TTL_MS);
  });
});
