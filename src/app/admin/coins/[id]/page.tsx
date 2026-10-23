import { notFound } from "next/navigation";
import { Flash } from "@/components/flash";
import { Alert, Button, Card, Field, Input, Page } from "@/components/ui";
import { coinHashrate } from "@/lib/coin-format";
import { coinProblems, mrrProfileFor } from "@/lib/coins";
import { db } from "@/lib/db";
import { createCoinProfileAction, saveCoinAction, testCoinPoolAction, toggleCoinAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function AdminCoin({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const coin = await db.coin.findUnique({ where: { id } });
  if (!coin) notFound();
  const unit = { unit: coin.unit, unitMh: Number(coin.unitMh) };
  const problems = coinProblems(coin);
  const profile = mrrProfileFor(coin);
  const orders = await db.order.count({ where: { coinId: id, status: { in: ["PAID", "QUEUED", "ACTIVE"] } } });

  return (
    <Page title={`${coin.name} (${coin.id})`}>
      <Flash sp={sp} />
      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <Card title="Setup">
          <form action={saveCoinAction} className="space-y-4">
            <input type="hidden" name="id" value={coin.id} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">
                <Input name="name" defaultValue={coin.name} />
              </Field>
              <Field label={`Rig size (${coin.unit})`} hint="One rented rig. Packages are shares of this.">
                <Input name="rig" type="number" step="any" min="0" defaultValue={Number(coin.rigMh) / unit.unitMh} required className="num" />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
              <Field label="Pool host" hint="Where customers' slots mine, unless they use their own pool.">
                <Input name="poolHost" defaultValue={coin.poolHost ?? ""} spellCheck={false} className="font-mono" />
              </Field>
              <Field label="Port">
                <Input name="poolPort" type="number" defaultValue={coin.poolPort ?? ""} className="num" />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
              <Field label="Pool username" hint="{address} = the customer's payout address, {worker} = an id per order.">
                <Input name="poolUser" defaultValue={coin.poolUser} spellCheck={false} className="font-mono" />
              </Field>
              <Field label="Password">
                <Input name="poolPass" defaultValue={coin.poolPass} spellCheck={false} className="font-mono" />
              </Field>
            </div>
            <Field label="House address" hint="Unsold rig time mines here. A wallet you control.">
              <Input name="houseAddress" defaultValue={coin.houseAddress ?? ""} spellCheck={false} className="font-mono" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="MRR pool profile id"
                hint={coin.algo === "kawpow" ? "Empty = MRR_PROFILE_ID from the server settings." : `A ${coin.algo} profile on MRR. Or create one below.`}
              >
                <Input name="mrrProfileId" defaultValue={coin.mrrProfileId ?? ""} className="num" />
              </Field>
              <Field label="Sort order">
                <Input name="sortOrder" type="number" defaultValue={coin.sortOrder} className="num" />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="ownPoolAllowed" defaultChecked={coin.ownPoolAllowed} disabled={coin.portsByDifficulty} />
              Customers may use their own pool
              {coin.portsByDifficulty && <span className="text-xs text-muted">(not for BTQ: rigs are matched to our pool&apos;s ports)</span>}
            </label>
            <Button>Save</Button>
          </form>
        </Card>

        <div className="space-y-6">
          <Card title="Status">
            <div className="space-y-3 text-sm">
              <div>
                {coin.enabled ? <span className="text-ok">On sale</span> : <span className="text-muted">Off sale</span>} · {orders} order(s)
                running or waiting
              </div>
              {problems.length ? (
                <Alert tone="warn">Not ready: {problems.join(", ")}.</Alert>
              ) : (
                <Alert tone="ok">Ready to rent {coinHashrate(coin.rigMh, unit)} rigs on profile {profile}.</Alert>
              )}
              <form action={toggleCoinAction}>
                <input type="hidden" name="id" value={coin.id} />
                <input type="hidden" name="back" value={`/admin/coins/${coin.id}`} />
                <Button variant={coin.enabled ? "danger" : "primary"}>{coin.enabled ? "Take off sale" : "Put on sale"}</Button>
              </form>
            </div>
          </Card>
          <Card title="MiningRigRentals">
            <div className="space-y-4 text-sm">
              <form action={testCoinPoolAction} className="space-y-2">
                <input type="hidden" name="id" value={coin.id} />
                <p className="text-muted">MRR connects to the pool with the house address and checks it gets work. Nothing is rented.</p>
                <Button variant="secondary">Test pool</Button>
              </form>
              <form action={createCoinProfileAction} className="space-y-2 border-t border-line pt-4">
                <input type="hidden" name="id" value={coin.id} />
                <p className="text-muted">
                  Creates a {coin.algo} pool profile on the MRR account, mining to the house address, and saves it here. Rentals start on it
                  and are switched to each slot&apos;s pool.
                </p>
                <Button variant="secondary">Create MRR profile</Button>
              </form>
            </div>
          </Card>
        </div>
      </div>
    </Page>
  );
}
