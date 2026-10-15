import { describe, expect, it } from "vitest";
import { availableSlots } from "./slots.js";
import { zonedToUtc } from "./time.js";

const TZ = "America/Sao_Paulo";
// 2026-10-19 is a Monday.
const monday = { weekday: 1, startMinute: 8 * 60, endMinute: 12 * 60 };

describe("availableSlots", () => {
  it("converts clinic time to UTC (São Paulo is UTC-3)", () => {
    expect(zonedToUtc("2026-10-19", 8 * 60, TZ).toISOString()).toBe("2026-10-19T11:00:00.000Z");
  });

  it("lists slots inside working hours that fit the procedure", () => {
    const slots = availableSlots({
      date: "2026-10-19",
      timeZone: TZ,
      workingHours: [monday],
      busy: [],
      durationMinutes: 60,
    });
    expect(slots.map((s) => s.toISOString())).toEqual([
      "2026-10-19T11:00:00.000Z",
      "2026-10-19T11:30:00.000Z",
      "2026-10-19T12:00:00.000Z",
      "2026-10-19T12:30:00.000Z",
      "2026-10-19T13:00:00.000Z",
      "2026-10-19T13:30:00.000Z",
      "2026-10-19T14:00:00.000Z",
    ]);
  });

  it("skips busy intervals and short notice", () => {
    const slots = availableSlots({
      date: "2026-10-19",
      timeZone: TZ,
      workingHours: [monday],
      busy: [
        {
          startsAt: zonedToUtc("2026-10-19", 9 * 60, TZ),
          endsAt: zonedToUtc("2026-10-19", 10 * 60, TZ),
        },
      ],
      durationMinutes: 60,
      now: zonedToUtc("2026-10-19", 7 * 60 + 30, TZ),
      minNoticeMinutes: 60,
    });
    expect(slots.map((s) => s.toISOString())).toEqual([
      "2026-10-19T13:00:00.000Z",
      "2026-10-19T13:30:00.000Z",
      "2026-10-19T14:00:00.000Z",
    ]);
  });

  it("returns nothing on days off", () => {
    expect(
      availableSlots({
        date: "2026-10-18",
        timeZone: TZ,
        workingHours: [monday],
        busy: [],
        durationMinutes: 30,
      }),
    ).toEqual([]);
  });
});
