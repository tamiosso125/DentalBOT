/** URL segment of the LGPD pages (/dados/paciente/:id, /dados/pedido/:id) to the API's. */
export type DataSubjectKind = "patients" | "data-requests";

export const SUBJECT_KIND: Record<string, DataSubjectKind> = {
  paciente: "patients",
  pedido: "data-requests",
};

export function parseSubject(tipo: string, id: string) {
  const kind = SUBJECT_KIND[tipo];
  return kind && id ? { kind, id } : null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the front desk reads after anonymizing. */
export function anonymizedNotice(r: {
  cancelledAppointments: number;
  conversations: number;
  messages: number;
}): string {
  const parts = [
    plural(r.messages, "mensagem apagada", "mensagens apagadas"),
    plural(r.conversations, "conversa anonimizada", "conversas anonimizadas"),
  ];
  if (r.cancelledAppointments)
    parts.push(
      plural(r.cancelledAppointments, "consulta futura cancelada", "consultas futuras canceladas"),
    );
  return `Dados anonimizados: ${parts.join(", ")}. Orçamentos e pagamentos ficam guardados sem identificar a pessoa.`;
}
