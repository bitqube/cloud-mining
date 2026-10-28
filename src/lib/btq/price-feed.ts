import Decimal from "decimal.js";
import type { PrismaClient } from "@prisma/client";
import { queueAdminAlert } from "../email/outbox";
import { getSettings, setSetting } from "../settings";

// Keeps btq.usdRate in line with the BTQ/USDT market on VinDAX when btq.priceAuto is on.
// The ticker is public market data, so no API key is needed.
//
// The market is thin (a few dollars a day, with the ask often 2-3x the bid), so the last
// trade can be pushed up cheaply. A higher price means fewer BTQ per order, so we use the
// lower of the last trade and the best bid: raising the bid means offering to buy everyone's
// BTQ at that price. Admin bounds catch anything else, and a feed that has given no usable
// price for STALE_MS switches BTQ checkout off (rate 0) rather than sell at an old price.

export const FEED_KEY = "btq.priceFeed"; // a Setting row outside the typed settings: the last check, as JSON
export const STALE_MS = 6 * 3_600_000;
const ALERT_EVERY_MS = 6 * 3_600_000;
const TIMEOUT_MS = 10_000;

export interface Ticker {
  last: Decimal;
  bid: Decimal;
  ask: Decimal;
  volumeUsd: Decimal; // last 24 hours
}

// What the admin page shows. Prices are strings so the JSON round-trips exactly.
export interface FeedState {
  checkedAt: string;
  ok: boolean;
  error?: string;
  last?: string;
  bid?: string;
  ask?: string;
  volumeUsd?: string;
  price?: string; // the price used, when ok
  okAt?: string; // last time a price was used
  alertedAt?: string;
}

export function vindaxConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    url: (env.VINDAX_API_URL?.trim() || "https://api.vindax.com").replace(/\/+$/, ""),
    symbol: env.VINDAX_SYMBOL?.trim() || "BTQUSDT",
  };
}

export async function fetchVindaxTicker(env: NodeJS.ProcessEnv = process.env): Promise<Ticker> {
  const c = vindaxConfig(env);
  const res = await fetch(`${c.url}/api/v1/ticker/24hr?symbol=${encodeURIComponent(c.symbol)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`VinDAX answered HTTP ${res.status}`);
  const t = (await res.json()) as Record<string, unknown>;
  const dec = (k: string) => {
    const d = new Decimal(String(t[k] ?? "NaN"));
    if (!d.isFinite() || d.lt(0)) throw new Error(`VinDAX ticker has no valid ${k}`);
    return d;
  };
  return { last: dec("lastPrice"), bid: dec("bidPrice"), ask: dec("askPrice"), volumeUsd: dec("quoteVolume") };
}

// The price to use, or why there is none.
export function priceFromTicker(t: Ticker, minUsd: number, maxUsd: number): { price: Decimal } | { error: string } {
  if (t.last.lte(0)) return { error: "no trades yet" };
  if (t.bid.lte(0)) return { error: "no buy orders on the book" };
  const price = Decimal.min(t.last, t.bid);
  if (minUsd > 0 && price.lt(minUsd)) return { error: `price $${price.toFixed()} is below the floor of $${minUsd}` };
  if (maxUsd > 0 && price.gt(maxUsd)) return { error: `price $${price.toFixed()} is above the ceiling of $${maxUsd}` };
  return { price };
}

export async function readFeedState(db: PrismaClient): Promise<FeedState | null> {
  const row = await db.setting.findUnique({ where: { key: FEED_KEY } });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as FeedState;
  } catch {
    return null;
  }
}

async function writeFeedState(db: PrismaClient, s: FeedState) {
  const value = JSON.stringify(s);
  await db.setting.upsert({ where: { key: FEED_KEY }, create: { key: FEED_KEY, value }, update: { value } });
}

// One check; returns 1 when the price changed. Does nothing unless btq.priceAuto is on.
export async function refreshBtqPrice(
  db: PrismaClient,
  log: (msg: string) => void,
  now = new Date(),
  fetchTicker: () => Promise<Ticker> = () => fetchVindaxTicker(),
): Promise<number> {
  const settings = await getSettings(db);
  if (!settings["btq.priceAuto"]) return 0;
  const prev = await readFeedState(db);
  // Before the feed has ever set a price, the one set by hand counts from when it was set.
  const okAt = prev?.okAt ?? (await db.setting.findUnique({ where: { key: "btq.usdRate" } }))?.updatedAt.toISOString();
  const state: FeedState = { checkedAt: now.toISOString(), ok: false, okAt, alertedAt: prev?.alertedAt };

  let result: { price: Decimal } | { error: string };
  let fetched = false; // a failed request alone (e.g. one timeout) only alerts once the price goes stale
  try {
    const t = await fetchTicker();
    Object.assign(state, { last: t.last.toFixed(), bid: t.bid.toFixed(), ask: t.ask.toFixed(), volumeUsd: t.volumeUsd.toFixed() });
    fetched = true;
    result = priceFromTicker(t, settings["btq.priceMinUsd"], settings["btq.priceMaxUsd"]);
  } catch (e) {
    result = { error: (e as Error).message };
  }

  if ("price" in result) {
    const changed = !result.price.eq(settings["btq.usdRate"]);
    // Written even when unchanged, so the rate's updatedAt shows when it was last confirmed.
    await setSetting(db, "btq.usdRate", result.price.toFixed());
    await writeFeedState(db, { ...state, ok: true, price: result.price.toFixed(), okAt: state.checkedAt });
    if (changed) log(`btq price: $${result.price.toFixed()} (was $${settings["btq.usdRate"].toFixed()})`);
    return changed ? 1 : 0;
  }

  state.error = result.error;
  const sinceOk = state.okAt ? now.getTime() - Date.parse(state.okAt) : Infinity;
  const stale = sinceOk >= STALE_MS;
  if (stale && settings["btq.usdRate"].gt(0)) await setSetting(db, "btq.usdRate", "0");
  const canAlert = !state.alertedAt || now.getTime() - Date.parse(state.alertedAt) >= ALERT_EVERY_MS;
  if (canAlert && (stale || fetched)) {
    await queueAdminAlert(
      db,
      stale ? "BTQ price feed stopped: BTQ checkout is off" : "BTQ price not updated",
      stale
        ? `No usable BTQ price from VinDAX for ${Math.round(STALE_MS / 3_600_000)} hours (${result.error}), so BTQ checkout is off until it recovers. Check Admin → BTQ.`
        : `The VinDAX price was not used: ${result.error}. The previous price stays for up to ${Math.round(STALE_MS / 3_600_000)} hours. Check Admin → BTQ.`,
    );
    state.alertedAt = state.checkedAt;
  }
  await writeFeedState(db, state);
  log(`btq price not updated: ${result.error}${stale ? " (BTQ checkout off)" : ""}`);
  return 0;
}
