import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { OutgoingEmail } from "./mailer";
import { deliverPendingEmails, queueEmail, retryEmail, sendQueuedNow } from "./outbox";

// TEST_DATABASE_URL=postgresql://.../bitqube_test npm run test:int
const url = process.env.TEST_DATABASE_URL;
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : (undefined as unknown as PrismaClient);

const msg = (to = "a@x.io") => ({ to, subject: "s", text: "t", html: "<p>t</p>", kind: "test" });

function recorder(failWith?: string) {
  const sent: OutgoingEmail[] = [];
  const send = async (m: OutgoingEmail) => {
    if (failWith) throw new Error(failWith);
    sent.push(m);
  };
  return { sent, send };
}

describe.skipIf(!url)("email outbox (integration)", () => {
  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE "Email" CASCADE`);
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  it("sends queued emails once", async () => {
    await queueEmail(db, msg("a@x.io"));
    await queueEmail(db, msg("b@x.io"));
    const r = recorder();
    expect(await deliverPendingEmails(db, r.send)).toBe(2);
    expect(await deliverPendingEmails(db, r.send)).toBe(0);
    expect(r.sent.map((m) => m.to).sort()).toEqual(["a@x.io", "b@x.io"]);
    expect(await db.email.count({ where: { status: "SENT" } })).toBe(2);
  });

  it("keeps emails queued while SMTP is not configured", async () => {
    await queueEmail(db, msg());
    expect(await deliverPendingEmails(db, null)).toBe(0);
    expect((await db.email.findFirstOrThrow()).status).toBe("PENDING");
  });

  it("backs off after a failure and gives up after the last attempt", async () => {
    const e = await queueEmail(db, msg());
    await deliverPendingEmails(db, recorder("535 bad credentials").send);
    let row = await db.email.findUniqueOrThrow({ where: { id: e.id } });
    expect(row).toMatchObject({ status: "PENDING", attempts: 1, lastError: "535 bad credentials" });
    expect(row.sendAfter.getTime()).toBeGreaterThan(Date.now() + 50_000); // waits ~1 min

    // Not due yet, so nothing is attempted.
    await deliverPendingEmails(db, recorder("x").send);
    expect((await db.email.findUniqueOrThrow({ where: { id: e.id } })).attempts).toBe(1);

    for (let i = 0; i < 5; i++) {
      await db.email.update({ where: { id: e.id }, data: { sendAfter: new Date(0) } });
      await deliverPendingEmails(db, recorder("still down").send);
    }
    row = await db.email.findUniqueOrThrow({ where: { id: e.id } });
    expect(row).toMatchObject({ status: "FAILED", attempts: 6 });

    await retryEmail(db, e.id);
    const r = recorder();
    expect(await deliverPendingEmails(db, r.send)).toBe(1);
  });

  it("drops mail that sat in the queue for over a day", async () => {
    await db.email.create({ data: { ...msg(), createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    const r = recorder();
    expect(await deliverPendingEmails(db, r.send)).toBe(0);
    expect(r.sent).toHaveLength(0);
    expect((await db.email.findFirstOrThrow()).status).toBe("FAILED");
  });

  it("sendQueuedNow sends just that email", async () => {
    const a = await queueEmail(db, msg("a@x.io"));
    await queueEmail(db, msg("b@x.io"));
    const r = recorder();
    expect(await sendQueuedNow(db, r.send, a.id)).toBe(true);
    expect(r.sent.map((m) => m.to)).toEqual(["a@x.io"]);
    expect(await db.email.count({ where: { status: "PENDING" } })).toBe(1);
  });
});
