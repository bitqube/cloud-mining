import Link from "next/link";
import type { EmailStatus } from "@prisma/client";
import { Alert, Button, Card, Input, Page, Table, Td, cx } from "@/components/ui";
import { Flash } from "@/components/flash";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { smtpSummary } from "@/lib/email/mailer";
import { adminRecipients } from "@/lib/email/outbox";
import { dateTime } from "@/lib/format";
import { retryEmailAction, sendTestEmailAction } from "../actions";

export const dynamic = "force-dynamic";

const TONE: Record<EmailStatus, string> = {
  PENDING: "bg-warn/15 text-warn",
  SENT: "bg-ok/15 text-ok",
  FAILED: "bg-bad/15 text-bad",
};

export default async function AdminEmails({ searchParams }: { searchParams: Promise<{ status?: string; ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const admin = await requireAdmin();
  const status = (["PENDING", "SENT", "FAILED"] as const).find((s) => s === sp.status);
  const smtp = smtpSummary();
  const [emails, counts, alertTo] = await Promise.all([
    db.email.findMany({ where: status ? { status } : {}, orderBy: { createdAt: "desc" }, take: 100 }),
    db.email.groupBy({ by: ["status"], _count: true }),
    adminRecipients(db),
  ]);
  const count = (s: EmailStatus) => counts.find((c) => c.status === s)?._count ?? 0;

  return (
    <Page title="Emails">
      <Flash sp={sp} />
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card title="SMTP">
          {!smtp.passwordSet && (
            <div className="mb-4">
              <Alert tone="warn">SMTP_PASSWORD is empty in .env. Emails are queued but not sent until it is set and the app and worker are restarted.</Alert>
            </div>
          )}
          <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted">Server</dt>
            <dd className="font-mono">{smtp.host ? `${smtp.host}:${smtp.port}` : "not set"}</dd>
            <dt className="text-muted">Username</dt>
            <dd className="font-mono break-all">{smtp.user ?? "not set"}</dd>
            <dt className="text-muted">From</dt>
            <dd className="font-mono break-all">{smtp.from ?? "not set"}</dd>
            <dt className="text-muted">Password</dt>
            <dd>{smtp.passwordSet ? "set" : "missing"}</dd>
            <dt className="text-muted">Admin alerts to</dt>
            <dd className="break-all">{alertTo.join(", ") || "nobody"}</dd>
          </dl>
        </Card>
        <Card title="Send a test email">
          <form action={sendTestEmailAction} className="space-y-3">
            <Input name="to" type="email" defaultValue={admin.email} />
            <Button variant="secondary">Send test</Button>
            <p className="text-xs text-muted">Sent immediately, so a wrong password or blocked login shows up here as an error.</p>
            <p className="text-xs">
              <Link href="/admin/emails/preview" className="text-accent">Preview all email templates &rsaquo;</Link>
            </p>
          </form>
        </Card>
      </div>

      <div className="mb-4 flex gap-2 text-sm">
        {[undefined, "PENDING", "SENT", "FAILED"].map((s) => (
          <Link
            key={s ?? "all"}
            href={s ? `/admin/emails?status=${s}` : "/admin/emails"}
            className={cx("rounded-md px-3 py-1.5", status === s ? "bg-panel-2 text-text" : "text-muted hover:text-text")}
          >
            {s ? `${s.toLowerCase()} (${count(s as EmailStatus)})` : "all"}
          </Link>
        ))}
      </div>
      <Table head={["Created", "To", "Subject", "Status", ""]} empty="No emails yet.">
        {emails.map((e) => (
          <tr key={e.id}>
            <Td className="text-xs text-muted whitespace-nowrap">{dateTime(e.createdAt)}</Td>
            <Td className="break-all">{e.to}</Td>
            <Td>
              <div>{e.subject}</div>
              <div className="text-xs text-muted">
                {e.kind}
                {e.orderId && (
                  <>
                    {" · "}
                    <Link href={`/admin/orders/${e.orderId}`} className="text-accent">order {e.orderId.slice(-8)}</Link>
                  </>
                )}
              </div>
              {e.lastError && <div className="mt-1 text-xs text-bad">{e.lastError}</div>}
            </Td>
            <Td>
              <span className={cx("inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold", TONE[e.status])}>{e.status.toLowerCase()}</span>
              <div className="mt-1 text-xs text-muted">
                {e.status === "SENT" ? dateTime(e.sentAt) : e.attempts ? `${e.attempts} attempt${e.attempts > 1 ? "s" : ""}` : ""}
              </div>
            </Td>
            <Td>
              {e.status === "FAILED" && e.kind !== "test" && (
                <form action={retryEmailAction}>
                  <input type="hidden" name="emailId" value={e.id} />
                  <button className="text-accent">Retry</button>
                </form>
              )}
            </Td>
          </tr>
        ))}
      </Table>
    </Page>
  );
}
