// BitQube network stats from the public explorer, cached briefly for the admin dashboard.
let cache: { at: number; hashrateMh: number | null; difficulty: number | null } | undefined;

export async function networkStats(): Promise<{ hashrateMh: number | null; difficulty: number | null }> {
  if (cache && Date.now() - cache.at < 120_000) return cache;
  const base = process.env.EXPLORER_URL ?? "https://explorer.bitqube.org";
  const get = async (path: string) => {
    try {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000), cache: "no-store" });
      const n = Number(await res.text());
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  };
  const [hps, difficulty] = await Promise.all([get("/api/getnetworkhashps"), get("/api/getdifficulty")]);
  cache = { at: Date.now(), hashrateMh: hps === null ? null : hps / 1e6, difficulty };
  return cache;
}
