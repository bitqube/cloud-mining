import type { HashUnit, MrrClient, MrrCurrency } from "./client";

// Typed wrappers for the MRR endpoints this platform uses. Shapes follow the examples
// in the v2 docs; MRR returns most numbers as strings, so they are typed as such and
// converted by callers with decimal.js.

export interface HashValue {
  hash: number | string;
  type: HashUnit;
  nice: string;
}

export interface RigPrice {
  currency: string;
  price: string; // per price.type unit per day
  // Whole rig per hour. Present in GET /rig, absent on rigs embedded in /rental.
  hour?: string;
  minhrs?: string; // cost of the minimum rental length
  maxhrs?: string;
  // Per-currency minimum hours (undocumented, seen live 2026-10-18); can exceed minhours.
  min_rental_length?: number;
  enabled: boolean;
}

export interface Rig {
  id: string;
  name: string;
  owner: string;
  type: string;
  status: { status: string; hours: number | string; rented?: boolean; online?: boolean; rental_id?: string };
  online: boolean;
  xnonce: "yes" | "no";
  poolstatus: string;
  region: string;
  rpi: string;
  suggested_diff: string;
  optimal_diff: { min: string; max: string };
  ndevices: string;
  extensions: boolean;
  price: { type: HashUnit } & Partial<Record<MrrCurrency, RigPrice>>;
  minhours: string;
  maxhours: string;
  hashrate: {
    advertised: HashValue;
    last_5min?: HashValue;
    last_15min?: HashValue;
    last_30min?: HashValue;
  };
  description: string | null;
  shorturl: string;
}

export interface RigSearchParams {
  type: string;
  currency?: MrrCurrency;
  minhours?: { min?: number; max?: number };
  maxhours?: { min?: number; max?: number };
  rpi?: { min?: number; max?: number };
  hash?: { min?: number; max?: number; type?: HashUnit };
  price?: { min?: number; max?: number; type?: HashUnit };
  offline?: boolean;
  rented?: boolean;
  expdiff?: number;
  islive?: "yes";
  xnonce?: "yes" | "no";
  count?: number;
  offset?: number;
  orderby?: string;
  orderdir?: "asc" | "desc";
}

export interface RigSearchResult {
  offset: number;
  count: number;
  total: string;
  records: Rig[];
}

export interface Rental {
  id: string;
  owner: string;
  renter: string;
  hashrate: {
    advertised: HashValue;
    average: HashValue & { percent?: string };
  };
  price: { type?: string; advertised: string; paid: string; currency: MrrCurrency };
  length: string;
  extended: string;
  start: string;
  end: string;
  start_unix?: string;
  end_unix?: string;
  ended?: boolean;
  refunded?: boolean;
  rig: Partial<Rig> & { id: string };
}

export interface RentalList {
  total: string;
  returned: number;
  start: number;
  limit: number;
  rentals: Rental[];
}

export interface PoolTestResult {
  result: Array<{
    source: string;
    dest: string;
    protocol?: string;
    connection: boolean;
    sub?: boolean;
    auth?: boolean;
    red?: boolean;
    diffs?: boolean;
    diff?: number;
    work?: boolean;
    xnonce?: boolean;
    ssl?: boolean;
    error: string;
    executiontime: number;
  }>;
  error: unknown[];
}

export interface AlgoInfo {
  name: string;
  display: string;
  suggested_price: { amount: string; currency: MrrCurrency; unit: string };
  stats: {
    available: { rigs: string; hash: { hash: number; unit: string; nice: string } };
    rented: { rigs: string; hash: { hash: number; unit: string; nice: string } };
    prices: Record<"lowest" | "last_10" | "last", { amount: string; currency: MrrCurrency; unit: string }>;
  };
}

export type Balances = Partial<Record<MrrCurrency, { confirmed: string; unconfirmed: string }>>;

export interface StratumTarget {
  host: string;
  port: number;
  user: string;
  pass: string;
}

// A response item for multi-id calls (PUT /rental/1;2/pool etc.).
interface ItemResult {
  id: string;
  success: boolean;
  message?: string;
}

// MRR returns a bare object for one id and an array for several; normalise to an array.
function asArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}

function assertAllOk(results: ItemResult | ItemResult[], what: string): void {
  const failed = asArray(results).filter((r) => !r.success);
  if (failed.length > 0) {
    throw new Error(`${what} failed for ${failed.map((f) => `${f.id}: ${f.message ?? "unknown"}`).join("; ")}`);
  }
}

export const mrrApi = (c: MrrClient) => ({
  whoami: () =>
    c.get<{ authed: boolean; userid: string; permissions: Record<"withdraw" | "rent" | "rigs", "yes" | "no"> }>(
      "/whoami",
    ),

  algo: (name: string, currency: MrrCurrency = "BTC") => c.get<AlgoInfo>(`/info/algos/${name}`, { currency }),
  pricing: () =>
    c.get<{ conversion_rates: Record<string, string>; market_rates: Record<string, Record<string, string>> }>(
      "/pricing",
    ),
  balance: () => c.get<Balances>("/account/balance"),

  searchRigs: (params: RigSearchParams) => c.get<RigSearchResult>("/rig", { ...params }),
  getRigs: (ids: string[]) => c.get<Rig | Rig[]>(`/rig/${ids.join(";")}`).then(asArray),

  testPool: (t: StratumTarget & { type: string; source?: string }) =>
    c.put<PoolTestResult>("/account/pool/test", { method: "full", ...t }),

  createPool: (p: StratumTarget & { type: string; name: string; notes?: string }) =>
    c.put<{ id: string }>("/account/pool", { ...p }),
  deletePools: (ids: string[]) => c.delete<unknown>(`/account/pool/${ids.join(";")}`),
  createProfile: (name: string, algo: string) => c.put<{ pid: string }>("/account/profile", { name, algo }),
  setProfilePool: (profileId: string, priority: 0 | 1 | 2 | 3 | 4, poolId: string) =>
    c.put<ItemResult>(`/account/profile/${profileId}/${priority}`, { poolid: Number(poolId) }),
  deleteProfile: (id: string) => c.delete<unknown>(`/account/profile/${id}`),

  rent: (p: {
    rig: number;
    length: number;
    profile: number;
    currency?: MrrCurrency;
    rate?: { type: HashUnit; price: number };
  }) => c.put<Rental>("/rental", { ...p }),

  rentals: (p: { type?: "renter" | "owner"; history?: boolean; algo?: string; start?: number; limit?: number }) =>
    c.get<RentalList>("/rental", { type: "renter", ...p }),
  getRentals: (ids: string[]) => c.get<Rental | Rental[]>(`/rental/${ids.join(";")}`).then(asArray),
  rentalLog: (ids: string[]) =>
    c
      .get<
        | { rentalid: string; rental_log: Array<{ id: string; time: string; msg: string }> }
        | Array<{ rentalid: string; rental_log: Array<{ id: string; time: string; msg: string }> }>
      >(`/rental/${ids.join(";")}/log`)
      .then(asArray),

  setRentalPool: async (ids: string[], priority: 0 | 1 | 2 | 3 | 4, t: StratumTarget) =>
    assertAllOk(await c.put<ItemResult | ItemResult[]>(`/rental/${ids.join(";")}/pool/${priority}`, { ...t }), "set rental pool"),

  extendRental: (ids: string[], lengthHours: number, simulate = false) =>
    c.put<Array<{ rentalid: string; cost: string; success: boolean; new_hrs: number; message?: string }>>(
      `/rental/${ids.join(";")}/extend`,
      simulate ? { length: lengthHours, getcost: true } : { length: lengthHours },
    ),
});

export type MrrApi = ReturnType<typeof mrrApi>;
