import crypto from "node:crypto";
import type { KycStatus } from "@prisma/client";

// Didit identity verification (https://docs.didit.me), hosted flow: we create a session,
// send the customer to Didit's page, and Didit posts the outcome to our webhook. Documents
// and selfies stay with Didit; we keep only the status.

const API = "https://verification.didit.me";
const TIMEOUT_MS = 15_000;
// Webhooks older or newer than this are rejected, so a captured one can't be replayed later.
export const WEBHOOK_TOLERANCE_S = 300;

export interface DiditConfig {
  apiKey: string;
  workflowId: string;
  webhookSecret: string;
}

export function diditConfig(env: NodeJS.ProcessEnv = process.env): DiditConfig | null {
  const apiKey = env.DIDIT_API_KEY?.trim();
  const workflowId = env.DIDIT_WORKFLOW_ID?.trim();
  const webhookSecret = env.DIDIT_WEBHOOK_SECRET?.trim();
  return apiKey && workflowId && webhookSecret ? { apiKey, workflowId, webhookSecret } : null;
}

export class DiditError extends Error {}

async function call<T>(c: DiditConfig, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: { "x-api-key": c.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new DiditError(`Didit unreachable: ${(e as Error).message}`);
  }
  if (!res.ok) throw new DiditError(`Didit answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

// vendor_data carries our user id, so the webhook can find the user.
export async function createSession(c: DiditConfig, userId: string, callbackUrl: string): Promise<{ sessionId: string; url: string }> {
  const s = await call<{ session_id: string; url: string }>(c, "/v3/session/", {
    method: "POST",
    body: JSON.stringify({ workflow_id: c.workflowId, vendor_data: userId, callback: callbackUrl }),
  });
  if (!s.session_id || !s.url) throw new DiditError("Didit returned no session");
  return { sessionId: s.session_id, url: s.url };
}

export async function sessionDecision(c: DiditConfig, sessionId: string): Promise<{ status: string; vendorData: string | null }> {
  const d = await call<{ status: string; vendor_data?: string | null }>(c, `/v3/session/${encodeURIComponent(sessionId)}/decision/`);
  return { status: d.status, vendorData: d.vendor_data ?? null };
}

// Didit's session statuses (case-sensitive) → ours. Unknown ones are ignored.
export function kycStatusFrom(diditStatus: string): KycStatus | null {
  switch (diditStatus) {
    case "Approved":
      return "APPROVED";
    case "Declined":
      return "DECLINED";
    case "In Review":
      return "REVIEW";
    case "Not Started":
    case "In Progress":
    case "Resubmitted":
    case "Awaiting User":
      return "PENDING";
    case "Abandoned":
    case "Expired":
    case "Kyc Expired":
      return "NONE";
    default:
      return null;
  }
}

// Didit's canonical JSON for X-Signature-V2: keys sorted recursively, compact, unicode unescaped.
// Built by hand because JSON.stringify keeps insertion order (and puts integer-like keys first).
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

const hmac = (secret: string, data: string) => crypto.createHmac("sha256", secret).update(data, "utf8").digest("hex");

function sameHex(expected: string, given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given.trim().toLowerCase(), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// True if the webhook is fresh and signed with our secret. Accepts X-Signature-V2 (over the
// canonical JSON) or X-Signature (over the raw body), and the -Previous variants Didit sends
// for a day after the secret is rotated.
export function verifyWebhook(rawBody: string, headers: Headers, secret: string, nowS = Date.now() / 1000): boolean {
  const ts = Number(headers.get("x-timestamp"));
  if (!Number.isFinite(ts) || Math.abs(nowS - ts) > WEBHOOK_TOLERANCE_S) return false;
  let canonical: string;
  try {
    canonical = canonicalJson(JSON.parse(rawBody));
  } catch {
    return false;
  }
  const v2 = hmac(secret, canonical);
  const raw = hmac(secret, rawBody);
  return (
    sameHex(v2, headers.get("x-signature-v2")) ||
    sameHex(v2, headers.get("x-signature-v2-previous")) ||
    sameHex(raw, headers.get("x-signature")) ||
    sameHex(raw, headers.get("x-signature-previous"))
  );
}
