import { describe, expect, it } from "vitest";
import { canMarkAttendance, noShowRate } from "./attendance";

describe("noShowRate", () => {
  it("is null before anything is marked", () => {
    expect(noShowRate({ attended: 0, noShow: 0 })).toBeNull();
  });

  it("rounds the share of missed appointments", () => {
    expect(noShowRate({ attended: 2, noShow: 1 })).toBe(33);
    expect(noShowRate({ attended: 0, noShow: 4 })).toBe(100);
  });
});

describe("canMarkAttendance", () => {
  const now = new Date("2026-10-20T13:00:00Z");

  it("waits for the start time and skips cancelled appointments", () => {
    expect(canMarkAttendance({ startsAt: "2026-10-20T14:00:00Z", status: "CONFIRMED" }, now)).toBe(
      false,
    );
    expect(canMarkAttendance({ startsAt: "2026-10-20T12:00:00Z", status: "CONFIRMED" }, now)).toBe(
      true,
    );
    expect(canMarkAttendance({ startsAt: "2026-10-20T12:00:00Z", status: "NO_SHOW" }, now)).toBe(
      true,
    );
    expect(canMarkAttendance({ startsAt: "2026-10-20T12:00:00Z", status: "CANCELLED" }, now)).toBe(
      false,
    );
  });
});
