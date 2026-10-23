import Decimal from "decimal.js";
import type { Coin, Order, Prisma, PrismaClient, RentalStatus, RigDay, Slot } from "@prisma/client";
import { minutesLabel } from "../lib/coin-format";
import { coinProblems, houseTarget, mrrProfileFor, orderTarget } from "../lib/coins";
import { queueAdminAlert, queueOrderEmail } from "../lib/email/outbox";
import { logEvent } from "../lib/order-service";
import { coinPorts } from "../lib/providers";
import type { ProviderRouter } from "../lib/providers/router";
import type { AllocationState, HashrateProvider, StratumTarget } from "../lib/providers/types";
import { getSettings, type Settings } from "../lib/settings";
import { allocate, layout, slotAt, SLOT_LEAD_MS, type DayState } from "../lib/slots";

// The worker's jobs. Customers buy minutes on shared 24-hour rigs (RigDays):
//
//   PAID order ──book──▶ slots on OPEN rig days ──rent──▶ rig day ACTIVE, slots timed
//   ──switch──▶ rig pointed at each slot's pool in turn, house in between ──finish──▶
//   order COMPLETED / PARTIAL
//
// Status columns are the queue (no Redis); bookings lock the coin row and renting claims
// the rig day, so more than one worker process is safe.

export interface WorkerDeps {
  db: PrismaClient;
  router: ProviderRouter;
  provider: HashrateProvider; // for status polling and pool switches
  log: (msg: string) => void;
}

type Tx = Prisma.TransactionClient;

// An order that ends with less than this share of the ordered MH·hours is PARTIAL.
const COMPLETE_THRESHOLD = 0.9;
// A rig day stuck in RENTING this long belongs to a crashed worker.
const RENT_LEASE_MS = 10 * 60_000;
// Wait between attempts to rent a rig day after a failure.
const RETRY_MS = 10 * 60_000;
// Admins hear about a rig day that keeps failing to rent after this many attempts.
const ALERT_AFTER_ATTEMPTS = 3;
// MRR rigs are lumpy: a basket can be up to 20% bigger than asked for, at a higher cost.
const OVERFILL = 1.2;
// Unpaid orders are cancelled this long after their quote expired.
const UNPAID_GRACE_MS = 2 * 3_600_000;
// A slot this late to start raises an admin alert.
const LATE_SWITCH_MS = 10 * 60_000;
// A rig day is closed this long after its planned end even if MRR still says active.
const END_GRACE_MS = 15 * 60_000;
const STATUS_BATCH = 20;

const STATE_TO_STATUS: Record<AllocationState, RentalStatus> = {
  PENDING: "REQUESTED",
  ACTIVE: "ACTIVE",
  ENDED: "ENDED",
  REFUNDED: "REFUNDED",
  ERROR: "ERROR",
};

const dec = (v: { toString(): string } | null | undefined) => new Decimal(v?.toString() ?? 0);

// ── Booking ──────────────────────────────────────────────────────────────────────────

// The most we pay for a rig day: what a customer was quoted for the whole rig, allowing
// for an overfilled basket and price movement since.
function rigBudget(quotedRigCostUsd: Decimal.Value, settings: Settings): Decimal {
  return new Decimal(quotedRigCostUsd).mul(OVERFILL).mul(1 + settings["pricing.slippagePct"] / 100).toDecimalPlaces(2, Decimal.ROUND_UP);
}

// Books `minutes` of rig time for an order: fills rig days of its coin and rig size that
// have room (rented ones only after their last slot), then opens new ones. Returns the new
// slots; those on rented days already have times.
async function bookMinutes(tx: Tx, order: Order, minutes: number, settings: Settings, now: Date): Promise<Slot[]> {
  // One booking per coin at a time, so two workers can't oversell a rig day.
  await tx.$queryRaw`SELECT id FROM "Coin" WHERE id = ${order.coinId} FOR UPDATE`;
  const days = await tx.rigDay.findMany({
    where: { coinId: order.coinId, status: { in: ["OPEN", "ACTIVE"] }, rigMh: order.rigMh },
    orderBy: { createdAt: "asc" },
    include: { slots: { orderBy: { seq: "desc" }, take: 1 } },
  });
  const state: DayState[] = days.map((d) => ({
    id: d.id,
    status: d.status as "OPEN" | "ACTIVE",
    minutes: d.minutes,
    bookedMinutes: d.bookedMinutes,
    endsAt: d.endsAt,
    lastSlotEnd: d.slots[0]?.endsAt ?? null,
  }));
  const pieces = allocate(minutes, state, now, { minChunk: settings["slots.minSlotMinutes"], dayMinutes: 1440 });
  const budget = rigBudget(order.quotedRigCostUsd.toString(), settings);

  const slots: Slot[] = [];
  for (const piece of pieces) {
    let day: RigDay & { slots: Slot[] };
    if (piece.dayId) {
      day = days.find((d) => d.id === piece.dayId)!;
    } else {
      day = { ...(await tx.rigDay.create({ data: { coinId: order.coinId, rigMh: order.rigMh, maxCostUsd: budget.toString() } })), slots: [] };
    }
    let times: { startsAt: Date; endsAt: Date } | undefined;
    if (day.status === "ACTIVE") {
      const from = new Date(Math.max(now.getTime() + SLOT_LEAD_MS, day.slots[0]?.endsAt?.getTime() ?? 0));
      times = { startsAt: from, endsAt: new Date(from.getTime() + piece.minutes * 60_000) };
    }
    const seq = (day.slots[0]?.seq ?? 0) + 1;
    const slot = await tx.slot.create({ data: { orderId: order.id, rigDayId: day.id, seq, minutes: piece.minutes, ...times } });
    await tx.rigDay.update({
      where: { id: day.id },
      data: {
        bookedMinutes: { increment: piece.minutes },
        // A customer quoted a higher rig price raises what the worker may pay for it.
        ...(day.status === "OPEN" && budget.gt(day.maxCostUsd.toString()) ? { maxCostUsd: budget.toString() } : {}),
      },
    });
    day.slots.unshift(slot);
    slots.push(slot);
  }
  return slots;
}

export async function bookPaidOrders(d: WorkerDeps, now = new Date()): Promise<number> {
  const settings = await getSettings(d.db);
  const orders = await d.db.order.findMany({ where: { status: "PAID" }, orderBy: { createdAt: "asc" } });
  let booked = 0;
  for (const order of orders) {
    await d.db.$transaction(async (tx) => {
      // Re-read under the transaction: another worker may have booked it already.
      const fresh = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
      if (fresh.status !== "PAID") return;
      const slots = await bookMinutes(tx, fresh, fresh.slotMinutes, settings, now);
      await tx.order.update({ where: { id: order.id }, data: { status: "QUEUED" } });
      await logEvent(
        tx,
        order.id,
        "order.booked",
        `Booked ${minutesLabel(fresh.slotMinutes)} of shared rig time` + (slots.length > 1 ? ` in ${slots.length} slots` : ""),
        { slots: slots.map((s) => s.id) },
      );
      const timed = slots.filter((s) => s.startsAt && s.endsAt);
      if (timed.length) await queueOrderEmail(tx, order.id, "order.scheduled", { slots: timed.map((s) => ({ startsAt: s.startsAt!, endsAt: s.endsAt! })) });
    });
    booked++;
  }
  return booked;
}

// ── Renting ──────────────────────────────────────────────────────────────────────────

// Rents OPEN rig days that are due: enough of the day sold, the first customer has waited
// long enough, or an admin asked. Unsold time mines to the coin's house address.
export async function rentRigDays(d: WorkerDeps, now = new Date()): Promise<number> {
  const settings = await getSettings(d.db);
  if (!settings["provisioning.enabled"]) return 0;

  const days = await d.db.rigDay.findMany({
    where: { status: "OPEN", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
    orderBy: { createdAt: "asc" },
    include: { coin: true, slots: { orderBy: { createdAt: "asc" }, take: 1 } },
  });
  let rented = 0;
  for (const day of days) {
    const firstBooking = day.slots[0]?.createdAt;
    if (!firstBooking && !day.forceRent) continue;
    const bookedPct = (day.bookedMinutes / day.minutes) * 100;
    const waited = firstBooking ? now.getTime() - firstBooking.getTime() : 0;
    const due = day.forceRent || bookedPct >= settings["slots.minBookedPct"] || waited >= settings["slots.maxWaitHours"] * 3_600_000;
    if (!due) continue;

    const problems = coinProblems(day.coin);
    if (problems.length) {
      await holdRigDay(d, day, `${day.coin.name} is not set up: ${problems.join(", ")}`, now);
      continue;
    }
    const cap = settings["mrr.maxActiveCostUsd"];
    if (cap > 0) {
      const live = await d.db.rigDay.findMany({ where: { status: { in: ["ACTIVE", "RENTING"] } }, select: { costUsd: true, maxCostUsd: true } });
      const spend = live.reduce((s, x) => s.add(dec(x.costUsd ?? x.maxCostUsd)), new Decimal(0));
      if (spend.add(dec(day.maxCostUsd)).gt(cap)) {
        d.log(`rig day ${day.id} waits: would pass the $${cap} spend cap ($${spend.toFixed(2)} rented now)`);
        continue;
      }
    }
    // Claim it so no other worker rents the same day.
    const claimed = await d.db.rigDay.updateMany({
      where: { id: day.id, status: "OPEN" },
      data: { status: "RENTING", lockedUntil: new Date(now.getTime() + RENT_LEASE_MS) },
    });
    if (claimed.count === 0) continue;
    if (await rentRigDay(d, day, now)) rented++;
  }
  return rented;
}

// Puts a rig day back to OPEN to try again later; tells admins once it keeps failing.
async function holdRigDay(d: WorkerDeps, day: RigDay & { coin: Coin }, reason: string, now: Date) {
  const attempts = day.attempts + 1;
  await d.db.rigDay.update({
    where: { id: day.id },
    data: { status: "OPEN", lockedUntil: null, attempts, failureReason: reason.slice(0, 1000), nextAttemptAt: new Date(now.getTime() + RETRY_MS) },
  });
  d.log(`rig day ${day.id} (${day.coin.id}) not rented: ${reason}`);
  if (attempts === ALERT_AFTER_ATTEMPTS) {
    await queueAdminAlert(
      d.db,
      `${day.coin.name} rig day can't be rented`,
      `A shared ${day.coin.name} rig with ${minutesLabel(day.bookedMinutes)} booked has failed to rent ${attempts} times. Last reason: ${reason}. The worker keeps retrying every ${RETRY_MS / 60_000} minutes; see Admin → Rigs.`,
    );
  }
}

async function rentRigDay(d: WorkerDeps, day: RigDay & { coin: Coin }, now: Date): Promise<boolean> {
  const { coin } = day;
  let result;
  try {
    result = await d.router.fulfil({
      algo: coin.algo,
      hashrateMh: dec(day.rigMh),
      hours: day.minutes / 60,
      orderRef: day.id,
      pool: houseTarget(coin)!,
      maxCostUsd: dec(day.maxCostUsd),
      profileId: mrrProfileFor(coin) ?? undefined,
      ports: coinPorts(coin),
    });
  } catch (e) {
    // Nothing was recorded as rented; safe to retry.
    await holdRigDay(d, day, (e as Error).message, now);
    return false;
  }
  if (result.allocations.length === 0) {
    await holdRigDay(d, day, result.errors.map((e) => e.message).join("; ") || "no rigs available", now);
    return false;
  }

  const endsAt = new Date(now.getTime() + day.minutes * 60_000);
  await d.db.$transaction(async (tx) => {
    for (const a of result.allocations) {
      await tx.rental.create({
        data: {
          rigDayId: day.id,
          provider: a.provider,
          externalId: a.externalId,
          rigId: a.rigId,
          advertisedMh: a.advertisedMh.toString(),
          costUsd: a.costUsd.toDecimalPlaces(2).toString(),
          costAsset: a.costAsset?.amount.toString(),
          costCurrency: a.costAsset?.currency,
          port: a.meta?.port ? Number(a.meta.port) : undefined,
          poolPending: a.meta?.poolPending === "1",
          status: "ACTIVE",
          startsAt: now,
          endsAt,
        },
      });
    }
    const slots = await tx.slot.findMany({ where: { rigDayId: day.id }, orderBy: { seq: "asc" } });
    const times = layout(now, slots.map((s) => s.minutes));
    for (const [i, s] of slots.entries()) await tx.slot.update({ where: { id: s.id }, data: times[i] });
    // Rigs start on the house pool; if a repoint failed, leave target unset so the switch
    // job tries again.
    const repointed = result.allocations.every((a) => a.meta?.poolPending !== "1");
    await tx.rigDay.update({
      where: { id: day.id },
      data: {
        status: "ACTIVE",
        startsAt: now,
        endsAt,
        costUsd: result.costUsd.toDecimalPlaces(2).toString(),
        target: repointed ? "house" : null,
        lockedUntil: null,
        failureReason: null,
      },
    });
    const got = result.allocations.reduce((s, a) => s.add(a.advertisedMh), new Decimal(0));
    for (const orderId of new Set(slots.map((s) => s.orderId))) {
      const mine = slots.flatMap((s, i) => (s.orderId === orderId ? [times[i]] : []));
      await logEvent(tx, orderId, "rig.rented", `Shared ${coin.name} rig rented; your slot starts ${mine[0].startsAt.toISOString()}`, {
        rigDayId: day.id,
      });
      await queueOrderEmail(tx, orderId, "order.scheduled", { slots: mine });
    }
    if (result.shortfallMh.gt(0)) {
      await queueAdminAlert(
        tx,
        `${coin.name} rig day is short by ${result.shortfallMh.toFixed(2)} MH/s`,
        `Only ${got.toFixed(2)} of ${day.rigMh} MH/s could be rented for rig day ${day.id}. Its customers will get proportionally less; their orders may finish as partly delivered.`,
      );
    }
  });
  d.log(`rig day ${day.id} (${coin.id}) rented: ${result.allocations.length} rig(s), $${result.costUsd.toFixed(2)}`);
  return true;
}

// RENTING rig days whose lease ran out: a worker died mid-rental. Rentals may exist on
// MRR that we never recorded, so a human checks before anything is retried.
export async function flagStuckRenting(d: WorkerDeps, now = new Date()): Promise<number> {
  const stuck = await d.db.rigDay.findMany({ where: { status: "RENTING", lockedUntil: { lt: now } }, include: { coin: true } });
  for (const day of stuck) {
    await d.db.$transaction(async (tx) => {
      await tx.rigDay.update({
        where: { id: day.id },
        data: { status: "FAILED", lockedUntil: null, failureReason: "Worker interrupted while renting. Check MRR for rentals of this rig day before retrying." },
      });
      await queueAdminAlert(
        tx,
        `${day.coin.name} rig day was interrupted while renting`,
        `The worker stopped while renting rig day ${day.id}. Check MRR for rentals made around ${day.updatedAt.toISOString()} before pressing Retry in Admin → Rigs.`,
      );
    });
  }
  return stuck.length;
}

// ── Switching ────────────────────────────────────────────────────────────────────────

type DayForSwitch = RigDay & {
  coin: Coin;
  rentals: Array<{ id: string; externalId: string; port: number | null; averageMh: Prisma.Decimal | null; advertisedMh: Prisma.Decimal }>;
  slots: Array<Slot & { order: Order }>;
};

// Live hashrate of a rig day: the latest average MRR reports, or what was advertised.
const rigMhNow = (day: DayForSwitch) => day.rentals.reduce((s, r) => s.add(dec(r.averageMh ?? r.advertisedMh)), new Decimal(0));

async function pointRig(d: WorkerDeps, day: DayForSwitch, target: StratumTarget) {
  // On our own pool each rig keeps the port matching its difficulty.
  const byPort = new Map<number, string[]>();
  for (const r of day.rentals) {
    const port = day.coin.portsByDifficulty && target.host === day.coin.poolHost ? (r.port ?? target.port) : target.port;
    byPort.set(port, [...(byPort.get(port) ?? []), r.externalId]);
  }
  for (const [port, ids] of byPort) await d.provider.setPool(ids, { ...target, port });
}

// Closes a slot and returns the minutes it was short: started late (worker or MRR down)
// or cut off when the rig stopped. Those minutes are booked again.
async function endSlot(tx: Tx, day: DayForSwitch, slot: Slot, at: Date): Promise<number> {
  const started = slot.startedAt ?? at;
  const ranMin = Math.max(0, at.getTime() - started.getTime()) / 60_000;
  await tx.slot.update({
    where: { id: slot.id },
    data: { status: "DONE", endedAt: at, deliveredMhHours: rigMhNow(day).mul(ranMin / 60).toDecimalPlaces(6).toString() },
  });
  return Math.floor(slot.minutes - ranMin);
}

// Books a slot's undelivered minutes onto another rig day. A minute or two is lost to every
// pool switch anyway, so small shortfalls are not worth a new slot.
const REBOOK_MIN_MINUTES = 3;

async function rebook(tx: Tx, coin: Coin, slot: Slot & { order: Order }, minutes: number, why: string, settings: Settings, now: Date) {
  if (minutes < REBOOK_MIN_MINUTES) return;
  const again = await bookMinutes(tx, slot.order, minutes, settings, now);
  await logEvent(tx, slot.orderId, "slot.rebooked", `${why}; ${minutesLabel(minutes)} of your time was booked again`, {
    slots: again.map((x) => x.id),
  });
  await queueAdminAlert(
    tx,
    `${coin.name} slot ran short`,
    `${why}: ${minutesLabel(minutes)} of order ${slot.orderId.slice(-8)}'s time didn't run on rig day ${slot.rigDayId} and was booked onto another rig day. If the rig stopped early, check MRR for a refund on the rental.`,
    slot.orderId,
  );
}

// Points every rented rig at whoever owns the current minute: a customer's slot, or the
// house between and after slots. Runs every tick, so switches land within one tick.
export async function switchSlots(d: WorkerDeps, now = new Date()): Promise<number> {
  const settings = await getSettings(d.db);
  const days = await d.db.rigDay.findMany({
    where: { status: "ACTIVE" },
    include: {
      coin: true,
      rentals: { where: { status: { in: ["REQUESTED", "ACTIVE"] } } },
      slots: { where: { status: { in: ["BOOKED", "MINING"] } }, orderBy: { seq: "asc" }, include: { order: true } },
    },
  });
  let switched = 0;
  for (const day of days as DayForSwitch[]) {
    if (day.rentals.length === 0) continue; // finished or refunded; finishRigDays closes it
    const current = slotAt(day.slots, now);
    const want = current?.id ?? "house";
    const overdue = day.slots.filter((s) => s.status === "MINING" && s.id !== want);
    if (day.target === want && overdue.length === 0) continue;

    if (day.target !== want) {
      const target = current ? orderTarget(day.coin, current.order) : houseTarget(day.coin);
      if (!target) {
        // Don't mark the slot as mining when the rig isn't mining for it.
        d.log(`rig day ${day.id}: no ${current ? "pool for the slot" : "house target"}; rig left where it is`);
        continue;
      } else {
        try {
          await pointRig(d, day, target);
        } catch (e) {
          d.log(`rig day ${day.id}: switch to ${want} failed: ${(e as Error).message}`);
          if (current?.startsAt && now.getTime() - current.startsAt.getTime() > LATE_SWITCH_MS) {
            await alertOnce(d.db, current.orderId, "slot.late", async () => {
              await queueAdminAlert(
                d.db,
                `Slot for order ${current.orderId.slice(-8)} has not started`,
                `MRR keeps refusing to point rig day ${day.id} at the customer's pool: ${(e as Error).message}. Their slot started at ${current.startsAt!.toISOString()}.`,
                current.orderId,
              );
            });
          }
          continue;
        }
      }
    }

    await d.db.$transaction(async (tx) => {
      for (const s of overdue) {
        const short = await endSlot(tx, day, s, now);
        await rebook(tx, day.coin, s, short, "Your slot started late", settings, now);
      }
      if (current && current.status === "BOOKED") {
        await tx.slot.update({ where: { id: current.id }, data: { status: "MINING", startedAt: now } });
        const order = current.order;
        if (order.status === "QUEUED") {
          await tx.order.update({ where: { id: order.id }, data: { status: "ACTIVE", startedAt: order.startedAt ?? now } });
          await queueOrderEmail(tx, order.id, "order.active", { slots: [{ startsAt: now, endsAt: current.endsAt! }] });
        }
        await logEvent(tx, order.id, "slot.started", `Rig mining for you until ${current.endsAt!.toISOString()}`);
      }
      await tx.rigDay.update({ where: { id: day.id }, data: { target: want } });
    });
    switched++;
  }
  return switched;
}

async function alertOnce(db: PrismaClient, orderId: string, type: string, run: () => Promise<void>) {
  if (await db.orderEvent.findFirst({ where: { orderId, type }, select: { id: true } })) return;
  await logEvent(db, orderId, type, "Admins alerted");
  await run();
}

// ── Polling and finishing ────────────────────────────────────────────────────────────

export async function pollActiveRentals(d: WorkerDeps): Promise<number> {
  const rentals = await d.db.rental.findMany({ where: { status: { in: ["REQUESTED", "ACTIVE"] } } });
  for (let i = 0; i < rentals.length; i += STATUS_BATCH) {
    const batch = rentals.slice(i, i + STATUS_BATCH);
    let statuses;
    try {
      statuses = await d.provider.status(batch.map((r) => r.externalId));
    } catch (e) {
      d.log(`status poll failed: ${(e as Error).message}`);
      continue;
    }
    const byId = new Map(statuses.map((s) => [s.externalId, s]));
    for (const r of batch) {
      const s = byId.get(r.externalId);
      if (!s) continue;
      await d.db.rental.update({
        where: { id: r.id },
        data: {
          status: STATE_TO_STATUS[s.state],
          averageMh: s.averageMh?.toDecimalPlaces(6).toString(),
          startsAt: s.startsAt ?? undefined,
          endsAt: s.endsAt ?? undefined,
          lastPolledAt: new Date(),
          raw: JSON.parse(JSON.stringify(s.raw ?? null)),
        },
      });
    }
  }
  return rentals.length;
}

// Closes rig days whose rentals have all ended (or that are well past their end). A slot
// the rig never reached, or the part of one it was cut off from, is booked again.
export async function finishRigDays(d: WorkerDeps, now = new Date()): Promise<number> {
  const settings = await getSettings(d.db);
  const days = await d.db.rigDay.findMany({
    where: { status: "ACTIVE" },
    include: {
      coin: true,
      rentals: true,
      slots: { where: { status: { in: ["BOOKED", "MINING"] } }, orderBy: { seq: "asc" }, include: { order: true } },
    },
  });
  let finished = 0;
  for (const day of days) {
    const running = day.rentals.some((r) => r.status === "REQUESTED" || r.status === "ACTIVE");
    if (running && !(day.endsAt && now.getTime() > day.endsAt.getTime() + END_GRACE_MS)) continue;
    const endedAt = new Date(Math.min(now.getTime(), day.endsAt?.getTime() ?? now.getTime()));
    const live = { ...day, rentals: day.rentals.filter((r) => r.status === "ACTIVE" || r.status === "ENDED") } as DayForSwitch;

    await d.db.$transaction(async (tx) => {
      // Closed first, so the minutes rebooked below can't land back on this rig.
      await tx.rigDay.update({ where: { id: day.id }, data: { status: "ENDED", target: null } });
      for (const s of day.slots) {
        let short = s.minutes;
        if (s.status === "MINING") short = await endSlot(tx, live, s, endedAt);
        else await tx.slot.update({ where: { id: s.id }, data: { status: "MISSED" } });
        await rebook(tx, day.coin, s, short, "The shared rig stopped before your slot finished", settings, now);
      }
    });
    finished++;
  }
  return finished;
}

// QUEUED/ACTIVE orders whose slots have all run: COMPLETED, or PARTIAL if the rigs
// delivered less than 90% of the MH·hours bought.
export async function completeFinishedOrders(d: WorkerDeps): Promise<number> {
  const orders = await d.db.order.findMany({ where: { status: { in: ["QUEUED", "ACTIVE"] } }, include: { slots: true } });
  let done = 0;
  for (const o of orders) {
    if (o.slots.length === 0 || o.slots.some((s) => s.status === "BOOKED" || s.status === "MINING")) continue;
    const delivered = o.slots.reduce((sum, s) => sum.add(dec(s.deliveredMhHours)), new Decimal(0));
    const ordered = dec(o.rigMh).mul(o.slotMinutes).div(60);
    const ratio = ordered.gt(0) ? delivered.div(ordered) : new Decimal(0);
    const status = ratio.gte(COMPLETE_THRESHOLD) ? "COMPLETED" : "PARTIAL";
    const pct = ratio.mul(100).toFixed(1);
    const endsAt = o.slots.reduce<Date | null>((last, s) => (s.endedAt && (!last || s.endedAt > last) ? s.endedAt : last), null);
    await d.db.$transaction(async (tx) => {
      await tx.order.update({ where: { id: o.id }, data: { status, endsAt, deliveredMhHours: delivered.toDecimalPlaces(6).toString() } });
      await logEvent(tx, o.id, `order.${status.toLowerCase()}`, `Finished: delivered ${pct}% of ordered hashrate·hours`);
      if (status === "COMPLETED") {
        await queueOrderEmail(tx, o.id, "order.completed");
      } else {
        await queueOrderEmail(tx, o.id, "order.partial", { deliveredPct: pct });
        await queueAdminAlert(
          tx,
          `Order ${o.id.slice(-8)} finished at ${pct}%`,
          `Delivered ${pct}% of the ordered hashrate·hours. The customer was told support will contact them about a partial refund.`,
          o.id,
        );
      }
    });
    done++;
  }
  return done;
}

// ── Unpaid orders ────────────────────────────────────────────────────────────────────

export async function cancelUnpaidOrders(d: WorkerDeps, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - UNPAID_GRACE_MS);
  const stale = await d.db.order.findMany({
    where: {
      status: "PENDING_PAYMENT",
      quote: { expiresAt: { lt: cutoff } },
      // A BTQ payment window can outlast the quote, and a BTQ payment already seen on the
      // network is left to the BTQ watcher.
      payments: { none: { status: "PENDING", OR: [{ expiresAt: { gte: cutoff } }, { seenAt: { not: null } }] } },
    },
    include: { payments: true },
  });
  for (const o of stale) {
    const paid = o.payments.filter((p) => p.status === "CONFIRMED");
    const paidUsd = paid.reduce((s, p) => s.add(dec(p.amountUsd)), new Decimal(0));
    await d.db.$transaction(async (tx) => {
      await tx.order.update({ where: { id: o.id }, data: { status: "CANCELLED" } });
      await tx.payment.updateMany({ where: { orderId: o.id, status: "PENDING" }, data: { status: "EXPIRED" } });
      await logEvent(tx, o.id, "order.cancelled", paid.length ? `Not fully paid in time ($${paidUsd.toFixed(2)} received)` : "Not paid in time");
      await queueOrderEmail(tx, o.id, "order.cancelled", {
        reason: paid.length
          ? `We received $${paidUsd.toFixed(2)} of $${dec(o.priceUsd).toFixed(2)}, but the rest didn't arrive in time, so this order was cancelled. We'll refund what you paid; our team will be in touch.`
          : "We didn't receive payment in time, so this order was cancelled and you have not been charged. Place a new order any time for a fresh price.",
      });
      if (paid.length) {
        await queueAdminAlert(
          tx,
          `Refund needed: order ${o.id.slice(-8)} was only partly paid`,
          `Order ${o.id} was cancelled with $${paidUsd.toFixed(2)} of $${dec(o.priceUsd).toFixed(2)} paid (${paid.map((p) => p.method).join(", ")}). Refund the customer outside the system.`,
          o.id,
        );
      }
    });
  }
  return stale.length;
}
