import { z } from "zod";
import type { ConversationStore } from "../conversation/store.js";
import type { Logger } from "../lib/logger.js";
import { formatCents } from "../lib/money.js";
import { maskPhone } from "../privacy/index.js";
import { formatWhenPtBr } from "../scheduling/time.js";
import { previewText, type OutboundMessage, type WhatsAppChannel } from "../whatsapp/index.js";

export type AuthorizationStatus = "AUTHORIZED" | "DENIED";

/**
 * An appointment of a patient whose plan asks for prior authorization of the procedure,
 * with the front desk's decision once there is one.
 */
export type AuthorizationCase = {
  clinicId: string;
  appointmentId: string;
  appointmentStatus: string;
  startsAt: Date;
  procedureId: string;
  procedureName: string;
  procedurePriceCents: number | null;
  patientId: string;
  patientName: string;
  /** Decrypted WhatsApp number (wa_id). */
  phone: string;
  planId: string;
  planName: string;
  /** Decrypted card number; null if not informed yet. */
  card: string | null;
  decision: {
    id: string;
    status: AuthorizationStatus;
    decidedAt: Date;
    notifiedAt: Date | null;
    privateChosenAt: Date | null;
  } | null;
};

export type PatientInsurance = { planId: string | null; card: string | null };

/** Storage port. Every read and write is scoped by clinic. */
export interface InsuranceRepository {
  clinic(clinicId: string): Promise<{ name: string; timeZone: string } | null>;
  plans(clinicId: string): Promise<Array<{ id: string; name: string }>>;
  patientInsurance(clinicId: string, patientId: string): Promise<PatientInsurance | null>;
  /** False if the patient is not of this clinic. A null plan clears plan and card. */
  setPatientInsurance(
    clinicId: string,
    patientId: string,
    planId: string | null,
    card: string | null,
  ): Promise<boolean>;
  /** The plan of the patient covers the procedure and asks for prior authorization. */
  requiresAuthorization(clinicId: string, patientId: string, procedureId: string): Promise<boolean>;
  /**
   * Cases of appointments starting at or after `from`: pending, booked and active ones
   * that need authorization under the patient's current plan, and any with a decision.
   */
  cases(clinicId: string, from: Date): Promise<AuthorizationCase[]>;
  caseOf(clinicId: string, appointmentId: string): Promise<AuthorizationCase | null>;
  /** Decision by id (the button of convenio_negado). */
  caseOfDecision(clinicId: string, authorizationId: string): Promise<AuthorizationCase | null>;
  /** Records the decision. Null if the appointment already has one. */
  decide(c: AuthorizationCase, status: AuthorizationStatus, at: Date): Promise<string | null>;
  markNotified(authorizationId: string, at: Date): Promise<void>;
  /** Denied and no choice yet -> records "particular". False otherwise. */
  choosePrivate(authorizationId: string, at: Date): Promise<boolean>;
}

export class InsuranceError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    message: string,
  ) {
    super(message);
    this.name = "InsuranceError";
  }
}

/** Card numbers: letters and digits only, as typed on the insurer's portal. */
export function normalizeCard(raw: string): string | null {
  const card = raw.replace(/[\s.\-/]/g, "").toUpperCase();
  return /^[0-9A-Z]{5,30}$/.test(card) ? card : null;
}

export const decisionSchema = z.strictObject({ authorized: z.boolean() });

export const patientInsuranceSchema = z.strictObject({
  planId: z.string().min(1).max(64).nullable(),
  card: z.string().trim().max(40).optional(),
});

export const AUTHORIZATION_MESSAGES = {
  notFound: "Não encontrei essa consulta. Se precisar, é só escrever aqui.",
  alreadyChosen: "Já registramos que a consulta segue como particular. Até lá!",
  privateChosen: (when: string, procedure: string, price: number | null) =>
    `Combinado! Sua consulta de ${when} segue como particular. ` +
    (price === null
      ? `O valor de ${procedure} é definido na avaliação.`
      : `O valor de ${procedure} é ${formatCents(price)}, pago na clínica.`),
} as const;

/** Reply ids of the convenio_negado buttons, in order. */
export const deniedButtons = (authorizationId: string) => [
  `auth:${authorizationId}:private`,
  "handoff",
];

export type AuthorizationList = {
  plans: Array<{ id: string; name: string }>;
  /** Upcoming appointments waiting for the front desk to ask the insurer, soonest first. */
  pending: AuthorizationRow[];
  /** Decisions of appointments from the last 30 days on, newest decision first. */
  decided: AuthorizationRow[];
};

export type AuthorizationRow = {
  appointmentId: string;
  startsAt: string;
  procedureName: string;
  patientId: string;
  patientName: string;
  /** Last 4 digits only. */
  patientPhone: string;
  planName: string;
  /** Full card number: the front desk types it into the insurer's portal. */
  card: string | null;
  status: AuthorizationStatus | "PENDING";
  decidedAt: string | null;
  notifiedAt: string | null;
  privateChosenAt: string | null;
};

const DAY_MS = 86_400_000;
const ACTIVE = new Set(["PENDING_CONFIRMATION", "CONFIRMED"]);
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/**
 * Prior authorization with the insurer (Odontoprev has no public API): the bot collects the
 * plan and card number, the panel lists the appointments that need authorization, the front
 * desk asks on the insurer's portal and records the answer, and the patient gets it by
 * template. A denied patient can keep the appointment as private.
 */
export class InsuranceAuthorizations {
  constructor(
    private readonly deps: {
      repo: InsuranceRepository;
      channel: WhatsAppChannel;
      store: ConversationStore;
      logger: Logger;
    },
  ) {}

  /** Bot (informar_convenio): plan by name among the clinic's, card normalized. */
  async register(clinicId: string, patientId: string, planName: string, rawCard: string) {
    const plans = await this.deps.repo.plans(clinicId);
    const wanted = planName.trim().toLowerCase();
    const plan = plans.find((p) => p.name.toLowerCase() === wanted);
    if (!plan) return { error: "plan" as const, plans: plans.map((p) => p.name) };
    const card = normalizeCard(rawCard);
    if (!card) return { error: "card" as const };
    if (!(await this.deps.repo.setPatientInsurance(clinicId, patientId, plan.id, card)))
      return { error: "patient" as const };
    this.deps.logger.info({ patientId, planId: plan.id }, "insurance registered by the bot");
    return { plan: plan.name };
  }

  async requiresAuthorization(clinicId: string, patientId: string, procedureId: string) {
    return this.deps.repo.requiresAuthorization(clinicId, patientId, procedureId);
  }

  /** Panel: plan and card of a patient, with the clinic's plans. */
  async patientInsurance(clinicId: string, patientId: string) {
    const [current, plans] = await Promise.all([
      this.deps.repo.patientInsurance(clinicId, patientId),
      this.deps.repo.plans(clinicId),
    ]);
    if (!current) throw new InsuranceError(404, "Paciente não encontrado.");
    return { ...current, plans };
  }

  /** Panel: sets (or clears, with a null plan) the patient's plan and card. */
  async setPatientInsurance(clinicId: string, patientId: string, input: unknown) {
    const parsed = patientInsuranceSchema.safeParse(input);
    if (!parsed.success) throw new InsuranceError(422, "Dados do convênio inválidos.");
    const { planId } = parsed.data;
    let card: string | null = null;
    if (planId) {
      if (!(await this.deps.repo.plans(clinicId)).some((p) => p.id === planId))
        throw new InsuranceError(422, "Convênio não encontrado.");
      if (parsed.data.card) {
        card = normalizeCard(parsed.data.card);
        if (!card)
          throw new InsuranceError(422, "Carteirinha inválida: use de 5 a 30 letras ou números.");
      }
    }
    if (!(await this.deps.repo.setPatientInsurance(clinicId, patientId, planId, card)))
      throw new InsuranceError(404, "Paciente não encontrado.");
    this.deps.logger.info({ patientId, planId }, "insurance set by staff");
  }

  async list(clinicId: string, now: Date): Promise<AuthorizationList> {
    const [plans, cases] = await Promise.all([
      this.deps.repo.plans(clinicId),
      this.deps.repo.cases(clinicId, new Date(now.getTime() - 30 * DAY_MS)),
    ]);
    const pending = cases
      .filter((c) => !c.decision && ACTIVE.has(c.appointmentStatus) && c.startsAt >= now)
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    const decided = cases
      .filter((c) => c.decision)
      .sort((a, b) => b.decision!.decidedAt.getTime() - a.decision!.decidedAt.getTime());
    return { plans, pending: pending.map(row), decided: decided.map(row) };
  }

  /**
   * Panel: records the insurer's answer and tells the patient by template. The decision
   * stays even if the send fails (the panel shows it was not notified).
   */
  async decide(
    clinicId: string,
    appointmentId: string,
    input: unknown,
    now: Date,
  ): Promise<{ notified: boolean }> {
    const parsed = decisionSchema.safeParse(input);
    if (!parsed.success) throw new InsuranceError(422, "Informe se foi autorizado.");
    const { repo, logger } = this.deps;
    const c = await repo.caseOf(clinicId, appointmentId);
    if (!c) throw new InsuranceError(404, "Consulta sem autorização de convênio pendente.");
    if (c.decision) throw new InsuranceError(409, "Essa autorização já foi registrada.");
    if (!ACTIVE.has(c.appointmentStatus))
      throw new InsuranceError(409, "A consulta não está mais marcada.");
    const status: AuthorizationStatus = parsed.data.authorized ? "AUTHORIZED" : "DENIED";
    const id = await repo.decide(c, status, now);
    if (!id) throw new InsuranceError(409, "Essa autorização já foi registrada.");
    logger.info({ appointmentId, authorizationId: id, status }, "insurance decision recorded");

    const clinic = await repo.clinic(clinicId);
    if (!clinic) return { notified: false };
    try {
      const conv = await this.deps.store.getOrCreateConversation(clinicId, c.phone);
      const params = [
        firstName(c.patientName),
        c.planName,
        formatWhenPtBr(c.startsAt, clinic.timeZone),
        clinic.name,
      ];
      const msg: OutboundMessage =
        status === "AUTHORIZED"
          ? { kind: "template", to: conv.contact, template: "convenio_autorizado", params }
          : {
              kind: "template",
              to: conv.contact,
              template: "convenio_negado",
              params,
              buttonPayloads: deniedButtons(id),
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
      await repo.markNotified(id, now);
      return { notified: true };
    } catch (err) {
      logger.error(
        { authorizationId: id, err: err instanceof Error ? err.message : "unknown" },
        "insurance decision notice failed",
      );
      return { notified: false };
    }
  }

  /** "Seguir como particular" on convenio_negado. Only the case's own patient can tap it. */
  async choosePrivate(clinicId: string, contact: string, authorizationId: string, now: Date) {
    const { repo, logger } = this.deps;
    const c = await repo.caseOfDecision(clinicId, authorizationId);
    if (
      !c ||
      c.phone !== contact ||
      c.decision?.status !== "DENIED" ||
      !ACTIVE.has(c.appointmentStatus)
    )
      return { text: AUTHORIZATION_MESSAGES.notFound };
    if (c.decision.privateChosenAt || !(await repo.choosePrivate(authorizationId, now)))
      return { text: AUTHORIZATION_MESSAGES.alreadyChosen };
    logger.info({ authorizationId }, "patient keeps the appointment as private");
    const clinic = await repo.clinic(clinicId);
    return {
      text: AUTHORIZATION_MESSAGES.privateChosen(
        formatWhenPtBr(c.startsAt, clinic?.timeZone ?? "America/Sao_Paulo"),
        c.procedureName,
        c.procedurePriceCents,
      ),
    };
  }
}

function row(c: AuthorizationCase): AuthorizationRow {
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  return {
    appointmentId: c.appointmentId,
    startsAt: c.startsAt.toISOString(),
    procedureName: c.procedureName,
    patientId: c.patientId,
    patientName: c.patientName,
    patientPhone: maskPhone(c.phone),
    planName: c.planName,
    card: c.card,
    status: c.decision?.status ?? "PENDING",
    decidedAt: iso(c.decision?.decidedAt),
    notifiedAt: iso(c.decision?.notifiedAt),
    privateChosenAt: iso(c.decision?.privateChosenAt),
  };
}
