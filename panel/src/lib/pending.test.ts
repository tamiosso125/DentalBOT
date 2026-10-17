import { describe, expect, it } from "vitest";
import { pendingHref, pendingLabel, pendingSummary, type PendingRow } from "./pending";

const row: PendingRow = { patientId: "p1", patientName: "Maria", items: [] };

describe("pending labels", () => {
  it("words each kind of item", () => {
    expect(pendingLabel({ kind: "OVERDUE", amountCents: 15050, count: 1 })).toMatch(
      /^1 parcela vencida: R\$\s150,50$/,
    );
    expect(pendingLabel({ kind: "OVERDUE", amountCents: 60000, count: 2 })).toMatch(
      /^2 parcelas vencidas: R\$\s600,00$/,
    );
    expect(pendingLabel({ kind: "UNCONFIRMED", at: "2026-10-20T13:00:00.000Z" })).toBe(
      "Consulta de 20/10/2026 sem confirmação",
    );
    expect(pendingLabel({ kind: "UNMARKED", at: "2026-10-15T13:00:00.000Z" })).toBe(
      "Consulta de 15/10/2026 sem compareceu ou faltou",
    );
  });

  it("links money to the overdue installments and visits to the appointment", () => {
    expect(pendingHref(row, { kind: "OVERDUE" })).toBe("/cobrancas?filtro=vencidas");
    expect(pendingHref(row, { kind: "UNCONFIRMED", appointmentId: "a 1" })).toBe(
      "/consultas/a%201",
    );
    expect(pendingHref(row, { kind: "UNMARKED" })).toBe("/pacientes/p1");
  });

  it("summarizes the count", () => {
    expect(pendingSummary([])).toBe("Nada pendente.");
    expect(pendingSummary([row])).toBe("1 paciente com pendência.");
    expect(pendingSummary([row, row])).toBe("2 pacientes com pendência.");
  });
});
