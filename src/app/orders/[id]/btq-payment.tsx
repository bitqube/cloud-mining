import Decimal from "decimal.js";
import QRCode from "qrcode";
import type { Payment } from "@prisma/client";
import { Alert, Card } from "@/components/ui";
import { isPaidInFull, paymentUri } from "@/lib/btq/payments";
import { dateTime } from "@/lib/format";
import { AutoRefresh, CopyButton, Countdown } from "./btq-live";

// What a customer paying in BTQ sees until the order is paid: where to send, how much,
// how long they have, and live progress once the node sees the payment.
export async function BtqPaymentCard({ payment, minConf }: { payment: Payment; minConf: number }) {
  const address = payment.providerRef!;
  const due = new Decimal(payment.amountAsset!.toString());
  const got = new Decimal(payment.receivedAsset?.toString() ?? 0);
  const conf = payment.confirmations ?? 0;
  const windowOpen = !payment.expiresAt || payment.expiresAt > new Date();
  const seenInTime = payment.seenAt && (!payment.expiresAt || payment.seenAt <= payment.expiresAt);
  const full = isPaidInFull(got, due);
  const uri = paymentUri(address, due.minus(got).gt(0) && got.gt(0) ? due.minus(got) : due);
  const qr = await QRCode.toString(uri, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#05070b", light: "#ffffff" },
  });

  let status;
  if (full && seenInTime) {
    const pct = Math.min(100, Math.round((conf / minConf) * 100));
    status = (
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            <span className="live-dot" /> Payment received, confirming
          </span>
          <span className="num font-semibold">
            {Math.min(conf, minConf)} / {minConf}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-panel-2">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.max(pct, 4)}%` }} />
        </div>
        <p className="text-xs text-muted">BitQube blocks arrive about once a minute. Mining starts as soon as this reaches {minConf}.</p>
      </div>
    );
  } else if (got.gt(0) && !seenInTime) {
    status = (
      <Alert tone="warn">
        We received {got.toFixed()} BTQ after the payment window closed. Our team will contact you to start the order or refund it.
      </Alert>
    );
  } else if (got.gt(0) && windowOpen) {
    status = (
      <Alert tone="warn">
        Received {got.toFixed()} of {due.toFixed()} BTQ. Send the remaining <b>{due.minus(got).toFixed()} BTQ</b> to the same address before
        the window closes.
      </Alert>
    );
  } else if (got.gt(0)) {
    status = (
      <Alert tone="warn">
        Only {got.toFixed()} of {due.toFixed()} BTQ arrived before the window closed. Our team will contact you.
      </Alert>
    );
  } else if (windowOpen) {
    status = (
      <p className="flex items-center gap-2 text-sm text-muted">
        <span className="live-dot" /> Waiting for your payment. This page updates by itself.
      </p>
    );
  } else {
    status = (
      <Alert tone="warn">
        The payment window has closed. If you already sent BTQ, it will show here once it reaches the network; otherwise place a new order.
      </Alert>
    );
  }

  const waiting = windowOpen || (full && seenInTime);
  return (
    <Card title="Pay with BTQ">
      {waiting && <AutoRefresh />}
      <div className="flex flex-col gap-5 sm:flex-row">
        <div
          className="mx-auto w-44 shrink-0 overflow-hidden rounded-2xl bg-white p-2 sm:mx-0 [&_svg]:h-auto [&_svg]:w-full"
          role="img"
          aria-label="QR code with the payment address and amount"
          dangerouslySetInnerHTML={{ __html: qr }}
        />
        <div className="min-w-0 flex-1 space-y-4">
          <div>
            <div className="text-xs text-muted">Send exactly</div>
            <div className="flex items-center gap-3">
              <span className="font-display text-2xl font-bold text-accent num">{due.toFixed()} BTQ</span>
              <CopyButton value={due.toFixed()} />
            </div>
          </div>
          <div>
            <div className="text-xs text-muted">To this address (this order only)</div>
            <div className="flex items-start gap-3">
              <span className="font-mono text-sm break-all">{address}</span>
              <CopyButton value={address} />
            </div>
          </div>
          {windowOpen && payment.expiresAt && !(full && seenInTime) && (
            <div className="text-sm text-muted">
              Time left to send: <Countdown until={payment.expiresAt.toISOString()} />
              <span className="text-xs"> (until {dateTime(payment.expiresAt)})</span>
            </div>
          )}
        </div>
      </div>
      <div className="mt-5 border-t border-line pt-4">{status}</div>
    </Card>
  );
}
