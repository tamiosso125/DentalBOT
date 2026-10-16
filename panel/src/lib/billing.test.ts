import { describe, expect, it } from "vitest";
import { hasPaymentLink, installmentStatus, parseFilter, type InstallmentRow } from "./billing";

const row = (r: Partial<InstallmentRow>): InstallmentRow => ({
  id: "i1",
  quoteId: "q1",
  patientName: "Maria Exemplo",
  patientPhone: "***0051",
  number: 1,
  of: 3,
  amountCents: 100_00,
  dueDate: "2026-10-20",
  status: "BILLED",
  late: false,
  charged: true,
  paidAt: null,
  paymentMethod: null,
  overdueNoticeAt: null,
  ...r,
});

describe("billing helpers", () => {
  it("falls back to open installments for an unknown filter", () => {
    expect(parseFilter("vencidas")).toBe("vencidas");
    expect(parseFilter("ligar")).toBe("ligar");
    expect(parseFilter("x")).toBe("abertas");
    expect(parseFilter(undefined)).toBe("abertas");
  });

  it("labels each situation, late open ones as overdue", () => {
    expect(installmentStatus(row({}))).toEqual({ label: "Cobrança emitida", tone: "warn" });
    expect(installmentStatus(row({ status: "PENDING", charged: false }))).toEqual({
      label: "A emitir",
      tone: "",
    });
    expect(installmentStatus(row({ late: true }))).toEqual({ label: "Vencida", tone: "danger" });
    expect(installmentStatus(row({ status: "OVERDUE", late: true })).label).toBe("Vencida");
    expect(installmentStatus(row({ status: "PAID", paymentMethod: "PIX" }))).toEqual({
      label: "Paga (Pix)",
      tone: "ok",
    });
    expect(installmentStatus(row({ status: "CANCELLED" })).label).toBe("Cancelada");
  });

  it("offers the payment link only for open, charged installments", () => {
    expect(hasPaymentLink(row({}))).toBe(true);
    expect(hasPaymentLink(row({ status: "OVERDUE" }))).toBe(true);
    expect(hasPaymentLink(row({ charged: false }))).toBe(false);
    expect(hasPaymentLink(row({ status: "PAID" }))).toBe(false);
  });
});
