import { describe, expect, it } from "vitest";
import {
  canReceiveAtClinic,
  hasPaymentLink,
  installmentStatus,
  parseFilter,
  parseReais,
  type InstallmentRow,
} from "./billing";

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
  receivedAtClinic: false,
  overdueNoticeAt: null,
  ...r,
});

describe("billing helpers", () => {
  it("reads amounts typed in reais", () => {
    expect(parseReais("150")).toBe(150_00);
    expect(parseReais("150,5")).toBe(150_50);
    expect(parseReais("R$ 1.234,56")).toBe(1234_56);
    expect(parseReais("1234,56")).toBe(1234_56);
    for (const bad of ["", "0", "0,00", "-10", "12,345", "1.23", "abc", "10.5"])
      expect(parseReais(bad), bad).toBeNull();
  });

  it("marks paid-at-the-clinic installments and which can still be received", () => {
    expect(
      installmentStatus(row({ status: "PAID", paymentMethod: "CASH", receivedAtClinic: true })),
    ).toEqual({ label: "Paga na clínica (dinheiro)", tone: "ok" });
    expect(canReceiveAtClinic(row({ status: "OVERDUE" }))).toBe(true);
    expect(canReceiveAtClinic(row({ status: "PENDING", charged: false }))).toBe(true);
    expect(canReceiveAtClinic(row({ status: "PAID" }))).toBe(false);
    expect(canReceiveAtClinic(row({ status: "CANCELLED" }))).toBe(false);
  });

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
