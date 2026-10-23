import { Button, Card, Field, Input, Page, Table, Td } from "@/components/ui";
import { Flash } from "@/components/flash";
import { minutesLabel, planMinutes } from "@/lib/coin-format";
import { db } from "@/lib/db";
import { savePackageAction, togglePackageAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function AdminPackages({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const plans = await db.plan.findMany({ orderBy: [{ sortOrder: "asc" }, { sharePct: "asc" }] });
  return (
    <Page title="Packages">
      <Flash sp={sp} />
      <p className="mb-6 text-sm text-muted">
        A package is a share of one rig&apos;s day, for every coin: 10% of a 1 GH/s rig is 100 MH/s, delivered as 2h 24m of the full rig.
        There is no fixed price: each one is priced live from MiningRigRentals × markup.
      </p>
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Table head={["Name", "Share of a rig", "Rig time per day", "Order", "Visible"]} empty="No packages yet.">
          {plans.map((p) => (
            <tr key={p.id} className={p.active ? undefined : "opacity-50"}>
              <Td>{p.name}</Td>
              <Td className="num">{Number(p.sharePct)}%</Td>
              <Td className="num">{minutesLabel(planMinutes(p.sharePct, 1))}</Td>
              <Td className="num">{p.sortOrder}</Td>
              <Td>
                <form action={togglePackageAction}>
                  <input type="hidden" name="id" value={p.id} />
                  <button className={p.active ? "text-ok" : "text-muted"}>{p.active ? "Shown" : "Hidden"}</button>
                </form>
              </Td>
            </tr>
          ))}
        </Table>
        <Card title="Add package">
          <form action={savePackageAction} className="space-y-3">
            <Field label="Name">
              <Input name="name" placeholder="Starter" required />
            </Field>
            <Field label="Share of a rig (%)" hint="10 = 2h 24m a day, 25 = 6h, 50 = 12h">
              <Input name="sharePct" type="number" step="0.01" min="0.01" max="100" required />
            </Field>
            <Field label="Sort order">
              <Input name="sortOrder" type="number" defaultValue="0" />
            </Field>
            <Button>Add</Button>
          </form>
        </Card>
      </div>
    </Page>
  );
}
