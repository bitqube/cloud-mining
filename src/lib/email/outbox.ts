import type { Email, Prisma, PrismaClient } from "@prisma/client";
import type { SendFn } from "./mailer";
import { adminAlertEmail, orderEmail, type OrderEmailExtra, type OrderEmailKind } from "./templates";

// Emails are written to the Email table, usually inside the transaction that makes the
// change they announce, and the worker delivers them. A failed send is retried with
// backoff; nothing is lost if SMTP is down or not configured yet.

type Db = PrismaClient | Prisma.TransactionClient;

const BATCH = 20;
// Minutes to wait before attempt n+1; after the last one the email is marked FAILED.
const BACKOFF_MIN = [1, 5, 15, 60, 180];
const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;
// Queued mail older than this is dropped rather than sent late (e.g. SMTP was off for days).
const MAX_AGE_MS = 24 * 3_600_000;
// A claimed email is invisible to other workers for this long.
const LEASE_MS = 5 * 60_000;

export async function queueEmail(
  db: Db,
  msg: { to: string; subject: string; text: string; html: string; kind: string; orderId?: string },
): Promise<Email> {
  return db.email.create({ data: msg });
}

export async function queueOrderEmail(db: Db, orderId: string, kind: OrderEmailKind, extra?: OrderEmailExtra) {
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { user: { select: { email: true } }, coin: true } });
  return queueEmail(db, { to: order.user.email, kind, orderId, ...orderEmail(kind, order, extra) });
}

// ADMIN_ALERT_EMAIL (comma-separated) if set, otherwise every admin account.
export async function adminRecipients(db: Db): Promise<string[]> {
  const configured = (process.env.ADMIN_ALERT_EMAIL ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (configured.length) return configured;
  const admins = await db.user.findMany({ where: { role: "ADMIN", suspended: false }, select: { email: true } });
  return admins.map((a) => a.email);
}

export async function queueAdminAlert(db: Db, subject: string, message: string, orderId?: string) {
  const content = adminAlertEmail(subject, message, orderId);
  for (const to of await adminRecipients(db)) {
    await queueEmail(db, { to, kind: "admin.alert", orderId, ...content });
  }
}

// Timestamps are stored as UTC without a time zone, hence now() AT TIME ZONE 'UTC'.
async function claim(db: PrismaClient, limit: number, id?: string): Promise<Email[]> {
  return db.$queryRaw<Email[]>`
    UPDATE "Email" SET "sendAfter" = (now() AT TIME ZONE 'UTC') + ${`${LEASE_MS / 1000} seconds`}::interval
    WHERE id IN (
      SELECT id FROM "Email"
      WHERE status = 'PENDING' AND "sendAfter" <= (now() AT TIME ZONE 'UTC') AND (${id ?? null}::text IS NULL OR id = ${id ?? null}::text)
      ORDER BY "createdAt" LIMIT ${limit} FOR UPDATE SKIP LOCKED
    )
    RETURNING *`;
}

async function deliver(db: PrismaClient, send: SendFn, e: Email): Promise<boolean> {
  try {
    await send({ to: e.to, subject: e.subject, text: e.text, html: e.html });
    await db.email.update({ where: { id: e.id }, data: { status: "SENT", sentAt: new Date(), attempts: e.attempts + 1, lastError: null } });
    return true;
  } catch (err) {
    const attempts = e.attempts + 1;
    const giveUp = attempts >= MAX_ATTEMPTS;
    await db.email.update({
      where: { id: e.id },
      data: {
        attempts,
        lastError: (err as Error).message.slice(0, 500),
        status: giveUp ? "FAILED" : "PENDING",
        sendAfter: new Date(Date.now() + (BACKOFF_MIN[attempts - 1] ?? 0) * 60_000),
      },
    });
    return false;
  }
}

// Worker job. Returns the number of emails sent.
export async function deliverPendingEmails(db: PrismaClient, send: SendFn | null, log: (m: string) => void = () => {}): Promise<number> {
  const expired = await db.email.updateMany({
    where: { status: "PENDING", createdAt: { lt: new Date(Date.now() - MAX_AGE_MS) } },
    data: { status: "FAILED", lastError: "not sent within 24 hours; dropped" },
  });
  if (expired.count) log(`email: dropped ${expired.count} stale message(s)`);
  if (!send) return 0; // SMTP not configured: leave everything queued

  let sent = 0;
  for (const e of await claim(db, BATCH)) {
    if (await deliver(db, send, e)) sent++;
    else log(`email to ${e.to} (${e.kind}) failed, attempt ${e.attempts + 1}`);
  }
  return sent;
}

// Sends one queued email right away (password resets shouldn't wait for the worker tick).
// If it fails, it stays queued and the worker retries it.
export async function sendQueuedNow(db: PrismaClient, send: SendFn | null, id: string): Promise<boolean> {
  if (!send) return false;
  const [e] = await claim(db, 1, id);
  return e ? deliver(db, send, e) : false;
}

export async function retryEmail(db: PrismaClient, id: string) {
  await db.email.update({ where: { id }, data: { status: "PENDING", attempts: 0, sendAfter: new Date(), lastError: null, createdAt: new Date() } });
}
