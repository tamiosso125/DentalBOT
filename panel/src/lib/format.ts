/** Display helpers (pt-BR). Values arrive in cents and ISO instants from the API. */

export const TIME_ZONE = "America/Sao_Paulo";

export function formatCents(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

export function formatTime(iso: string, timeZone = TIME_ZONE): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit" }).format(
    new Date(iso),
  );
}

export function formatDayHeading(iso: string, timeZone = TIME_ZONE): string {
  const s = new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(iso));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatDateTime(iso: string, timeZone = TIME_ZONE): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** "YYYY-MM-DD" of an instant in the clinic timezone. */
export function dateKey(iso: string | Date, timeZone = TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(iso));
}

export function formatDate(date: string): string {
  return date.split("-").reverse().join("/");
}

/** Groups rows by clinic-local day, keeping the API order. */
export function groupByDay<T extends { startsAt: string }>(rows: T[], timeZone = TIME_ZONE) {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const key = dateKey(r.startsAt, timeZone);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()].map(([day, items]) => ({ day, items }));
}

export const APPOINTMENT_STATUS: Record<string, string> = {
  PENDING_CONFIRMATION: "A confirmar",
  CONFIRMED: "Confirmada",
  CANCELLED: "Cancelada",
  NO_SHOW: "Faltou",
  COMPLETED: "Atendida",
};

export const QUOTE_STATUS: Record<string, string> = {
  DRAFT: "Rascunho",
  SENT: "Enviado",
  ACCEPTED: "Aprovado",
  REJECTED: "Não aprovado",
  EXPIRED: "Vencido",
};
