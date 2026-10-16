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
};

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
