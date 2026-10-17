import { dateKey, formatCents, formatDate } from "./format";

/** The front desk's "Pendências" list. Data comes from GET /admin/pending. */

export type PendingKind = "OVERDUE" | "UNCONFIRMED" | "UNMARKED";

export type PendingItem = {
  kind: PendingKind;
  amountCents?: number;
  count?: number;
  appointmentId?: string;
  at?: string;
};

export type PendingRow = { patientId: string; patientName: string; items: PendingItem[] };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One pending item in a few words. */
export function pendingLabel(i: PendingItem): string {
  const when = i.at ? formatDate(dateKey(i.at)) : "";
  switch (i.kind) {
    case "OVERDUE":
      return `${plural(i.count ?? 1, "parcela vencida", "parcelas vencidas")}: ${formatCents(i.amountCents ?? 0)}`;
    case "UNCONFIRMED":
      return `Consulta de ${when} sem confirmação`;
    case "UNMARKED":
      return `Consulta de ${when} sem compareceu ou faltou`;
  }
}

/** Where the front desk acts on an item: the appointment or the installments. */
export function pendingHref(row: PendingRow, i: PendingItem): string {
  if (i.kind === "OVERDUE") return "/cobrancas?filtro=vencidas";
  return i.appointmentId
    ? `/consultas/${encodeURIComponent(i.appointmentId)}`
    : `/pacientes/${encodeURIComponent(row.patientId)}`;
}

/** "3 pacientes com pendência" for the heading. */
export function pendingSummary(rows: PendingRow[]): string {
  return rows.length === 0
    ? "Nada pendente."
    : `${plural(rows.length, "paciente com pendência", "pacientes com pendência")}.`;
}
