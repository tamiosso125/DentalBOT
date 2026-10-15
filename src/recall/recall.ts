import { z } from "zod";
import type { ConversationStore } from "../conversation/store.js";
import type { Logger } from "../lib/logger.js";
import { maskPhone } from "../privacy/index.js";
import { dateInZone, minuteOfDayInZone, weekdayOf, zonedToUtc } from "../scheduling/time.js";
import { previewText, type OutboundMessage, type WhatsAppChannel } from "../whatsapp/index.js";

/**
 * Recall ("retorno"): patients whose last visit was months ago and who have nothing booked
 * get one `convite_retorno` invitation per last visit, a marketing template. Only patients
 * with a recorded marketing consent are invited, and a later "PARAR" wins over the consent.
 */

/** Version of the consent text below; stored with every consent the front desk records. */
export const RECALL_CONSENT_VERSION = "retorno-v1";
/** Version of the bot's question (MESSAGES.recallConsentAsk) answered by button. */
export const RECALL_CONSENT_VERSION_WHATSAPP = "retorno-whatsapp-v1";

/** Who recorded a consent: the front desk in the panel or the patient on WhatsApp. */
export type ConsentSource = "STAFF" | "WHATSAPP";
export type RecallConsent = { granted: boolean; at: Date; source: ConsentSource };
export const RECALL_CONSENT_TEXT =
  "Aceito receber pelo WhatsApp convites da clínica para marcar meu retorno. " +
  "Posso parar quando quiser respondendo PARAR.";

/** Reply ids of the invitation's quick-reply buttons, in the template's button order. */
export const RECALL_BUTTONS = ["recall:schedule", "recall:stop"] as const;

/** A patient who visited before the cutoff and has no upcoming appointment. */
export type RecallRow = {
  patientId: string;
  patientName: string;
  /** Decrypted WhatsApp number (wa_id). */
  phone: string;
  lastVisitAt: Date;
  lastProcedure: string;
  /** Latest marketing consent the patient gave or withdrew. */
  consent: RecallConsent | null;
  /** "PARAR" on the patient's conversation. */
  optedOutAt: Date | null;
  invitedAt: Date | null;
};

export type RecallStatus = "due" | "invited" | "no_consent" | "opted_out";

export function recallStatus(
  row: Pick<RecallRow, "consent" | "optedOutAt" | "invitedAt" | "lastVisitAt">,
): RecallStatus {
  if (!row.consent?.granted) return "no_consent";
  if (row.optedOutAt && row.optedOutAt > row.consent.at) return "opted_out";
  if (row.invitedAt && row.invitedAt >= row.lastVisitAt) return "invited";
  return "due";
}

export type RecallClinic = { id: string; name: string; timeZone: string };

export interface RecallRepository {
  clinics(): Promise<RecallClinic[]>;
  clinic(clinicId: string): Promise<RecallClinic | null>;
  /** Patients whose last visit (not cancelled nor no-show) is before `visitedBefore`, with nothing booked from `now` on. */
  rows(clinicId: string, visitedBefore: Date, now: Date): Promise<RecallRow[]>;
  /** Marks the invitation for this last visit as taken. False if another run already took it. */
  claim(patientId: string, lastVisitAt: Date, at: Date): Promise<boolean>;
  /** Gives the invitation back after a failed send. */
  release(patientId: string, previous: Date | null): Promise<void>;
  /** False if the patient is not the clinic's (or was anonymized). */
  recordConsent(
    clinicId: string,
    patientId: string,
    granted: boolean,
    at: Date,
    source?: ConsentSource,
  ): Promise<boolean>;
  /** Latest recall consent of the clinic's patient, if any. */
  consentOf(clinicId: string, patientId: string): Promise<RecallConsent | null>;
}

export type RecallConfig = {
  /** Months since the last visit before inviting. */
  afterMonths: number;
  /** Day of the week (0 = Sunday) and local hours [from, until) when invitations go out. */
  weekday: number;
  sendFromHour: number;
  sendUntilHour: number;
  /** Invitations per clinic per run, so a first run does not flood the number. */
  maxPerRun: number;
};

export const DEFAULT_RECALL_CONFIG: RecallConfig = {
  afterMonths: 6,
  weekday: 2,
  sendFromHour: 9,
  sendUntilHour: 12,
  maxPerRun: 50,
};

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

export const consentBodySchema = z.strictObject({ granted: z.boolean() });

/** A request the front desk can act on. `status` is the HTTP code. */
export class RecallError extends Error {
  constructor(
    readonly status: 404 | 422,
    message: string,
  ) {
    super(message);
    this.name = "RecallError";
  }
}

/** What the panel shows: the phone masked, dates as ISO strings. */
export type RecallListRow = {
  patientId: string;
  patientName: string;
  patientPhone: string;
  lastVisitAt: string;
  lastProcedure: string;
  status: RecallStatus;
  invitedAt: string | null;
  optedOutAt: string | null;
  /** Where the latest consent answer came from, and when. */
  consentSource: ConsentSource | null;
  consentAt: string | null;
};

export type RecallList = {
  afterMonths: number;
  /** "terça, das 9h às 12h" */
  schedule: string;
  consentText: string;
  rows: RecallListRow[];
};

/** Midnight (clinic time) `months` calendar months before today. */
export function recallCutoff(now: Date, timeZone: string, months: number): Date {
  const [y, m, d] = dateInZone(now, timeZone).split("-").map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 - months, 1));
  const lastDay = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  first.setUTCDate(Math.min(d, lastDay));
  return zonedToUtc(first.toISOString().slice(0, 10), 0, timeZone);
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/**
 * Lists recall candidates for the panel, records consent from the front desk, and sends the
 * weekly invitations. Safe to run often and from several processes: each invitation is
 * claimed before sending, and a failed send releases it for the next run.
 */
export class RecallService {
  private readonly config: RecallConfig;

  constructor(
    private readonly deps: {
      repo: RecallRepository;
      channel: WhatsAppChannel;
      store: ConversationStore;
      logger: Logger;
      config?: Partial<RecallConfig>;
    },
  ) {
    this.config = { ...DEFAULT_RECALL_CONFIG, ...deps.config };
  }

  async list(clinicId: string, now: Date): Promise<RecallList> {
    const { afterMonths, weekday, sendFromHour, sendUntilHour } = this.config;
    const clinic = await this.deps.repo.clinic(clinicId);
    const rows = clinic
      ? await this.deps.repo.rows(clinicId, recallCutoff(now, clinic.timeZone, afterMonths), now)
      : [];
    return {
      afterMonths,
      schedule: `${WEEKDAYS[weekday]}, das ${sendFromHour}h às ${sendUntilHour}h`,
      consentText: RECALL_CONSENT_TEXT,
      rows: rows
        .map((r) => ({
          patientId: r.patientId,
          patientName: r.patientName,
          patientPhone: maskPhone(r.phone),
          lastVisitAt: r.lastVisitAt.toISOString(),
          lastProcedure: r.lastProcedure,
          status: recallStatus(r),
          invitedAt: r.invitedAt?.toISOString() ?? null,
          optedOutAt: r.optedOutAt?.toISOString() ?? null,
          consentSource: r.consent?.source ?? null,
          consentAt: r.consent?.at.toISOString() ?? null,
        }))
        .sort((a, b) => a.lastVisitAt.localeCompare(b.lastVisitAt)),
    };
  }

  async setConsent(clinicId: string, patientId: string, body: unknown, now: Date) {
    const parsed = consentBodySchema.safeParse(body);
    if (!parsed.success) throw new RecallError(422, "Pedido inválido.");
    const { granted } = parsed.data;
    if (!(await this.deps.repo.recordConsent(clinicId, patientId, granted, now, "STAFF")))
      throw new RecallError(404, "Paciente não encontrado.");
    this.deps.logger.info({ patientId, granted }, "recall consent recorded");
  }

  async run(now: Date): Promise<{ sent: number }> {
    const { repo, logger } = this.deps;
    const { afterMonths, weekday, sendFromHour, sendUntilHour, maxPerRun } = this.config;
    let sent = 0;
    for (const clinic of await repo.clinics()) {
      const hour = Math.floor(minuteOfDayInZone(now, clinic.timeZone) / 60);
      if (weekdayOf(dateInZone(now, clinic.timeZone)) !== weekday) continue;
      if (hour < sendFromHour || hour >= sendUntilHour) continue;
      const due = (
        await repo.rows(clinic.id, recallCutoff(now, clinic.timeZone, afterMonths), now)
      ).filter((r) => recallStatus(r) === "due");
      for (const row of due.slice(0, maxPerRun)) {
        if (!(await repo.claim(row.patientId, row.lastVisitAt, now))) continue;
        try {
          if (await this.invite(clinic, row, now)) sent++;
          else await repo.release(row.patientId, row.invitedAt);
        } catch (err) {
          await repo.release(row.patientId, row.invitedAt);
          logger.error(
            { patientId: row.patientId, err: err instanceof Error ? err.message : "unknown" },
            "recall invitation failed",
          );
        }
      }
    }
    if (sent) logger.info({ sent }, "recall invitations");
    return { sent };
  }

  /** False when the conversation says "PARAR" after the consent (checked again at send time). */
  private async invite(clinic: RecallClinic, row: RecallRow, now: Date): Promise<boolean> {
    const { channel, store } = this.deps;
    const conv = await store.getOrCreateConversation(clinic.id, row.phone);
    if (recallStatus({ ...row, optedOutAt: conv.marketingOptOutAt ?? row.optedOutAt }) !== "due")
      return false;
    const msg: OutboundMessage = {
      kind: "template",
      to: conv.contact,
      template: "convite_retorno",
      params: [firstName(row.patientName), clinic.name],
      buttonPayloads: [...RECALL_BUTTONS],
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
