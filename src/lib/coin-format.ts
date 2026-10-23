// Hashrate and slot-length formatting per coin. No server imports: the buy form uses it too.

export interface CoinUnit {
  unit: string; // "MH/s", "TH/s", "kSol/s"…
  unitMh: number; // MH/s in one unit
}

const trim = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 2 : n < 1000 ? 1 : 0 });

// Internal MH/s → the coin's own unit, e.g. 100000000 MH/s of SHA-256 → "100 TH/s".
export function coinHashrate(mh: number | { toString(): string }, c: CoinUnit): string {
  const n = Number(mh.toString()) / c.unitMh;
  return Number.isFinite(n) ? `${trim(n)} ${c.unit}` : "—";
}

// 144 → "2h 24m", 1440 → "24h", 45 → "45m".
export function minutesLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// Rig minutes a plan buys: its share of 24 hours, for each day.
export function planMinutes(sharePct: number | { toString(): string }, days: number): number {
  return Math.round((1440 * Number(sharePct.toString()) * days) / 100);
}
