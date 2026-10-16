import { describe, expect, it } from "vitest";
import { medicalAlerts, medicalHistorySchema } from "./medical-history.js";

describe("medical history", () => {
  it("fills defaults and turns blank text into null", () => {
    expect(medicalHistorySchema.parse({ allergies: "  ", medications: "Losartana" })).toEqual({
      allergies: null,
      medications: "Losartana",
      conditions: [],
      anticoagulant: false,
      pregnant: false,
      smoker: false,
      surgeries: null,
      notes: null,
    });
    expect(medicalHistorySchema.safeParse({ diagnosis: "x" }).success).toBe(false);
    expect(medicalHistorySchema.safeParse({ conditions: ["CANCER"] }).success).toBe(false);
  });

  it("raises what the dentist must see before treating", () => {
    const none = medicalHistorySchema.parse({ conditions: ["DIABETES"], smoker: true });
    expect(medicalAlerts(none)).toEqual([]);
    const all = medicalHistorySchema.parse({
      allergies: "Penicilina",
      anticoagulant: true,
      conditions: ["BLEEDING_DISORDER", "HEART_DISEASE"],
      pregnant: true,
    });
    expect(medicalAlerts(all)).toEqual([
      "Alergia: Penicilina",
      "Usa anticoagulante",
      "Problema de coagulação",
      "Problema cardíaco",
      "Gestante",
    ]);
  });
});
