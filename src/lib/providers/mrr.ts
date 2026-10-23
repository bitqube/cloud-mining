import Decimal from "decimal.js";
import type { MrrCurrency } from "../mrr/client";
import type { MrrApi, Rental, Rig } from "../mrr/api";
import { selectRigs, toUnit, type PoolPort, type SelectedRig } from "../mrr/selection";
import type {
  Allocation,
  AllocationStatus,
  HashrateProvider,
  ProvisionRequest,
  ProvisionResult,
  Quote,
  QuoteRequest,
  StratumTarget,
} from "./types";

export interface MrrProviderOptions {
  api: MrrApi;
  // USD price of one unit of `currency` (what the MRR balance is funded in).
  assetUsd: (currency: MrrCurrency) => Promise<Decimal>;
  // Profile every rental is created with. PUT /rental requires one; we then repoint the
  // rental at the customer's worker. Its pool should be ours with a house BTQ address,
  // since the rig hashes there for the few seconds before the repoint lands.
  baseProfileId: string;
  // Our pool's ports and their difficulty ranges; rigs that fit none are skipped. A
  // request can override this (ports: null for coins mined on other pools).
  ports: PoolPort[];
  currency?: MrrCurrency;
  minRpi?: number;
  maxOverfillPct?: number;
  maxRigs?: number;
  // Rigs get rented by others between search and PUT /rental; re-search this many times.
  maxRetries?: number;
  // Attempts at PUT /rental/{id}/pool before leaving the rental for the poller to fix.
  poolSetAttempts?: number;
}

type Tunables = Required<
  Pick<MrrProviderOptions, "currency" | "minRpi" | "maxOverfillPct" | "maxRigs" | "maxRetries" | "poolSetAttempts">
>;

const SEARCH_PAGES = 3;
const PAGE_SIZE = 100;

export class MrrProvider implements HashrateProvider {
  readonly id = "MRR" as const;
  private readonly o: Tunables;

  constructor(private readonly opts: MrrProviderOptions) {
    this.o = {
      currency: opts.currency ?? "BTC",
      minRpi: opts.minRpi ?? 80,
      maxOverfillPct: opts.maxOverfillPct ?? 20,
      maxRigs: opts.maxRigs ?? 10,
      maxRetries: opts.maxRetries ?? 2,
      poolSetAttempts: opts.poolSetAttempts ?? 3,
    };
  }

  private async searchRigs(algo: string, hours: number): Promise<Rig[]> {
    const rigs: Rig[] = [];
    for (let page = 0; page < SEARCH_PAGES; page++) {
      const res = await this.opts.api.searchRigs({
        type: algo,
        currency: this.o.currency,
        // No islive filter: most KawPOW rigs on MRR are autostart and show 0 H/s until
        // rented (2026-10-18: islive=yes left 1 of 135). RPI is the reliability signal.
        minhours: { max: hours },
        maxhours: { min: hours },
        rpi: { min: this.o.minRpi },
        orderby: "price",
        orderdir: "asc",
        count: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      rigs.push(...res.records);
      if (res.records.length < PAGE_SIZE) break;
    }
    return rigs;
  }

  private portsFor(req: QuoteRequest): PoolPort[] | undefined {
    return req.ports === undefined ? this.opts.ports : (req.ports ?? undefined);
  }

  private select(
    rigs: Rig[],
    targetMh: Decimal,
    hours: number,
    ports: PoolPort[] | undefined,
    exclude?: Set<string>,
    overfillPct = this.o.maxOverfillPct,
  ) {
    return selectRigs(
      rigs,
      {
        targetMh,
        hours,
        currency: this.o.currency,
        minRpi: this.o.minRpi,
        maxOverfillPct: overfillPct,
        maxRigs: this.o.maxRigs,
        ports,
      },
      exclude,
    );
  }

  async quote(req: QuoteRequest): Promise<Quote> {
    const [rigs, rate] = await Promise.all([this.searchRigs(req.algo, req.hours), this.opts.assetUsd(this.o.currency)]);
    const sel = this.select(rigs, req.hashrateMh, req.hours, this.portsFor(req));
    if (!sel.ok) return { ok: false, provider: this.id, reason: sel.reason, availableMh: sel.bestMh };
    return {
      ok: true,
      provider: this.id,
      hashrateMh: sel.totalMh,
      costUsd: sel.totalCost.mul(rate),
      plan: sel.rigs,
    };
  }

  private async pointAtCustomer(rentalId: string, rig: SelectedRig, pool: StratumTarget): Promise<string | undefined> {
    const target = { ...pool, port: rig.port ?? pool.port };
    let lastError = "";
    for (let i = 0; i < this.o.poolSetAttempts; i++) {
      try {
        await this.opts.api.setRentalPool([rentalId], 0, target);
        return undefined;
      } catch (e) {
        lastError = (e as Error).message;
      }
    }
    return lastError;
  }

  async provision(req: ProvisionRequest, quote: Quote & { ok: true }): Promise<ProvisionResult> {
    const { api } = this.opts;
    const errors: string[] = [];
    const rate = await this.opts.assetUsd(this.o.currency);

    const allocations: Allocation[] = [];
    const tried = new Set<string>();
    let spentUsd = new Decimal(0);
    let basket = quote.plan as SelectedRig[];

    for (let attempt = 0; ; attempt++) {
      for (const rig of basket) {
        tried.add(rig.rigId);
        if (spentUsd.add(rig.cost.mul(rate)).gt(req.maxCostUsd)) {
          errors.push(`rig ${rig.rigId}: would exceed cost ceiling`);
          continue;
        }
        let rental: Rental;
        try {
          rental = await api.rent({
            rig: Number(rig.rigId),
            length: req.hours,
            profile: Number(req.profileId ?? this.opts.baseProfileId),
            currency: this.o.currency,
            rate: { type: rig.priceUnit, price: rig.pricePerUnitDay.toNumber() },
          });
        } catch (e) {
          errors.push(`rig ${rig.rigId}: ${(e as Error).message}`);
          continue;
        }
        const paid = new Decimal(rental.price.paid);
        spentUsd = spentUsd.add(paid.mul(rate));
        // The rental is live and paid for at this point; a failed repoint must not lose it.
        const poolError = await this.pointAtCustomer(rental.id, rig, req.pool);
        if (poolError) errors.push(`rental ${rental.id}: pool not set (${poolError}); poller will retry`);
        allocations.push({
          provider: this.id,
          externalId: rental.id,
          rigId: rig.rigId,
          advertisedMh: rig.advertisedMh,
          costUsd: paid.mul(rate),
          costAsset: { amount: paid, currency: rental.price.currency },
          meta: { port: String(rig.port ?? req.pool.port), ...(poolError ? { poolPending: "1" } : {}) },
        });
      }

      const shortfall = shortfallOf(req.hashrateMh, allocations);
      if (shortfall.lte(0) || attempt >= this.o.maxRetries) break;
      // The overfill allowance belongs to the whole order, not to the leftover: otherwise
      // replacing a 50 MH rig in a 100 MH order could only use rigs up to ~48 MH.
      const headroom = req.hashrateMh.mul(1 + this.o.maxOverfillPct / 100).sub(req.hashrateMh.sub(shortfall));
      const refillPct = headroom.div(shortfall).sub(1).mul(100).toNumber();
      const refill = this.select(await this.searchRigs(req.algo, req.hours), shortfall, req.hours, this.portsFor(req), tried, refillPct);
      if (!refill.ok) {
        errors.push(`refill: ${refill.reason}`);
        break;
      }
      basket = refill.rigs;
    }

    return { allocations, shortfallMh: Decimal.max(shortfallOf(req.hashrateMh, allocations), 0), errors };
  }

  async status(externalIds: string[]): Promise<AllocationStatus[]> {
    if (externalIds.length === 0) return [];
    const rentals = await this.opts.api.getRentals(externalIds);
    return rentals.map(rentalStatus);
  }

  async setPool(externalIds: string[], pool: StratumTarget): Promise<void> {
    await this.opts.api.setRentalPool(externalIds, 0, pool);
  }
}

function shortfallOf(target: Decimal, allocations: Allocation[]): Decimal {
  return allocations.reduce((left, a) => left.sub(a.advertisedMh), new Decimal(target));
}

// MRR times look like "2022-03-02 15:37:03 UTC"; live responses also carry *_unix.
function parseMrrTime(s: string | undefined, unix?: string): Date | undefined {
  if (unix && Number(unix) > 0) return new Date(Number(unix) * 1000);
  if (!s) return undefined;
  const d = new Date(s.replace(" UTC", "Z").replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function rentalStatus(r: Rental): AllocationStatus {
  const endsAt = parseMrrTime(r.end, r.end_unix);
  const ended = r.ended ?? (endsAt ? endsAt.getTime() <= Date.now() : false);
  const avg = r.hashrate?.average;
  return {
    externalId: r.id,
    state: r.refunded ? "REFUNDED" : ended ? "ENDED" : "ACTIVE",
    averageMh: avg ? toUnit(avg.hash, avg.type, "mh") : undefined,
    startsAt: parseMrrTime(r.start, r.start_unix),
    endsAt,
    raw: r,
  };
}
