import type { ConversationStore } from "../conversation/store.js";
import type { Logger } from "../lib/logger.js";
import { maskPhone } from "../privacy/index.js";
import { addDays, dateInZone, minuteOfDayInZone, zonedToUtc } from "../scheduling/time.js";
import { previewText, type OutboundMessage, type WhatsAppChannel } from "../whatsapp/index.js";

/** An attended appointment that may get its satisfaction question. */
export type SurveyCandidate = {
  appointmentId: string;
  clinicId: string;
  clinicName: string;
  clinicTimeZone: string;
  patientId: string;
  patientName: string;
  /** Decrypted WhatsApp number (wa_id). */
  phone: string;
  startsAt: Date;
};

export type StoredSurvey = {
  id: string;
  patientId: string;
  /** Decrypted WhatsApp number of the survey's patient. */
  phone: string;
  rating: number | null;
};

export type LowRating = {
  surveyId: string;
  patientId: string;
  patientName: string;
  phone: string;
  rating: number;
  answeredAt: Date;
  appointmentAt: Date;
};

/** Storage port. Every read and write by id is scoped by clinic. */
export interface SurveyRepository {
  /**
   * COMPLETED appointments starting in [from, to) without a survey, of patients not
   * anonymized. Every clinic unless `clinicId` narrows it (tests sharing a database).
   */
  candidates(from: Date, to: Date, clinicId?: string): Promise<SurveyCandidate[]>;
  /** The patient was asked (any appointment) at or after `since`. */
  askedSince(patientId: string, since: Date): Promise<boolean>;
  /** Creates the survey before sending. Null if the appointment already has one. */
  create(candidate: SurveyCandidate, at: Date): Promise<string | null>;
  /** Gives the appointment back after a failed send. */
  remove(surveyId: string): Promise<void>;
  get(clinicId: string, surveyId: string): Promise<StoredSurvey | null>;
  /** Records the rating. False if the survey was already answered. */
  answer(surveyId: string, rating: number, at: Date): Promise<boolean>;
  clinicTimeZone(clinicId: string): Promise<string | null>;
  /** Surveys of the clinic sent in [from, to): how many, and the ratings given. */
  sentBetween(clinicId: string, from: Date, to: Date): Promise<{ sent: number; ratings: number[] }>;
  /** Ratings of `max` or less answered since `since`, newest first. */
  lowRatings(clinicId: string, since: Date, max: number): Promise<LowRating[]>;
}

export type SurveyConfig = {
  /** Ask about appointments from 1 to this many days ago (attendance may be marked late). */
  maxDaysAfter: number;
  /** At most one question per patient in this many days. */
  minDaysBetween: number;
  /** Only send between these local hours [start, end). */
  sendFromHour: number;
  sendUntilHour: number;
};

export const DEFAULT_SURVEY_CONFIG: SurveyConfig = {
  maxDaysAfter: 3,
  minDaysBetween: 30,
  sendFromHour: 10,
  sendUntilHour: 19,
};

/** At or below this rating, the front desk is called to get in touch. */
export const LOW_RATING = 2;

/** Reply ids of the template's buttons, in order: 5 (best) down to 1. */
export const surveyButtons = (surveyId: string) =>
  [5, 4, 3, 2, 1].map((n) => `survey:${surveyId}:${n}`);

export const SURVEY_MESSAGES = {
  thanks: "Obrigado pela sua avaliação! Ela nos ajuda a melhorar. 😊",
  low: "Sentimos muito que sua experiência não foi boa. Já avisamos a recepção, que vai entrar em contato com você para entender o que aconteceu.",
  answered: "Você já respondeu a essa pesquisa. Obrigado!",
  notFound: "Não encontrei essa pesquisa. Se precisar, é só escrever aqui.",
} as const;

export type SurveySummary = {
  month: {
    sent: number;
    answers: number;
    /** One decimal; null without answers. */
    average: number | null;
    /** Answers per rating, index 0 = rating 1. */
    byRating: [number, number, number, number, number];
  };
  /** Ratings 1-2 of the last 30 days, for the front desk to follow up. */
  low: Array<{
    surveyId: string;
    patientId: string;
    patientName: string;
    /** Last 4 digits only. */
    patientPhone: string;
    rating: number;
    answeredAt: string;
    appointmentAt: string;
  }>;
};

const DAY_MS = 86_400_000;
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const ddmm = (date: string) => date.slice(8, 10) + "/" + date.slice(5, 7);

/**
 * Satisfaction survey: the day after an attended appointment (the front desk marked
 * "Compareceu"), the patient gets the `pesquisa_satisfacao` template with ratings 1 to 5.
 * A low rating calls the front desk. At most one question per patient a month.
 *
 * Safe to run often and from several processes: the survey row (unique per appointment)
 * is created before sending and removed if the send fails.
 */
export class SurveyService {
  private readonly config: SurveyConfig;

  constructor(
    private readonly deps: {
      repo: SurveyRepository;
      channel: WhatsAppChannel;
      store: ConversationStore;
      logger: Logger;
      config?: Partial<SurveyConfig>;
    },
  ) {
    this.config = { ...DEFAULT_SURVEY_CONFIG, ...deps.config };
  }

  async run(now: Date, clinicId?: string): Promise<{ sent: number }> {
    const { repo, logger } = this.deps;
    const { maxDaysAfter, minDaysBetween, sendFromHour, sendUntilHour } = this.config;
    // Widened by a day on each side; each row is checked in its clinic's zone.
    const rows = await repo.candidates(
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
      if (await repo.askedSince(c.patientId, new Date(now.getTime() - minDaysBetween * DAY_MS)))
        continue;
      const conv = await this.deps.store.getOrCreateConversation(c.clinicId, c.phone);
      // The front desk is talking to the patient: leave it for a later run.
      if (conv.botPausedUntil && conv.botPausedUntil > now) continue;
      const surveyId = await repo.create(c, now);
      if (!surveyId) continue;
      try {
        const msg: OutboundMessage = {
          kind: "template",
          to: conv.contact,
          template: "pesquisa_satisfacao",
          params: [firstName(c.patientName), c.clinicName, ddmm(day)],
          buttonPayloads: surveyButtons(surveyId),
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
        await repo.remove(surveyId);
        logger.error(
          { appointmentId: c.appointmentId, err: err instanceof Error ? err.message : "unknown" },
          "survey send failed",
        );
      }
    }
    if (sent) logger.info({ sent }, "satisfaction surveys");
    return { sent };
  }

  /**
   * A rating button. Only the survey's own patient can answer it; anyone else gets "not
   * found". Works while the bot is paused: it answers something the clinic sent.
   */
  async answer(
    clinicId: string,
    contact: string,
    surveyId: string,
    rating: number,
    now: Date,
  ): Promise<{ text: string; handoff?: string }> {
    const { repo, logger } = this.deps;
    const survey = await repo.get(clinicId, surveyId);
    if (!survey || survey.phone !== contact || rating < 1 || rating > 5)
      return { text: SURVEY_MESSAGES.notFound };
    if (survey.rating !== null || !(await repo.answer(surveyId, rating, now)))
      return { text: SURVEY_MESSAGES.answered };
    logger.info({ surveyId, rating }, "survey answered");
    return rating <= LOW_RATING
      ? { text: SURVEY_MESSAGES.low, handoff: "survey:low" }
      : { text: SURVEY_MESSAGES.thanks };
  }

  /** Panel: this month's ratings and the low ones of the last 30 days. */
  async summary(clinicId: string, now: Date): Promise<SurveySummary> {
    const { repo } = this.deps;
    const timeZone = (await repo.clinicTimeZone(clinicId)) ?? "America/Sao_Paulo";
    const monthStart = zonedToUtc(`${dateInZone(now, timeZone).slice(0, 7)}-01`, 0, timeZone);
    const [month, low] = await Promise.all([
      repo.sentBetween(clinicId, monthStart, now),
      repo.lowRatings(clinicId, new Date(now.getTime() - 30 * DAY_MS), LOW_RATING),
    ]);
    const byRating: SurveySummary["month"]["byRating"] = [0, 0, 0, 0, 0];
    for (const r of month.ratings) byRating[r - 1]!++;
    const answers = month.ratings.length;
    const average = answers
      ? Math.round((month.ratings.reduce((a, b) => a + b, 0) / answers) * 10) / 10
      : null;
    return {
      month: { sent: month.sent, answers, average, byRating },
      low: low.map((l) => ({
        surveyId: l.surveyId,
        patientId: l.patientId,
        patientName: l.patientName,
        patientPhone: maskPhone(l.phone),
        rating: l.rating,
        answeredAt: l.answeredAt.toISOString(),
        appointmentAt: l.appointmentAt.toISOString(),
      })),
    };
  }
}
