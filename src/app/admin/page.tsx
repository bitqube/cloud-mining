import Decimal from "decimal.js";
import Link from "next/link";
import { Alert, Button, Card, Page, Stat, StatusBadge, Table, Td } from "@/components/ui";
import { Flash, type FlashParams } from "@/components/flash";
import { db } from "@/lib/db";
import { coinHashrate } from "@/lib/coin-format";
import { hashrate, multiplier, usd } from "@/lib/format";
import { networkStats } from "@/lib/network";
import { sharedMrrApi } from "@/lib/providers";
import { getSettings } from "@/lib/settings";
import { setProvisioningAction } from "./actions";

export const dynamic = "force-dynamic";

const REVENUE_STATUSES = ["PAID", "QUEUED", "PROVISIONING", "ACTIVE", "COMPLETED", "PARTIAL"] as const;

export default async function AdminDashboard({ searchParams }: { searchParams: FlashParams }) {
  const sp = await searchParams;
  const [settings, byStatus, money, rigCost, activeDays, waitingDays, needsAction, pendingPool, network, balance] = await Promise.all([
    getSettings(db),
    db.order.groupBy({ by: ["status"], _count: true }),
    db.order.aggregate({ where: { status: { in: [...REVENUE_STATUSES] } }, _sum: { priceUsd: true } }),
    db.rigDay.aggregate({ where: { costUsd: { not: null } }, _sum: { costUsd: true } }),
    db.rigDay.aggregate({ where: { status: { in: ["RENTING", "ACTIVE"] } }, _count: true, _sum: { costUsd: true, maxCostUsd: true } }),
    db.rigDay.count({ where: { status: { in: ["OPEN", "FAILED"] } } }),
    db.order.findMany({
      where: { status: { in: ["FAILED", "PARTIAL", "PAID"] } },
      orderBy: { updatedAt: "desc" },
      take: 10,
      include: { user: true, coin: true },
    }),
    db.rental.count({ where: { poolPending: true, status: { in: ["REQUESTED", "ACTIVE"] } } }),
    networkStats(),
    sharedMrrApi()
      .balance()
      .then((b) => ({ ok: true as const, b }))
      .catch((e: Error) => ({ ok: false as const, error: e.message })),
  ]);

  const count = (s: string) => byStatus.find((x) => x.status === s)?._count ?? 0;
  const revenue = new Decimal(money._sum.priceUsd?.toString() ?? 0);
  const cost = new Decimal(rigCost._sum.costUsd?.toString() ?? 0);
  const activeSpend = Number(activeDays._sum.costUsd ?? activeDays._sum.maxCostUsd ?? 0);
  const cap = settings["mrr.maxActiveCostUsd"];
  const on = settings["provisioning.enabled"];

  return (
    <Page title="Dashboard">
      <Flash sp={sp} />
      <Card className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-sm font-semibold">
              Provisioning is <span className={on ? "text-ok" : "text-warn"}>{on ? "ON" : "OFF"}</span>
            </div>
            <p className="text-sm text-muted">
              {on
                ? "Paid orders are rented on MiningRigRentals automatically, with real funds."
                : "Paid orders wait. Nothing is rented on MiningRigRentals until you turn this on."}
            </p>
          </div>
          <form action={setProvisioningAction}>
            <input type="hidden" name="on" value={String(!on)} />
            <Button variant={on ? "danger" : "primary"}>{on ? "Turn off" : "Turn on"}</Button>
          </form>
        </div>
      </Card>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat label="Revenue (paid orders)" value={usd(revenue)} />
        <Stat label="MRR cost" value={usd(cost)} hint={revenue.gt(0) ? `margin ${usd(revenue.sub(cost))}` : undefined} />
        <Link href="/admin/rigs">
          <Stat
            label="Rigs rented now"
            value={`${activeDays._count} · ${usd(activeSpend)}`}
            hint={`${waitingDays} waiting · ${cap > 0 ? `cap ${usd(cap)}` : "no cap"}`}
          />
        </Link>
        <Stat
          label="BitQube network"
          value={network.hashrateMh === null ? "—" : hashrate(network.hashrateMh)}
          hint={network.difficulty === null ? "explorer unreachable" : `difficulty ${network.difficulty.toFixed(2)}`}
        />
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card title="MiningRigRentals balance">
          {balance.ok ? (
            <dl className="num grid grid-cols-2 gap-2 text-sm">
              {Object.entries(balance.b).map(([cur, v]) => (
                <div key={cur} className="flex justify-between rounded-md bg-panel-2 px-3 py-2">
                  <dt className="text-muted">{cur}</dt>
                  <dd>{v?.confirmed}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <Alert tone="error">Could not read the MRR balance: {balance.error}</Alert>
          )}
          <p className="mt-3 text-xs text-muted">Top up on miningrigrentals.com. Rentals are paid in {process.env.MRR_CURRENCY ?? "BTC"}.</p>
        </Card>
        <Card title="Orders">
          <div className="grid grid-cols-3 gap-2 text-center text-sm">
            {(["PENDING_PAYMENT", "QUEUED", "ACTIVE", "COMPLETED", "PARTIAL", "FAILED"] as const).map((s) => (
              <Link key={s} href={`/admin/orders?status=${s}`} className="rounded-md bg-panel-2 px-2 py-3 hover:ring-1 hover:ring-line">
                <div className="num text-xl font-semibold">{count(s)}</div>
                <StatusBadge status={s} />
              </Link>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted">Global markup: {multiplier(settings["pricing.globalMultiplier"])}</p>
        </Card>
      </div>

      {pendingPool > 0 && (
        <div className="mb-6">
          <Alert tone="warn">
            {pendingPool} rental(s) could not be pointed at their slot&apos;s pool yet. The worker keeps retrying.
          </Alert>
        </div>
      )}

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Needs attention</h2>
      <Table head={["Order", "Customer", "Coin", "Hashrate", "Price", "Status", "Reason"]} empty="All clear.">
        {needsAction.map((o) => (
          <tr key={o.id} className="hover:bg-panel-2">
            <Td>
              <Link href={`/admin/orders/${o.id}`} className="font-mono text-accent">
                {o.id.slice(-8)}
              </Link>
            </Td>
            <Td>{o.user.email}</Td>
            <Td>{o.coinId}</Td>
            <Td className="num">{coinHashrate(o.hashrateMh, { unit: o.coin.unit, unitMh: Number(o.coin.unitMh) })}</Td>
            <Td className="num">{usd(o.priceUsd)}</Td>
            <Td>
              <StatusBadge status={o.status} />
            </Td>
            <Td className="max-w-xs truncate text-xs text-muted">{o.status === "PAID" && !on ? "Waiting: provisioning is off" : o.failureReason ?? ""}</Td>
          </tr>
        ))}
      </Table>
    </Page>
  );
}
