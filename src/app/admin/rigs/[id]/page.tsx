import Link from "next/link";
import { notFound } from "next/navigation";
import { Flash } from "@/components/flash";
import { Alert, Button, Card, Page, Table, Td } from "@/components/ui";
import { coinHashrate, minutesLabel } from "@/lib/coin-format";
import { db } from "@/lib/db";
import { dateTime, usd } from "@/lib/format";
import { forceRentRigDayAction, retryRigDayAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function AdminRigDay({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const day = await db.rigDay.findUnique({
    where: { id },
    include: {
      coin: true,
      slots: { orderBy: [{ startsAt: { sort: "asc", nulls: "last" } }, { seq: "asc" }], include: { order: { include: { user: true } } } },
      rentals: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!day) notFound();
  const unit = { unit: day.coin.unit, unitMh: Number(day.coin.unitMh) };
  const unsold = day.minutes - day.bookedMinutes;

  return (
    <Page title={`Rig day ${day.id.slice(-8)}`}>
      <Flash sp={sp} />
      <div className="mb-6 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card title="Rig">
          <dl className="space-y-2 text-sm">
            <Row k="Coin" v={`${day.coin.name} (${day.coinId})`} />
            <Row k="Rig" v={`${coinHashrate(day.rigMh, unit)} for ${minutesLabel(day.minutes)}`} />
            <Row k="Sold" v={`${minutesLabel(day.bookedMinutes)} (${Math.round((day.bookedMinutes / day.minutes) * 100)}%) · ${minutesLabel(unsold)} to the house address`} />
            <Row k="Status" v={day.status} />
            <Row k="Runs" v={day.startsAt ? `${dateTime(day.startsAt)} → ${dateTime(day.endsAt)}` : "not rented yet"} />
            <Row k="Mining for" v={day.target === "house" ? "house address" : day.target ? `slot ${day.target.slice(-8)}` : "—"} />
            <Row k="Cost / budget" v={`${day.costUsd ? usd(day.costUsd) : "—"} / ${usd(day.maxCostUsd)}`} />
            {day.attempts > 0 && <Row k="Rent attempts" v={`${day.attempts}${day.nextAttemptAt ? `, next ${dateTime(day.nextAttemptAt)}` : ""}`} />}
            {day.failureReason && <Row k="Problem" v={<span className="text-bad">{day.failureReason}</span>} />}
          </dl>
        </Card>
        <Card title="Actions">
          <div className="space-y-4 text-sm">
            {day.status === "OPEN" && (
              <form action={forceRentRigDayAction} className="space-y-2">
                <input type="hidden" name="id" value={day.id} />
                <p className="text-muted">Rent this rig now, whatever is sold. Unsold time mines to the house address.</p>
                <Button disabled={day.forceRent}>{day.forceRent ? "Will rent on the next tick" : "Rent now"}</Button>
              </form>
            )}
            {day.status === "FAILED" && (
              <form action={retryRigDayAction} className="space-y-2">
                <input type="hidden" name="id" value={day.id} />
                <p className="text-muted">Put this rig day back in the queue to be rented again.</p>
                <Button>Retry</Button>
              </form>
            )}
            {day.status !== "OPEN" && day.status !== "FAILED" && <p className="text-muted">No actions for this status.</p>}
            {day.status === "FAILED" && day.rentals.length > 0 && (
              <Alert tone="warn">This rig day has rentals on MRR. Check them there; cancel or refund customers from their orders.</Alert>
            )}
          </div>
        </Card>
      </div>

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Slots</h2>
      <div className="mb-6">
        <Table head={["Order", "Customer", "Length", "Starts", "Ends", "Status"]} empty="No slots.">
          {day.slots.map((s) => (
            <tr key={s.id}>
              <Td>
                <Link href={`/admin/orders/${s.orderId}`} className="font-mono text-accent">
                  {s.orderId.slice(-8)}
                </Link>
              </Td>
              <Td className="text-xs">{s.order.user.email}</Td>
              <Td className="num">{minutesLabel(s.minutes)}</Td>
              <Td className="text-xs">{dateTime(s.startsAt)}</Td>
              <Td className="text-xs">{dateTime(s.endsAt)}</Td>
              <Td>{s.status}</Td>
            </tr>
          ))}
        </Table>
      </div>

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Rentals on MiningRigRentals</h2>
      <Table head={["Rental", "Rig", "Advertised", "Average", "Port", "Cost", "Status", "Ends"]} empty="No rentals yet.">
        {day.rentals.map((r) => (
          <tr key={r.id}>
            <Td>
              <a className="font-mono text-accent" href={`https://www.miningrigrentals.com/rentals/${r.externalId}`} target="_blank" rel="noreferrer">
                #{r.externalId}
              </a>
            </Td>
            <Td className="font-mono text-xs">{r.rigId}</Td>
            <Td className="num">{coinHashrate(r.advertisedMh, unit)}</Td>
            <Td className="num">{r.averageMh ? coinHashrate(r.averageMh, unit) : "—"}</Td>
            <Td className="num">
              {r.port ?? "—"}
              {r.poolPending && <span className="ml-1 text-warn">(repoint pending)</span>}
            </Td>
            <Td className="num">{usd(r.costUsd)}</Td>
            <Td>{r.status}</Td>
            <Td className="text-xs text-muted">{dateTime(r.endsAt)}</Td>
          </tr>
        ))}
      </Table>
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
