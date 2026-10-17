import { dateKey, formatCents, formatDate } from "./format";

/** Display helpers for the patient record. Data comes from GET /admin/patients/:id/record. */

export type PatientRecord = {
  patient: {
    id: string;
    name: string;
    phone: string;
    hasCpf: boolean;
    birthDate: string | null;
    createdAt: string;
    anonymizedAt: string | null;
  };
  insurance: { plan: string; cardEnd: string | null } | null;
  recallConsent: { granted: boolean; at: string; source: string } | null;
  marketingOptOutAt: string | null;
  botPausedUntil: string | null;
  counts: { upcoming: number; attended: number; noShow: number; cancelled: number };
  appointments: Array<{
    id: string;
    startsAt: string;
    status: string;
    procedure: string;
    dentist: string;
    authorization: "AUTHORIZED" | "DENIED" | null;
    surveyRating: number | null;
    aftercareAnswer: "OK" | "HELP" | null;
  }>;
  quotes: Array<{
    id: string;
    status: string;
    totalCents: number;
    createdAt: string;
    installments: number;
    paidCents: number;
    openCents: number;
    overdue: number;
  }>;
  balance: { openCents: number; overdueCents: number };
  clinicPayments: Array<{
    id: string;
    paidAt: string;
    amountCents: number;
    method: string;
    procedure: string | null;
  }>;
  waitlist: Array<{ id: string; procedure: string; until: string }>;
  /** From the current anamnese, what the dentist must see before treating. */
  medicalAlerts: string[];
  /** When the anamnese was last filled in, null if never. */
  medicalHistoryAt: string | null;
  /** Clinical record entries signed so far (addenda included). */
  clinicalEntries: number;
  /** Staff notes, newest first. */
  notes: Array<{
    id: string;
    author: NoteAuthor;
    text: string;
    createdAt: string;
    staffName: string | null;
  }>;
};

export type NoteAuthor = "RECEPTION" | "DENTIST";

/** Who wrote a staff note. */
export function authorLabel(a: NoteAuthor): string {
  return a === "DENTIST" ? "Dentista" : "Recepção";
}

/** Recall invitations: what the front desk needs to know before talking about it. */
export function recallLabel(r: Pick<PatientRecord, "recallConsent" | "marketingOptOutAt">): string {
  if (r.marketingOptOutAt) return "Pediu para não receber mensagens (PARAR)";
  if (!r.recallConsent) return "Ainda não perguntado";
  const how = r.recallConsent.source === "WHATSAPP" ? " pelo WhatsApp" : " na recepção";
  return r.recallConsent.granted ? `Aceitou${how}` : `Não aceitou${how}`;
}

/** What happened after the visit, in a few words, or null when nothing. */
export function afterVisitLabel(a: PatientRecord["appointments"][number]): string | null {
  const parts: string[] = [];
  if (a.authorization === "AUTHORIZED") parts.push("Convênio autorizou");
  if (a.authorization === "DENIED") parts.push("Convênio negou");
  if (a.aftercareAnswer === "OK") parts.push("Pós: tudo bem");
  if (a.aftercareAnswer === "HELP") parts.push("Pós: pediu ajuda");
  if (a.surveyRating !== null) parts.push(`Nota ${a.surveyRating}`);
  return parts.length ? parts.join(" · ") : null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "1 marcada · 2 atendidas · 1 falta · 0 canceladas" */
export function countsLabel(c: PatientRecord["counts"]): string {
  return [
    plural(c.upcoming, "marcada", "marcadas"),
    plural(c.attended, "atendida", "atendidas"),
    plural(c.noShow, "falta", "faltas"),
    plural(c.cancelled, "cancelada", "canceladas"),
  ].join(" · ");
}

/** "17/05/1990 (36 anos)" in the clinic's calendar, from a YYYY-MM-DD birth date. */
export function birthLabel(birthDate: string, today: string): string {
  const [y, m, d] = birthDate.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
  const age = ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
  return `${birthDate.split("-").reverse().join("/")} (${age} anos)`;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What the front desk should look at first on a record, from data the page already has:
 * overdue installments, visits still unconfirmed this week, past visits nobody marked
 * attended or missed, a denied insurance authorization, and no anamnese before a visit.
 */
export function pendingNotices(
  r: Pick<PatientRecord, "balance" | "appointments" | "counts" | "medicalHistoryAt">,
  now: Date,
): string[] {
  const out: string[] = [];
  if (r.balance.overdueCents > 0)
    out.push(`Parcelas vencidas: ${formatCents(r.balance.overdueCents)}.`);

  const when = (a: { startsAt: string }) => formatDate(dateKey(a.startsAt));
  const t = now.getTime();
  const future = r.appointments.filter((a) => new Date(a.startsAt).getTime() >= t);
  const active = (a: { status: string }) =>
    a.status === "PENDING_CONFIRMATION" || a.status === "CONFIRMED";

  for (const a of future) {
    if (a.status === "PENDING_CONFIRMATION" && new Date(a.startsAt).getTime() - t <= WEEK_MS)
      out.push(`Consulta de ${when(a)} ainda sem confirmação.`);
    if (active(a) && a.authorization === "DENIED")
      out.push(`O convênio negou a consulta de ${when(a)}.`);
  }
  for (const a of r.appointments)
    if (active(a) && new Date(a.startsAt).getTime() < t)
      out.push(`Consulta de ${when(a)} sem marcação de compareceu ou faltou.`);
  if (r.medicalHistoryAt === null && future.some(active))
    out.push("Anamnese ainda não preenchida e há consulta marcada.");
  return out;
}
