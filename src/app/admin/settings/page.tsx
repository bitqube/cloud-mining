import { Button, Card, Input, Page } from "@/components/ui";
import { Flash } from "@/components/flash";
import { db } from "@/lib/db";
import { getSettings, type SettingKey } from "@/lib/settings";
import { setSettingAction } from "../actions";

export const dynamic = "force-dynamic";

const EDITABLE: Array<{ key: SettingKey; label: string; hint: string; step?: string }> = [
  {
    key: "pricing.slippagePct",
    label: "Provisioning slippage (%)",
    hint: "Extra MRR spend allowed over the quoted rig-day cost when quoted rigs are gone.",
  },
  { key: "mrr.minRpi", label: "Minimum rig RPI", hint: "MRR's reliability score (0–100). Rigs below this are never rented." },
  {
    key: "mrr.maxActiveCostUsd",
    label: "Max rented at once (USD)",
    hint: "Cap on what all rigs rented at the same time may cost. A rig day that would go over waits. 0 = no cap.",
  },
  { key: "orders.maxDays", label: "Longest order (days)", hint: "Customers choose 1 day up to this." },
  {
    key: "slots.minBookedPct",
    label: "Rent a rig day once this much is sold (%)",
    hint: "Unsold time mines to the coin's house address. Lower = customers start sooner, but we pay for more unsold time.",
  },
  {
    key: "slots.maxWaitHours",
    label: "…or once its first order has waited (hours)",
    hint: "Rents the rig even if less is sold, so no customer waits longer than this. 0 = rent straight away.",
  },
  {
    key: "slots.minSlotMinutes",
    label: "Shortest slot (minutes)",
    hint: "Orders are split across rig days in pieces no shorter than this. Each piece is one pool switch.",
  },
];

export default async function AdminSettings({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const settings = await getSettings(db);
  return (
    <Page title="Settings">
      <Flash sp={sp} />
      <p className="mb-6 text-sm text-muted">The provisioning on/off switch is on the Dashboard, markups on Pricing, coins and pools on Coins, BTQ payments on BTQ.</p>
      <div className="grid gap-4 lg:grid-cols-2">
        {EDITABLE.map((s) => (
          <Card key={s.key}>
            <form action={setSettingAction} className="space-y-2">
              <input type="hidden" name="key" value={s.key} />
              <div className="text-sm font-medium">{s.label}</div>
              <div className="flex gap-2">
                <Input name="value" defaultValue={String(settings[s.key])} type="number" step={s.step ?? "1"} required />
                <Button variant="secondary">Save</Button>
              </div>
              {s.hint && <p className="text-xs text-muted">{s.hint}</p>}
            </form>
          </Card>
        ))}
      </div>
    </Page>
  );
}
