// Read-only: print the raw JSON of a GET call. Usage: tsx scripts/mrr-raw.ts /rig '{"type":"kawpow","count":2}'
import { mrrClientFromEnv } from "../src/lib/mrr/client";

async function main() {
  const [ep, params] = process.argv.slice(2);
  console.log(JSON.stringify(await mrrClientFromEnv().get(ep, params ? JSON.parse(params) : undefined), null, 1));
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
