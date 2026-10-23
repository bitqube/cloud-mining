import { Button, Card, Field, Input, Page, Table, Td } from "@/components/ui";
import { Flash } from "@/components/flash";
import { db } from "@/lib/db";
import { dateTime, multiplier, usd } from "@/lib/format";
import { DEFAULT_GLOBAL_MULTIPLIER, MAX_MULTIPLIER, MIN_MULTIPLIER, customerPrice } from "@/lib/pricing";
import { getSettings } from "@/lib/settings";
import { setGlobalMultiplierAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function AdminPricing({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const [settings, history, overrides, admins] = await Promise.all([
    getSettings(db),
    db.pricingChange.findMany({ orderBy: { createdAt: "desc" }, take: 50, include: { targetUser: true } }),
    db.user.count({ where: { priceMultiplier: { not: null } } }),
    db.user.findMany({ where: { role: "ADMIN" }, select: { id: true, email: true } }),
  ]);
  const global = settings["pricing.globalMultiplier"];
  const adminEmail = new Map(admins.map((a) => [a.id, a.email]));
  const exampleCost = 11.86; // 1 GH/s × 24h on MRR, 2026-10-18

  return (
    <Page title="Pricing">
      <Flash sp={sp} />
      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card title="Global markup">
          <form action={setGlobalMultiplierAction} className="space-y-4">
            <Field label="Multiplier" hint={`Customer price = MiningRigRentals cost × this. Allowed ${MIN_MULTIPLIER}× to ${MAX_MULTIPLIER}×.`}>
              <Input name="multiplier" type="number" step="0.05" min={MIN_MULTIPLIER.toString()} max={MAX_MULTIPLIER.toString()} defaultValue={global.toString()} required />
            </Field>
            <Field label="Note (optional)">
              <Input name="note" placeholder="Why this change?" />
            </Field>
            <Button>Save global markup</Button>
          </form>
        </Card>
        <Card title="What customers see">
          <p className="mb-3 text-sm text-muted">Example: 1 GH/s for 24 hours costs about {usd(exampleCost)} on MiningRigRentals.</p>
          <div className="space-y-2 text-sm">
            {[global.toNumber(), 2, 3, 5].filter((v, i, a) => a.indexOf(v) === i).map((m) => (
              <div key={m} className={`flex justify-between rounded-md px-3 py-2 ${m === global.toNumber() ? "bg-accent/10 text-accent" : "bg-panel-2"}`}>
                <span>{multiplier(m)}{m === global.toNumber() ? " (current)" : ""}</span>
                <span className="num">
                  {usd(customerPrice(exampleCost, m))} · margin {usd(customerPrice(exampleCost, m).sub(exampleCost))}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted">
            {overrides} customer(s) have their own markup (set on the Users page). Changing a markup never changes a price already shown or paid.
          </p>
        </Card>
      </div>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Change history</h2>
      <Table head={["When", "Applies to", "From", "To", "By", "Note"]} empty="No changes yet.">
        {history.map((h) => (
          <tr key={h.id}>
            <Td className="text-xs text-muted">{dateTime(h.createdAt)}</Td>
            <Td>{h.targetUser ? h.targetUser.email : <span className="text-accent">Everyone (global)</span>}</Td>
            <Td className="num">{h.oldValue ? multiplier(h.oldValue) : h.targetUser ? "global" : `${multiplier(DEFAULT_GLOBAL_MULTIPLIER)} (default)`}</Td>
            <Td className="num">{h.newValue ? multiplier(h.newValue) : "global"}</Td>
            <Td className="text-xs">{adminEmail.get(h.changedBy) ?? h.changedBy}</Td>
            <Td className="text-xs text-muted">{h.note ?? ""}</Td>
          </tr>
        ))}
      </Table>
    </Page>
  );
}
