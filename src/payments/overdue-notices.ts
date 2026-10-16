import type { PrismaClient } from "@prisma/client";
import type { ConversationStore } from "../conversation/store.js";
import type { Logger } from "../lib/logger.js";
import { formatCents } from "../lib/money.js";
import type { FieldCipher } from "../privacy/index.js";
import { addDays, dateInZone, minuteOfDayInZone } from "../scheduling/time.js";
import { previewText, type OutboundMessage, type WhatsAppChannel } from "../whatsapp/index.js";
import type { PaymentsGateway } from "./asaas.js";
import type { ReminderCandidate } from "./installment-reminders.js";

/** A charged installment past its due date that may need its overdue notice. */
export type OverdueCandidate = ReminderCandidate & { clinicName: string };

export interface OverdueNoticeRepository {
  /**
   * Charged installments still open (BILLED or OVERDUE) of approved quotes, due between the
   * two dates, without a notice yet. Anonymized patients never come back. Every clinic
   * unless `clinicId` narrows it (tests sharing a database).
   */
  overdueCandidates(
    fromDate: string,
    toDate: string,
    clinicId?: string,
  ): Promise<OverdueCandidate[]>;
  /** Marks the notice as taken. False if another run took it or the installment was paid. */
  claimOverdueNotice(installmentId: string, at: Date): Promise<boolean>;
  /** Gives the notice back after a failed send, so the next run retries. */
  releaseOverdueNotice(installmentId: string): Promise<void>;
}

export type OverdueNoticeConfig = {
  /** Send this many days after the due date (once). */
  daysAfter: number;
  /** Older debts are left to the front desk: no surprise message weeks later. */
  maxDaysLate: number;
  /** Only send between these local hours [start, end). */
  sendFromHour: number;
  sendUntilHour: number;
};

export const DEFAULT_OVERDUE_NOTICE_CONFIG: OverdueNoticeConfig = {
  daysAfter: 1,
  maxDaysLate: 30,
  sendFromHour: 9,
  sendUntilHour: 19,
};

/** Asaas statuses that mean the installment is already paid (webhook may be late). */
const PAID_STATUSES = new Set(["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"]);

const ddmmyyyy = (date: string) => date.split("-").reverse().join("/");
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/**
 * Tells the patient, once, that an installment is past due, with the current Asaas payment
 * link and a button to talk to the front desk. Clinic-initiated, so always the approved
 * template `parcela_vencida`. Debts older than a week show up in the panel for a call.
 *
 * Safe to run often and from several processes: each notice is claimed before sending and
 * released if the send fails. Waits while the front desk is in the chat.
 */
export class OverdueNotices {
  private readonly config: OverdueNoticeConfig;

  constructor(
    private readonly deps: {
      repo: OverdueNoticeRepository;
      gateway: PaymentsGateway;
      channel: WhatsAppChannel;
      store: ConversationStore;
      logger: Logger;
      config?: Partial<OverdueNoticeConfig>;
    },
  ) {
    this.config = { ...DEFAULT_OVERDUE_NOTICE_CONFIG, ...deps.config };
  }

  async run(now: Date): Promise<{ sent: number; skipped: number }> {
    const { repo, logger } = this.deps;
    const { daysAfter, maxDaysLate, sendFromHour, sendUntilHour } = this.config;
    // UTC dates widened by a day on each side; each row is checked in its clinic's zone.
    const utcToday = now.toISOString().slice(0, 10);
    const candidates = await repo.overdueCandidates(
      addDays(utcToday, -maxDaysLate - 1),
      addDays(utcToday, -daysAfter + 1),
    );

    let sent = 0;
    let skipped = 0;
    for (const c of candidates) {
      const today = dateInZone(now, c.clinicTimeZone);
      const hour = Math.floor(minuteOfDayInZone(now, c.clinicTimeZone) / 60);
      const due =
        c.dueDate <= addDays(today, -daysAfter) && c.dueDate >= addDays(today, -maxDaysLate);
      if (!due || hour < sendFromHour || hour >= sendUntilHour) continue;
      const conv = await this.deps.store.getOrCreateConversation(c.clinicId, c.phone);
      // The front desk is talking to the patient: leave it to them, try again later.
      if (conv.botPausedUntil && conv.botPausedUntil > now) continue;
      if (!(await repo.claimOverdueNotice(c.installmentId, now))) continue;
      try {
        const charge = await this.deps.gateway.findCharge(c.installmentId);
        if (!charge) throw new Error("Asaas charge not found");
        if (PAID_STATUSES.has(charge.status)) {
          logger.info({ installmentId: c.installmentId }, "installment already paid, no notice");
          skipped++;
          continue;
        }
        const msg: OutboundMessage = {
          kind: "template",
          to: conv.contact,
          template: "parcela_vencida",
          params: [
            firstName(c.patientName),
            `${c.number}/${c.installmentCount}`,
            c.clinicName,
            formatCents(c.amountCents),
            ddmmyyyy(c.dueDate),
            charge.invoiceUrl,
          ],
          buttonPayloads: ["handoff"],
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
        sent++;
      } catch (err) {
        await repo.releaseOverdueNotice(c.installmentId);
        logger.error(
          { installmentId: c.installmentId, err: err instanceof Error ? err.message : "unknown" },
          "overdue notice failed",
        );
      }
    }
    if (sent || skipped) logger.info({ sent, skipped }, "overdue notices");
    return { sent, skipped };
  }
}

const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);

export class PrismaOverdueNoticeRepository implements OverdueNoticeRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly cipher: FieldCipher,
  ) {}

  async overdueCandidates(fromDate: string, toDate_: string, clinicId?: string) {
    const rows = await this.db.installment.findMany({
      where: {
        status: { in: ["BILLED", "OVERDUE"] },
        overdueNoticeAt: null,
        asaasPaymentId: { not: null },
        dueDate: { gte: toDate(fromDate), lte: toDate(toDate_) },
        quote: {
          ...(clinicId ? { clinicId } : {}),
          status: "ACCEPTED",
          patient: { anonymizedAt: null },
        },
      },
      orderBy: { dueDate: "asc" },
      take: 500,
      include: {
        quote: {
          select: {
            clinicId: true,
            installmentCount: true,
            clinic: { select: { name: true, timezone: true } },
            patient: { select: { name: true, phoneEncrypted: true } },
          },
        },
      },
    });
    return rows.map((i) => ({
      installmentId: i.id,
      clinicId: i.quote.clinicId,
      clinicName: i.quote.clinic.name,
      clinicTimeZone: i.quote.clinic.timezone,
      patientName: i.quote.patient.name,
      phone: this.cipher.decrypt(i.quote.patient.phoneEncrypted),
      number: i.number,
      installmentCount: i.quote.installmentCount,
      amountCents: i.amountCents,
      dueDate: i.dueDate.toISOString().slice(0, 10),
    }));
  }

  async claimOverdueNotice(installmentId: string, at: Date) {
    const { count } = await this.db.installment.updateMany({
      where: { id: installmentId, overdueNoticeAt: null, status: { in: ["BILLED", "OVERDUE"] } },
      data: { overdueNoticeAt: at },
    });
    return count === 1;
  }

  async releaseOverdueNotice(installmentId: string) {
    await this.db.installment.updateMany({
      where: { id: installmentId },
      data: { overdueNoticeAt: null },
    });
  }
}
