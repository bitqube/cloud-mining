import Link from "next/link";
import type { OrderStatus, Prisma } from "@prisma/client";
import { Page, StatusBadge, Table, Td, cx } from "@/components/ui";
import { db } from "@/lib/db";
import { coinHashrate } from "@/lib/coin-format";
import { dateTime, multiplier, usd } from "@/lib/format";

export const dynamic = "force-dynamic";

const STATUSES: OrderStatus[] = ["PENDING_PAYMENT", "PAID", "QUEUED", "PROVISIONING", "ACTIVE", "COMPLETED", "PARTIAL", "FAILED", "REFUNDED", "CANCELLED"];

export default async function AdminOrders({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const sp = await searchParams;
  const status = STATUSES.find((s) => s === sp.status);
  const where: Prisma.OrderWhereInput = {
    ...(status ? { status } : {}),
    ...(sp.q ? { OR: [{ id: { contains: sp.q } }, { payoutAddress: { contains: sp.q } }, { user: { email: { contains: sp.q.toLowerCase() } } }] } : {}),
  };
  const orders = await db.order.findMany({ where, orderBy: { createdAt: "desc" }, take: 200, include: { user: true, coin: true } });

  return (
    <Page title="Orders">
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <Link href="/admin/orders" className={cx("rounded-full border px-3 py-1", !status ? "border-accent text-accent" : "border-line text-muted")}>
          All
        </Link>
        {STATUSES.map((s) => (
          <Link key={s} href={`/admin/orders?status=${s}`} className={cx("rounded-full border px-3 py-1", status === s ? "border-accent text-accent" : "border-line text-muted")}>
            {s.replace("_", " ").toLowerCase()}
          </Link>
        ))}
        <form className="ml-auto">
          {status && <input type="hidden" name="status" value={status} />}
          <input name="q" defaultValue={sp.q} placeholder="Search id, email, address" className="rounded-lg border border-line bg-bg px-3 py-1.5 text-sm" />
        </form>
      </div>
      <Table head={["Order", "Customer", "Coin", "Hashrate", "Days", "Price", "Quoted rig cost", "Markup", "Status", "Placed"]} empty="No orders match.">
        {orders.map((o) => (
          <tr key={o.id} className="hover:bg-panel-2">
            <Td>
              <Link href={`/admin/orders/${o.id}`} className="font-mono text-accent">
                {o.id.slice(-8)}
              </Link>
            </Td>
            <Td>{o.user.email}</Td>
            <Td>{o.coinId}</Td>
            <Td className="num">{coinHashrate(o.hashrateMh, { unit: o.coin.unit, unitMh: Number(o.coin.unitMh) })}</Td>
            <Td className="num">{o.days}</Td>
            <Td className="num">{usd(o.priceUsd)}</Td>
            <Td className="num">{usd(o.quotedCostUsd)}</Td>
            <Td className="num">{multiplier(o.multiplier)}</Td>
            <Td>
              <StatusBadge status={o.status} />
            </Td>
            <Td className="text-xs text-muted">{dateTime(o.createdAt)}</Td>
          </tr>
        ))}
      </Table>
    </Page>
  );
}
