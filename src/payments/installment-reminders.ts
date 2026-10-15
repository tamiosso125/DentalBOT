import type { PrismaClient } from "@prisma/client";
import type { ConversationStore } from "../conversation/store.js";
import type { Logger } from "../lib/logger.js";
import { formatCents } from "../lib/money.js";
import type { FieldCipher } from "../privacy/index.js";
import { addDays, dateInZone, minuteOfDayInZone } from "../scheduling/time.js";
import { previewText, type OutboundMessage, type WhatsAppChannel } from "../whatsapp/index.js";
import type { PaymentsGateway } from "./asaas.js";

/** A billed installment that may need its payment-link reminder. */
export type ReminderCandidate = {
  installmentId: string;
  clinicId: string;
  clinicTimeZone: string;
  patientName: string;
  /** Decrypted WhatsApp number (wa_id). */
  phone: string;
  number: number;
  installmentCount: number;
  amountCents: number;
  /** YYYY-MM-DD */
  dueDate: string;
};

export interface ReminderRepository {
  /** BILLED installments after the first, not reminded yet, due between the two dates. */
  candidates(fromDate: string, toDate: string): Promise<ReminderCandidate[]>;
  /** Marks the reminder as taken. False if another run already took it. */
  claim(installmentId: string, at: Date): Promise<boolean>;
  /** Gives the reminder back after a failed send, so the next run retries. */
  release(installmentId: string): Promise<void>;
}

export type ReminderConfig = {
  /** Remind this many days before the due date (and every day until it, if missed). */
  daysBefore: number;
  /** Only send between these local hours [start, end). */
  sendFromHour: number;
  sendUntilHour: number;
};

export const DEFAULT_REMINDER_CONFIG: ReminderConfig = {
  daysBefore: 3,
  sendFromHour: 9,
  sendUntilHour: 19,
};

/** Asaas statuses that mean the installment is already paid (webhook may be late). */
const PAID_STATUSES = new Set(["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"]);

const ddmmyyyy = (date: string) => date.split("-").reverse().join("/");
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/**
 * Sends the payment link of each upcoming installment by WhatsApp, a few days before it is
 * due. The first installment's link already went out when the patient approved the quote,
 * so only the later ones are reminded. Clinic-initiated, so always the approved template
 * `cobranca_parcela`.
 *
 * Safe to run often and from several processes: each installment is claimed before sending
 * (one reminder each), and a failed send releases it for the next run.
 */
export class InstallmentReminders {
  private readonly config: ReminderConfig;

  constructor(
    private readonly deps: {
      repo: ReminderRepository;
      gateway: PaymentsGateway;
      channel: WhatsAppChannel;
      store: ConversationStore;
      logger: Logger;
      config?: Partial<ReminderConfig>;
    },
  ) {
    this.config = { ...DEFAULT_REMINDER_CONFIG, ...deps.config };
  }

  async run(now: Date): Promise<{ sent: number; skipped: number }> {
    const { repo, logger } = this.deps;
    const { daysBefore, sendFromHour, sendUntilHour } = this.config;
    // UTC dates widened by a day on each side; each row is checked in its clinic's zone.
    const utcToday = now.toISOString().slice(0, 10);
    const candidates = await repo.candidates(
      addDays(utcToday, -1),
      addDays(utcToday, daysBefore + 1),
    );

    let sent = 0;
    let skipped = 0;
    for (const c of candidates) {
      const today = dateInZone(now, c.clinicTimeZone);
      const hour = Math.floor(minuteOfDayInZone(now, c.clinicTimeZone) / 60);
      const due = c.dueDate >= today && c.dueDate <= addDays(today, daysBefore);
      if (!due || hour < sendFromHour || hour >= sendUntilHour) continue;
      if (!(await repo.claim(c.installmentId, now))) continue;
      try {
        if (await this.remind(c, now)) sent++;
        else skipped++;
      } catch (err) {
        await repo.release(c.installmentId);
        logger.error(
          { installmentId: c.installmentId, err: err instanceof Error ? err.message : "unknown" },
          "installment reminder failed",
        );
      }
    }
    if (sent || skipped) logger.info({ sent, skipped }, "installment reminders");
    return { sent, skipped };
  }

  /** Returns false when there is nothing to send (already paid in Asaas). */
  private async remind(c: ReminderCandidate, now: Date): Promise<boolean> {
    const { gateway, channel, store, logger } = this.deps;
    const charge = await gateway.findCharge(c.installmentId);
    if (!charge) throw new Error("Asaas charge not found");
    if (PAID_STATUSES.has(charge.status)) {
      logger.info({ installmentId: c.installmentId }, "installment already paid, no reminder");
      return false;
    }
    const conv = await store.getOrCreateConversation(c.clinicId, c.phone);
    const msg: OutboundMessage = {
      kind: "template",
      to: conv.contact,
      template: "cobranca_parcela",
      params: [
        firstName(c.patientName),
        `${c.number}/${c.installmentCount}`,
        formatCents(c.amountCents),
        ddmmyyyy(c.dueDate),
        charge.invoiceUrl,
      ],
    };
    const { waMessageId } = await channel.send(msg);
    await store.saveMessage({
      conversationId: conv.id,
      waMessageId,
      direction: "OUTBOUND",
      type: msg.kind,
      body: previewText(msg),
      at: now,
    });
    return true;
  }
}

const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);

export class PrismaReminderRepository implements ReminderRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly cipher: FieldCipher,
  ) {}

  async candidates(fromDate: string, toDate_: string) {
    const rows = await this.db.installment.findMany({
      where: {
        status: "BILLED",
        number: { gt: 1 },
        reminderSentAt: null,
        asaasPaymentId: { not: null },
        dueDate: { gte: toDate(fromDate), lte: toDate(toDate_) },
        quote: { status: "ACCEPTED" },
      },
      orderBy: { dueDate: "asc" },
      take: 500,
      include: {
        quote: {
          select: {
            clinicId: true,
            installmentCount: true,
            clinic: { select: { timezone: true } },
            patient: { select: { name: true, phoneEncrypted: true } },
          },
        },
      },
    });
    return rows.map((i) => ({
      installmentId: i.id,
      clinicId: i.quote.clinicId,
      clinicTimeZone: i.quote.clinic.timezone,
      patientName: i.quote.patient.name,
      phone: this.cipher.decrypt(i.quote.patient.phoneEncrypted),
      number: i.number,
      installmentCount: i.quote.installmentCount,
      amountCents: i.amountCents,
      dueDate: i.dueDate.toISOString().slice(0, 10),
    }));
  }

  async claim(installmentId: string, at: Date) {
    const { count } = await this.db.installment.updateMany({
      where: { id: installmentId, reminderSentAt: null, status: "BILLED" },
      data: { reminderSentAt: at },
    });
    return count === 1;
  }

  async release(installmentId: string) {
    await this.db.installment.updateMany({
      where: { id: installmentId },
      data: { reminderSentAt: null },
    });
  }
}

export class InMemoryReminderRepository implements ReminderRepository {
  readonly rows: Array<ReminderCandidate & { status: string; reminderSentAt: Date | null }> = [];

  async candidates(fromDate: string, toDate_: string) {
    return this.rows
      .filter(
        (r) =>
          r.status === "BILLED" &&
          r.number > 1 &&
          r.reminderSentAt === null &&
          r.dueDate >= fromDate &&
          r.dueDate <= toDate_,
      )
      .map((r) => {
        const c: Partial<(typeof this.rows)[number]> = { ...r };
        delete c.status;
        delete c.reminderSentAt;
        return c as ReminderCandidate;
      });
  }

  async claim(installmentId: string, at: Date) {
    const r = this.rows.find((x) => x.installmentId === installmentId);
    if (!r || r.reminderSentAt || r.status !== "BILLED") return false;
    r.reminderSentAt = at;
    return true;
  }

  async release(installmentId: string) {
    const r = this.rows.find((x) => x.installmentId === installmentId);
    if (r) r.reminderSentAt = null;
  }
}
