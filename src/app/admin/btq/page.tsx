import Link from "next/link";
import { Flash } from "@/components/flash";
import { Alert, Button, Card, Input, Page, Stat, Table, Td } from "@/components/ui";
import { btqWalletFromEnv, type NodeStatus } from "@/lib/btq/wallet";
import { db } from "@/lib/db";
import { dateTime, usd } from "@/lib/format";
import { getSettings, type SettingKey } from "@/lib/settings";
import { setSettingAction } from "../actions";

export const dynamic = "force-dynamic";

// The BTQ price is typed by hand; after this long it gets a warning.
const RATE_STALE_HOURS = 24;
// getnewaddress needs the wallet unlocked once the keypool runs out.
const KEYPOOL_LOW = 500;

const EDITABLE: Array<{ key: SettingKey; label: string; hint: string; step?: string }> = [
  { key: "btq.maxSharePct", label: "Most of a price payable in BTQ (%)", hint: "Customers choose 0% up to this; the rest is paid by card or USDT. 100 = all of it." },
  { key: "btq.usdRate", label: "BTQ price (USD)", hint: "Converts the BTQ part of a price into BTQ at checkout.", step: "any" },
  { key: "btq.confirmations", label: "Confirmations", hint: "Blocks (about a minute each) before a BTQ payment counts as paid." },
  {
    key: "btq.maxOrderUsd",
    label: "Most BTQ per order (USD)",
    hint: "The BitQube network is small enough that a payment can be reversed cheaply; this caps what one reversal could cost.",
  },
  {
    key: "btq.paymentWindowMinutes",
    label: "Payment window (minutes)",
    hint: "How long the customer has to send. A payment seen in time is accepted even if it confirms later.",
  },
];

export default async function AdminBtq({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const wallet = btqWalletFromEnv();
  const [settings, rateRow, payments, node] = await Promise.all([
    getSettings(db),
    db.setting.findUnique({ where: { key: "btq.usdRate" } }),
    db.payment.findMany({ where: { method: "BTQ" }, orderBy: { createdAt: "desc" }, take: 25, include: { order: { select: { id: true, status: true } } } }),
    wallet
      ? wallet
          .status()
          .then((s) => ({ ok: true as const, s }))
          .catch((e: Error) => ({ ok: false as const, error: e.message }))
      : Promise.resolve(null),
  ]);
  const on = settings["btq.enabled"];
  const rateAgeH = rateRow ? (Date.now() - rateRow.updatedAt.getTime()) / 3_600_000 : null;

  const warnings: string[] = [];
  if (!wallet) warnings.push("The node is not connected: set BTQ_RPC_URL, BTQ_RPC_USER and BTQ_RPC_PASSWORD on the server.");
  if (node && !node.ok) warnings.push(`The node did not answer: ${node.error}`);
  if (settings["btq.usdRate"].lte(0)) warnings.push("No BTQ price is set, so customers can't pay in BTQ.");
  else if (rateAgeH !== null && rateAgeH > RATE_STALE_HOURS)
    warnings.push(`The BTQ price was last changed ${Math.floor(rateAgeH / 24)} day(s) ago. Check it still matches the market.`);
  if (node?.ok) {
    const s: NodeStatus = node.s;
    if (!s.synced) warnings.push(`The node is still syncing (${s.blocks} of ${s.headers} blocks). Payments are seen late until it catches up.`);
    if (!s.encrypted) warnings.push("The node's wallet is not encrypted.");
    if (s.keypool < KEYPOOL_LOW)
      warnings.push(`Only ${s.keypool} unused addresses left. Unlock the wallet on the node and run keypoolrefill 10000.`);
  }

  return (
    <Page title="BTQ payments">
      <Flash sp={sp} />
      <Card className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-sm font-semibold">
              BTQ payments are <span className={on ? "text-ok" : "text-warn"}>{on ? "ON" : "OFF"}</span>
            </div>
            <p className="text-sm text-muted">
              {on
                ? `Customers can pay up to ${settings["btq.maxSharePct"]}% of a price in BTQ (at most ${usd(settings["btq.maxOrderUsd"])} per order).`
                : "Checkout offers card and USDT only. Orders already waiting for BTQ can still be paid."}
            </p>
          </div>
          <form action={setSettingAction}>
            <input type="hidden" name="back" value="/admin/btq" />
            <input type="hidden" name="key" value="btq.enabled" />
            <input type="hidden" name="value" value={String(!on)} />
            <Button variant={on ? "danger" : "primary"}>{on ? "Turn off" : "Turn on"}</Button>
          </form>
        </div>
      </Card>

      {warnings.length > 0 && (
        <div className="mb-6 space-y-2">
          {warnings.map((w) => (
            <Alert key={w} tone="warn">
              {w}
            </Alert>
          ))}
        </div>
      )}

      {node?.ok && (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <Stat label="Node" value={node.s.synced ? "Synced" : "Syncing"} hint={`block ${node.s.blocks}`} />
          <Stat label="Wallet" value={node.s.encrypted ? (node.s.unlocked ? "Unlocked" : "Locked") : "Not encrypted"} hint={`${node.s.keypool} addresses left`} />
          <Stat label="Waiting for sweep" value={`${node.s.balance.toFixed(2)} BTQ`} hint={node.s.unconfirmed.gt(0) ? `+${node.s.unconfirmed.toFixed(2)} unconfirmed` : undefined} />
          <Stat label="BTQ price" value={`$${settings["btq.usdRate"].toFixed()}`} hint={rateRow ? `set ${dateTime(rateRow.updatedAt)}` : "never set"} />
        </div>
      )}

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        {EDITABLE.map((s) => (
          <Card key={s.key}>
            <form action={setSettingAction} className="space-y-2">
              <input type="hidden" name="back" value="/admin/btq" />
              <input type="hidden" name="key" value={s.key} />
              <div className="text-sm font-medium">{s.label}</div>
              <div className="flex gap-2">
                <Input name="value" defaultValue={String(settings[s.key])} type="number" step={s.step ?? "1"} required />
                <Button variant="secondary">Save</Button>
              </div>
              <p className="text-xs text-muted">{s.hint}</p>
            </form>
          </Card>
        ))}
      </div>

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Recent BTQ payments</h2>
      <Table head={["Order", "USD", "BTQ due", "Received", "Conf", "Status", "Created"]} empty="No BTQ payments yet.">
        {payments.map((p) => (
          <tr key={p.id}>
            <Td>
              <Link href={`/admin/orders/${p.orderId}`} className="font-mono text-accent">
                {p.orderId.slice(-8)}
              </Link>
            </Td>
            <Td className="num">{usd(p.amountUsd)}</Td>
            <Td className="num">{String(p.amountAsset ?? "—")}</Td>
            <Td className="num">{String(p.receivedAsset ?? 0)}</Td>
            <Td className="num">{p.confirmations ?? "—"}</Td>
            <Td>{p.status}</Td>
            <Td className="text-xs text-muted">{dateTime(p.createdAt)}</Td>
          </tr>
        ))}
      </Table>
      <p className="mt-4 text-xs text-muted">
        Received BTQ stays in the node&apos;s wallet until the weekly sweep (docs/btq-payments.md). Card and USDT gateways are not connected
        yet: confirm those parts by hand with &quot;Mark paid&quot; on the order.
      </p>
    </Page>
  );
}
