import { notFound } from "next/navigation";
import { ButtonLink, Card, Page } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { btqUnavailableReason } from "@/lib/btq/payments";
import { btqWalletFromEnv } from "@/lib/btq/wallet";
import { coinHashrate, minutesLabel } from "@/lib/coin-format";
import { addressHint } from "@/lib/coins";
import { db } from "@/lib/db";
import { usd } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { CheckoutForm } from "./checkout-form";

export const dynamic = "force-dynamic";

export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const quote = await db.quote.findUnique({ where: { id }, include: { coin: true, order: { select: { id: true } } } });
  if (!quote || quote.userId !== user.id) notFound();
  const { coin } = quote;
  const expired = quote.expiresAt <= new Date();
  const settings = await getSettings(db);
  const minutes = Math.round((1440 * Number(quote.sharePct) * quote.days) / 100);

  // The largest BTQ share this price allows: the admin's max %, and no more than
  // btq.maxOrderUsd in BTQ. 0 when BTQ is off.
  const btqOff = btqUnavailableReason(btqWalletFromEnv(), settings);
  const price = Number(quote.priceUsd);
  const byUsd = price > 0 ? Math.floor((Number(settings["btq.maxOrderUsd"]) / price) * 100) : 0;
  const maxShare = btqOff ? 0 : Math.max(0, Math.min(settings["btq.maxSharePct"], byUsd, 100));
  const saved = (user.payoutAddresses as Record<string, string> | null)?.[coin.id] ?? (coin.id === "BTQ" ? (user.btqAddress ?? "") : "");

  return (
    <Page title="Your price">
      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <Card title="Order">
          <dl className="space-y-3 text-sm">
            <Row label="Coin" value={`${coin.name} (${coin.id})`} />
            <Row label="Hashrate" value={coinHashrate(quote.hashrateMh, { unit: coin.unit, unitMh: Number(coin.unitMh) })} />
            <Row label="Duration" value={`${quote.days} day${quote.days === 1 ? "" : "s"}`} />
            <Row
              label="Your rig time"
              value={`${minutesLabel(minutes)} at ${coinHashrate(quote.rigMh, { unit: coin.unit, unitMh: Number(coin.unitMh) })}`}
            />
            <div className="border-t border-line pt-3">
              <Row label="Total" value={<span className="text-2xl font-bold text-accent">{usd(quote.priceUsd)}</span>} />
            </div>
          </dl>
          <p className="mt-4 text-xs leading-relaxed text-muted">
            Your rig time runs as one or more slots once the shared rig is rented. We email the times.
          </p>
        </Card>
        <Card title="Checkout">
          {quote.order ? (
            <ButtonLink href={`/orders/${quote.order.id}`}>View your order</ButtonLink>
          ) : expired ? (
            <div className="space-y-4">
              <p className="text-sm text-muted">This price has expired. Market prices move, so please get a fresh one.</p>
              <ButtonLink href={`/buy?coin=${coin.id}`}>Get a new price</ButtonLink>
            </div>
          ) : (
            <CheckoutForm
              quoteId={quote.id}
              expiresAt={quote.expiresAt.toISOString()}
              coin={{ id: coin.id, name: coin.name, hint: addressHint(coin.id), ownPoolAllowed: coin.ownPoolAllowed }}
              defaultAddress={saved}
              priceUsd={price}
              btq={{ maxShare, rateUsd: Number(settings["btq.usdRate"]), off: btqOff }}
            />
          )}
        </Card>
      </div>
    </Page>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="num text-right font-medium">{value}</dd>
    </div>
  );
}
