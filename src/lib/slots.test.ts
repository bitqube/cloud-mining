import { describe, expect, it } from "vitest";
import { planMinutes, minutesLabel } from "./coin-format";
import { allocate, freeMinutes, layout, slotAt, SLOT_LEAD_MS } from "./slots";

const now = new Date("2026-10-23T10:00:00Z");
const at = (min: number) => new Date(now.getTime() + min * 60_000);
const opts = { minChunk: 30, dayMinutes: 1440 };

describe("plan minutes", () => {
  it("matches the flyer: 10% = 2h24m, 25% = 6h, 50% = 12h a day", () => {
    expect(minutesLabel(planMinutes(10, 1))).toBe("2h 24m");
    expect(minutesLabel(planMinutes(25, 1))).toBe("6h");
    expect(minutesLabel(planMinutes(50, 1))).toBe("12h");
    expect(planMinutes(10, 7)).toBe(1008);
  });
});

describe("freeMinutes", () => {
  it("an open day is whatever is unbooked", () => {
    expect(freeMinutes({ id: "a", status: "OPEN", minutes: 1440, bookedMinutes: 1000 }, now)).toBe(440);
  });

  it("a running day only has the time left after its last slot, and never the past", () => {
    const day = { id: "a", status: "ACTIVE" as const, minutes: 1440, bookedMinutes: 600, endsAt: at(300) };
    expect(freeMinutes({ ...day, lastSlotEnd: at(100) }, now)).toBe(200);
    // Last slot already over: starts after the lead time.
    expect(freeMinutes({ ...day, lastSlotEnd: at(-50) }, now)).toBe(300 - SLOT_LEAD_MS / 60_000);
    // Booked minutes still cap it.
    expect(freeMinutes({ ...day, bookedMinutes: 1400, lastSlotEnd: null }, now)).toBe(40);
  });
});

describe("allocate", () => {
  it("fills existing days first, then opens new ones", () => {
    const days = [{ id: "a", status: "OPEN" as const, minutes: 1440, bookedMinutes: 1300 }];
    expect(allocate(720, days, now, opts)).toEqual([
      { dayId: "a", minutes: 140 },
      { dayId: null, minutes: 580 },
    ]);
  });

  it("skips gaps shorter than a slot", () => {
    const days = [{ id: "a", status: "OPEN" as const, minutes: 1440, bookedMinutes: 1420 }];
    expect(allocate(144, days, now, opts)).toEqual([{ dayId: null, minutes: 144 }]);
  });

  it("never leaves a tail too short for its own slot", () => {
    const days = [{ id: "a", status: "OPEN" as const, minutes: 1440, bookedMinutes: 1300 }];
    // 140 free, 150 needed: taking 140 would leave 10, so it takes 120 and leaves 30.
    expect(allocate(150, days, now, opts)).toEqual([
      { dayId: "a", minutes: 120 },
      { dayId: null, minutes: 30 },
    ]);
  });

  it("an order smaller than a slot still fits as one piece", () => {
    expect(allocate(20, [], now, opts)).toEqual([{ dayId: null, minutes: 20 }]);
  });

  it("orders longer than a day span several new days", () => {
    const pieces = allocate(3000, [], now, opts);
    expect(pieces.map((p) => p.minutes)).toEqual([1440, 1440, 120]);
    expect(pieces.every((p) => p.dayId === null)).toBe(true);
  });
});

describe("layout and slotAt", () => {
  it("runs slots back to back and leaves the rest to the house", () => {
    const slots = layout(now, [144, 360]).map((t, i) => ({ id: String(i), ...t }));
    expect(slots[1].startsAt).toEqual(at(144));
    expect(slots[1].endsAt).toEqual(at(504));
    expect(slotAt(slots, at(0))?.id).toBe("0");
    expect(slotAt(slots, at(144))?.id).toBe("1");
    expect(slotAt(slots, at(504))).toBeNull();
  });
});
