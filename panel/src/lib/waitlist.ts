/** Display helpers for the "Lista de espera" page. Data comes from GET /admin/waitlist. */

import { dateKey, formatDate, formatDateTime } from "./format";

export type WaitlistStatus = "WAITING" | "BOOKED" | "REMOVED" | "EXPIRED";
export type WaitlistAnswer = "ACCEPTED" | "DECLINED" | "TAKEN";

export type WaitlistRow = {
  id: string;
  patientId: string;
  patientName: string;
  patientPhone: string;
  procedureName: string;
  /** Exclusive end: slots starting before this instant are offered. */
  until: string;
  status: WaitlistStatus;
  createdAt: string;
  closedAt: string | null;
  offers: number;
  lastOffer: { startsAt: string; answer: WaitlistAnswer | null } | null;
};

export type WaitlistList = { schedule: string; rows: WaitlistRow[] };

const STATUS: Record<WaitlistStatus, { label: string; tone: string }> = {
  WAITING: { label: "Esperando vaga", tone: "warn" },
  BOOKED: { label: "Marcou pela lista", tone: "ok" },
  REMOVED: { label: "Saiu da lista", tone: "" },
  EXPIRED: { label: "Prazo acabou", tone: "" },
};

export const waitlistStatus = (r: WaitlistRow) => STATUS[r.status];

/** Last day the patient waits for, as the front desk chose it ("22/10/2026"). */
export const untilDay = (r: Pick<WaitlistRow, "until">) =>
  formatDate(dateKey(new Date(new Date(r.until).getTime() - 1)));

const ANSWER: Record<WaitlistAnswer, string> = {
  ACCEPTED: "aceitou",
  DECLINED: "recusou",
  TAKEN: "já tinha sido preenchida",
};

/** "20/10, 10:00 · aceitou", or null when no slot was offered yet. */
export function lastOfferText(r: WaitlistRow): string | null {
  if (!r.lastOffer) return null;
  const answer = r.lastOffer.answer ? ANSWER[r.lastOffer.answer] : "sem resposta";
  return `${formatDateTime(r.lastOffer.startsAt)} · ${answer}`;
}

/** Default "até" in the add form: two weeks from today. */
export function defaultUntil(today: string): string {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 14);
  return d.toISOString().slice(0, 10);
}
