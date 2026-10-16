import { describe, expect, it } from "vitest";
import { clinicalEntrySchema } from "./clinical-record.js";

describe("clinical entry", () => {
  it("fills defaults and turns blank notes into null", () => {
    expect(
      clinicalEntrySchema.parse({ performed: "  Restauração em resina  ", notes: " " }),
    ).toEqual({
      performed: "Restauração em resina",
      teeth: [],
      notes: null,
    });
  });

  it("requires what was done", () => {
    expect(clinicalEntrySchema.safeParse({ performed: "   " }).success).toBe(false);
    expect(clinicalEntrySchema.safeParse({}).success).toBe(false);
  });

  it("accepts FDI tooth numbers only", () => {
    const ok = clinicalEntrySchema.safeParse({ performed: "x", teeth: ["11", "48", "55", "85"] });
    expect(ok.success).toBe(true);
    for (const bad of ["19", "49", "56", "00", "3", "361", "ab"])
      expect(clinicalEntrySchema.safeParse({ performed: "x", teeth: [bad] }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(clinicalEntrySchema.safeParse({ performed: "x", diagnosis: "cárie" }).success).toBe(
      false,
    );
  });
});
