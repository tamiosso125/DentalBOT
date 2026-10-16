/** Display helpers for "Acessos". Data comes from GET /admin/access-log. */

export type AccessAction =
  | "SEARCH_PATIENTS"
  | "VIEW_RECORD"
  | "VIEW_DATA"
  | "EXPORT_DATA"
  | "ANONYMIZE"
  | "VIEW_MEDICAL_HISTORY"
  | "SET_MEDICAL_HISTORY"
  | "VIEW_CLINICAL_RECORD"
  | "ADD_CLINICAL_ENTRY"
  | "ISSUE_ATTENDANCE_CERTIFICATE"
  | "PRINT_DAY_SHEET"
  | "VIEW_NOTES"
  | "ADD_NOTE"
  | "DELETE_NOTE"
  | "VIEW_INSURANCE"
  | "SET_INSURANCE"
  | "SET_CONSENT"
  | "VIEW_APPOINTMENT"
  | "VIEW_QUOTE"
  | "VIEW_QUOTE_PDF"
  | "RECEIVE_INSTALLMENT"
  | "REGISTER_CLINIC_PAYMENT"
  | "VIEW_ACCESS_LOG"
  | "LOGIN"
  | "MANAGE_STAFF";

export type AccessEntry = {
  id: string;
  at: string;
  action: AccessAction;
  patientId: string | null;
  patientName: string | null;
  staffName: string | null;
  targetId: string | null;
};

export type AccessLogPage = {
  from: string;
  to: string;
  entries: AccessEntry[];
  truncated: boolean;
};

const LABEL: Record<AccessAction, string> = {
  SEARCH_PATIENTS: "Buscou pacientes",
  VIEW_RECORD: "Abriu a ficha",
  VIEW_DATA: "Abriu os dados (LGPD)",
  EXPORT_DATA: "Exportou os dados (LGPD)",
  ANONYMIZE: "Anonimizou os dados (LGPD)",
  VIEW_MEDICAL_HISTORY: "Viu a anamnese",
  SET_MEDICAL_HISTORY: "Atualizou a anamnese",
  VIEW_CLINICAL_RECORD: "Viu o prontuário",
  ADD_CLINICAL_ENTRY: "Assinou uma evolução clínica",
  ISSUE_ATTENDANCE_CERTIFICATE: "Emitiu um atestado de comparecimento",
  PRINT_DAY_SHEET: "Imprimiu a agenda do dia",
  VIEW_NOTES: "Viu as anotações",
  ADD_NOTE: "Escreveu uma anotação",
  DELETE_NOTE: "Apagou uma anotação",
  VIEW_INSURANCE: "Viu o convênio",
  SET_INSURANCE: "Mudou o convênio",
  SET_CONSENT: "Mudou o consentimento de retorno",
  VIEW_APPOINTMENT: "Abriu uma consulta",
  VIEW_QUOTE: "Abriu um orçamento",
  VIEW_QUOTE_PDF: "Baixou o PDF do orçamento",
  RECEIVE_INSTALLMENT: "Recebeu parcela no balcão",
  REGISTER_CLINIC_PAYMENT: "Registrou pagamento no balcão",
  VIEW_ACCESS_LOG: "Abriu os acessos",
  LOGIN: "Entrou no painel",
  MANAGE_STAFF: "Mudou um login da equipe",
};

export function actionLabel(a: AccessAction): string {
  return LABEL[a] ?? a;
}

/** Where the record the action was about can be opened, if the panel has a page for it. */
export function targetHref(e: Pick<AccessEntry, "action" | "targetId">): string | null {
  if (!e.targetId) return null;
  const id = encodeURIComponent(e.targetId);
  if (e.action === "VIEW_APPOINTMENT") return `/consultas/${id}`;
  if (e.action === "VIEW_QUOTE" || e.action === "VIEW_QUOTE_PDF") return `/orcamentos/${id}`;
  return null;
}
