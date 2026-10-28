import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { priceFromTicker, vindaxConfig, type Ticker } from "./price-feed";

const ticker = (last: string, bid: string, ask = "0.021"): Ticker => ({
  last: new Decimal(last),
  bid: new Decimal(bid),
  ask: new Decimal(ask),
  volumeUsd: new Decimal("9.9"),
});

describe("BTQ price from VinDAX", () => {
  it("uses the lower of the last trade and the best bid", () => {
    expect(priceFromTicker(ticker("0.021", "0.00785"), 0, 0)).toEqual({ price: new Decimal("0.00785") });
    expect(priceFromTicker(ticker("0.0079", "0.0085"), 0, 0)).toEqual({ price: new Decimal("0.0079") });
  });

  it("needs a trade and a bid", () => {
    expect(priceFromTicker(ticker("0", "0.008"), 0, 0)).toEqual({ error: "no trades yet" });
    expect(priceFromTicker(ticker("0.01", "0"), 0, 0)).toEqual({ error: "no buy orders on the book" });
  });

  it("rejects a price outside the admin floor and ceiling (0 = no bound)", () => {
    expect(priceFromTicker(ticker("0.01", "0.008"), 0.009, 0)).toEqual({ error: "price $0.008 is below the floor of $0.009" });
    expect(priceFromTicker(ticker("0.05", "0.04"), 0, 0.03)).toEqual({ error: "price $0.04 is above the ceiling of $0.03" });
    expect(priceFromTicker(ticker("0.01", "0.008"), 0.005, 0.03)).toEqual({ price: new Decimal("0.008") });
  });

  it("defaults to VinDAX's public API and BTQUSDT", () => {
    const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;
    expect(vindaxConfig(env({}))).toEqual({ url: "https://api.vindax.com", symbol: "BTQUSDT" });
    expect(vindaxConfig(env({ VINDAX_API_URL: " https://example.test/ ", VINDAX_SYMBOL: "BTQUSDC" }))).toEqual({
      url: "https://example.test",
      symbol: "BTQUSDC",
    });
  });
});
