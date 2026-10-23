import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../settings";
import { btqAmount, btqUnavailableReason, BtqUnavailableError, isPaidInFull, paymentUri } from "./payments";
import type { BtqWallet } from "./wallet";

const wallet = {} as BtqWallet;
const settings = (rate: string, maxUsd = 200, enabled = true) => ({
  ...DEFAULTS,
  "btq.enabled": enabled,
  "btq.usdRate": new Decimal(rate),
  "btq.maxOrderUsd": maxUsd,
});

describe("BTQ pricing", () => {
  it("converts USD at the admin rate, rounding up to 0.01 BTQ", () => {
    expect(btqAmount("70.55", "0.005").toFixed()).toBe("14110");
    expect(btqAmount("10", "3").toFixed()).toBe("3.34"); // 3.333… never rounds down
    expect(() => btqAmount("10", "0")).toThrow(BtqUnavailableError);
  });

  it("accepts up to 0.5% short, for wallets that take the fee out of the amount", () => {
    expect(isPaidInFull("100", "100")).toBe(true);
    expect(isPaidInFull("99.5", "100")).toBe(true);
    expect(isPaidInFull("99.49", "100")).toBe(false);
  });

  it("is offered only when switched on, with a node, a price, and under the per-order cap", () => {
    expect(btqUnavailableReason(wallet, settings("0.01", 200, false), 50)).toMatch(/not available/);
    expect(btqUnavailableReason(null, settings("0.01"), 50)).toMatch(/not available/);
    expect(btqUnavailableReason(wallet, settings("0"), 50)).toMatch(/not available/);
    expect(btqUnavailableReason(wallet, settings("0.01", 200), "200.01")).toMatch(/At most \$200/);
    expect(btqUnavailableReason(wallet, settings("0.01", 200), 200)).toBeNull();
    expect(btqUnavailableReason(wallet, settings("0.01", 200))).toBeNull();
  });

  it("builds a bitqube: payment URI", () => {
    expect(paymentUri("BAddr", new Decimal("14110.50"))).toBe("bitqube:BAddr?amount=14110.5");
  });
});
