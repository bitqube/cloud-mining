import { notFound } from "next/navigation";
import { Alert, Card, Page, StatusBadge, cx } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { coinHashrate, minutesLabel } from "@/lib/coin-format";
import { db } from "@/lib/db";
import { dateTime, usd } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { BtqPaymentCard } from "./btq-payment";

export const dynamic = "force-dynamic";

// Events customers see; internal ones (costs, admin notes, provider errors) stay hidden.
const PUBLIC_EVENTS: Record<string, string> = {
  "order.created": "Order placed",
  "payment.seen": "Payment seen on the BitQube network",
  "payment.part": "Part of the payment confirmed",
  "payment.confirmed": "Payment confirmed",
  "order.booked": "Rig time booked on a shared rig",
  "rig.rented": "Rig rented, slot times set",
  "slot.started": "Your slot started mining",
  "slot.rebooked": "Missed time rebooked to a later slot",
  "order.completed": "Completed",
  "order.partial": "Finished with less rig time than ordered. Support will contact you",
  "order.cancelled": "Cancelled",
  "order.refunded": "Refunded",
};

const SLOT_LABEL = { BOOKED: "Booked", MINING: "Mining now", DONE: "Done", MISSED: "Missed, rebooked" } as const;
const METHOD_LABEL: Record<string, string> = { STRIPE: "Card", USDT: "USDT", BTQ: "BTQ", MANUAL: "Manual" };

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const order = await db.order.findUnique({
    where: { id },
    include: {
      coin: true,
      payments: { orderBy: { createdAt: "asc" } },
      slots: { orderBy: [{ startsAt: { sort: "asc", nulls: "last" } }, { seq: "asc" }] },
      events: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!order || (order.userId !== user.id && user.role !== "ADMIN")) notFound();

  const unit = { unit: order.coin.unit, unitMh: Number(order.coin.unitMh) };
  const live = order.payments.filter((p) => p.status !== "EXPIRED" && p.status !== "FAILED");
  const btq = live.findLast((p) => p.method === "BTQ" && p.providerRef) ?? order.payments.findLast((p) => p.method === "BTQ" && p.providerRef);
  // BTQ card: while that part is unpaid, and also after a cancel if coins arrived late.
  const showBtq =
    btq &&
    ((order.status === "PENDING_PAYMENT" && btq.status !== "CONFIRMED") ||
      (order.status === "CANCELLED" && Number(btq.receivedAsset ?? 0) > 0));
  const minConf = showBtq ? (await getSettings(db))["btq.confirmations"] : 0;
  const otherPending = order.status === "PENDING_PAYMENT" ? live.filter((p) => p.method !== "BTQ" && p.status === "PENDING") : [];
  const mining = order.slots.find((s) => s.status === "MINING");

  return (
    <Page title={`Order ${order.id.slice(-8)}`} actions={<StatusBadge status={order.status} />}>
      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <div className="space-y-6">
          <Card title="Details">
            <dl className="space-y-3 text-sm">
              <Row label="Coin" value={`${order.coin.name} (${order.coinId})`} />
              <Row label="Hashrate" value={coinHashrate(order.hashrateMh, unit)} />
              <Row label="Duration" value={`${order.days} day${order.days === 1 ? "" : "s"}`} />
              <Row label="Rig time" value={`${minutesLabel(order.slotMinutes)} at ${coinHashrate(order.rigMh, unit)}`} />
              <Row label="Price" value={usd(order.priceUsd)} />
              {order.poolHost ? (
                <Row label="Your pool" value={<span className="font-mono text-xs break-all">{`${order.poolHost}:${order.poolPort} · ${order.poolUser}`}</span>} />
              ) : (
                <Row label="Payout address" value={<span className="font-mono text-xs break-all">{order.payoutAddress}</span>} />
              )}
              {mining && <Row label="Mining now until" value={dateTime(mining.endsAt)} />}
            </dl>
          </Card>
          {order.slots.length > 0 && (
            <Card title="Your slots">
              <ul className="space-y-2 text-sm">
                {order.slots.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 border-b border-line pb-2 last:border-0">
                    <div>
                      <div className="num">{s.startsAt ? `${dateTime(s.startsAt)} → ${dateTime(s.endsAt)}` : "Time set when the rig is rented"}</div>
                      <div className="text-xs text-muted">{minutesLabel(s.minutes)}</div>
                    </div>
                    <span
                      className={cx(
                        "rounded-full px-2.5 py-0.5 text-xs",
                        s.status === "MINING" ? "bg-ok/15 text-ok" : s.status === "MISSED" ? "bg-warn/15 text-warn" : "bg-panel-2 text-muted",
                      )}
                    >
                      {SLOT_LABEL[s.status]}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
        <div className={showBtq ? "order-first space-y-6 lg:order-none" : "space-y-6"}>
          {showBtq && <BtqPaymentCard payment={btq} minConf={minConf} />}
          {live.length > 1 && (
            <Card title="Payment">
              <ul className="space-y-2 text-sm">
                {live.map((p) => (
                  <li key={p.id} className="flex items-center justify-between">
                    <span>{METHOD_LABEL[p.method] ?? p.method}</span>
                    <span className="num">
                      {usd(p.amountUsd)} <span className="ml-2 text-xs text-muted">{p.status === "CONFIRMED" ? "paid" : "waiting"}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {otherPending.map((p) => (
            <Alert key={p.id} tone="warn">
              Waiting for your {p.method === "STRIPE" ? "card" : p.method} payment of {usd(p.amountUsd)}. Payment links are being
              connected. Until then our team will send payment details for this order.
            </Alert>
          ))}
          <Card title="Timeline">
            <ol className="space-y-3 text-sm">
              {order.events
                .filter((e) => PUBLIC_EVENTS[e.type])
                .map((e) => (
                  <li key={e.id} className="flex gap-3">
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" />
                    <div>
                      <div>{PUBLIC_EVENTS[e.type]}</div>
                      <div className="text-xs text-muted">{dateTime(e.createdAt)}</div>
                    </div>
                  </li>
                ))}
            </ol>
          </Card>
          {(order.status === "ACTIVE" || order.status === "QUEUED") && (
            <Card title="Track your mining">
              <p className="text-sm text-muted">
                {order.poolHost ? (
                  <>Your pool&apos;s dashboard shows shares and payouts during your slots.</>
                ) : order.coinId === "BTQ" ? (
                  <>
                    Look up your address on{" "}
                    <a className="text-accent" href="https://pool.bitqube.org" target="_blank" rel="noreferrer">
                      pool.bitqube.org
                    </a>{" "}
                    to see shares and payouts.
                  </>
                ) : (
                  <>
                    Look up your address on <span className="font-mono">{order.coin.poolHost}</span> to see shares and payouts during your
                    slots.
                  </>
                )}
              </p>
            </Card>
          )}
        </div>
      </div>
    </Page>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="num text-right font-medium">{value}</dd>
    </div>
  );
}
