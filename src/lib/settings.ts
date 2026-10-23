import Decimal from "decimal.js";
import type { PrismaClient } from "@prisma/client";
import { DEFAULT_GLOBAL_MULTIPLIER, DEFAULT_SLIPPAGE_PCT, parseMultiplier } from "./pricing";

// Admin-editable settings stored in the Setting table, with typed defaults.
// pricing.globalMultiplier is edited through pricing-service so changes are audited.

export interface Settings {
  "provisioning.enabled": boolean; // kill switch: when false, paid orders wait and nothing is rented
  "pricing.globalMultiplier": Decimal;
  "pricing.slippagePct": number;
  "mrr.minRpi": number;
  "mrr.maxActiveCostUsd": number; // cap on what all rigs rented at once may cost (0 = no cap)
  "orders.maxDays": number;
  "slots.minBookedPct": number; // a shared rig is rented once this share of its day is sold…
  "slots.maxWaitHours": number; // …or once its first booking has waited this long
  "slots.minSlotMinutes": number; // shortest piece an order is split into (each costs a pool switch)
  "btq.enabled": boolean; // BTQ offered at checkout
  "btq.maxSharePct": number; // most of an order's price that may be paid in BTQ
  "btq.usdRate": Decimal; // admin-set BTQ price, converts the BTQ part of a price
  "btq.confirmations": number; // blocks before a BTQ payment counts as paid
  "btq.maxOrderUsd": number; // largest order payable in BTQ (a reversed payment costs at most this)
  "btq.paymentWindowMinutes": number; // how long the customer has to send BTQ
}

export type SettingKey = keyof Settings;

export const DEFAULTS: Settings = {
  "provisioning.enabled": false,
  "pricing.globalMultiplier": DEFAULT_GLOBAL_MULTIPLIER,
  "pricing.slippagePct": DEFAULT_SLIPPAGE_PCT,
  "mrr.minRpi": 80,
  "mrr.maxActiveCostUsd": 500,
  "orders.maxDays": 30,
  "slots.minBookedPct": 50,
  "slots.maxWaitHours": 12,
  "slots.minSlotMinutes": 30,
  "btq.enabled": false,
  "btq.maxSharePct": 100,
  "btq.usdRate": new Decimal(0),
  "btq.confirmations": 6,
  "btq.maxOrderUsd": 200,
  "btq.paymentWindowMinutes": 60,
};

type Parser<K extends SettingKey> = (raw: string) => Settings[K];

const num = (min: number, max: number) => (raw: string) => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`must be a number between ${min} and ${max}`);
  return n;
};

const bool = (raw: string) => {
  if (raw !== "true" && raw !== "false") throw new Error("must be true or false");
  return raw === "true";
};

const PARSERS: { [K in SettingKey]: Parser<K> } = {
  "provisioning.enabled": bool,
  "pricing.globalMultiplier": (raw) => parseMultiplier(raw),
  "pricing.slippagePct": num(0, 50),
  "mrr.minRpi": num(0, 100),
  "mrr.maxActiveCostUsd": num(0, 1_000_000),
  "orders.maxDays": num(1, 365),
  "slots.minBookedPct": num(0, 100),
  "slots.maxWaitHours": num(0, 168),
  "slots.minSlotMinutes": num(5, 720),
  "btq.enabled": bool,
  "btq.maxSharePct": num(1, 100),
  "btq.usdRate": (raw) => {
    const d = new Decimal(raw);
    if (!d.isFinite() || d.lt(0)) throw new Error("must be a non-negative number");
    return d;
  },
  "btq.confirmations": num(1, 1000),
  "btq.maxOrderUsd": num(1, 1_000_000),
  "btq.paymentWindowMinutes": num(15, 1440),
};

export function parseSetting<K extends SettingKey>(key: K, raw: string): Settings[K] {
  return PARSERS[key](raw.trim());
}

export function isSettingKey(key: string): key is SettingKey {
  return key in DEFAULTS;
}

export async function getSettings(db: PrismaClient): Promise<Settings> {
  const rows = await db.setting.findMany();
  const out = { ...DEFAULTS } as Record<SettingKey, unknown>;
  for (const row of rows) {
    if (!isSettingKey(row.key)) continue;
    try {
      out[row.key] = parseSetting(row.key, row.value);
    } catch {
      // A bad stored value falls back to the default rather than breaking the site.
    }
  }
  return out as unknown as Settings;
}

export async function setSetting(db: PrismaClient, key: SettingKey, raw: string): Promise<void> {
  if (key === "pricing.globalMultiplier") throw new Error("use pricing-service.setGlobalMultiplier (audited)");
  const value = String(parseSetting(key, raw));
  await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}
