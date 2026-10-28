import { db } from "@/lib/db";
import { diditConfig, verifyWebhook } from "@/lib/kyc/didit";
import { applyDiditStatus } from "@/lib/kyc/service";

// Didit posts verification outcomes here (destination set in the Didit console, event
// status.updated). Unsigned, stale or unknown requests get 401; anything we accepted but
// don't act on gets 200 so Didit doesn't retry it.
export async function POST(req: Request) {
  const c = diditConfig();
  if (!c) return new Response("KYC is not configured", { status: 503 });

  const raw = await req.text();
  if (!verifyWebhook(raw, req.headers, c.webhookSecret)) return new Response("invalid signature", { status: 401 });

  const body = JSON.parse(raw) as { webhook_type?: string; session_id?: string; status?: string; vendor_data?: string | null };
  if (body.webhook_type !== "status.updated" || !body.session_id || !body.status) return new Response("ignored");

  const changed = await applyDiditStatus(db, { sessionId: body.session_id, userId: body.vendor_data ?? null, status: body.status });
  if (changed) console.log(`kyc: user ${body.vendor_data} is now ${changed} (session ${body.session_id})`);
  return new Response("ok");
}
