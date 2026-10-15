import { describe, expect, it } from "vitest";
import { consentAction, consentOrigin, recallCounts, recallStatus, type RecallRow } from "./recall";

const row = (r: Partial<RecallRow>): RecallRow => ({
  patientId: "p1",
  patientName: "Maria Exemplo",
  patientPhone: "***0001",
  lastVisitAt: "2026-03-10T13:00:00.000Z",
  lastProcedure: "Limpeza",
  status: "due",
  invitedAt: null,
  optedOutAt: null,
  consentSource: "STAFF",
  consentAt: "2026-10-01T12:00:00.000Z",
  ...r,
});

describe("recall helpers", () => {
  it("labels each status", () => {
    expect(recallStatus(row({}))).toEqual({ label: "Convite na próxima janela", tone: "warn" });
    expect(recallStatus(row({ status: "opted_out" })).label).toBe("Pediu para parar");
  });

  it("offers to grant consent when missing and to withdraw it otherwise", () => {
    expect(consentAction(row({ status: "no_consent" })).granted).toBe(true);
    expect(consentAction(row({ status: "opted_out" })).granted).toBe(true);
    expect(consentAction(row({ status: "invited" }))).toEqual({
      granted: false,
      label: "Retirar consentimento",
    });
  });

  it("says who recorded the latest answer", () => {
    expect(consentOrigin(row({}))).toBe("Aceitou pela recepção");
    expect(consentOrigin(row({ status: "no_consent", consentSource: "WHATSAPP" }))).toBe(
      "Recusou pelo WhatsApp",
    );
    expect(consentOrigin(row({ status: "no_consent", consentSource: null }))).toBeNull();
  });

  it("counts rows per status", () => {
    expect(recallCounts([row({}), row({ status: "invited" }), row({ status: "invited" })])).toEqual(
      { due: 1, invited: 2, no_consent: 0, opted_out: 0 },
    );
  });
});
