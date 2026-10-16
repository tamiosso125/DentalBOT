/** Display helpers for the month summary. Data comes from GET /admin/report. */

export type MonthNumbers = {
  attended: number;
  attendedInsurance: number;
  attendedPrivate: number;
  noShow: number;
  cancelled: number;
  receivedCents: number;
  receivedByMethod: {
    PIX: number;
    BOLETO: number;
    CREDIT_CARD: number;
    DEBIT_CARD: number;
    CASH: number;
    OTHER: number;
  };
  /** Of `receivedCents`, what the front desk recorded as received at the clinic. */
  receivedAtClinicCents: number;
  dueOpenCents: number;
  lateCents: number;
  quotesSent: number;
  quotesAccepted: number;
  acceptedCents: number;
  quotesRejected: number;
};

export type MonthlyReport = {
  month: string;
  current: boolean;
  numbers: MonthNumbers;
  previous: MonthNumbers;
  topProcedures: Array<{ name: string; count: number }>;
};

const MONTHS = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

export const METHOD_LABEL = {
  PIX: "Pix",
  BOLETO: "Boleto",
  CREDIT_CARD: "Crédito",
  DEBIT_CARD: "Débito",
  CASH: "Dinheiro",
  OTHER: "Outro",
} as const;

export const isMonth = (s: string | undefined): s is string =>
  !!s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

/** "2026-10" -> "outubro de 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return `${MONTHS[m - 1]} de ${y}`;
}

/** "2026-10" -> "2026-09" (n = -1). */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

/** "+3", "-2" or "=" against the month before. */
export function delta(now: number, before: number): string {
  const d = now - before;
  return d === 0 ? "=" : d > 0 ? `+${d}` : `${d}`;
}

/** Share in whole percent; null when the total is zero. */
export function share(part: number, total: number): number | null {
  return total === 0 ? null : Math.round((part / total) * 100);
}

/** Of the visits that happened or were missed, the share missed. */
export function noShowShare(n: Pick<MonthNumbers, "attended" | "noShow">): number | null {
  return share(n.noShow, n.attended + n.noShow);
}
