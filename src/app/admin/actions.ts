"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { OrderStatus, Role } from "@prisma/client";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { smtpSender } from "@/lib/email/mailer";
import { retryEmail } from "@/lib/email/outbox";
import { testEmail } from "@/lib/email/templates";
import Decimal from "decimal.js";
import { coinProblems, houseTarget, isValidPayoutAddress } from "@/lib/coins";
import { sharedMrrApi } from "@/lib/providers";
import { adminSetStatus, markPaid } from "@/lib/order-service";
import { setGlobalMultiplier, setUserMultiplier } from "@/lib/pricing-service";
import { isSettingKey, setSetting } from "@/lib/settings";

// Every admin mutation: check the role, run, then come back to the page with a message.
async function run(back: string, fn: (adminId: string, adminEmail: string) => Promise<string | void>): Promise<never> {
  const admin = await requireAdmin();
  let msg: string;
  let ok = true;
  try {
    msg = (await fn(admin.id, admin.email)) || "Saved.";
  } catch (e) {
    ok = false;
    msg = (e as Error).message;
  }
  revalidatePath("/admin", "layout");
  redirect(`${back}?${ok ? "ok" : "error"}=${encodeURIComponent(msg)}`);
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

export async function setGlobalMultiplierAction(form: FormData) {
  await run("/admin/pricing", async (adminId) => {
    const m = await setGlobalMultiplier(db, adminId, str(form, "multiplier"), str(form, "note") || undefined);
    return `Global markup set to ${m}×. New quotes use it; existing quotes and orders keep their price.`;
  });
}

export async function setUserMultiplierAction(form: FormData) {
  const back = str(form, "back") || "/admin/users";
  await run(back, async (adminId) => {
    const raw = str(form, "multiplier");
    const m = await setUserMultiplier(db, adminId, str(form, "userId"), raw === "" ? null : raw, str(form, "note") || undefined);
    return m === null ? "Override removed; this customer now uses the global markup." : `Customer markup set to ${m}×.`;
  });
}

export async function setSettingAction(form: FormData) {
  await run(str(form, "back") || "/admin/settings", async () => {
    const key = str(form, "key");
    if (!isSettingKey(key)) throw new Error(`unknown setting ${key}`);
    await setSetting(db, key, str(form, "value"));
    return `${key} updated.`;
  });
}

export async function setProvisioningAction(form: FormData) {
  const on = str(form, "on") === "true";
  await run(str(form, "back") || "/admin", async () => {
    await setSetting(db, "provisioning.enabled", String(on));
    return on ? "Provisioning ON: paid orders will rent rigs on MRR with real funds." : "Provisioning OFF: paid orders will wait.";
  });
}

export async function markPaidAction(form: FormData) {
  const orderId = str(form, "orderId");
  await run(`/admin/orders/${orderId}`, async (_id, adminEmail) => {
    await markPaid(db, orderId, { method: "MANUAL", by: adminEmail, providerRef: str(form, "reference") || undefined });
    return "Marked as paid. The worker will start it when provisioning is on.";
  });
}

// For a BTQ payment the watcher did not accept on its own: late, short, or to a cancelled
// order. Uses what the node has actually received; the admin decides it is good enough.
export async function acceptBtqPaymentAction(form: FormData) {
  const orderId = str(form, "orderId");
  await run(`/admin/orders/${orderId}`, async (_id, adminEmail) => {
    const p = await db.payment.findFirst({ where: { orderId, method: "BTQ", receivedAsset: { gt: 0 } }, orderBy: { createdAt: "desc" } });
    if (!p?.providerRef) throw new Error("No BTQ has been received for this order.");
    await markPaid(db, orderId, { method: "BTQ", providerRef: p.providerRef, txid: p.txid ?? undefined, by: adminEmail });
    return `Accepted ${p.receivedAsset} BTQ as payment. The worker will start it when provisioning is on.`;
  });
}

export async function setOrderStatusAction(form: FormData) {
  const orderId = str(form, "orderId");
  await run(`/admin/orders/${orderId}`, async (_id, adminEmail) => {
    await adminSetStatus(db, orderId, str(form, "status") as OrderStatus, adminEmail, str(form, "note") || undefined);
  });
}

export async function setUserRoleAction(form: FormData) {
  await run("/admin/users", async (adminId) => {
    const userId = str(form, "userId");
    if (userId === adminId) throw new Error("You can't change your own role.");
    const role = str(form, "role") as Role;
    if (role !== "ADMIN" && role !== "CUSTOMER") throw new Error("bad role");
    await db.user.update({ where: { id: userId }, data: { role } });
    return `Role changed to ${role}.`;
  });
}

export async function setSuspendedAction(form: FormData) {
  await run("/admin/users", async (adminId) => {
    const userId = str(form, "userId");
    if (userId === adminId) throw new Error("You can't suspend yourself.");
    const suspended = str(form, "suspended") === "true";
    await db.$transaction([
      db.user.update({ where: { id: userId }, data: { suspended } }),
      ...(suspended ? [db.session.deleteMany({ where: { userId } })] : []),
    ]);
    return suspended ? "User suspended and logged out." : "User reactivated.";
  });
}

// Manual override, e.g. for a customer Didit couldn't verify but an admin has checked by hand.
export async function setKycStatusAction(form: FormData) {
  await run("/admin/users", async (_adminId, adminEmail) => {
    const userId = str(form, "userId");
    const status = str(form, "status");
    if (status !== "APPROVED" && status !== "NONE") throw new Error("unknown KYC status");
    const u = await db.user.update({ where: { id: userId }, data: { kycStatus: status, kycUpdatedAt: new Date() } });
    console.log(`kyc: ${adminEmail} set ${u.email} to ${status}`);
    return status === "APPROVED" ? `${u.email} marked as verified.` : `${u.email} must verify again.`;
  });
}

export async function savePackageAction(form: FormData) {
  await run("/admin/packages", async () => {
    const name = str(form, "name");
    const share = Number(str(form, "sharePct"));
    if (!name || !(share > 0 && share <= 100)) throw new Error("A name and a share between 0 and 100% are required.");
    await db.plan.create({ data: { name, sharePct: share, sortOrder: Number(str(form, "sortOrder") || 0) } });
    return `Package "${name}" added.`;
  });
}

export async function togglePackageAction(form: FormData) {
  await run("/admin/packages", async () => {
    const id = str(form, "id");
    const plan = await db.plan.findUniqueOrThrow({ where: { id } });
    await db.plan.update({ where: { id }, data: { active: !plan.active } });
    return plan.active ? "Package hidden." : "Package shown.";
  });
}

// Sends straight away (not via the queue) so SMTP errors show up on the page.
export async function sendTestEmailAction(form: FormData) {
  await run("/admin/emails", async (_id, adminEmail) => {
    const to = str(form, "to") || adminEmail;
    const send = smtpSender();
    if (!send) throw new Error("SMTP is not configured: set SMTP_SERVER, SMTP_USERNAME and SMTP_PASSWORD in .env and restart.");
    const content = testEmail();
    try {
      await send({ to, ...content });
    } catch (e) {
      await db.email.create({
        data: { to, kind: "test", ...content, status: "FAILED", attempts: 1, lastError: (e as Error).message.slice(0, 500) },
      });
      throw new Error(`SMTP error: ${(e as Error).message}`);
    }
    await db.email.create({ data: { to, kind: "test", ...content, status: "SENT", attempts: 1, sentAt: new Date() } });
    return `Test email sent to ${to}.`;
  });
}

export async function retryEmailAction(form: FormData) {
  await run("/admin/emails", async () => {
    await retryEmail(db, str(form, "emailId"));
    return "Queued again; the worker sends it on its next tick.";
  });
}

// Coins: everything about where a coin's rigs mine. Rig size is typed in the coin's unit.
export async function saveCoinAction(form: FormData) {
  const id = str(form, "id");
  await run(`/admin/coins/${id}`, async () => {
    const coin = await db.coin.findUniqueOrThrow({ where: { id } });
    const rigUnits = Number(str(form, "rig"));
    if (!(rigUnits > 0)) throw new Error(`Rig size must be more than 0 ${coin.unit}.`);
    const port = str(form, "poolPort");
    const house = str(form, "houseAddress");
    if (house && !isValidPayoutAddress(id, house)) throw new Error(`The house address is not a valid ${coin.name} address.`);
    const poolUser = str(form, "poolUser") || "{address}.{worker}";
    if (!poolUser.includes("{address}")) throw new Error("The pool username must contain {address}.");
    const data = {
      name: str(form, "name") || coin.name,
      rigMh: new Decimal(rigUnits).mul(coin.unitMh.toString()).toString(),
      poolHost: str(form, "poolHost").replace(/^stratum\+(tcp|ssl):\/\//i, "") || null,
      poolPort: port ? Number(port) : null,
      poolUser,
      poolPass: str(form, "poolPass") || "x",
      ownPoolAllowed: form.get("ownPoolAllowed") === "on",
      houseAddress: house || null,
      mrrProfileId: str(form, "mrrProfileId") || null,
      sortOrder: Number(str(form, "sortOrder") || coin.sortOrder),
    };
    if (data.poolPort !== null && !(Number.isInteger(data.poolPort) && data.poolPort > 0 && data.poolPort < 65536))
      throw new Error("Pool port must be 1–65535.");
    const updated = await db.coin.update({ where: { id }, data });
    const problems = coinProblems(updated);
    return problems.length && updated.enabled ? `Saved. Rigs can't be rented yet: ${problems.join(", ")}.` : "Saved.";
  });
}

export async function toggleCoinAction(form: FormData) {
  const id = str(form, "id");
  await run(str(form, "back") || "/admin/coins", async () => {
    const coin = await db.coin.findUniqueOrThrow({ where: { id } });
    if (!coin.enabled) {
      const problems = coinProblems(coin);
      if (problems.length) throw new Error(`${coin.name} can't go on sale yet: ${problems.join(", ")}.`);
    }
    await db.coin.update({ where: { id }, data: { enabled: !coin.enabled } });
    return coin.enabled ? `${coin.name} is off sale. Booked orders still run.` : `${coin.name} is on sale.`;
  });
}

// MRR connects to the pool and tries to subscribe, authorise and get work, using the
// house address as the username. Nothing is rented.
export async function testCoinPoolAction(form: FormData) {
  const id = str(form, "id");
  await run(`/admin/coins/${id}`, async () => {
    const coin = await db.coin.findUniqueOrThrow({ where: { id } });
    const target = houseTarget(coin);
    if (!target) throw new Error("Set the pool and the house address first.");
    const res = await sharedMrrApi().testPool({ ...target, type: coin.algo });
    const rows = res.result ?? [];
    const good = rows.filter((r) => r.connection && r.auth !== false && r.work !== false);
    if (good.length === 0) throw new Error(`Pool test failed: ${rows.map((r) => `${r.source}: ${r.error || "no work"}`).join("; ") || "no result"}.`);
    return `Pool OK from ${good.map((r) => r.source).join(", ")}${good[0].diff ? ` (difficulty ${good[0].diff})` : ""}.`;
  });
}

// Creates an MRR pool pointing at the house address and a profile using it, then saves
// the profile on the coin. Rentals start on this profile; the worker repoints them.
export async function createCoinProfileAction(form: FormData) {
  const id = str(form, "id");
  await run(`/admin/coins/${id}`, async () => {
    const coin = await db.coin.findUniqueOrThrow({ where: { id } });
    const target = houseTarget(coin);
    if (!target) throw new Error("Set the pool and the house address first.");
    const api = sharedMrrApi();
    const pool = await api.createPool({ ...target, type: coin.algo, name: `BitQube ${coin.id} house` });
    const profile = await api.createProfile(`BitQube ${coin.id}`, coin.algo);
    await api.setProfilePool(profile.pid, 0, pool.id);
    await db.coin.update({ where: { id }, data: { mrrProfileId: String(profile.pid) } });
    return `MRR profile ${profile.pid} created for ${coin.algo} and saved.`;
  });
}

// Rig days: rent one now whatever is booked, or put a failed one back in the queue.
export async function forceRentRigDayAction(form: FormData) {
  const id = str(form, "id");
  await run(`/admin/rigs/${id}`, async () => {
    const day = await db.rigDay.findUniqueOrThrow({ where: { id } });
    if (day.status !== "OPEN") throw new Error("Only an open rig day can be rented early.");
    await db.rigDay.update({ where: { id }, data: { forceRent: true, nextAttemptAt: null } });
    return "Marked to rent now. The worker rents it on its next tick if provisioning is on.";
  });
}

export async function retryRigDayAction(form: FormData) {
  const id = str(form, "id");
  await run(`/admin/rigs/${id}`, async () => {
    const day = await db.rigDay.findUniqueOrThrow({ where: { id }, include: { rentals: true } });
    if (day.status !== "FAILED") throw new Error("Only a failed rig day can be retried.");
    if (day.rentals.length) throw new Error("This rig day has rentals on MRR. Check them there before retrying.");
    await db.rigDay.update({ where: { id }, data: { status: "OPEN", attempts: 0, nextAttemptAt: null, failureReason: null, lockedUntil: null } });
    return "Back in the queue.";
  });
}
