import Link from "next/link";
import type { RigDayStatus } from "@prisma/client";
import { Flash } from "@/components/flash";
import { Page, Table, Td, cx } from "@/components/ui";
import { coinHashrate, minutesLabel } from "@/lib/coin-format";
import { db } from "@/lib/db";
import { dateTime, usd } from "@/lib/format";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

const STATUSES: RigDayStatus[] = ["OPEN", "RENTING", "ACTIVE", "ENDED", "FAILED"];

export default async function AdminRigs({ searchParams }: { searchParams: Promise<{ status?: string; ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const status = STATUSES.find((s) => s === sp.status);
  const [days, settings] = await Promise.all([
    db.rigDay.findMany({
      where: status ? { status } : { status: { in: ["OPEN", "RENTING", "ACTIVE", "FAILED"] } },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { coin: true, _count: { select: { slots: true } }, slots: { select: { createdAt: true }, orderBy: { createdAt: "asc" }, take: 1 } },
    }),
    getSettings(db),
  ]);

  return (
    <Page title="Rigs">
      <Flash sp={sp} />
      <p className="mb-4 text-sm text-muted">
        One rig day = one rig rented for 24h and shared by its customers&apos; slots. An open day is rented once {settings["slots.minBookedPct"]}% is
        sold or its first order has waited {settings["slots.maxWaitHours"]}h{settings["provisioning.enabled"] ? "" : " (provisioning is OFF, so nothing is rented)"}.
      </p>
      <div className="mb-4 flex flex-wrap gap-2 text-xs">
        <Link href="/admin/rigs" className={cx("rounded-full border px-3 py-1", !status ? "border-accent text-accent" : "border-line text-muted")}>
          Current
        </Link>
        {STATUSES.map((s) => (
          <Link key={s} href={`/admin/rigs?status=${s}`} className={cx("rounded-full border px-3 py-1", status === s ? "border-accent text-accent" : "border-line text-muted")}>
            {s.toLowerCase()}
          </Link>
        ))}
      </div>
      <Table head={["Rig day", "Coin", "Rig", "Sold", "Orders", "Waiting since", "Cost / budget", "Status", "Runs"]} empty="No rig days.">
        {days.map((d) => (
          <tr key={d.id}>
            <Td>
              <Link href={`/admin/rigs/${d.id}`} className="font-mono text-accent">
                {d.id.slice(-8)}
              </Link>
            </Td>
            <Td>{d.coinId}</Td>
            <Td className="num">{coinHashrate(d.rigMh, { unit: d.coin.unit, unitMh: Number(d.coin.unitMh) })}</Td>
            <Td className="num">
              {Math.round((d.bookedMinutes / d.minutes) * 100)}% <span className="text-xs text-muted">{minutesLabel(d.bookedMinutes)}</span>
            </Td>
            <Td className="num">{d._count.slots}</Td>
            <Td className="text-xs text-muted">{d.status === "OPEN" ? dateTime(d.slots[0]?.createdAt ?? d.createdAt) : "—"}</Td>
            <Td className="num">
              {d.costUsd ? usd(d.costUsd) : "—"} / {usd(d.maxCostUsd)}
            </Td>
            <Td className={d.status === "FAILED" ? "text-bad" : undefined}>
              {d.status}
              {d.forceRent && d.status === "OPEN" && <span className="ml-1 text-xs text-accent">(rent now)</span>}
            </Td>
            <Td className="text-xs text-muted">{d.startsAt ? `${dateTime(d.startsAt)} → ${dateTime(d.endsAt)}` : "—"}</Td>
          </tr>
        ))}
      </Table>
    </Page>
  );
}
