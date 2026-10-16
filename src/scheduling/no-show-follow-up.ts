import type { PrismaClient } from "@prisma/client";
import type { ConversationStore } from "../conversation/store.js";
import type { Logger } from "../lib/logger.js";
import type { FieldCipher } from "../privacy/index.js";
import { previewText, type OutboundMessage, type WhatsAppChannel } from "../whatsapp/index.js";
import type { InMemoryAgendaRepository } from "./memory-agenda.js";
import { addDays, dateInZone, formatWhenPtBr, minuteOfDayInZone } from "./time.js";

/** A missed appointment that may get its "we missed you" message. */
export type NoShowCandidate = {
  appointmentId: string;
  clinicId: string;
  clinicName: string;
  clinicTimeZone: string;
  patientName: string;
  /** Decrypted WhatsApp number (wa_id). */
  phone: string;
  startsAt: Date;
};

export interface NoShowFollowUpRepository {
  /**
   * NO_SHOW appointments starting in [from, to), without a notice yet, of patients not
   * anonymized and with nothing pending or confirmed from `to` on (they already rebooked).
   * Every clinic unless `clinicId` narrows it (tests sharing a database).
   */
  noShowCandidates(from: Date, to: Date, clinicId?: string): Promise<NoShowCandidate[]>;
  /** Marks the notice as taken. False if another run took it or the status changed. */
  claimNoShowNotice(appointmentId: string, at: Date): Promise<boolean>;
  /** Gives the notice back after a failed send, so the next run retries. */
  releaseNoShowNotice(appointmentId: string): Promise<void>;
}

export type NoShowFollowUpConfig = {
  /** Send from the day after the appointment up to this many days after (late marking). */
  maxDaysAfter: number;
  /** Only send between these local hours [start, end). */
  sendFromHour: number;
  sendUntilHour: number;
};

export const DEFAULT_NO_SHOW_FOLLOW_UP_CONFIG: NoShowFollowUpConfig = {
  maxDaysAfter: 3,
  sendFromHour: 9,
  sendUntilHour: 19,
};

/** Reply ids of the template's buttons, in order. */
export const noShowButtons = (appointmentId: string) => [`appt:${appointmentId}:rebook`, "handoff"];

const DAY_MS = 86_400_000;
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/**
 * After the front desk marks "Faltou", sends the `consulta_perdida` template once, the day
 * after, with "Marcar novo horário" and "Falar com a recepção". Skipped if the patient has
 * already booked again or the front desk is in the chat.
 *
 * Safe to run often and from several processes: each notice is claimed before sending and
 * released if the send fails.
 */
export class NoShowFollowUps {
  private readonly config: NoShowFollowUpConfig;

  constructor(
    private readonly deps: {
      repo: NoShowFollowUpRepository;
      channel: WhatsAppChannel;
      store: ConversationStore;
      logger: Logger;
      config?: Partial<NoShowFollowUpConfig>;
    },
  ) {
    this.config = { ...DEFAULT_NO_SHOW_FOLLOW_UP_CONFIG, ...deps.config };
  }

  async run(now: Date, clinicId?: string): Promise<{ sent: number }> {
    const { repo, logger } = this.deps;
    const { maxDaysAfter, sendFromHour, sendUntilHour } = this.config;
    // Widened by a day; each row is checked in its clinic's zone.
    const rows = await repo.noShowCandidates(
      new Date(now.getTime() - (maxDaysAfter + 1) * DAY_MS),
      now,
      clinicId,
    );
    let sent = 0;
    for (const c of rows) {
      const today = dateInZone(now, c.clinicTimeZone);
      const day = dateInZone(c.startsAt, c.clinicTimeZone);
      const hour = Math.floor(minuteOfDayInZone(now, c.clinicTimeZone) / 60);
      if (day >= today || day < addDays(today, -maxDaysAfter)) continue;
      if (hour < sendFromHour || hour >= sendUntilHour) continue;
      const conv = await this.deps.store.getOrCreateConversation(c.clinicId, c.phone);
      // The front desk is talking to the patient: leave it to them, try again later.
      if (conv.botPausedUntil && conv.botPausedUntil > now) continue;
      if (!(await repo.claimNoShowNotice(c.appointmentId, now))) continue;
      try {
        const msg: OutboundMessage = {
          kind: "template",
          to: conv.contact,
          template: "consulta_perdida",
          params: [
            firstName(c.patientName),
            formatWhenPtBr(c.startsAt, c.clinicTimeZone),
            c.clinicName,
          ],
          buttonPayloads: noShowButtons(c.appointmentId),
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
        await repo.releaseNoShowNotice(c.appointmentId);
        logger.error(
          { appointmentId: c.appointmentId, err: err instanceof Error ? err.message : "unknown" },
          "no-show notice failed",
        );
      }
    }
    if (sent) logger.info({ sent }, "no-show notices");
    return { sent };
  }
}

export class PrismaNoShowFollowUpRepository implements NoShowFollowUpRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly cipher: FieldCipher,
  ) {}

  async noShowCandidates(from: Date, to: Date, clinicId?: string) {
    const rows = await this.db.appointment.findMany({
      where: {
        ...(clinicId ? { clinicId } : {}),
        status: "NO_SHOW",
        noShowNoticeAt: null,
        startsAt: { gte: from, lt: to },
        patient: {
          anonymizedAt: null,
          appointments: {
            none: { status: { in: ["PENDING_CONFIRMATION", "CONFIRMED"] }, startsAt: { gte: to } },
          },
        },
      },
      orderBy: { startsAt: "asc" },
      take: 500,
      select: {
        id: true,
        clinicId: true,
        startsAt: true,
        clinic: { select: { name: true, timezone: true } },
        patient: { select: { name: true, phoneEncrypted: true } },
      },
    });
    return rows.map((a) => ({
      appointmentId: a.id,
      clinicId: a.clinicId,
      clinicName: a.clinic.name,
      clinicTimeZone: a.clinic.timezone,
      patientName: a.patient.name,
      phone: this.cipher.decrypt(a.patient.phoneEncrypted),
      startsAt: a.startsAt,
    }));
  }

  async claimNoShowNotice(appointmentId: string, at: Date) {
    const { count } = await this.db.appointment.updateMany({
      where: { id: appointmentId, noShowNoticeAt: null, status: "NO_SHOW" },
      data: { noShowNoticeAt: at },
    });
    return count === 1;
  }

  async releaseNoShowNotice(appointmentId: string) {
    await this.db.appointment.updateMany({
      where: { id: appointmentId },
      data: { noShowNoticeAt: null },
    });
  }
}

/** No-show notices over the in-memory agenda (tests and the conversation eval). */
export class InMemoryNoShowFollowUpRepository implements NoShowFollowUpRepository {
  constructor(
    private readonly agenda: InMemoryAgendaRepository,
    private readonly clinicName: string,
  ) {}

  async noShowCandidates(from: Date, to: Date, clinicId?: string) {
    if (clinicId && clinicId !== this.agenda.clinicId) return [];
    const appts = this.agenda.appointments;
    return appts
      .filter(
        (a) =>
          a.status === "NO_SHOW" &&
          !a.noShowNoticeAt &&
          a.startsAt >= from &&
          a.startsAt < to &&
          !appts.some(
            (b) =>
              b.patientId === a.patientId &&
              (b.status === "PENDING_CONFIRMATION" || b.status === "CONFIRMED") &&
              b.startsAt >= to,
          ),
      )
      .flatMap((a) => {
        const patient = this.agenda.patients.find((p) => p.id === a.patientId);
        if (!patient) return [];
        return [
          {
            appointmentId: a.id,
            clinicId: this.agenda.clinicId,
            clinicName: this.clinicName,
            clinicTimeZone: this.agenda.timeZone,
            patientName: patient.name,
            phone: patient.phone,
            startsAt: a.startsAt,
          },
        ];
      });
  }

  async claimNoShowNotice(appointmentId: string, at: Date) {
    const a = this.agenda.appointments.find((x) => x.id === appointmentId);
    if (!a || a.noShowNoticeAt || a.status !== "NO_SHOW") return false;
    a.noShowNoticeAt = at;
    return true;
  }

  async releaseNoShowNotice(appointmentId: string) {
    const a = this.agenda.appointments.find((x) => x.id === appointmentId);
    if (a) a.noShowNoticeAt = null;
  }
}
