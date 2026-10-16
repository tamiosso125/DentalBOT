import { describe, expect, it } from "vitest";
import { payerOf, reportQuerySchema, shiftMonth } from "./monthly-report.js";

describe("monthly report helpers", () => {
  it("moves across years", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-10", 0)).toBe("2026-10");
  });

  it("trusts the insurer's answer before the patient's current plan", () => {
    expect(payerOf({ authorization: null, coveredByPlan: true })).toBe("INSURANCE");
    expect(payerOf({ authorization: null, coveredByPlan: false })).toBe("PRIVATE");
    expect(payerOf({ authorization: { status: "DENIED" }, coveredByPlan: true })).toBe("PRIVATE");
    expect(payerOf({ authorization: { status: "AUTHORIZED" }, coveredByPlan: false })).toBe(
      "INSURANCE",
    );
  });

  it("accepts only YYYY-MM months", () => {
    expect(reportQuerySchema.safeParse({ mes: "2026-10" }).success).toBe(true);
    expect(reportQuerySchema.safeParse({}).success).toBe(true);
    for (const mes of ["2026-00", "2026-13", "26-10", "2026-1"])
      expect(reportQuerySchema.safeParse({ mes }).success, mes).toBe(false);
  });
});
