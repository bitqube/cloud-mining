import Decimal from "decimal.js";

// Customer pricing = what MRR charges us × a markup multiplier.
//
// MRR is a marketplace, so the underlying cost moves with every quote. The admin sets
// one global multiplier and can override it per customer (better rates for long-term
// buyers). Quotes snapshot both the cost and the multiplier so later changes never
// alter a price a customer has already been shown or paid.

// Guard rails for the admin panel: below 1× sells at a loss, and a value like 300 is
// almost certainly a typo for 3.
export const MIN_MULTIPLIER = new Decimal(1);
export const MAX_MULTIPLIER = new Decimal(20);
export const DEFAULT_GLOBAL_MULTIPLIER = new Decimal(3);

// How long a quoted price is honoured while the customer pays.
export const QUOTE_TTL_MS = 15 * 60_000;

// Extra MRR spend allowed at provisioning time over the quoted cost, because rigs in
// the quoted basket can be rented by others and replacements may cost a bit more.
export const DEFAULT_SLIPPAGE_PCT = 10;

export type MultiplierSource = "user" | "global";

export class MultiplierError extends Error {}

export function parseMultiplier(value: Decimal.Value): Decimal {
  let m: Decimal;
  try {
    m = new Decimal(value);
  } catch {
    throw new MultiplierError(`not a number: ${String(value)}`);
  }
  if (!m.isFinite()) throw new MultiplierError(`not a number: ${String(value)}`);
  if (m.lt(MIN_MULTIPLIER)) throw new MultiplierError(`multiplier must be at least ${MIN_MULTIPLIER}× (got ${m})`);
  if (m.gt(MAX_MULTIPLIER)) throw new MultiplierError(`multiplier must be at most ${MAX_MULTIPLIER}× (got ${m})`);
  return m.toDecimalPlaces(4);
}

// A per-user override wins over the global value; null/undefined means "use global".
export function resolveMultiplier(opts: {
  global: Decimal.Value | null | undefined;
  user?: Decimal.Value | null;
}): { multiplier: Decimal; source: MultiplierSource } {
  if (opts.user !== null && opts.user !== undefined) return { multiplier: new Decimal(opts.user), source: "user" };
  return { multiplier: new Decimal(opts.global ?? DEFAULT_GLOBAL_MULTIPLIER), source: "global" };
}

// Rounded up to the cent so the markup is never undercut by rounding.
export function customerPrice(costUsd: Decimal.Value, multiplier: Decimal.Value): Decimal {
  return new Decimal(costUsd).mul(multiplier).toDecimalPlaces(2, Decimal.ROUND_UP);
}

// Rate shown on a marketplace-style listing: USD per MH/s per day, marked up.
export function displayRatePerMhDay(costUsdPerMhDay: Decimal.Value, multiplier: Decimal.Value): Decimal {
  return new Decimal(costUsdPerMhDay).mul(multiplier).toDecimalPlaces(6, Decimal.ROUND_UP);
}

// The most we let the provisioner spend at MRR for a paid order: the quoted cost plus
// slippage, but never more than the customer paid (we never fill an order at a loss).
export function provisioningBudget(quotedCostUsd: Decimal.Value, priceUsd: Decimal.Value, slippagePct = DEFAULT_SLIPPAGE_PCT): Decimal {
  const withSlippage = new Decimal(quotedCostUsd).mul(1 + slippagePct / 100);
  return Decimal.min(withSlippage, priceUsd);
}

export interface PricedQuote {
  costUsd: Decimal;
  multiplier: Decimal;
  multiplierSource: MultiplierSource;
  priceUsd: Decimal;
  marginUsd: Decimal;
  expiresAt: Date;
}

export function priceQuote(
  costUsd: Decimal.Value,
  multipliers: { global: Decimal.Value | null | undefined; user?: Decimal.Value | null },
  now = Date.now(),
): PricedQuote {
  const { multiplier, source } = resolveMultiplier(multipliers);
  const cost = new Decimal(costUsd);
  const price = customerPrice(cost, multiplier);
  return {
    costUsd: cost,
    multiplier,
    multiplierSource: source,
    priceUsd: price,
    marginUsd: price.sub(cost),
    expiresAt: new Date(now + QUOTE_TTL_MS),
  };
}
