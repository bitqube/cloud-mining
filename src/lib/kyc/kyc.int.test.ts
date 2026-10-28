import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrderFromQuote } from "../order-service";
import type { DiditConfig } from "./didit";
import { applyDiditStatus, refreshKyc, startKyc } from "./service";

// Runs against a real Postgres: TEST_DATABASE_URL=postgresql://.../bitqube_test npm run test:int
const url = process.env.TEST_DATABASE_URL;
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : (undefined as unknown as PrismaClient);

const didit: DiditConfig = { apiKey: "k", workflowId: "wf", webhookSecret: "s" };
const setting = (key: string, value: string) => db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
const newUser = () => db.user.create({ data: { email: `u${Date.now()}${Math.random()}@x.io`, passwordHash: "x" } });
const kyc = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id } })).kycStatus;

// A $50 card order for this user.
async function order(userId: string) {
  const quote = await db.quote.create({
    data: {
      userId,
      coinId: "BTQ",
      sharePct: 25,
      days: 1,
      rigMh: 1000,
      rigCostUsd: 66.67,
      hashrateMh: 250,
      hours: 24,
      costUsd: 16.67,
      multiplier: 3,
      multiplierSource: "global",
      priceUsd: 50,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    },
  });
  return createOrderFromQuote(db, {
    quoteId: quote.id,
    userId,
    payoutAddress: "BC2MHYXdTCtNSHhbxoPfra9hi2t2Vng5jY",
    method: "STRIPE",
    btqSharePct: 0,
    btqWallet: null,
  });
}

// Didit's API, faked: session creation and decisions.
function fakeDidit(decision = "In Progress") {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal("fetch", async (u: string, init?: RequestInit) => {
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
    const json = u.endsWith("/v3/session/")
      ? { session_id: `sess${calls.length}`, url: `https://verify.didit.me/session/sess${calls.length}` }
      : { status: decision, vendor_data: (calls[0]?.body as { vendor_data?: string } | null)?.vendor_data };
    return new Response(JSON.stringify(json), { status: u.endsWith("/v3/session/") ? 201 : 200 });
  });
  return calls;
}

describe.skipIf(!url)("KYC (integration)", () => {
  beforeEach(async () => {
    vi.unstubAllGlobals();
    await db.$executeRawUnsafe(
      `TRUNCATE "Email","PasswordReset","OrderEvent","Rental","Slot","RigDay","Payment","Order","Quote","Session","PricingChange","User","Setting" CASCADE`,
    );
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await db?.$disconnect();
  });

  it("lets anyone order while verification is not required", async () => {
    const u = await newUser();
    await expect(order(u.id)).resolves.toMatchObject({ userId: u.id });
  });

  it("blocks orders until the customer is approved, once required", async () => {
    await setting("kyc.required", "true");
    const u = await newUser();
    await expect(order(u.id)).rejects.toThrow(/verify your identity/);
    await db.user.update({ where: { id: u.id }, data: { kycStatus: "DECLINED" } });
    await expect(order(u.id)).rejects.toThrow(/not approved/);
    await db.user.update({ where: { id: u.id }, data: { kycStatus: "APPROVED" } });
    await expect(order(u.id)).resolves.toMatchObject({ userId: u.id });
  });

  it("starts a Didit session carrying the user id and a return link", async () => {
    const calls = fakeDidit();
    const u = await newUser();
    const link = await startKyc(db, didit, u, "https://cloud.test/kyc?next=%2Fbuy");
    expect(link).toBe("https://verify.didit.me/session/sess1");
    expect(calls[0].body).toEqual({ workflow_id: "wf", vendor_data: u.id, callback: "https://cloud.test/kyc?next=%2Fbuy" });
    expect(await db.user.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({ kycStatus: "PENDING", kycSessionId: "sess1" });
  });

  it("applies outcomes only from the user's latest session", async () => {
    fakeDidit();
    const u = await newUser();
    await startKyc(db, didit, u, "https://cloud.test/kyc");
    await startKyc(db, didit, { ...u, kycStatus: "PENDING" }, "https://cloud.test/kyc"); // retried: sess2 is current
    expect(await applyDiditStatus(db, { sessionId: "sess1", userId: u.id, status: "Approved" })).toBeNull();
    expect(await kyc(u.id)).toBe("PENDING");
    expect(await applyDiditStatus(db, { sessionId: "sess2", userId: "someone-else", status: "Approved" })).toBeNull();
    expect(await applyDiditStatus(db, { sessionId: "sess2", userId: u.id, status: "Approved" })).toBe("APPROVED");
    expect(await kyc(u.id)).toBe("APPROVED");
    expect(await applyDiditStatus(db, { sessionId: "sess2", userId: u.id, status: "Approved" })).toBeNull(); // repeat delivery
  });

  it("picks up the result when the customer returns, before the webhook arrives", async () => {
    fakeDidit("In Review");
    const u = await newUser();
    await startKyc(db, didit, u, "https://cloud.test/kyc");
    const pending = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(await refreshKyc(db, didit, pending)).toBe("REVIEW");
    expect(await kyc(u.id)).toBe("REVIEW");
  });

  it("won't start a new check for a user already approved or in review", async () => {
    fakeDidit();
    const u = await newUser();
    await expect(startKyc(db, didit, { ...u, kycStatus: "APPROVED" }, "https://cloud.test/kyc")).rejects.toThrow(/verified/);
    await expect(startKyc(db, didit, { ...u, kycStatus: "REVIEW" }, "https://cloud.test/kyc")).rejects.toThrow(/reviewed/);
  });
});
