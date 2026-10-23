import Decimal from "decimal.js";
import type { Allocation, HashrateProvider, ProviderId, ProvisionRequest, Quote, QuoteRequest } from "./types";

// Chooses where an order's hashrate comes from.
//
// - quoteAll asks every enabled provider in parallel; one failing never blocks the other.
// - fulfil tries the cheapest acceptable quote first, then fills any shortfall from the
//   next provider. With MRR as the only provider this still enforces the budget and the
//   shortfall tolerance; a second provider can be added without touching callers.

export interface RouterOptions {
  // Provider order to use when quotes tie or when pricing is disabled.
  preference?: ProviderId[];
  // A shortfall at or below this fraction of the order counts as filled (rigs are lumpy).
  toleratedShortfallPct?: number;
}

export interface FulfilmentResult {
  allocations: Allocation[];
  shortfallMh: Decimal;
  costUsd: Decimal;
  quotes: Quote[];
  errors: Array<{ provider: ProviderId; message: string }>;
}

export class ProviderRouter {
  private readonly providers: Map<ProviderId, HashrateProvider>;

  constructor(
    providers: HashrateProvider[],
    private readonly opts: RouterOptions = {},
  ) {
    this.providers = new Map(providers.map((p) => [p.id, p]));
  }

  get(id: ProviderId): HashrateProvider {
    const p = this.providers.get(id);
    if (!p) throw new Error(`provider ${id} is not enabled`);
    return p;
  }

  async quoteAll(req: QuoteRequest): Promise<Quote[]> {
    const settled = await Promise.allSettled([...this.providers.values()].map((p) => p.quote(req)));
    return settled.map((s, i) =>
      s.status === "fulfilled"
        ? s.value
        : { ok: false as const, provider: [...this.providers.keys()][i], reason: String(s.reason?.message ?? s.reason) },
    );
  }

  // Cheapest first; ties go to the preference order.
  rank(quotes: Quote[]): Array<Quote & { ok: true }> {
    const pref = this.opts.preference ?? [...this.providers.keys()];
    return quotes
      .filter((q): q is Quote & { ok: true } => q.ok)
      .sort((a, b) => a.costUsd.cmp(b.costUsd) || pref.indexOf(a.provider) - pref.indexOf(b.provider));
  }

  async fulfil(req: ProvisionRequest): Promise<FulfilmentResult> {
    const quotes = await this.quoteAll(req);
    const errors: FulfilmentResult["errors"] = quotes
      .filter((q): q is Quote & { ok: false } => !q.ok)
      .map((q) => ({ provider: q.provider, message: q.reason }));

    const tolerated = new Decimal(req.hashrateMh).mul((this.opts.toleratedShortfallPct ?? 5) / 100);
    const allocations: Allocation[] = [];
    let remaining = new Decimal(req.hashrateMh);
    let budget = new Decimal(req.maxCostUsd);

    for (const first of this.rank(quotes)) {
      if (remaining.lte(tolerated)) break;
      // The ranked quote was for the whole order; re-quote if we are only topping up.
      const quote = remaining.eq(req.hashrateMh)
        ? first
        : await this.get(first.provider).quote({ ...req, hashrateMh: remaining });
      if (!quote.ok) {
        errors.push({ provider: quote.provider, message: `top-up: ${quote.reason}` });
        continue;
      }
      if (quote.costUsd.gt(budget)) {
        errors.push({ provider: quote.provider, message: `quote $${quote.costUsd.toFixed(2)} over budget $${budget.toFixed(2)}` });
        continue;
      }
      try {
        const res = await this.get(quote.provider).provision({ ...req, hashrateMh: remaining, maxCostUsd: budget }, quote);
        allocations.push(...res.allocations);
        res.errors.forEach((message) => errors.push({ provider: quote.provider, message }));
        const got = res.allocations.reduce((s, a) => s.add(a.advertisedMh), new Decimal(0));
        remaining = Decimal.max(remaining.sub(got), 0);
        budget = budget.sub(res.allocations.reduce((s, a) => s.add(a.costUsd), new Decimal(0)));
      } catch (e) {
        errors.push({ provider: quote.provider, message: (e as Error).message });
      }
    }

    return {
      allocations,
      shortfallMh: remaining.lte(tolerated) ? new Decimal(0) : remaining,
      costUsd: allocations.reduce((s, a) => s.add(a.costUsd), new Decimal(0)),
      quotes,
      errors,
    };
  }
}
