import Decimal from "decimal.js";
import type { HashUnit, MrrCurrency } from "./client";
import type { Rig } from "./api";

// MRR sells individual rigs, not "X MH/s for Y hours". A customer order is filled by
// renting a basket of rigs whose advertised hashrate adds up to the order. This module
// picks that basket; it is pure so it can be unit-tested against canned /rig results.

const UNIT_POWER: Record<HashUnit, number> = { hash: 0, kh: 1, mh: 2, gh: 3, th: 4, ph: 5, eh: 6 };

// EasyNOMP KawPOW share difficulty 1 = 2^32 hashes; MRR's optimal_diff is in hashes.
export const HASHES_PER_POOL_DIFF = 2 ** 32;

export function toUnit(value: Decimal.Value, from: HashUnit, to: HashUnit): Decimal {
  return new Decimal(value).mul(new Decimal(1000).pow(UNIT_POWER[from] - UNIT_POWER[to]));
}

// A stratum port on our pool and the varDiff range it hands out.
export interface PoolPort {
  port: number;
  minDiff: number;
  maxDiff: number;
}

export interface SelectionCriteria {
  targetMh: Decimal.Value;
  hours: number;
  currency: MrrCurrency;
  minRpi: number;
  // Accept a basket up to this much above target (rigs are indivisible).
  maxOverfillPct: number;
  maxRigs: number;
  // Ceiling on total MRR cost for the order, in `currency`.
  maxTotalCost?: Decimal.Value;
  // If set, only rigs whose optimal difficulty overlaps one of these ports are used.
  ports?: PoolPort[];
}

export interface SelectedRig {
  rigId: string;
  advertisedMh: Decimal;
  costPerHour: Decimal;
  cost: Decimal;
  // The rig's listed rate, passed back to PUT /rental as a price cap.
  priceUnit: HashUnit;
  pricePerUnitDay: Decimal;
  // Pool port whose difficulty range suits this rig (undefined when ports aren't configured).
  port?: number;
}

export type SelectionResult =
  | { ok: true; rigs: SelectedRig[]; totalMh: Decimal; totalCost: Decimal }
  | { ok: false; reason: string; bestMh: Decimal };

// GET /rig includes `hour`, but rigs embedded in rental responses only carry the
// per-unit-per-day `price`, so derive it when missing.
export function hourlyCost(rig: Rig, currency: MrrCurrency): Decimal | undefined {
  const p = rig.price[currency];
  if (!p?.enabled) return undefined;
  if (p.hour !== undefined && Number(p.hour) > 0) return new Decimal(p.hour);
  const adv = rig.hashrate.advertised;
  return new Decimal(p.price).mul(toUnit(adv.hash, adv.type, rig.price.type)).div(24);
}

// Picks the port whose range best overlaps the rig's optimal difficulty window.
export function portFor(rig: Rig, ports: PoolPort[]): number | undefined {
  const lo = Number(rig.optimal_diff?.min) / HASHES_PER_POOL_DIFF;
  const hi = Number(rig.optimal_diff?.max) / HASHES_PER_POOL_DIFF;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= 0) return undefined;
  let best: { port: number; overlap: number } | undefined;
  for (const p of ports) {
    const overlap = Math.min(hi, p.maxDiff) - Math.max(lo, p.minDiff);
    if (overlap > 0 && (!best || overlap > best.overlap)) best = { port: p.port, overlap };
  }
  return best?.port;
}

export function isEligible(rig: Rig, c: SelectionCriteria): boolean {
  if (!hourlyCost(rig, c.currency)?.gt(0)) return false;
  if (!rig.online || rig.status.rented || rig.status.status !== "available") return false;
  const minLen = Math.max(Number(rig.minhours), Number(rig.price[c.currency]?.min_rental_length ?? 0));
  if (minLen > c.hours || Number(rig.maxhours) < c.hours) return false;
  // "new" rigs have no RPI history yet; treat them as unproven.
  const rpi = Number(rig.rpi);
  if (!Number.isFinite(rpi) || rpi < c.minRpi) return false;
  if (c.ports && portFor(rig, c.ports) === undefined) return false;
  return new Decimal(rig.hashrate.advertised.hash).gt(0);
}

function costPerMhHour(r: SelectedRig): Decimal {
  return r.costPerHour.div(r.advertisedMh);
}

export function selectRigs(rigs: Rig[], c: SelectionCriteria, exclude: ReadonlySet<string> = new Set()): SelectionResult {
  const target = new Decimal(c.targetMh);
  const ceiling = target.mul(1 + c.maxOverfillPct / 100);

  const candidates: SelectedRig[] = rigs
    .filter((r) => !exclude.has(r.id) && isEligible(r, c))
    .map((r) => {
      const costPerHour = hourlyCost(r, c.currency)!;
      return {
        rigId: r.id,
        advertisedMh: toUnit(r.hashrate.advertised.hash, r.hashrate.advertised.type, "mh"),
        costPerHour,
        cost: costPerHour.mul(c.hours),
        priceUnit: r.price.type,
        pricePerUnitDay: new Decimal(r.price[c.currency]!.price),
        port: c.ports ? portFor(r, c.ports) : undefined,
      };
    })
    .sort((a, b) => costPerMhHour(a).cmp(costPerMhHour(b)));

  // Cheapest-per-MH first, skipping any rig that would push the basket past the
  // overfill ceiling; a smaller rig further down the list may still fit.
  const chosen: SelectedRig[] = [];
  let total = new Decimal(0);
  for (const rig of candidates) {
    if (total.gte(target) || chosen.length >= c.maxRigs) break;
    if (total.add(rig.advertisedMh).gt(ceiling)) continue;
    chosen.push(rig);
    total = total.add(rig.advertisedMh);
  }

  if (total.lt(target)) {
    return { ok: false, reason: `only ${total.toFixed(2)} of ${target.toFixed(2)} MH/s available`, bestMh: total };
  }
  const totalCost = chosen.reduce((s, r) => s.add(r.cost), new Decimal(0));
  if (c.maxTotalCost !== undefined && totalCost.gt(c.maxTotalCost)) {
    return { ok: false, reason: `cost ${totalCost.toFixed(8)} ${c.currency} exceeds ceiling`, bestMh: total };
  }
  return { ok: true, rigs: chosen, totalMh: total, totalCost };
}
