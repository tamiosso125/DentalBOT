import { describe, expect, it } from "vitest";
import { dateKey, formatDayHeading, formatTime, groupByDay } from "./format";

describe("format", () => {
  it("uses the clinic timezone for days and times", () => {
    // 23:30 on Monday in São Paulo is already Tuesday in UTC.
    const late = "2026-10-20T02:30:00.000Z";
    expect(dateKey(late)).toBe("2026-10-19");
    expect(formatTime(late)).toBe("23:30");
    expect(formatDayHeading(late)).toBe("Segunda-feira, 19/10");
  });

  it("groups appointments by clinic-local day", () => {
    const rows = [
      { startsAt: "2026-10-19T11:00:00.000Z" },
      { startsAt: "2026-10-20T02:30:00.000Z" },
      { startsAt: "2026-10-20T11:00:00.000Z" },
    ];
    expect(groupByDay(rows).map((g) => [g.day, g.items.length])).toEqual([
      ["2026-10-19", 2],
      ["2026-10-20", 1],
    ]);
  });
});
