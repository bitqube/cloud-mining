import Link from "next/link";
import { ButtonLink, Page, StatusBadge, Table, Td } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { coinHashrate } from "@/lib/coin-format";
import { dateTime, shortAddr, usd } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const user = await requireUser();
  const orders = await db.order.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, include: { coin: true } });
  return (
    <Page title="My orders" actions={<ButtonLink href="/buy">Buy hashrate</ButtonLink>}>
      <Table head={["Order", "Coin", "Hashrate", "Days", "Payout", "Price", "Status", "Placed"]} empty="No orders yet.">
        {orders.map((o) => (
          <tr key={o.id} className="hover:bg-panel-2">
            <Td>
              <Link href={`/orders/${o.id}`} className="font-mono text-accent">
                {o.id.slice(-8)}
              </Link>
            </Td>
            <Td>{o.coinId}</Td>
            <Td className="num">{coinHashrate(o.hashrateMh, { unit: o.coin.unit, unitMh: Number(o.coin.unitMh) })}</Td>
            <Td className="num">{o.days}</Td>
            <Td className="font-mono text-xs">{o.poolHost ? o.poolHost : shortAddr(o.payoutAddress)}</Td>
            <Td className="num">{usd(o.priceUsd)}</Td>
            <Td>
              <StatusBadge status={o.status} />
            </Td>
            <Td className="text-muted">{dateTime(o.createdAt)}</Td>
          </tr>
        ))}
      </Table>
    </Page>
  );
}
