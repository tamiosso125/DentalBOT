import { describe, expect, it } from "vitest";
import { cardGroups, decisionLabel, noticeLabel, type AuthorizationRow } from "./authorizations";

const row: AuthorizationRow = {
  appointmentId: "a1",
  startsAt: "2026-10-22T13:00:00.000Z",
  procedureName: "Extração",
  patientId: "p1",
  patientName: "Maria Teste",
  patientPhone: "***0001",
  planName: "Odontoprev",
  card: "123456789012",
  status: "PENDING",
  decidedAt: null,
  notifiedAt: null,
  privateChosenAt: null,
};

describe("authorization helpers", () => {
  it("labels the decision and what the patient chose", () => {
    expect(decisionLabel(row).label).toBe("Pendente");
    expect(decisionLabel({ ...row, status: "AUTHORIZED" })).toEqual({
      label: "Autorizado",
      tone: "ok",
    });
    expect(decisionLabel({ ...row, status: "DENIED" }).label).toBe("Negado");
    expect(
      decisionLabel({ ...row, status: "DENIED", privateChosenAt: "2026-10-20T12:00:00.000Z" })
        .label,
    ).toBe("Negado · segue particular");
  });

  it("says when the patient still has to be told", () => {
    expect(noticeLabel(row)).toMatch(/telefone/);
    expect(noticeLabel({ ...row, notifiedAt: "2026-10-20T12:00:00.000Z" })).toBe(
      "Paciente avisado",
    );
  });

  it("groups the card in fours", () => {
    expect(cardGroups("123456789012")).toBe("1234 5678 9012");
    expect(cardGroups("ABC12")).toBe("ABC1 2");
  });
});
