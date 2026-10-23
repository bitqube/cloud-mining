import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, Card, Field, Input, Page, Select, StatusBadge, Table, Td } from "@/components/ui";
import { Flash } from "@/components/flash";
import { db } from "@/lib/db";
import { coinHashrate, minutesLabel } from "@/lib/coin-format";
import { dateTime, multiplier, usd } from "@/lib/format";
import { allowedAdminTransitions } from "@/lib/order-service";
import { acceptBtqPaymentAction, markPaidAction, setOrderStatusAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function AdminOrder({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const order = await db.order.findUnique({
    where: { id },
    include: {
      user: true,
      coin: true,
      slots: { orderBy: [{ startsAt: { sort: "asc", nulls: "last" } }, { seq: "asc" }], include: { rigDay: true } },
      payments: { orderBy: { createdAt: "asc" } },
      events: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!order) notFound();
  const transitions = allowedAdminTransitions(order.status);
  // Our cost for this order: its share of each rig day it was booked on, at the quoted
  // rig-day price until the day is rented.
  const unit = { unit: order.coin.unit, unitMh: Number(order.coin.unitMh) };
  const margin = Number(order.priceUsd) - Number(order.quotedCostUsd);
  const paid = order.payments.filter((p) => p.status === "CONFIRMED").reduce((s, p) => s + Number(p.amountUsd), 0);
  const btq = order.payments.findLast((p) => p.method === "BTQ");
  const canAcceptBtq =
    btq &&
    btq.status !== "CONFIRMED" &&
    Number(btq.receivedAsset ?? 0) > 0 &&
    (order.status === "PENDING_PAYMENT" || order.status === "CANCELLED");

  return (
    <Page title={`Order ${order.id.slice(-8)}`} actions={<StatusBadge status={order.status} />}>
      <Flash sp={sp} />
      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card title="Order">
          <dl className="space-y-2 text-sm">
            <Row
              k="Customer"
              v={
                <Link href={`/admin/users?q=${order.user.email}`} className="text-accent">
                  {order.user.email}
                </Link>
              }
            />
            <Row k="Coin" v={`${order.coin.name} (${order.coinId})`} />
            <Row k="Hashrate" v={`${coinHashrate(order.hashrateMh, unit)} · ${Number(order.sharePct)}% of a rig`} />
            <Row k="Duration" v={`${order.days} day${order.days === 1 ? "" : "s"}`} />
            <Row k="Rig time" v={`${minutesLabel(order.slotMinutes)} at ${coinHashrate(order.rigMh, unit)}`} />
            {order.poolHost ? (
              <Row k="Own pool" v={<span className="font-mono text-xs break-all">{`${order.poolHost}:${order.poolPort} · ${order.poolUser}`}</span>} />
            ) : (
              <Row k="Payout address" v={<span className="font-mono text-xs break-all">{order.payoutAddress}</span>} />
            )}
            {order.failureReason && <Row k="Problem" v={<span className="text-bad">{order.failureReason}</span>} />}
          </dl>
        </Card>
        <Card title="Money">
          <dl className="space-y-2 text-sm">
            <Row k="Price" v={usd(order.priceUsd)} />
            <Row k="Paid so far" v={usd(paid)} />
            <Row k="Markup" v={multiplier(order.multiplier)} />
            <Row k="Rig cost (quoted share)" v={usd(order.quotedCostUsd)} />
            <Row k="Margin" v={<span className={margin >= 0 ? "text-ok" : "text-bad"}>{usd(margin)}</span>} />
            {order.payments.map((p) =>
              p.method === "BTQ" ? (
                <Row
                  key={p.id}
                  k="Payment BTQ"
                  v={
                    <div className="space-y-0.5">
                      <div>
                        {p.status} · {String(p.receivedAsset ?? 0)} of {String(p.amountAsset)} BTQ
                        {p.confirmations !== null && ` · ${p.confirmations} conf`}
                      </div>
                      <div className="font-mono text-xs break-all text-muted">{p.providerRef}</div>
                      <div className="text-xs text-muted">
                        at ${String(p.rateUsd)}/BTQ · window until {dateTime(p.expiresAt)}
                      </div>
                      {p.txid && <div className="font-mono text-xs break-all text-muted">tx {p.txid}</div>}
                    </div>
                  }
                />
              ) : (
                <Row key={p.id} k={`Payment ${p.method}`} v={`${usd(p.amountUsd)} · ${p.status}${p.providerRef ? ` · ${p.providerRef}` : ""}`} />
              ),
            )}
          </dl>
        </Card>
        <Card title="Actions">
          <div className="space-y-5">
            {canAcceptBtq && (
              <form action={acceptBtqPaymentAction} className="space-y-2">
                <input type="hidden" name="orderId" value={order.id} />
                <p className="text-sm">
                  {String(btq.receivedAsset)} of {String(btq.amountAsset)} BTQ received, but not accepted automatically (late, short, or the
                  order was cancelled).
                </p>
                <Button>Accept BTQ payment</Button>
              </form>
            )}
            {order.status === "PENDING_PAYMENT" && (
              <form action={markPaidAction} className="space-y-2">
                <input type="hidden" name="orderId" value={order.id} />
                <Field label="Mark as paid (manual)" hint={`Records ${usd(Number(order.priceUsd) - paid)} still owed as received, e.g. a bank transfer or a card/USDT payment checked by hand.`}>
                  <Input name="reference" placeholder="Reference (optional)" />
                </Field>
                <Button>Mark paid</Button>
              </form>
            )}
            {transitions.length > 0 && (
              <form action={setOrderStatusAction} className="space-y-2">
                <input type="hidden" name="orderId" value={order.id} />
                <Field
                  label="Change status"
                  hint={
                    order.status === "FAILED"
                      ? "PAID = retry renting rigs."
                      : "Refunds are recorded here; send the money back outside the system."
                  }
                >
                  <Select name="status">
                    {transitions.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Input name="note" placeholder="Note (optional)" />
                <Button variant="secondary">Apply</Button>
              </form>
            )}
            {transitions.length === 0 && order.status !== "PENDING_PAYMENT" && !canAcceptBtq && (
              <p className="text-sm text-muted">No manual actions for this status.</p>
            )}
          </div>
        </Card>
      </div>

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Slots</h2>
      <div className="mb-6">
        <Table head={["Rig day", "Length", "Starts", "Ends", "Status", "Delivered"]} empty="Not booked yet.">
          {order.slots.map((s) => (
            <tr key={s.id}>
              <Td>
                <Link href={`/admin/rigs/${s.rigDayId}`} className="font-mono text-accent">
                  {s.rigDayId.slice(-8)}
                </Link>
                <span className="ml-2 text-xs text-muted">{s.rigDay.status}</span>
              </Td>
              <Td className="num">{minutesLabel(s.minutes)}</Td>
              <Td className="text-xs">{dateTime(s.startsAt)}</Td>
              <Td className="text-xs">{dateTime(s.endsAt)}</Td>
              <Td>{s.status}</Td>
              <Td className="num">{s.deliveredMhHours ? `${coinHashrate(Number(s.deliveredMhHours), unit)}·h` : "—"}</Td>
            </tr>
          ))}
        </Table>
      </div>

      <Card title="Event log">
        <ol className="space-y-2 text-sm">
          {order.events.map((e) => (
            <li
              key={e.id}
              className="flex flex-col gap-0.5 border-b border-line pb-3 last:border-0 sm:flex-row sm:gap-3 sm:border-0 sm:pb-0"
            >
              <span className="text-xs text-muted sm:w-40 sm:shrink-0">{dateTime(e.createdAt)}</span>
              <span className="font-mono text-xs text-blue sm:w-36 sm:shrink-0">{e.type}</span>
              <span className="min-w-0 break-words">
                {e.message}
                {Array.isArray((e.data as { errors?: unknown })?.errors) && (e.data as { errors: string[] }).errors.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-xs text-muted">
                    {(e.data as { errors: string[] }).errors.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                )}
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </Page>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 text-muted">{k}</dt>
      <dd className="num text-right">{v}</dd>
    </div>
  );
}
