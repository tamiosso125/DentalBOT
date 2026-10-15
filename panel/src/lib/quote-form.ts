/** Turns the "novo orçamento" form into the API body. Prices are typed in reais. */

export const ITEM_ROWS = 6;

export type QuoteBody = {
  patientId: string;
  dentistId: string;
  items: Array<{
    procedureId: string;
    quantity: number;
    coverage: "PRIVATE" | "INSURANCE";
    unitPriceCents?: number;
  }>;
  installmentCount: number;
  validDays: number;
  notes?: string;
};

type Form = { get(name: string): FormDataEntryValue | null };

const text = (f: Form, name: string) => {
  const v = f.get(name);
  return typeof v === "string" ? v.trim() : "";
};

/** "1.234,56", "1234,5" or "1234.56" -> cents. Null if not a valid amount. */
export function parseReais(input: string): number | null {
  const s = input.replace(/\s|R\$/g, "");
  if (!s) return null;
  const normalized = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 100);
}

export function parseQuoteForm(f: Form): { body: QuoteBody } | { errors: string[] } {
  const errors: string[] = [];
  const patientId = text(f, "patientId");
  const dentistId = text(f, "dentistId");
  if (!patientId) errors.push("Escolha o paciente.");
  if (!dentistId) errors.push("Escolha a dentista.");

  const items: QuoteBody["items"] = [];
  for (let i = 0; i < ITEM_ROWS; i++) {
    const procedureId = text(f, `item${i}.procedureId`);
    if (!procedureId) continue;
    const quantity = Number(text(f, `item${i}.quantity`) || "1");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 32) {
      errors.push(`Item ${i + 1}: quantidade inválida.`);
      continue;
    }
    const coverage = text(f, `item${i}.coverage`) === "INSURANCE" ? "INSURANCE" : "PRIVATE";
    const priceText = text(f, `item${i}.price`);
    const item: QuoteBody["items"][number] = { procedureId, quantity, coverage };
    if (priceText && coverage === "PRIVATE") {
      const cents = parseReais(priceText);
      if (cents === null) {
        errors.push(`Item ${i + 1}: valor inválido.`);
        continue;
      }
      item.unitPriceCents = cents;
    }
    items.push(item);
  }
  if (items.length === 0 && errors.length === 0) errors.push("Inclua pelo menos um procedimento.");

  const installmentCount = Number(text(f, "installmentCount") || "1");
  if (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > 12)
    errors.push("Parcelas: de 1 a 12.");
  const validDays = Number(text(f, "validDays") || "15");
  if (!Number.isInteger(validDays) || validDays < 1 || validDays > 90)
    errors.push("Validade: de 1 a 90 dias.");
  const notes = text(f, "notes");
  if (notes.length > 500) errors.push("Observações: até 500 caracteres.");

  if (errors.length) return { errors };
  return {
    body: {
      patientId,
      dentistId,
      items,
      installmentCount,
      validDays,
      ...(notes ? { notes } : {}),
    },
  };
}
