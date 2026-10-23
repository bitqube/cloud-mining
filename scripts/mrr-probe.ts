// Read-only permission probe: which GET endpoints does this key reach?
import { mrrClientFromEnv } from "../src/lib/mrr/client";

const c = mrrClientFromEnv();
const probes: Array<[string, Record<string, unknown>?]> = [
  ["/whoami"],
  ["/info/algos"],
  ["/account/balance"],
  ["/account/pool"],
  ["/account/profile"],
  ["/rental", { type: "renter", limit: 1 }],
  ["/rig", { type: "kawpow", count: 3, orderby: "price", orderdir: "asc" }],
];

async function main() {
for (const [ep, params] of probes) {
  try {
    const data = await c.get<unknown>(ep, params);
    let summary = JSON.stringify(data);
    if (ep === "/info/algos") summary = JSON.stringify((data as Array<{ name: string; display: string }>).filter((a) => /kaw/i.test(a.name + a.display)));
    console.log(`OK   ${ep}: ${summary.slice(0, 600)}`);
  } catch (e) {
    console.log(`FAIL ${ep}: ${(e as Error).message}`);
  }
}
}

main();
