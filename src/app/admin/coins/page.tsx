import Link from "next/link";
import { Flash } from "@/components/flash";
import { Page, Table, Td } from "@/components/ui";
import { coinHashrate } from "@/lib/coin-format";
import { coinProblems } from "@/lib/coins";
import { db } from "@/lib/db";
import { toggleCoinAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function AdminCoins({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const coins = await db.coin.findMany({ orderBy: [{ sortOrder: "asc" }, { id: "asc" }] });
  return (
    <Page title="Coins">
      <Flash sp={sp} />
      <p className="mb-6 text-sm text-muted">
        A coin can go on sale once it has a pool, a house address for unsold rig time, and an MRR pool profile for its algorithm. Open a coin
        to set these and test its pool.
      </p>
      <Table head={["Coin", "Algorithm", "Rig size", "Pool", "Ready", "On sale"]}>
        {coins.map((c) => {
          const problems = coinProblems(c);
          return (
            <tr key={c.id} className={c.enabled ? undefined : "opacity-70"}>
              <Td>
                <Link href={`/admin/coins/${c.id}`} className="text-accent">
                  <span className="num font-semibold">{c.id}</span> <span className="text-muted">{c.name}</span>
                </Link>
              </Td>
              <Td className="font-mono text-xs">{c.algo}</Td>
              <Td className="num">{coinHashrate(c.rigMh, { unit: c.unit, unitMh: Number(c.unitMh) })}</Td>
              <Td className="font-mono text-xs">{c.poolHost ? `${c.poolHost}:${c.poolPort}` : "—"}</Td>
              <Td className="text-xs">{problems.length ? <span className="text-warn">{problems.join(", ")}</span> : <span className="text-ok">ready</span>}</Td>
              <Td>
                <form action={toggleCoinAction}>
                  <input type="hidden" name="id" value={c.id} />
                  <button className={c.enabled ? "text-ok" : "text-muted"}>{c.enabled ? "On sale" : "Off"}</button>
                </form>
              </Td>
            </tr>
          );
        })}
      </Table>
    </Page>
  );
}
