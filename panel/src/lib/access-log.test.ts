import { describe, expect, it } from "vitest";
import { actionLabel, targetHref } from "./access-log";

describe("access log helpers", () => {
  it("says what was done in pt-BR", () => {
    expect(actionLabel("VIEW_RECORD")).toBe("Abriu a ficha");
    expect(actionLabel("EXPORT_DATA")).toBe("Exportou os dados (LGPD)");
    expect(actionLabel("SET_MEDICAL_HISTORY")).toBe("Atualizou a anamnese");
    expect(actionLabel("ADD_CLINICAL_ENTRY")).toBe("Assinou uma evolução clínica");
    expect(actionLabel("ISSUE_ATTENDANCE_CERTIFICATE")).toBe(
      "Emitiu um atestado de comparecimento",
    );
    expect(actionLabel("PRINT_DAY_SHEET")).toBe("Imprimiu a agenda do dia");
  });

  it("links to the appointment or quote, and nothing else", () => {
    expect(targetHref({ action: "VIEW_APPOINTMENT", targetId: "a 1" })).toBe("/consultas/a%201");
    expect(targetHref({ action: "VIEW_QUOTE_PDF", targetId: "q1" })).toBe("/orcamentos/q1");
    expect(targetHref({ action: "RECEIVE_INSTALLMENT", targetId: "i1" })).toBeNull();
    expect(targetHref({ action: "VIEW_RECORD", targetId: null })).toBeNull();
  });
});
