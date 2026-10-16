/** Display helpers for insurance prior authorization. Data comes from GET /admin/authorizations. */

export type AuthorizationRow = {
  appointmentId: string;
  startsAt: string;
  procedureName: string;
  patientId: string;
  patientName: string;
  /** Last 4 digits only. */
  patientPhone: string;
  planName: string;
  /** Full card number, typed by the front desk into the insurer's portal. */
  card: string | null;
  status: "PENDING" | "AUTHORIZED" | "DENIED";
  decidedAt: string | null;
  notifiedAt: string | null;
  privateChosenAt: string | null;
};

export type AuthorizationList = {
  plans: Array<{ id: string; name: string }>;
  pending: AuthorizationRow[];
  decided: AuthorizationRow[];
};

export type PatientInsurance = {
  planId: string | null;
  card: string | null;
  plans: Array<{ id: string; name: string }>;
};

/** Badge of a decided authorization, with what the patient did next. */
export function decisionLabel(r: AuthorizationRow): { label: string; tone: string } {
  if (r.status === "AUTHORIZED") return { label: "Autorizado", tone: "ok" };
  if (r.status === "DENIED")
    return r.privateChosenAt
      ? { label: "Negado · segue particular", tone: "warn" }
      : { label: "Negado", tone: "danger" };
  return { label: "Pendente", tone: "warn" };
}

/** Whether the patient got the WhatsApp notice of the decision. */
export function noticeLabel(r: AuthorizationRow): string {
  return r.notifiedAt ? "Paciente avisado" : "Aviso não enviado: avise por telefone";
}

/** "1234 5678 9012" for reading on the phone; the raw value is what goes into the portal. */
export function cardGroups(card: string): string {
  return card.replace(/(.{4})(?=.)/g, "$1 ");
}
