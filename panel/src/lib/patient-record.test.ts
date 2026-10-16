import { describe, expect, it } from "vitest";
import { afterVisitLabel, birthLabel, countsLabel, recallLabel } from "./patient-record";

const visit = {
  id: "a1",
  startsAt: "2026-10-13T13:00:00.000Z",
  status: "COMPLETED",
  procedure: "Extração simples",
  dentist: "Dra. Ana",
  authorization: null,
  surveyRating: null,
  aftercareAnswer: null,
} as const;

describe("patient record labels", () => {
  it("puts an opt-out before any consent", () => {
    const granted = { granted: true, at: "2026-10-01T12:00:00.000Z", source: "WHATSAPP" };
    expect(recallLabel({ recallConsent: null, marketingOptOutAt: null })).toBe(
      "Ainda não perguntado",
    );
    expect(recallLabel({ recallConsent: granted, marketingOptOutAt: null })).toBe(
      "Aceitou pelo WhatsApp",
    );
    expect(
      recallLabel({
        recallConsent: { ...granted, granted: false, source: "STAFF" },
        marketingOptOutAt: null,
      }),
    ).toBe("Não aceitou na recepção");
    expect(
      recallLabel({ recallConsent: granted, marketingOptOutAt: "2026-10-02T12:00:00.000Z" }),
    ).toBe("Pediu para não receber mensagens (PARAR)");
  });

  it("summarizes what came after a visit", () => {
    expect(afterVisitLabel(visit)).toBeNull();
    expect(
      afterVisitLabel({
        ...visit,
        authorization: "AUTHORIZED",
        aftercareAnswer: "HELP",
        surveyRating: 4,
      }),
    ).toBe("Convênio autorizou · Pós: pediu ajuda · Nota 4");
  });

  it("counts appointments in pt-BR, singular and plural", () => {
    expect(countsLabel({ upcoming: 1, attended: 2, noShow: 1, cancelled: 0 })).toBe(
      "1 marcada · 2 atendidas · 1 falta · 0 canceladas",
    );
  });

  it("counts the age in whole years", () => {
    expect(birthLabel("1990-05-17", "2026-05-16")).toBe("17/05/1990 (35 anos)");
    expect(birthLabel("1990-05-17", "2026-05-17")).toBe("17/05/1990 (36 anos)");
  });
});
