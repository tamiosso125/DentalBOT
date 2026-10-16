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

const METHOD: Record<string, string> = { PIX: "Pix", BOLETO: "boleto", CREDIT_CARD: "cartão" };

/** Label and badge tone of an installment, late open ones shown as "Vencida". */
export function installmentStatus(r: InstallmentRow): { label: string; tone: string } {
  if (r.status === "PAID")
    return {
      label: r.paymentMethod ? `Paga (${METHOD[r.paymentMethod] ?? r.paymentMethod})` : "Paga",
      tone: "ok",
    };
  if (r.status === "CANCELLED") return { label: "Cancelada", tone: "" };
  if (r.late) return { label: "Vencida", tone: "danger" };
  if (r.status === "BILLED") return { label: "Cobrança emitida", tone: "warn" };
  return { label: "A emitir", tone: "" };
}

/** The payment link only exists for an open installment whose charge was created. */
export const hasPaymentLink = (r: InstallmentRow) =>
  r.charged && (r.status === "PENDING" || r.status === "BILLED" || r.status === "OVERDUE");
