/** Display helpers for quotes waiting on the patient. Data comes from GET /admin/quotes/follow-up. */

export type QuoteFollowUp = {
  waiting: Array<{
    id: string;
    patientName: string;
    totalCents: number;
    sentAt: string;
    reminderSentAt: string | null;
    validUntil: string | null;
  }>;
  month: { accepted: number; rejected: number; expired: number };
};

const DAY_MS = 86_400_000;

/** Share of this month's answered quotes that were approved, in whole percent; null if none. */
export function acceptanceRate(month: QuoteFollowUp["month"]): number | null {
  const total = month.accepted + month.rejected + month.expired;
  return total === 0 ? null : Math.round((month.accepted / total) * 100);
}

/** Whole days since the quote went out. */
export function daysWaiting(sentAt: string, now = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(sentAt).getTime()) / DAY_MS));
}

/** "hoje", "há 1 dia", "há 5 dias". */
export function waitingLabel(sentAt: string, now = new Date()): string {
  const d = daysWaiting(sentAt, now);
  return d === 0 ? "hoje" : d === 1 ? "há 1 dia" : `há ${d} dias`;
}
