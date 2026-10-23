// Booking customers' minutes onto shared 24-hour rigs (RigDays). Pure, so it is unit-tested
// without a database; the worker jobs apply the results.
//
// A rig day not yet rented (OPEN) is a bucket of minutes. Once rented (ACTIVE) its slots
// run back to back from the rental's start; a booking added later goes after the last slot
// and can only use the time left before the rental ends.

// A slot added to a running rig starts at least this far ahead, so the pool switch lands
// on time.
export const SLOT_LEAD_MS = 2 * 60_000;

export interface DayState {
  id: string;
  status: "OPEN" | "ACTIVE";
  minutes: number;
  bookedMinutes: number;
  endsAt?: Date | null;
  lastSlotEnd?: Date | null; // ACTIVE: when the last booked slot ends
}

export function freeMinutes(day: DayState, now: Date): number {
  const unbooked = Math.max(0, day.minutes - day.bookedMinutes);
  if (day.status === "OPEN") return unbooked;
  if (!day.endsAt) return 0;
  const from = Math.max(now.getTime() + SLOT_LEAD_MS, day.lastSlotEnd?.getTime() ?? 0);
  return Math.max(0, Math.min(unbooked, Math.floor((day.endsAt.getTime() - from) / 60_000)));
}

export interface Piece {
  dayId: string | null; // null = a new rig day
  minutes: number;
}

// Splits an order's minutes over rig days: existing ones first (in the order given), then
// new ones. No piece is shorter than minChunk unless the whole order is, because every
// slot costs a pool switch (about a minute of reconnecting).
export function allocate(needed: number, days: DayState[], now: Date, opts: { minChunk: number; dayMinutes: number }): Piece[] {
  const pieces: Piece[] = [];
  let left = needed;
  const take = (free: number) => {
    let n = Math.min(free, left);
    // Leave the rest either empty or big enough for a slot of its own.
    if (left - n > 0 && left - n < opts.minChunk) n = left - opts.minChunk;
    return n >= Math.min(opts.minChunk, left) ? n : 0;
  };
  for (const d of days) {
    if (left <= 0) break;
    const n = take(freeMinutes(d, now));
    if (n <= 0) continue;
    pieces.push({ dayId: d.id, minutes: n });
    left -= n;
  }
  while (left > 0) {
    const n = take(opts.dayMinutes) || left;
    pieces.push({ dayId: null, minutes: n });
    left -= n;
  }
  return pieces;
}

export interface Timed {
  startsAt: Date;
  endsAt: Date;
}

// Back-to-back times for a rig day's slots (sorted by seq), starting when the rig starts.
export function layout(start: Date, minutes: number[]): Timed[] {
  let t = start.getTime();
  return minutes.map((m) => {
    const slot = { startsAt: new Date(t), endsAt: new Date(t + m * 60_000) };
    t += m * 60_000;
    return slot;
  });
}

// The slot the rig should be mining for right now, or null for the house.
export function slotAt<T extends { startsAt: Date | null; endsAt: Date | null }>(slots: T[], now: Date): T | null {
  return slots.find((s) => s.startsAt && s.endsAt && s.startsAt <= now && now < s.endsAt) ?? null;
}
