/** Display helpers for the "Cobranças" page. Rows come from GET /admin/installments. */

export type InstallmentRow = {
  id: string;
  quoteId: string;
  patientName: string;
  patientPhone: string;
  number: number;
  of: number;
  amountCents: number;
  dueDate: string;
  status: "PENDING" | "BILLED" | "PAID" | "OVERDUE" | "CANCELLED";
  late: boolean;
  charged: boolean;
  paidAt: string | null;
  paymentMethod: string | null;
  /** Paid at the front desk (recorded in the panel). */
  receivedAtClinic: boolean;
  overdueNoticeAt: string | null;
};

export type BillingSummary = {
  openCents: number;
  lateCents: number;
  lateCount: number;
  /** Late a week or more: the bot's notice was not enough, the front desk calls. */
  toCallCount: number;
  paidThisMonthCents: number;
};

export const FILTERS = {
  abertas: "Em aberto",
  vencidas: "Vencidas",
  ligar: "Para ligar",
  pagas: "Pagas",
  todas: "Todas",
} as const;
export type Filter = keyof typeof FILTERS;

export function parseFilter(value: string | undefined): Filter {
  return value && value in FILTERS ? (value as Filter) : "abertas";
}

const METHOD: Record<string, string> = {
  PIX: "Pix",
  BOLETO: "boleto",
  CREDIT_CARD: "cartão",
  DEBIT_CARD: "débito",
  CASH: "dinheiro",
};

/** How the front desk can receive (boleto only exists through Asaas), in form order. */
export const CLINIC_METHODS = {
  CASH: "Dinheiro",
  DEBIT_CARD: "Cartão de débito",
  CREDIT_CARD: "Cartão de crédito",
  PIX: "Pix direto para a clínica",
} as const;
export type ClinicMethod = keyof typeof CLINIC_METHODS;

export const isClinicMethod = (v: string): v is ClinicMethod => v in CLINIC_METHODS;

/** Label of any payment method, lowercase ("dinheiro", "Pix"). */
export const methodLabel = (m: string) => METHOD[m] ?? m;

/** "150", "150,5", "1.234,56" or "R$ 80,00" -> cents; null if not a positive amount. */
export function parseReais(input: string): number | null {
  const s = input.replace(/R\$|\s/g, "");
  if (!/^\d{1,3}(\.?\d{3})*(,\d{1,2})?$/.test(s)) return null;
  const [int, dec = ""] = s.replace(/\./g, "").split(",");
  const cents = Number(int) * 100 + Number(dec.padEnd(2, "0"));
  return cents > 0 ? cents : null;
}

export type ClinicPaymentRow = {
  id: string;
  paidOn: string;
  patientId: string;
  patientName: string;
  patientPhone: string;
  procedureName: string | null;
  amountCents: number;
  method: string;
};

/** Label and badge tone of an installment, late open ones shown as "Vencida". */
export function installmentStatus(r: InstallmentRow): { label: string; tone: string } {
  if (r.status === "PAID") {
    const how = r.paymentMethod ? ` (${methodLabel(r.paymentMethod)})` : "";
    return { label: `${r.receivedAtClinic ? "Paga na clínica" : "Paga"}${how}`, tone: "ok" };
  }
  if (r.status === "CANCELLED") return { label: "Cancelada", tone: "" };
  if (r.late) return { label: "Vencida", tone: "danger" };
  if (r.status === "BILLED") return { label: "Cobrança emitida", tone: "warn" };
  return { label: "A emitir", tone: "" };
}

/** Open installments can be marked as paid at the front desk. */
export const canReceiveAtClinic = (r: InstallmentRow) =>
  r.status === "PENDING" || r.status === "BILLED" || r.status === "OVERDUE";

/** The payment link only exists for an open installment whose charge was created. */
export const hasPaymentLink = (r: InstallmentRow) =>
  r.charged && (r.status === "PENDING" || r.status === "BILLED" || r.status === "OVERDUE");
