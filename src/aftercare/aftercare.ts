import type { ConversationStore } from "../conversation/store.js";
import type { Logger } from "../lib/logger.js";
import { maskPhone } from "../privacy/index.js";
import { addDays, dateInZone, minuteOfDayInZone, zonedToUtc } from "../scheduling/time.js";
import {
  previewText,
  type OutboundMessage,
  type TemplateName,
  type WhatsAppChannel,
} from "../whatsapp/index.js";

export type AftercareAnswer = "OK" | "HELP";

/** An attended appointment whose procedure has care instructions, not sent yet. */
export type InstructionCandidate = {
  appointmentId: string;
  clinicId: string;
  clinicName: string;
  clinicTimeZone: string;
  patientId: string;
  patientName: string;
  /** Decrypted WhatsApp number (wa_id). */
  phone: string;
  startsAt: Date;
  procedureName: string;
  aftercareText: string;
};

/** Instructions already sent, waiting for the next-day check-in. */
export type CheckInCandidate = {
  followUpId: string;
  clinicId: string;
  clinicName: string;
  clinicTimeZone: string;
  patientName: string;
  phone: string;
  procedureName: string;
  instructionsSentAt: Date;
};

export type StoredFollowUp = {
  id: string;
  /** Decrypted WhatsApp number of the follow-up's patient. */
  phone: string;
  checkInSentAt: Date | null;
  answer: AftercareAnswer | null;
};

export type HelpRequest = {
  followUpId: string;
  patientId: string;
  patientName: string;
  phone: string;
  procedureName: string;
  appointmentAt: Date;
  answeredAt: Date;
};

/** Storage port. Every read and write by id is scoped by clinic. */
export interface AftercareRepository {
  /**
   * COMPLETED appointments starting in [from, to) whose procedure has care text and that
   * have no follow-up yet, of patients not anonymized. Every clinic unless `clinicId`
   * narrows it (tests sharing a database).
   */
  instructionCandidates(from: Date, to: Date, clinicId?: string): Promise<InstructionCandidate[]>;
  /** Creates the follow-up before sending. Null if the appointment already has one. */
  create(candidate: InstructionCandidate, at: Date): Promise<string | null>;
  /** Gives the appointment back after a failed send of the instructions. */
  remove(followUpId: string): Promise<void>;
  /** Follow-ups whose instructions went out in [from, to) and have no check-in yet. */
  checkInCandidates(from: Date, to: Date, clinicId?: string): Promise<CheckInCandidate[]>;
  /** Marks the check-in as sent. False if another run already took it. */
  claimCheckIn(followUpId: string, at: Date): Promise<boolean>;
  /** Undoes the claim after a failed send. */
  releaseCheckIn(followUpId: string): Promise<void>;
  get(clinicId: string, followUpId: string): Promise<StoredFollowUp | null>;
  recordAnswer(followUpId: string, answer: AftercareAnswer, at: Date): Promise<void>;
  clinicTimeZone(clinicId: string): Promise<string | null>;
  /** Follow-ups of the clinic whose instructions went out in [from, to), with their answers. */
  sentBetween(
    clinicId: string,
    from: Date,
    to: Date,
  ): Promise<Array<{ checkIn: boolean; answer: AftercareAnswer | null }>>;
  /** "Preciso de ajuda" answers since `since`, newest first. */
  helpRequests(clinicId: string, since: Date): Promise<HelpRequest[]>;
}

export type AftercareConfig = {
  /** Instructions go out for appointments of today or up to this many days ago. */
  maxDaysLate: number;
  /** Local hours [start, end) for the instructions. */
  instructionsFromHour: number;
  instructionsUntilHour: number;
  /** Local hours [start, end) for the check-in, from the day after the instructions. */
  checkInFromHour: number;
  checkInUntilHour: number;
  /** No check-in once this many days passed since the instructions. */
  checkInMaxDays: number;
};

export const DEFAULT_AFTERCARE_CONFIG: AftercareConfig = {
  maxDaysLate: 1,
  instructionsFromHour: 8,
  instructionsUntilHour: 21,
  checkInFromHour: 10,
  checkInUntilHour: 19,
  checkInMaxDays: 2,
};

/** Longest care text the panel accepts: it travels as a template parameter. */
export const MAX_AFTERCARE_TEXT = 600;

/** Reply ids of the check-in buttons, in order: "Tudo bem", "Preciso de ajuda". */
export const aftercareButtons = (followUpId: string) => [
  `care:${followUpId}:ok`,
  `care:${followUpId}:help`,
];

export const AFTERCARE_MESSAGES = {
  ok: "Que bom! Continue seguindo as orientações da dentista. Se algo mudar, é só escrever aqui.",
  help: "Certo, já avisamos a equipe da clínica, que vai falar com você em breve. Se tiver inchaço que dificulta respirar ou engolir, febre alta ou sangramento que não para, procure agora um pronto-socorro.",
  answered: "Você já respondeu. Se precisar de algo, é só escrever aqui.",
  notFound: "Não encontrei esse acompanhamento. Se precisar, é só escrever aqui.",
} as const;

export type AftercareSummary = {
  month: { sent: number; checkIns: number; ok: number; help: number };
  /** "Preciso de ajuda" of the last 14 days, for the front desk to follow up. */
  help: Array<{
    followUpId: string;
    patientId: string;
    patientName: string;
    /** Last 4 digits only. */
    patientPhone: string;
    procedureName: string;
    appointmentAt: string;
    answeredAt: string;
  }>;
};

const DAY_MS = 86_400_000;
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** Meta refuses line breaks, tabs and runs of spaces inside template parameters. */
export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Post-procedure care. When the front desk marks "Compareceu" on a procedure that has
 * care text, the patient gets the dentist's instructions (orientacoes_pos_procedimento).
 * The next day the bot asks how they are (acompanhamento_pos_procedimento): "Preciso de
 * ajuda" calls the front desk. The bot relays the dentist's words and never adds its own.
 *
 * Safe to run often and from several processes: the follow-up row (unique per
 * appointment) and the check-in claim are written before sending and undone on failure.
 */
export class AftercareService {
  private readonly config: AftercareConfig;

  constructor(
    private readonly deps: {
      repo: AftercareRepository;
      channel: WhatsAppChannel;
      store: ConversationStore;
      logger: Logger;
      config?: Partial<AftercareConfig>;
    },
  ) {
    this.config = { ...DEFAULT_AFTERCARE_CONFIG, ...deps.config };
  }

  async run(now: Date, clinicId?: string): Promise<{ instructions: number; checkIns: number }> {
    const instructions = await this.sendInstructions(now, clinicId);
    const checkIns = await this.sendCheckIns(now, clinicId);
    if (instructions || checkIns) this.deps.logger.info({ instructions, checkIns }, "aftercare");
    return { instructions, checkIns };
  }

  private async sendInstructions(now: Date, clinicId?: string) {
    const { repo, logger } = this.deps;
    const { maxDaysLate, instructionsFromHour, instructionsUntilHour } = this.config;
    // Widened by a day; each row is checked in its clinic's zone.
    const rows = await repo.instructionCandidates(
      new Date(now.getTime() - (maxDaysLate + 1) * DAY_MS),
      now,
      clinicId,
    );
    let sent = 0;
    for (const c of rows) {
      const today = dateInZone(now, c.clinicTimeZone);
      const day = dateInZone(c.startsAt, c.clinicTimeZone);
      if (day > today || day < addDays(today, -maxDaysLate)) continue;
      if (!this.inHours(now, c.clinicTimeZone, instructionsFromHour, instructionsUntilHour))
        continue;
      const text = oneLine(c.aftercareText);
      if (!text) continue;
      const conv = await this.deps.store.getOrCreateConversation(c.clinicId, c.phone);
      // The front desk is talking to the patient: leave it for a later run.
      if (conv.botPausedUntil && conv.botPausedUntil > now) continue;
      const followUpId = await repo.create(c, now);
      if (!followUpId) continue;
      try {
        await this.send(conv, "orientacoes_pos_procedimento", now, [
          firstName(c.patientName),
          c.clinicName,
          c.procedureName,
          text,
        ]);
        sent++;
      } catch (err) {
        await repo.remove(followUpId);
        logger.error(
          { appointmentId: c.appointmentId, err: err instanceof Error ? err.message : "unknown" },
          "aftercare instructions send failed",
        );
      }
    }
    return sent;
  }

  private async sendCheckIns(now: Date, clinicId?: string) {
    const { repo, logger } = this.deps;
    const { checkInFromHour, checkInUntilHour, checkInMaxDays } = this.config;
    const rows = await repo.checkInCandidates(
      new Date(now.getTime() - (checkInMaxDays + 1) * DAY_MS),
      now,
      clinicId,
    );
    let sent = 0;
    for (const c of rows) {
      const today = dateInZone(now, c.clinicTimeZone);
      const day = dateInZone(c.instructionsSentAt, c.clinicTimeZone);
      if (day >= today || day < addDays(today, -checkInMaxDays)) continue;
      if (!this.inHours(now, c.clinicTimeZone, checkInFromHour, checkInUntilHour)) continue;
      const conv = await this.deps.store.getOrCreateConversation(c.clinicId, c.phone);
      if (conv.botPausedUntil && conv.botPausedUntil > now) continue;
      if (!(await repo.claimCheckIn(c.followUpId, now))) continue;
      try {
        await this.send(
          conv,
          "acompanhamento_pos_procedimento",
          now,
          [firstName(c.patientName), c.procedureName, c.clinicName],
          aftercareButtons(c.followUpId),
        );
        sent++;
      } catch (err) {
        await repo.releaseCheckIn(c.followUpId);
        logger.error(
          { followUpId: c.followUpId, err: err instanceof Error ? err.message : "unknown" },
          "aftercare check-in send failed",
        );
      }
    }
    return sent;
  }

  private inHours(now: Date, timeZone: string, from: number, until: number) {
    const hour = Math.floor(minuteOfDayInZone(now, timeZone) / 60);
    return hour >= from && hour < until;
  }

  private async send(
    conv: { id: string; contact: string },
    template: TemplateName,
    now: Date,
    params: string[],
    buttonPayloads?: string[],
  ) {
    const msg: OutboundMessage = {
      kind: "template",
      to: conv.contact,
      template,
      params,
      ...(buttonPayloads ? { buttonPayloads } : {}),
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
  }

  /**
   * A check-in button. Only the follow-up's own patient can answer it. Works while the bot
   * is paused: it answers something the clinic sent. "Preciso de ajuda" always calls the
   * front desk, even after an earlier "Tudo bem".
   */
  async answer(
    clinicId: string,
    contact: string,
    followUpId: string,
    answer: AftercareAnswer,
    now: Date,
  ): Promise<{ text: string; handoff?: string }> {
    const { repo, logger } = this.deps;
    const f = await repo.get(clinicId, followUpId);
    if (!f || f.phone !== contact || !f.checkInSentAt) return { text: AFTERCARE_MESSAGES.notFound };
    if (answer === "HELP") {
      if (f.answer !== "HELP") await repo.recordAnswer(followUpId, "HELP", now);
      logger.info({ followUpId }, "aftercare: patient asked for help");
      return { text: AFTERCARE_MESSAGES.help, handoff: "aftercare:help" };
    }
    if (f.answer !== null) return { text: AFTERCARE_MESSAGES.answered };
    await repo.recordAnswer(followUpId, "OK", now);
    logger.info({ followUpId }, "aftercare: patient is fine");
    return { text: AFTERCARE_MESSAGES.ok };
  }

  /** Panel: this month's follow-ups and the help requests of the last 14 days. */
  async summary(clinicId: string, now: Date): Promise<AftercareSummary> {
    const { repo } = this.deps;
    const timeZone = (await repo.clinicTimeZone(clinicId)) ?? "America/Sao_Paulo";
    const monthStart = zonedToUtc(`${dateInZone(now, timeZone).slice(0, 7)}-01`, 0, timeZone);
    const [month, help] = await Promise.all([
      repo.sentBetween(clinicId, monthStart, now),
      repo.helpRequests(clinicId, new Date(now.getTime() - 14 * DAY_MS)),
    ]);
    return {
      month: {
        sent: month.length,
        checkIns: month.filter((m) => m.checkIn).length,
        ok: month.filter((m) => m.answer === "OK").length,
        help: month.filter((m) => m.answer === "HELP").length,
      },
      help: help.map((h) => ({
        followUpId: h.followUpId,
        patientId: h.patientId,
        patientName: h.patientName,
        patientPhone: maskPhone(h.phone),
        procedureName: h.procedureName,
        appointmentAt: h.appointmentAt.toISOString(),
        answeredAt: h.answeredAt.toISOString(),
      })),
    };
  }
}
