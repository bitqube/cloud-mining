import Decimal from "decimal.js";
import { Alert, Page } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { planMinutes } from "@/lib/coin-format";
import { db } from "@/lib/db";
import { networkStats } from "@/lib/network";
import { customerPrice, resolveMultiplier } from "@/lib/pricing";
import { getGlobalMultiplier, rigDayCost } from "@/lib/pricing-service";
import { getRouter } from "@/lib/router-instance";
import { getSettings } from "@/lib/settings";
import { BuyForm } from "./buy-form";

export const dynamic = "force-dynamic";

export default async function BuyPage({ searchParams }: { searchParams: Promise<{ coin?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const [settings, coins, plans, global] = await Promise.all([
    getSettings(db),
    db.coin.findMany({ where: { enabled: true }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] }),
    db.plan.findMany({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { sharePct: "asc" }] }),
    getGlobalMultiplier(db),
  ]);
  if (coins.length === 0 || plans.length === 0) {
    return (
      <Page title="Buy hashrate">
        <Alert tone="info">Nothing is on sale right now. Please check back soon.</Alert>
      </Page>
    );
  }
  const coin = coins.find((c) => c.id === sp.coin?.toUpperCase()) ?? coins[0];

  // A live estimate per plan, from the market price of one rig day. The real price is
  // quoted (and locked) on the next step.
  let rigCost: Decimal | null = null;
  try {
    rigCost = await rigDayCost(getRouter(), coin);
  } catch {
    // Market unreachable or no rigs: the form still works, just without estimates.
  }
  const { multiplier } = resolveMultiplier({ global, user: user.priceMultiplier });
  const net = coin.id === "BTQ" ? await networkStats() : null;

  return (
    <Page title="Buy hashrate">
      <BuyForm
        coins={coins.map((c) => ({ id: c.id, name: c.name, algo: c.algo }))}
        coin={{ id: coin.id, name: coin.name, unit: coin.unit, unitMh: Number(coin.unitMh), rigMh: Number(coin.rigMh) }}
        plans={plans.map((p) => ({
          id: p.id,
          name: p.name,
          sharePct: Number(p.sharePct),
          minutesPerDay: planMinutes(p.sharePct, 1),
          perDayUsd: rigCost ? customerPrice(rigCost.mul(p.sharePct.toString()).div(100), multiplier).toNumber() : null,
        }))}
        maxDays={settings["orders.maxDays"]}
        networkMh={net?.hashrateMh ?? null}
      />
    </Page>
  );
}
