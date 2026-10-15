import type { PrismaClient } from "@prisma/client";
import type { ConversationStore } from "../conversation/store.js";
import type { Logger } from "../lib/logger.js";
import type { FieldCipher } from "../privacy/index.js";
import { previewText, type OutboundMessage, type WhatsAppChannel } from "../whatsapp/index.js";
import type { InMemoryAgendaRepository } from "./memory-agenda.js";
import { addDays, dateInZone, formatWhenPtBr, minuteOfDayInZone } from "./time.js";

/** An upcoming appointment that may need its day-before reminder. */
export type AppointmentReminderCandidate = {
  appointmentId: string;
  clinicId: string;
  clinicName: string;
  clinicTimeZone: string;
  patientName: string;
  /** Decrypted WhatsApp number (wa_id). */
  phone: string;
  startsAt: Date;
};

export interface AppointmentReminderRepository {
  /** Pending or confirmed appointments, not reminded yet, starting in [from, to). */
  candidates(from: Date, to: Date): Promise<AppointmentReminderCandidate[]>;
  /** Marks the reminder as taken. False if another run already took it. */
  claim(appointmentId: string, at: Date): Promise<boolean>;
  /** Gives the reminder back after a failed send, so the next run retries. */
  release(appointmentId: string): Promise<void>;
}

export type AppointmentReminderConfig = {
  /** Only send between these local hours [start, end). */
  sendFromHour: number;
  sendUntilHour: number;
};

export const DEFAULT_APPOINTMENT_REMINDER_CONFIG: AppointmentReminderConfig = {
  sendFromHour: 9,
  sendUntilHour: 19,
};

/** Reply ids of the reminder's quick-reply buttons, in the template's button order. */
export const appointmentButtons = (appointmentId: string) => [
  `appt:${appointmentId}:confirm`,
  `appt:${appointmentId}:reschedule`,
];

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/**
 * Sends the `lembrete_consulta` template the day before each appointment, with
 * "Confirmar" and "Remarcar" buttons. Clinic-initiated, so always the approved template.
 *
 * Safe to run often and from several processes: each appointment is claimed before
 * sending (one reminder each; moving it to another date clears the claim), and a failed
 * send releases it for the next run.
 */
export class AppointmentReminders {
  private readonly config: AppointmentReminderConfig;

  constructor(
    private readonly deps: {
      repo: AppointmentReminderRepository;
      channel: WhatsAppChannel;
      store: ConversationStore;
      logger: Logger;
      config?: Partial<AppointmentReminderConfig>;
    },
  ) {
    this.config = { ...DEFAULT_APPOINTMENT_REMINDER_CONFIG, ...deps.config };
  }

  async run(now: Date): Promise<{ sent: number }> {
    const { repo, logger } = this.deps;
    const { sendFromHour, sendUntilHour } = this.config;
    // Wide UTC window; each row is checked against "tomorrow" in its clinic's zone.
    const candidates = await repo.candidates(now, new Date(now.getTime() + 3 * 86_400_000));

    let sent = 0;
    for (const c of candidates) {
      const tomorrow = addDays(dateInZone(now, c.clinicTimeZone), 1);
      const hour = Math.floor(minuteOfDayInZone(now, c.clinicTimeZone) / 60);
      if (dateInZone(c.startsAt, c.clinicTimeZone) !== tomorrow) continue;
      if (hour < sendFromHour || hour >= sendUntilHour) continue;
      if (!(await repo.claim(c.appointmentId, now))) continue;
      try {
        await this.remind(c, now);
        sent++;
      } catch (err) {
        await repo.release(c.appointmentId);
        logger.error(
          { appointmentId: c.appointmentId, err: err instanceof Error ? err.message : "unknown" },
          "appointment reminder failed",
        );
      }
    }
    if (sent) logger.info({ sent }, "appointment reminders");
    return { sent };
  }

  private async remind(c: AppointmentReminderCandidate, now: Date) {
    const { channel, store } = this.deps;
    const conv = await store.getOrCreateConversation(c.clinicId, c.phone);
    const msg: OutboundMessage = {
      kind: "template",
      to: conv.contact,
      template: "lembrete_consulta",
      params: [
        firstName(c.patientName),
        formatWhenPtBr(c.startsAt, c.clinicTimeZone),
        c.clinicName,
      ],
      buttonPayloads: appointmentButtons(c.appointmentId),
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
  }
}

const ACTIVE = { in: ["PENDING_CONFIRMATION" as const, "CONFIRMED" as const] };

export class PrismaAppointmentReminderRepository implements AppointmentReminderRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly cipher: FieldCipher,
  ) {}

  async candidates(from: Date, to: Date) {
    const rows = await this.db.appointment.findMany({
      where: { status: ACTIVE, reminderSentAt: null, startsAt: { gte: from, lt: to } },
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

  async claim(appointmentId: string, at: Date) {
    const { count } = await this.db.appointment.updateMany({
      where: { id: appointmentId, reminderSentAt: null, status: ACTIVE },
      data: { reminderSentAt: at },
    });
    return count === 1;
  }

  async release(appointmentId: string) {
    await this.db.appointment.updateMany({
      where: { id: appointmentId },
      data: { reminderSentAt: null },
    });
  }
}

/** Reminders over the in-memory agenda (tests and the conversation eval). */
export class InMemoryAppointmentReminderRepository implements AppointmentReminderRepository {
  constructor(
    private readonly agenda: InMemoryAgendaRepository,
    private readonly clinicName: string,
  ) {}

  async candidates(from: Date, to: Date) {
    return this.agenda.appointments
      .filter(
        (a) =>
          (a.status === "PENDING_CONFIRMATION" || a.status === "CONFIRMED") &&
          a.reminderSentAt === null &&
          a.startsAt >= from &&
          a.startsAt < to,
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

  async claim(appointmentId: string, at: Date) {
    const a = this.agenda.appointments.find((x) => x.id === appointmentId);
    if (!a || a.reminderSentAt || a.status === "CANCELLED") return false;
    a.reminderSentAt = at;
    return true;
  }

  async release(appointmentId: string) {
    const a = this.agenda.appointments.find((x) => x.id === appointmentId);
    if (a) a.reminderSentAt = null;
  }
}
