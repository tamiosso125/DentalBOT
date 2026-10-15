import { describe, expect, it } from "vitest";
import { anonymizedNotice, parseSubject } from "./data-subject";

describe("LGPD pages", () => {
  it("maps the page URL to the API subject", () => {
    expect(parseSubject("paciente", "p1")).toEqual({ kind: "patients", id: "p1" });
    expect(parseSubject("pedido", "r1")).toEqual({ kind: "data-requests", id: "r1" });
    expect(parseSubject("consulta", "a1")).toBeNull();
  });

  it("summarizes what anonymizing removed", () => {
    expect(anonymizedNotice({ cancelledAppointments: 0, conversations: 1, messages: 1 })).toBe(
      "Dados anonimizados: 1 mensagem apagada, 1 conversa anonimizada. Orçamentos e pagamentos ficam guardados sem identificar a pessoa.",
    );
    expect(anonymizedNotice({ cancelledAppointments: 2, conversations: 2, messages: 5 })).toContain(
      "5 mensagens apagadas, 2 conversas anonimizadas, 2 consultas futuras canceladas.",
    );
  });
});
