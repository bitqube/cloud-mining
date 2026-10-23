"use client";

import { useActionState, useEffect, useState } from "react";
import { Alert, Button, Field, Input, cx } from "@/components/ui";
import { placeOrderAction } from "../../actions";

type CoinInfo = { id: string; name: string; hint: string; ownPoolAllowed: boolean };
type Btq = { maxShare: number; rateUsd: number; off: string | null };

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const METHODS = [
  { id: "STRIPE", label: "Card", hint: "Visa, Mastercard, UPI via Stripe" },
  { id: "USDT", label: "USDT", hint: "TRC-20" },
];

export function CheckoutForm({
  quoteId,
  expiresAt,
  coin,
  defaultAddress,
  priceUsd,
  btq,
}: {
  quoteId: string;
  expiresAt: string;
  coin: CoinInfo;
  defaultAddress: string;
  priceUsd: number;
  btq: Btq;
}) {
  const [state, action, pending] = useActionState(placeOrderAction, undefined);
  const [method, setMethod] = useState("STRIPE");
  const [address, setAddress] = useState(defaultAddress);
  const [ownPool, setOwnPool] = useState(false);
  const [share, setShare] = useState(0);
  const left = useCountdown(expiresAt);

  // Same rounding as the server: the BTQ part rounds up to the cent, BTQ up to 0.01.
  const btqUsd = share >= 100 ? priceUsd : Math.ceil((priceUsd * share) / 100 * 100) / 100;
  const restUsd = Math.max(0, Math.round((priceUsd - btqUsd) * 100) / 100);
  const btqCoins = btq.rateUsd > 0 ? Math.ceil((btqUsd / btq.rateUsd) * 100) / 100 : 0;
  const steps = [0, 25, 50, 75, 100].filter((s) => s <= btq.maxShare);
  if (btq.maxShare > 0 && !steps.includes(btq.maxShare)) steps.push(btq.maxShare);

  return (
    <form action={action} className="space-y-6">
      {state?.error && <Alert tone="error">{state.error}</Alert>}
      <input type="hidden" name="quoteId" value={quoteId} />
      <input type="hidden" name="method" value={restUsd > 0 ? method : ""} />
      <input type="hidden" name="btqShare" value={share} />
      <p className={cx("text-sm", left <= 60 ? "text-warn" : "text-muted")}>
        {left > 0
          ? `Price held for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`
          : "This price has expired. Reload for a new one."}
      </p>

      {coin.ownPoolAllowed && (
        <div className="glass flex gap-1 rounded-2xl p-1 text-sm">
          {[
            [false, "Our pool"],
            [true, "My own pool"],
          ].map(([v, label]) => (
            <button
              type="button"
              key={String(v)}
              onClick={() => setOwnPool(v as boolean)}
              className={cx("flex-1 rounded-xl px-3 py-2 transition", ownPool === v ? "bg-accent text-accent-ink" : "text-muted hover:text-text")}
            >
              {label as string}
            </button>
          ))}
        </div>
      )}

      {ownPool ? (
        <div className="space-y-4">
          <input type="hidden" name="useOwnPool" value="on" />
          <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
            <Field label="Pool host" hint="e.g. rvn.2miners.com">
              <Input name="poolHost" required spellCheck={false} className="font-mono" />
            </Field>
            <Field label="Port">
              <Input name="poolPort" type="number" min={1} max={65535} required className="num" />
            </Field>
          </div>
          <Field label="Username / worker" hint="Usually your address, optionally .worker">
            <Input name="poolUser" required spellCheck={false} className="font-mono" />
          </Field>
          <Field label="Password" hint="Leave empty for x">
            <Input name="poolPass" spellCheck={false} className="font-mono" />
          </Field>
          <p className="text-xs text-muted">Make sure the pool supports {coin.name} and the rented rig&apos;s difficulty. Rig time lost to a wrong pool can&apos;t be refunded.</p>
        </div>
      ) : (
        <Field label={`Your ${coin.name} payout address`} hint={`The pool pays mined coins here (${coin.hint}). Double-check it: payouts can't be reversed.`}>
          <Input
            name="payoutAddress"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            required
            spellCheck={false}
            className="font-mono"
          />
        </Field>
      )}

      <div>
        <div className="mb-2 flex items-end justify-between text-sm">
          <span className="font-medium">Pay in BTQ</span>
          <span className="num text-muted">{btq.maxShare > 0 ? `up to ${btq.maxShare}%` : ""}</span>
        </div>
        {btq.maxShare > 0 ? (
          <>
            <div className="glass flex gap-1 rounded-2xl p-1">
              {steps.map((s) => (
                <button
                  type="button"
                  key={s}
                  onClick={() => setShare(s)}
                  className={cx("num flex-1 rounded-xl px-2 py-2 text-xs transition", share === s ? "bg-accent text-accent-ink" : "text-muted hover:text-text")}
                >
                  {s}%
                </button>
              ))}
            </div>
            {share > 0 && (
              <p className="num mt-2 text-xs text-muted">
                {usd(btqUsd)} = {btqCoins.toLocaleString("en-US", { maximumFractionDigits: 2 })} BTQ, sent to an address shown after you place the order.
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-muted">{btq.off ?? "This order is too large to pay any part in BTQ."}</p>
        )}
      </div>

      {restUsd > 0 && (
        <div>
          <div className="mb-2 flex items-end justify-between text-sm">
            <span className="font-medium">{share > 0 ? "Pay the rest with" : "Pay with"}</span>
            <span className="num">{usd(restUsd)}</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {METHODS.map((m) => (
              <button
                type="button"
                key={m.id}
                onClick={() => setMethod(m.id)}
                className={cx(
                  "rounded-lg border px-3 py-3 text-left text-sm",
                  method === m.id ? "border-accent bg-accent/10" : "border-line bg-panel-2 hover:border-muted",
                )}
              >
                <div className="font-semibold">{m.label}</div>
                <div className="text-xs text-muted">{m.hint}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      <Button className="w-full" disabled={pending || left <= 0}>
        {pending ? "Placing order…" : `Place order · ${usd(priceUsd)}`}
      </Button>
    </form>
  );
}

function useCountdown(iso: string): number {
  const end = new Date(iso).getTime();
  const [left, setLeft] = useState(() => Math.max(0, Math.round((end - Date.now()) / 1000)));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, Math.round((end - Date.now()) / 1000))), 1000);
    return () => clearInterval(t);
  }, [end]);
  return left;
}
