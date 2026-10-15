import { describe, expect, it } from "vitest";
import { parseQuoteForm, parseReais } from "./quote-form";

const form = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

describe("parseReais", () => {
  it("reads Brazilian and plain amounts into cents", () => {
    expect(parseReais("1.234,56")).toBe(123456);
    expect(parseReais("R$ 350,00")).toBe(35000);
    expect(parseReais("1800")).toBe(180000);
    expect(parseReais("99.9")).toBe(9990);
    expect(parseReais("12,345")).toBeNull();
    expect(parseReais("abc")).toBeNull();
    expect(parseReais("-10")).toBeNull();
  });
});

describe("parseQuoteForm", () => {
  it("builds the API body from filled rows only", () => {
    const out = parseQuoteForm(
      form({
        patientId: "pat_1",
        dentistId: "den_1",
        "item0.procedureId": "proc_resina",
        "item0.quantity": "2",
        "item1.procedureId": "proc_avaliacao",
        "item1.coverage": "INSURANCE",
        "item1.price": "100,00",
        "item3.procedureId": "proc_coroa",
        "item3.price": "1.800,00",
        installmentCount: "3",
        notes: "  Retorno em 6 meses. ",
      }),
    );
    expect(out).toEqual({
      body: {
        patientId: "pat_1",
        dentistId: "den_1",
        items: [
          { procedureId: "proc_resina", quantity: 2, coverage: "PRIVATE" },
          // Insurance items are never priced, whatever was typed.
          { procedureId: "proc_avaliacao", quantity: 1, coverage: "INSURANCE" },
          { procedureId: "proc_coroa", quantity: 1, coverage: "PRIVATE", unitPriceCents: 180000 },
        ],
        installmentCount: 3,
        validDays: 15,
        notes: "Retorno em 6 meses.",
      },
    });
  });

  it("lists every problem in pt-BR", () => {
    const out = parseQuoteForm(
      form({
        "item0.procedureId": "proc_resina",
        "item0.quantity": "0",
        "item1.procedureId": "proc_coroa",
        "item1.price": "dez reais",
        installmentCount: "24",
        validDays: "0",
      }),
    );
    expect(out).toEqual({
      errors: [
        "Escolha o paciente.",
        "Escolha a dentista.",
        "Item 1: quantidade inválida.",
        "Item 2: valor inválido.",
        "Parcelas: de 1 a 12.",
        "Validade: de 1 a 90 dias.",
      ],
    });
  });

  it("requires at least one procedure", () => {
    expect(parseQuoteForm(form({ patientId: "p", dentistId: "d" }))).toEqual({
      errors: ["Inclua pelo menos um procedimento."],
    });
  });
});
