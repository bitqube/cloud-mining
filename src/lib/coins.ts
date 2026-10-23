import type { Coin } from "@prisma/client";
import { isValidBtqAddress } from "./btq-address";
import type { StratumTarget } from "./providers/types";

// Per-coin rules: payout address formats, where a coin's rigs mine, and whether a coin is
// configured well enough to rent rigs for.

// Format checks only (no checksums except BTQ). Pools pay the worker name verbatim, so the
// checkout also asks the customer to double-check.
const ADDRESS: Record<string, { re: RegExp; hint: string }> = {
  BTC: { re: /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/, hint: "starts with bc1, 1 or 3" },
  LTC: { re: /^(ltc1[02-9ac-hj-np-z]{11,71}|[LM3][1-9A-HJ-NP-Za-km-z]{26,33})$/, hint: "starts with ltc1, L, M or 3" },
  DOGE: { re: /^[DA9][1-9A-HJ-NP-Za-km-z]{33}$/, hint: "starts with D" },
  KAS: { re: /^kaspa:[a-z0-9]{61,63}$/, hint: "starts with kaspa:" },
  ETC: { re: /^0x[0-9a-fA-F]{40}$/, hint: "starts with 0x" },
  XMR: { re: /^[48][1-9A-HJ-NP-Za-km-z]{94}([1-9A-HJ-NP-Za-km-z]{11})?$/, hint: "starts with 4 or 8, 95 characters" },
  ZEC: { re: /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/, hint: "a transparent address, starting with t1 or t3" },
  RVN: { re: /^R[1-9A-HJ-NP-Za-km-z]{33}$/, hint: "starts with R" },
  DASH: { re: /^X[1-9A-HJ-NP-Za-km-z]{33}$/, hint: "starts with X" },
  ERG: { re: /^9[1-9A-HJ-NP-Za-km-z]{50}$/, hint: "starts with 9" },
};
const GENERIC = /^[A-Za-z0-9:._-]{20,120}$/;

export function addressHint(coinId: string): string {
  return coinId === "BTQ" ? "starts with B" : (ADDRESS[coinId]?.hint ?? "your wallet's receiving address");
}

export function isValidPayoutAddress(coinId: string, address: string): boolean {
  const a = address.trim();
  if (coinId === "BTQ") return isValidBtqAddress(a);
  return (ADDRESS[coinId]?.re ?? GENERIC).test(a);
}

// A customer's own pool, as typed at checkout. Returns an error message or the cleaned values.
export function parseOwnPool(raw: { host: string; port: string; user: string; pass: string }):
  | { ok: true; host: string; port: number; user: string; pass: string }
  | { ok: false; error: string } {
  const host = raw.host.trim().replace(/^stratum\+(tcp|ssl):\/\//i, "").replace(/\/+$/, "");
  const port = Number(raw.port);
  const user = raw.user.trim();
  if (!/^[a-z0-9.-]{3,253}$/i.test(host) || !host.includes(".")) return { ok: false, error: "Enter the pool host, e.g. rvn.2miners.com." };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "Enter the pool's stratum port." };
  if (!user || user.length > 200 || /\s/.test(user)) return { ok: false, error: "Enter your worker name / pool username." };
  return { ok: true, host, port, user, pass: raw.pass.trim() || "x" };
}

type OrderPool = { id: string; payoutAddress: string; poolHost: string | null; poolPort: number | null; poolUser: string | null; poolPass: string | null };
type CoinPool = Pick<Coin, "poolHost" | "poolPort" | "poolUser" | "poolPass">;

const fill = (template: string, address: string, worker: string) => template.replaceAll("{address}", address).replaceAll("{worker}", worker);

// Shows on the pool's worker list, so a customer can tell their slot apart.
export const workerName = (orderId: string) => `bq${orderId.slice(-6)}`;

// Where the rig mines during this order's slot: the customer's own pool, or the coin's pool
// with their address as the username. null if the coin has no pool configured.
export function orderTarget(coin: CoinPool, order: OrderPool): StratumTarget | null {
  if (order.poolHost && order.poolPort && order.poolUser) {
    return { host: order.poolHost, port: order.poolPort, user: order.poolUser, pass: order.poolPass || "x" };
  }
  if (!coin.poolHost || !coin.poolPort) return null;
  return { host: coin.poolHost, port: coin.poolPort, user: fill(coin.poolUser, order.payoutAddress, workerName(order.id)), pass: coin.poolPass };
}

// Where unsold rig time mines.
export function houseTarget(coin: CoinPool & Pick<Coin, "houseAddress">): StratumTarget | null {
  if (!coin.poolHost || !coin.poolPort || !coin.houseAddress) return null;
  return { host: coin.poolHost, port: coin.poolPort, user: fill(coin.poolUser, coin.houseAddress, "house"), pass: coin.poolPass };
}

// MRR needs a pool profile of the rig's algorithm to rent. The KawPOW one from the env
// (MRR_PROFILE_ID) serves both BitQube and Ravencoin unless a coin sets its own.
export function mrrProfileFor(coin: Pick<Coin, "mrrProfileId" | "algo">, env: Record<string, string | undefined> = process.env): string | null {
  return coin.mrrProfileId || (coin.algo === "kawpow" ? env.MRR_PROFILE_ID || null : null);
}

// What stops this coin's rigs from being rented; empty when it is ready.
export function coinProblems(coin: Coin, env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = [];
  if (!coin.poolHost || !coin.poolPort) out.push("no pool set");
  if (!coin.houseAddress) out.push("no house address for unsold time");
  else if (!isValidPayoutAddress(coin.id, coin.houseAddress)) out.push("house address is not a valid address for this coin");
  if (!mrrProfileFor(coin, env)) out.push(`no MRR pool profile for ${coin.algo}`);
  if (Number(coin.rigMh) <= 0) out.push("rig size not set");
  return out;
}
