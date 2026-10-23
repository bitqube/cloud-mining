import Decimal from "decimal.js";

type Num = Decimal.Value | { toString(): string } | null | undefined;

const toNum = (v: Num) => (v === null || v === undefined ? NaN : Number(v.toString()));

export function usd(v: Num): string {
  const n = toNum(v);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { style: "currency", currency: "USD" }) : "—";
}

// MH/s → "205 MH/s" / "1.5 GH/s" / "12 TH/s"
export function hashrate(mh: Num): string {
  const n = toNum(mh);
  if (!Number.isFinite(n)) return "—";
  if (n >= 1e6) return `${trim(n / 1e6)} TH/s`;
  if (n >= 1e3) return `${trim(n / 1e3)} GH/s`;
  return `${trim(n)} MH/s`;
}

export function duration(hours: number): string {
  if (hours % 24 === 0) return `${hours / 24} day${hours === 24 ? "" : "s"}`;
  return `${hours} h`;
}

export function multiplier(v: Num): string {
  const n = toNum(v);
  return Number.isFinite(n) ? `${trim(n)}×` : "—";
}

export function dateTime(d: Date | null | undefined): string {
  return d ? d.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—";
}

function trim(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function shortAddr(a: string): string {
  return a.length > 14 ? `${a.slice(0, 7)}…${a.slice(-5)}` : a;
}
