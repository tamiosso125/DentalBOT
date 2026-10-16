import type { ConversationStore } from "../conversation/store.js";
import type { Logger } from "../lib/logger.js";
import { formatCents } from "../lib/money.js";
import { dateInZone, minuteOfDayInZone } from "../scheduling/time.js";
import { previewText, type OutboundMessage, type WhatsAppChannel } from "../whatsapp/index.js";
import { ddmmyyyy } from "./quote-pdf.js";

/** A sent quote the patient has not answered yet. */
export type UnansweredQuote = {
  quoteId: string;
  clinicId: string;
  clinicName: string;
  clinicTimeZone: string;
  patientName: string;
  /** Decrypted WhatsApp number (wa_id). */
  phone: string;
  totalCents: number;
  sentAt: Date;
  /** "YYYY-MM-DD", last day the quote can be accepted. */
  validUntil: string;
};

/** Storage port for the follow-up job. Rows of anonymized patients never come back. */
export interface QuoteFollowUpRepository {
  /**
   * SENT quotes with a validity, sent at or before `sentBefore`, not reminded yet. Every
   * clinic unless `clinicId` narrows it (tests sharing a database).
   */
  unanswered(sentBefore: Date, clinicId?: string): Promise<UnansweredQuote[]>;
  /** Marks the reminder as taken. False if another run took it or the quote was answered. */
  claimReminder(quoteId: string, at: Date): Promise<boolean>;
  /** Gives the reminder back after a failed send, so the next run retries. */
  releaseReminder(quoteId: string): Promise<void>;
  /** SENT quotes valid until `onOrBefore` at the latest (each checked in its clinic's zone). */
  expiring(
    onOrBefore: string,
  ): Promise<Array<{ quoteId: string; clinicTimeZone: string; validUntil: string }>>;
  /** SENT -> EXPIRED. False if the patient answered in the meantime. */
  expire(quoteId: string, at: Date): Promise<boolean>;
}

export type QuoteFollowUpConfig = {
  /** Remind once, this many days after the quote went out. */
  remindAfterDays: number;
  /** Only send between these local hours [start, end). */
  sendFromHour: number;
  sendUntilHour: number;
};

export const DEFAULT_QUOTE_FOLLOW_UP_CONFIG: QuoteFollowUpConfig = {
  remindAfterDays: 3,
  sendFromHour: 9,
  sendUntilHour: 19,
};

const DAY_MS = 86_400_000;
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/**
 * Follows up on quotes nobody answered: one reminder (`lembrete_orcamento`, with the same
 * "Ver orçamento" button that brings the PDF and the approve buttons) a few days after the
 * quote went out, and EXPIRED once its validity is over, so the panel shows the real state.
 *
 * Safe to run often and from several processes: the reminder is claimed before sending and
 * released if the send fails; expiring only moves quotes that are still SENT.
 */
export class QuoteFollowUps {
  private readonly config: QuoteFollowUpConfig;

  constructor(
    private readonly deps: {
      repo: QuoteFollowUpRepository;
      channel: WhatsAppChannel;
      store: ConversationStore;
      logger: Logger;
      config?: Partial<QuoteFollowUpConfig>;
    },
  ) {
    this.config = { ...DEFAULT_QUOTE_FOLLOW_UP_CONFIG, ...deps.config };
  }

  async run(now: Date): Promise<{ reminded: number; expired: number }> {
    const { repo, logger } = this.deps;
    let expired = 0;
    // UTC "today" is at most a day off the clinic's; each row is checked in its own zone.
    for (const q of await repo.expiring(now.toISOString().slice(0, 10))) {
      if (dateInZone(now, q.clinicTimeZone) > q.validUntil && (await repo.expire(q.quoteId, now)))
        expired++;
    }

    let reminded = 0;
    const { remindAfterDays, sendFromHour, sendUntilHour } = this.config;
    for (const q of await repo.unanswered(new Date(now.getTime() - remindAfterDays * DAY_MS))) {
      const today = dateInZone(now, q.clinicTimeZone);
      const hour = Math.floor(minuteOfDayInZone(now, q.clinicTimeZone) / 60);
      if (q.validUntil < today || hour < sendFromHour || hour >= sendUntilHour) continue;
      const conv = await this.deps.store.getOrCreateConversation(q.clinicId, q.phone);
      // The front desk is talking to the patient: leave it to them, try again later.
      if (conv.botPausedUntil && conv.botPausedUntil > now) continue;
      if (!(await repo.claimReminder(q.quoteId, now))) continue;
      try {
        const msg: OutboundMessage = {
          kind: "template",
          to: conv.contact,
          template: "lembrete_orcamento",
          params: [
            firstName(q.patientName),
            q.clinicName,
            formatCents(q.totalCents),
            q.validUntil === today ? "hoje" : ddmmyyyy(q.validUntil),
          ],
          buttonPayloads: [`quote:${q.quoteId}:view`, "handoff"],
        };
        const { waMessageId } = await this.deps.channel.send(msg);
        await this.deps.store.saveMessage({
          conversationId: conv.id,
          waMessageId,
          direction: "OUTBOUND",
          type: msg.kind,
          body: previewText(msg),
          at: now,
        });
        reminded++;
      } catch (err) {
        await repo.releaseReminder(q.quoteId);
        logger.error(
          { quoteId: q.quoteId, err: err instanceof Error ? err.message : "unknown" },
          "quote reminder failed",
        );
      }
    }
    if (reminded || expired) logger.info({ reminded, expired }, "quote follow-ups");
    return { reminded, expired };
  }
}
