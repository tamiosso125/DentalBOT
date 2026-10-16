import { describe, expect, it } from "vitest";
import { delta, isMonth, monthLabel, noShowShare, share, shiftMonth } from "./report";

describe("month summary helpers", () => {
  it("names and moves months", () => {
    expect(monthLabel("2026-10")).toBe("outubro de 2026");
    expect(monthLabel("2027-03")).toBe("março de 2027");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });

  it("accepts only YYYY-MM", () => {
    expect(isMonth("2026-10")).toBe(true);
    expect(isMonth(undefined)).toBe(false);
    expect(isMonth("2026-13")).toBe(false);
    expect(isMonth("2026-1")).toBe(false);
  });

  it("compares with the month before", () => {
    expect(delta(5, 2)).toBe("+3");
    expect(delta(2, 5)).toBe("-3");
    expect(delta(4, 4)).toBe("=");
  });

  it("computes shares without dividing by zero", () => {
    expect(share(1, 3)).toBe(33);
    expect(share(0, 0)).toBeNull();
    expect(noShowShare({ attended: 9, noShow: 1 })).toBe(10);
    expect(noShowShare({ attended: 0, noShow: 0 })).toBeNull();
  });
});
