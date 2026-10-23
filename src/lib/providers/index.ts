import Decimal from "decimal.js";
import { mrrApi, type MrrApi } from "../mrr/api";
import { mrrClientFromEnv, type MrrCurrency } from "../mrr/client";
import type { PoolPort } from "../mrr/selection";
import { MrrProvider } from "./mrr";
import { ProviderRouter } from "./router";

const cache = new Map<string, { at: number; price: Decimal }>();

// MRR prices are in the balance currency (BTC/ETH/...); convert to USD for quoting
// customers. Coinbase spot, cached for a minute.
export async function assetUsd(currency: MrrCurrency): Promise<Decimal> {
  const hit = cache.get(currency);
  if (hit && Date.now() - hit.at < 60_000) return hit.price;
  const res = await fetch(`https://api.coinbase.com/v2/prices/${currency}-USD/spot`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${currency}/USD price feed: HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { amount?: string } };
  if (!json.data?.amount) throw new Error(`${currency}/USD price feed: no amount`);
  const price = new Decimal(json.data.amount);
  cache.set(currency, { at: Date.now(), price });
  return price;
}

// POOL_PORTS="10032:0.04:16,10256:1000:9000" — port:minDiff:maxDiff, mirroring the
// varDiff ranges in the pool's pool_configs/bitqube.json.
export function parsePoolPorts(spec: string): PoolPort[] {
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [port, minDiff, maxDiff] = s.split(":").map(Number);
      if (![port, minDiff, maxDiff].every(Number.isFinite)) throw new Error(`bad POOL_PORTS entry: ${s}`);
      return { port, minDiff, maxDiff };
    });
}

// Pool ports by difficulty apply only to coins mined on our own pool (BTQ); other pools
// take any rig, so no filter.
export function coinPorts(coin: { portsByDifficulty: boolean }): PoolPort[] | null {
  return coin.portsByDifficulty ? parsePoolPorts(process.env.POOL_PORTS ?? "10032:0.04:16") : null;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
}

const g = globalThis as unknown as { bqMrrApi?: MrrApi };

// One client per process so every call shares the same nonce sequence.
export function sharedMrrApi(): MrrApi {
  return (g.bqMrrApi ??= mrrApi(mrrClientFromEnv(process.env.BQ_PROCESS === "worker" ? "MRR_WORKER_" : "MRR_")));
}

export function buildMrrProvider(): MrrProvider {
  return new MrrProvider({
    api: sharedMrrApi(),
    assetUsd,
    baseProfileId: required("MRR_PROFILE_ID"),
    ports: parsePoolPorts(process.env.POOL_PORTS ?? "10032:0.04:16"),
    currency: (process.env.MRR_CURRENCY ?? "BTC") as MrrCurrency,
    minRpi: Number(process.env.MRR_MIN_RPI ?? 80),
  });
}

export function buildRouter(): ProviderRouter {
  return new ProviderRouter([buildMrrProvider()]);
}
