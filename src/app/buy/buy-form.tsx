"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Qube } from "@/components/qube";
import { Alert, Button, Field, Input, cx } from "@/components/ui";
import { coinHashrate, minutesLabel } from "@/lib/coin-format";
import { quoteAction } from "./actions";

type CoinChip = { id: string; name: string; algo: string };
type CoinInfo = { id: string; name: string; unit: string; unitMh: number; rigMh: number };
type PlanCard = { id: string; name: string; sharePct: number; minutesPerDay: number; perDayUsd: number | null };

const DAYS = [1, 3, 7, 14, 30];
// BitQube estimate, same as the pool.bitqube.org calculator: while the rig mines for you
// your share is rig / (network + rig) of one 3.5 BTQ block (year-1 reward) a minute,
// minus the 1% pool fee.
const BLOCK_REWARD = 3.5;
const POOL_FEE = 0.01;

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export function BuyForm({
  coins,
  coin,
  plans,
  maxDays,
  networkMh,
}: {
  coins: CoinChip[];
  coin: CoinInfo;
  plans: PlanCard[];
  maxDays: number;
  networkMh: number | null;
}) {
  const [state, action, pending] = useActionState(quoteAction, undefined);
  const [planId, setPlanId] = useState(plans[0].id);
  const [days, setDays] = useState("1");

  const plan = plans.find((p) => p.id === planId) ?? plans[0];
  const daysNum = Math.min(maxDays, Math.max(0, Math.floor(Number(days) || 0)));
  const rig = coinHashrate(coin.rigMh, coin);
  const rate = (p: PlanCard) => coinHashrate((coin.rigMh * p.sharePct) / 100, coin);
  const totalMinutes = plan.minutesPerDay * daysNum;
  const estUsd = plan.perDayUsd !== null && daysNum ? plan.perDayUsd * daysNum : null;
  const btqEst =
    coin.id === "BTQ" && networkMh && daysNum
      ? (coin.rigMh / (networkMh + coin.rigMh)) * totalMinutes * BLOCK_REWARD * (1 - POOL_FEE)
      : null;

  return (
    <form action={action} className="grid gap-6 pb-24 lg:grid-cols-[1.5fr_1fr] lg:pb-0">
      <section className="glass edge-glow rise min-w-0 space-y-8 rounded-3xl p-6 sm:p-8">
        {state?.error && <Alert tone="error">{state.error}</Alert>}
        <input type="hidden" name="coin" value={coin.id} />
        <input type="hidden" name="planId" value={plan.id} />

        <div>
          <div className="mb-3 text-xs font-medium tracking-[0.14em] text-muted uppercase">Coin</div>
          <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {coins.map((c) => {
              const on = c.id === coin.id;
              return (
                <Link
                  key={c.id}
                  href={`/buy?coin=${c.id}`}
                  scroll={false}
                  className={cx(
                    "shrink-0 rounded-2xl border px-4 py-2.5 transition duration-300",
                    on ? "border-accent bg-accent/10 shadow-[0_0_24px_-8px_var(--accent)]" : "border-line bg-bg/40 hover:border-line-strong",
                  )}
                >
                  <div className="num text-sm font-semibold">{c.id}</div>
                  <div className="text-[11px] whitespace-nowrap text-muted">{c.name}</div>
                </Link>
              );
            })}
          </div>
        </div>

        <div>
          <div className="mb-3 text-xs font-medium tracking-[0.14em] text-muted uppercase">Plan</div>
          <div className="grid gap-2 sm:grid-cols-3 sm:gap-3">
            {plans.map((p) => {
              const on = p.id === plan.id;
              return (
                <button
                  type="button"
                  key={p.id}
                  onClick={() => setPlanId(p.id)}
                  aria-pressed={on}
                  className={cx(
                    "group relative min-w-0 rounded-2xl border px-4 py-4 text-left transition duration-300",
                    on
                      ? "border-accent bg-accent/10 shadow-[0_0_30px_-8px_var(--accent)]"
                      : "border-line bg-bg/40 hover:-translate-y-0.5 hover:border-line-strong",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium tracking-[0.14em] text-muted uppercase">{p.name}</span>
                    <span className={cx("h-2 w-2 rotate-45 transition", on ? "bg-accent" : "bg-line-strong group-hover:bg-accent/60")} />
                  </div>
                  <div className="num mt-2 text-xl font-semibold sm:text-2xl">{rate(p)}</div>
                  <div className="mt-1 text-xs text-muted">
                    {rig} for {minutesLabel(p.minutesPerDay)} a day
                  </div>
                  <div className="num mt-3 text-sm">{p.perDayUsd !== null ? `≈ ${usd(p.perDayUsd)} / day` : " "}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="mb-3 flex items-end justify-between">
            <span className="text-xs font-medium tracking-[0.14em] text-muted uppercase">Days</span>
            <span className="num text-3xl">
              {daysNum || "—"}
              <span className="ml-1.5 text-base text-muted">day{daysNum === 1 ? "" : "s"}</span>
            </span>
          </div>
          <div className="glass flex flex-wrap gap-1 rounded-2xl p-1">
            {DAYS.filter((n) => n <= maxDays).map((n) => (
              <button
                type="button"
                key={n}
                onClick={() => setDays(String(n))}
                className={cx(
                  "num flex-1 rounded-xl px-3 py-2 text-xs transition",
                  days === String(n) ? "bg-accent text-accent-ink shadow-[0_0_20px_-6px_var(--accent)]" : "text-muted hover:text-text",
                )}
              >
                {n}d
              </button>
            ))}
          </div>
          <div className="mt-4 max-w-48">
            <Field label="Or exactly" hint={`1–${maxDays} days`}>
              <Input name="days" type="number" min={1} max={maxDays} value={days} onChange={(e) => setDays(e.target.value)} required className="num" />
            </Field>
          </div>
        </div>

        <div className="border-t border-line pt-6 text-sm leading-relaxed text-muted">
          <p>
            <span className="font-medium text-text">How it works.</span> We rent one full-power {coin.name} rig ({rig}) for 24 hours and
            share it in time slots. {rate(plan)} for a day is the same total work as {rig} for {minutesLabel(plan.minutesPerDay)}, so that
            is your slot: the pool shows about {rig} for you during it, and nothing outside it.
          </p>
          <p className="mt-3">
            The rig is rented once enough of its day is sold, usually within hours; we email your slot times. Rewards are not guaranteed,
            and rented hashrate often earns less than it costs. Spend only what you can afford to lose.
          </p>
        </div>
      </section>

      <aside className="glass edge-glow rise relative flex flex-col overflow-hidden rounded-3xl p-6 sm:p-8" style={{ "--d": "120ms" } as React.CSSProperties}>
        <div className="text-xs font-medium tracking-[0.14em] text-muted uppercase">Your contract</div>
        <div className="relative -mx-6 my-2 h-48 sm:-mx-8">
          <Qube className="absolute inset-0" />
        </div>
        <dl className="space-y-3 text-sm">
          <Row k="Coin" v={`${coin.name} (${coin.id})`} />
          <Row k="Hashrate" v={rate(plan)} />
          <Row k="Duration" v={daysNum ? `${daysNum} day${daysNum === 1 ? "" : "s"}` : "—"} />
          <Row k="Your rig time" v={daysNum ? `${minutesLabel(totalMinutes)} at ${rig}` : "—"} />
          <Row k="Estimated price" v={estUsd !== null ? `≈ ${usd(estUsd)}` : "on next step"} />
        </dl>

        {btqEst !== null && (
          <div className="mt-6 rounded-2xl border border-line bg-bg/40 p-4">
            <div className="flex items-end justify-between">
              <span className="text-xs text-muted">Est. BTQ for this order</span>
              <span className="num text-xl">{btqEst.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              At today&apos;s network hashrate. Difficulty retargets every block, so a full-power rig earns somewhat less than this.
            </p>
          </div>
        )}

        <div className="mt-auto hidden pt-6 lg:block">
          <Button disabled={pending || !daysNum} className="w-full py-3">
            {pending ? "Scanning the market…" : "Get live price"}
          </Button>
          <p className="mt-3 text-center text-[11px] text-muted">Price locks for 15 minutes. No charge until you pay.</p>
        </div>
      </aside>

      {/* Phones: the summary and the button stay in reach at the bottom of the screen. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/80 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-xl lg:hidden">
        <div className="mx-auto flex max-w-xl items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="num truncate text-sm">
              {coin.id} · {rate(plan)} · {daysNum || "—"}d
            </div>
            <div className="text-[11px] text-muted">{estUsd !== null ? `≈ ${usd(estUsd)}` : "Price locks for 15 min"}</div>
          </div>
          <Button disabled={pending || !daysNum} className="shrink-0 px-6 py-3">
            {pending ? "Scanning…" : "Get live price"}
          </Button>
        </div>
      </div>
    </form>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line pb-3 last:border-0">
      <dt className="shrink-0 text-muted">{k}</dt>
      <dd className="num text-right">{v}</dd>
    </div>
  );
}
