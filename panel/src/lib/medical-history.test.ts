import { describe, expect, it } from "vitest";
import { EMPTY_HISTORY, historyFromForm, historySummary } from "./medical-history";

describe("historyFromForm", () => {
  it("reads text, conditions and checkboxes", () => {
    const f = new FormData();
    f.set("allergies", "  Dipirona ");
    f.set("medications", "");
    f.append("conditions", "HEART_DISEASE");
    f.append("conditions", "DIABETES");
    f.append("conditions", "INVENTADA");
    f.set("anticoagulant", "on");
    f.set("notes", "Ansiosa");
    expect(historyFromForm(f)).toEqual({
      ...EMPTY_HISTORY,
      allergies: "Dipirona",
      conditions: ["DIABETES", "HEART_DISEASE"],
      anticoagulant: true,
      notes: "Ansiosa",
    });
  });

  it("an empty form is the empty history", () => {
    expect(historyFromForm(new FormData())).toEqual(EMPTY_HISTORY);
  });
});

describe("historySummary", () => {
  it("says when no allergy was informed and lists the rest", () => {
    expect(historySummary(EMPTY_HISTORY)).toBe("Sem alergia informada");
    expect(
      historySummary({
        ...EMPTY_HISTORY,
        allergies: "Látex",
        conditions: ["HYPERTENSION"],
        pregnant: true,
        smoker: true,
      }),
    ).toBe("Alergia: Látex · Pressão alta · Gestante · Fumante");
  });
});
