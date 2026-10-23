// Read-only: dump one rental's details, pool, log and recent hashrate.
import { mrrClientFromEnv } from "../src/lib/mrr/client";

async function main() {
  const id = process.argv[2];
  const c = mrrClientFromEnv();
  const show = async (ep: string, params?: Record<string, unknown>) => {
    try {
      console.log(`--- ${ep}\n${JSON.stringify(await c.get(ep, params), null, 1).slice(0, 2500)}`);
    } catch (e) {
      console.log(`--- ${ep} FAIL ${(e as Error).message}`);
    }
  };
  await show(`/rental/${id}`);
  await show(`/rental/${id}/pool`);
  await show(`/rental/${id}/log`);
}
main();
