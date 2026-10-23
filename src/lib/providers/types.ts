import type Decimal from "decimal.js";
import type { PoolPort } from "../mrr/selection";

// One interface over a hashrate source. The order pipeline only talks to this; MRR is
// the only adapter today (client's choice, 2026-10-18), but another can slot in.

export type ProviderId = "MRR";

export interface StratumTarget {
  host: string;
  port: number;
  user: string; // pool username, usually the payout address
  pass: string;
}

export interface QuoteRequest {
  algo: string;
  hashrateMh: Decimal;
  hours: number;
  // Only rent rigs whose difficulty suits one of these pool ports (pool.bitqube.org).
  // undefined = the provider's default, null = any rig.
  ports?: PoolPort[] | null;
}

export type Quote =
  | {
      ok: true;
      provider: ProviderId;
      hashrateMh: Decimal; // what this provider would actually deliver (rig baskets can overfill)
      costUsd: Decimal;
      // Opaque provider data handed back to provision(), e.g. the MRR rig basket.
      plan?: unknown;
    }
  | { ok: false; provider: ProviderId; reason: string; availableMh?: Decimal };

export interface ProvisionRequest extends QuoteRequest {
  orderRef: string;
  pool: StratumTarget;
  maxCostUsd: Decimal;
  // MRR pool profile to rent with; must be for the rig's algorithm.
  profileId?: string;
}

// A single unit of hashrate at a provider: one MRR rental.
export interface Allocation {
  provider: ProviderId;
  externalId: string;
  rigId?: string;
  advertisedMh: Decimal;
  costUsd: Decimal;
  costAsset?: { amount: Decimal; currency: string };
  // Provider-specific flags, e.g. MRR { port, poolPending }.
  meta?: Record<string, string>;
}

export interface ProvisionResult {
  allocations: Allocation[];
  shortfallMh: Decimal;
  errors: string[];
}

export type AllocationState = "PENDING" | "ACTIVE" | "ENDED" | "REFUNDED" | "ERROR";

export interface AllocationStatus {
  externalId: string;
  state: AllocationState;
  averageMh?: Decimal;
  startsAt?: Date;
  endsAt?: Date;
  raw?: unknown;
}

export interface HashrateProvider {
  readonly id: ProviderId;
  quote(req: QuoteRequest): Promise<Quote>;
  provision(req: ProvisionRequest, quote: Quote & { ok: true }): Promise<ProvisionResult>;
  status(externalIds: string[]): Promise<AllocationStatus[]>;
  setPool(externalIds: string[], pool: StratumTarget): Promise<void>;
  // Release provider-side resources after the order has ended.
  cleanup?(allocations: Allocation[]): Promise<void>;
}
