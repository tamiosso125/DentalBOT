/** Filters the week's agenda by dentist and appointment status, in the page (no API call). */

export const STATUS_FILTERS = {
  "a-confirmar": { label: "A confirmar", status: "PENDING_CONFIRMATION" },
  confirmada: { label: "Confirmadas", status: "CONFIRMED" },
  compareceu: { label: "Compareceu", status: "COMPLETED" },
  faltou: { label: "Faltou", status: "NO_SHOW" },
  cancelada: { label: "Canceladas", status: "CANCELLED" },
} as const;

export type StatusFilter = keyof typeof STATUS_FILTERS;

export type AgendaFilter = { dentist: string | null; status: StatusFilter | null };

type Row = { dentistName: string; status: string };

const isStatusFilter = (v: string | undefined): v is StatusFilter =>
  v !== undefined && Object.hasOwn(STATUS_FILTERS, v);

/** Reads the query string; anything unknown means "no filter". */
export function parseAgendaFilter(q: { dentista?: string; situacao?: string }): AgendaFilter {
  return {
    dentist: q.dentista?.trim() ? q.dentista.trim() : null,
    status: isStatusFilter(q.situacao) ? q.situacao : null,
  };
}

export const isFiltered = (f: AgendaFilter) => f.dentist !== null || f.status !== null;

export function filterAgenda<T extends Row>(rows: T[], f: AgendaFilter): T[] {
  return rows.filter(
    (r) =>
      (f.dentist === null || r.dentistName === f.dentist) &&
      (f.status === null || r.status === STATUS_FILTERS[f.status].status),
  );
}

/** The dentists in the rows, by name. */
export function dentistsOf(rows: Row[]): string[] {
  return [...new Set(rows.map((r) => r.dentistName))].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

/** Agenda link for another week that keeps the filter. */
export function agendaHref(from: string, f: AgendaFilter): string {
  const p = new URLSearchParams({ de: from });
  if (f.dentist) p.set("dentista", f.dentist);
  if (f.status) p.set("situacao", f.status);
  return `/?${p.toString()}`;
}
