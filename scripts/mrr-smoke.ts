// Read-only MRR check: npm run mrr:smoke. Spends nothing. The only non-GET call is
// PUT /account/pool/test, MRR's compatibility test against our own pool.
import Decimal from "decimal.js";
import { mrrApi } from "../src/lib/mrr/api";
import { mrrClientFromEnv, type MrrCurrency } from "../src/lib/mrr/client";
import { MrrProvider } from "../src/lib/providers/mrr";
import { assetUsd, parsePoolPorts } from "../src/lib/providers/index";

const ALGO = process.env.MRR_ALGO ?? "kawpow";
const POOL_HOST = process.env.POOL_HOST ?? "pool.bitqube.org";
const POOL_PORT = Number(process.env.POOL_PORT ?? 10032);
const HOUSE_WORKER = process.env.TEST_BTQ_ADDRESS ?? "BL1sN615b8xezvCYEJEKhMHN4kfKLgbw8Y";

async function step(name: string, fn: () => Promise<unknown>) {
  try {
    const out = await fn();
    console.log(`OK   ${name}${out === undefined ? "" : `: ${typeof out === "string" ? out : JSON.stringify(out)}`}`);
  } catch (e) {
    console.log(`FAIL ${name}: ${(e as Error).message}`);
  }
}

async function main() {
  const api = mrrApi(mrrClientFromEnv());

  await step("whoami", async () => (await api.whoami()).permissions);
  await step("market", async () => {
    const a = await api.algo(ALGO);
    return `${a.stats.available.hash.nice} on ${a.stats.available.rigs} rigs free, ${a.stats.rented.hash.nice} rented; lowest ${a.stats.prices.lowest.amount} ${a.stats.prices.lowest.currency}/${a.stats.prices.lowest.unit}`;
  });
  await step("balance", async () => api.balance());

  for (const currency of ["ETH", "BTC"] as MrrCurrency[]) {
    const provider = new MrrProvider({
      api,
      assetUsd,
      baseProfileId: process.env.MRR_PROFILE_ID ?? "0",
      ports: parsePoolPorts(process.env.POOL_PORTS ?? "10032:0.04:16"),
      currency,
      minRpi: Number(process.env.MRR_MIN_RPI ?? 80),
    });
    for (const [mh, hours] of [[200, 24], [1000, 24], [5000, 24], [10000, 72]] as const) {
      await step(`quote ${currency} ${mh} MH/s x ${hours}h`, async () => {
        const q = await provider.quote({ algo: ALGO, hashrateMh: new Decimal(mh), hours });
        if (!q.ok) return `no fill: ${q.reason}`;
        const rigs = q.plan as Array<{ rigId: string; advertisedMh: Decimal; port?: number }>;
        return `$${q.costUsd.toFixed(2)} for ${q.hashrateMh.toFixed(0)} MH/s via ${rigs.map((r) => `${r.rigId}(${r.advertisedMh.toFixed(0)}MH@${r.port})`).join(" ")}`;
      });
    }
  }

  await step("pool test", async () => {
    const t = await api.testPool({ type: ALGO, host: POOL_HOST, port: POOL_PORT, user: HOUSE_WORKER, pass: "x" });
    return t.result;
  });
}

main();
