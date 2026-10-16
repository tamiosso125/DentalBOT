/** Display helpers for the post-procedure follow-up. Data comes from GET /admin/aftercare. */

export type AftercareSummary = {
  month: { sent: number; checkIns: number; ok: number; help: number };
  help: Array<{
    followUpId: string;
    patientId: string;
    patientName: string;
    patientPhone: string;
    procedureName: string;
    appointmentAt: string;
    answeredAt: string;
  }>;
};

/** One line for the home card, or null when nothing went out this month. */
export function aftercareLine(month: AftercareSummary["month"]): string | null {
  if (month.sent === 0) return null;
  const sent = month.sent === 1 ? "1 paciente recebeu" : `${month.sent} pacientes receberam`;
  const parts = [`${sent} os cuidados`];
  if (month.checkIns > 0) {
    const silent = month.checkIns - month.ok - month.help;
    parts.push(`${month.ok} tudo bem`, `${month.help} pediram ajuda`);
    if (silent > 0) parts.push(`${silent} sem resposta`);
  }
  return parts.join(" · ");
}
