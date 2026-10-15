/** Display helpers for the "Retorno" page. Data comes from GET /admin/recall. */

export type RecallStatus = "due" | "invited" | "no_consent" | "opted_out";

export type RecallRow = {
  patientId: string;
  patientName: string;
  patientPhone: string;
  lastVisitAt: string;
  lastProcedure: string;
  status: RecallStatus;
  invitedAt: string | null;
  optedOutAt: string | null;
  consentSource: "STAFF" | "WHATSAPP" | null;
  consentAt: string | null;
};

export type RecallList = {
  afterMonths: number;
  schedule: string;
  consentText: string;
  rows: RecallRow[];
};

const STATUS: Record<RecallStatus, { label: string; tone: string }> = {
  due: { label: "Convite na próxima janela", tone: "warn" },
  invited: { label: "Convidado", tone: "ok" },
  no_consent: { label: "Sem consentimento", tone: "" },
  opted_out: { label: "Pediu para parar", tone: "danger" },
};

export const recallStatus = (r: RecallRow) => STATUS[r.status];

/** What the front desk can record for this patient: grant when missing, withdraw when given. */
export function consentAction(r: RecallRow): { granted: boolean; label: string } {
  return r.status === "no_consent" || r.status === "opted_out"
    ? { granted: true, label: "Registrar consentimento" }
    : { granted: false, label: "Retirar consentimento" };
}

/** Who gave the latest consent answer: "pelo WhatsApp" or "pela recepção". */
export function consentOrigin(r: RecallRow): string | null {
  if (!r.consentSource) return null;
  const verb = r.status === "no_consent" ? "Recusou" : "Aceitou";
  return `${verb} ${r.consentSource === "WHATSAPP" ? "pelo WhatsApp" : "pela recepção"}`;
}

/** Counts per status, for the summary line. */
export function recallCounts(rows: RecallRow[]): Record<RecallStatus, number> {
  const out: Record<RecallStatus, number> = { due: 0, invited: 0, no_consent: 0, opted_out: 0 };
  for (const r of rows) out[r.status]++;
  return out;
}
