import type { KycStatus, PrismaClient, User } from "@prisma/client";
import type { Settings } from "../settings";
import { createSession, kycStatusFrom, sessionDecision, type DiditConfig } from "./didit";

// Identity verification: with kyc.required on, a customer must be APPROVED before placing
// any order. The status changes when Didit's webhook arrives, when the customer comes back
// from Didit (we ask Didit directly, in case the webhook is slow), or when an admin sets it.

export const KYC_MESSAGE: Record<KycStatus, string> = {
  NONE: "Please verify your identity before your first order. It takes about two minutes.",
  PENDING: "Your identity check isn't finished yet. Continue it to place an order.",
  REVIEW: "Your identity check is being reviewed, usually within a day. Check back here for the result.",
  APPROVED: "Your identity is verified.",
  DECLINED: "Your identity check was not approved. You can try again, or contact us if you think this is a mistake.",
};

export class KycRequiredError extends Error {}

// Where to go after verifying: only paths on this site, so the link can't send customers elsewhere.
export const safeNext = (next: unknown) => (typeof next === "string" && /^\/(?!\/)[\w\-/?=&%.]*$/.test(next) ? next : "/buy");

// Why this user can't order yet, or null if they can.
export function kycBlockReason(settings: Settings, user: Pick<User, "kycStatus">): string | null {
  if (!settings["kyc.required"] || user.kycStatus === "APPROVED") return null;
  return KYC_MESSAGE[user.kycStatus];
}

// Starts (or restarts) a check and returns the Didit page to send the customer to.
export async function startKyc(db: PrismaClient, c: DiditConfig, user: Pick<User, "id" | "kycStatus">, callbackUrl: string): Promise<string> {
  if (user.kycStatus === "APPROVED" || user.kycStatus === "REVIEW") throw new KycRequiredError(KYC_MESSAGE[user.kycStatus]);
  const s = await createSession(c, user.id, callbackUrl);
  await db.user.update({ where: { id: user.id }, data: { kycSessionId: s.sessionId, kycStatus: "PENDING", kycUpdatedAt: new Date() } });
  return s.url;
}

// Applies a Didit status to the user who owns the session. Only the user's latest session
// counts, so a late webhook from an older attempt can't change the outcome. Returns the new
// status, or null if nothing changed.
export async function applyDiditStatus(
  db: PrismaClient,
  update: { sessionId: string; userId: string | null; status: string },
  now = new Date(),
): Promise<KycStatus | null> {
  const status = kycStatusFrom(update.status);
  if (!status || !update.userId) return null;
  const res = await db.user.updateMany({
    where: { id: update.userId, kycSessionId: update.sessionId, kycStatus: { not: status } },
    data: { kycStatus: status, kycUpdatedAt: now },
  });
  return res.count > 0 ? status : null;
}

// Called when the customer returns from Didit: asks Didit for the latest status.
export async function refreshKyc(db: PrismaClient, c: DiditConfig, user: Pick<User, "id" | "kycSessionId" | "kycStatus">) {
  if (!user.kycSessionId || user.kycStatus === "APPROVED") return null;
  const d = await sessionDecision(c, user.kycSessionId);
  return applyDiditStatus(db, { sessionId: user.kycSessionId, userId: d.vendorData ?? user.id, status: d.status });
}
