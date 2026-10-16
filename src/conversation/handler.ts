import { respond, type OrchestratorDeps } from "../ai/orchestrator.js";
import type { Logger } from "../lib/logger.js";
import type { QuoteService } from "../quotes/quote-service.js";
import type { RecallRepository } from "../recall/recall.js";
import { AppointmentNotFoundError, type AgendaProvider } from "../scheduling/agenda-provider.js";
import { formatWhenPtBr } from "../scheduling/time.js";
import type { InsuranceAuthorizations } from "../insurance/authorizations.js";
import type { SurveyService } from "../survey/survey.js";
import type { AftercareService } from "../aftercare/aftercare.js";
import type { WaitlistService } from "../waitlist/waitlist.js";
import type { OutboundMessage, WhatsAppChannel, WhatsAppEvent } from "../whatsapp/index.js";
import { previewText } from "../whatsapp/index.js";
import { detectIntent, type AppointmentAction } from "./intents.js";
import { MESSAGES } from "./messages.js";
import type { ClinicInfo, ConversationRecord, ConversationStore } from "./store.js";

export type HandlerDeps = {
  store: ConversationStore;
  channel: WhatsAppChannel;
  logger: Logger;
  now?: () => Date;
  config: { handoffPauseMinutes: number; privacyPolicyUrl: string };
  /** LLM orchestrator (router + attendant). Absent = deterministic menu only (AI_MODE=off). */
  ai?: OrchestratorDeps;
  /** Quote buttons (approve/decline/view). Absent = the front desk handles them. */
  quotes?: QuoteService;
  /** Agenda of a clinic, for the appointment reminder buttons. Absent = the front desk handles them. */
  agendaFor?: (clinicId: string) => Promise<AgendaProvider | null>;
  /** Recall consent asked after a confirmation. Absent = only the front desk records it. */
  recall?: Pick<RecallRepository, "recordConsent" | "consentOf">;
  /** Waiting-list offer buttons. Absent = the front desk handles them. */
  waitlist?: Pick<WaitlistService, "answer">;
  /** "Seguir como particular" after a denied authorization. Absent = the front desk handles it. */
  insurance?: Pick<InsuranceAuthorizations, "choosePrivate">;
  /** Satisfaction survey ratings. Absent = the front desk reads them in the chat. */
  survey?: Pick<SurveyService, "answer">;
  /** "Tudo bem" / "Preciso de ajuda" after a procedure. Absent = the front desk handles them. */
  aftercare?: Pick<AftercareService, "answer">;
};

/**
 * Processes one normalized WhatsApp event. Runs inside the queue worker, never in the
 * webhook request. Idempotent per waMessageId (Meta redelivers webhooks).
 *
 * Deterministic commands, safety handoffs and the coexistence pause always run first and
 * never depend on model output. Only what is left goes to the LLM orchestrator.
 */
export async function handleWhatsAppEvent(event: WhatsAppEvent, deps: HandlerDeps): Promise<void> {
  const { store, logger } = deps;
  const now = deps.now ?? (() => new Date());

  if (event.kind === "status") {
    await store.updateMessageStatus(event.waMessageId, event.status);
    return;
  }

  const clinic = await store.findClinicByPhoneNumberId(event.phoneNumberId);
  if (!clinic) {
    logger.warn({ phoneNumberId: event.phoneNumberId }, "webhook for unknown phone number id");
    return;
  }

  if (await store.hasMessage(event.waMessageId)) {
    logger.debug({ waMessageId: event.waMessageId }, "duplicate webhook ignored");
    return;
  }

  if (event.kind === "echo") {
    // Front desk answered from the WhatsApp Business app: the bot steps back.
    const conv = await store.getOrCreateConversation(clinic.id, event.to);
    await store.saveMessage({
      conversationId: conv.id,
      waMessageId: event.waMessageId,
      direction: "ECHO",
      type: event.type,
      body: event.text,
      at: now(),
    });
    await store.updateConversation(conv.id, { botPausedUntil: pauseUntil(now(), deps) });
    logger.info({ conversationId: conv.id }, "bot paused: front desk replied via app");
    return;
  }

  const conv = await store.getOrCreateConversation(clinic.id, event.from);
  await store.saveMessage({
    conversationId: conv.id,
    waMessageId: event.waMessageId,
    direction: "INBOUND",
    type: event.type,
    body: event.text,
    at: now(),
  });
  await store.updateConversation(conv.id, { lastInboundAt: now() });

  const intent = detectIntent(event.text, event.replyId);
  const paused = conv.botPausedUntil !== null && conv.botPausedUntil > now();

  // Emergencies always get the safety message, even while a human is handling the chat.
  // Quote buttons, "Confirmar" on a reminder, waiting-list offers, survey ratings, the
  // post-procedure check-in and opting out are deterministic answers to something the clinic
  // sent, so they are recorded even then. "Remarcar" and "Quero agendar" need a conversation,
  // which is the front desk's while it is in the chat.
  const answersClinic =
    intent.kind === "quote_action" ||
    intent.kind === "opt_out" ||
    intent.kind === "recall_consent" ||
    intent.kind === "waitlist_answer" ||
    intent.kind === "survey_answer" ||
    intent.kind === "aftercare_answer" ||
    intent.kind === "insurance_private" ||
    (intent.kind === "appointment_action" && intent.action === "confirm");
  if (paused && intent.kind !== "emergency" && !answersClinic) {
    logger.debug({ conversationId: conv.id }, "bot paused, message left for the front desk");
    return;
  }

  const send = (msg: OutboundMessage) => sendAndStore(conv, msg, deps);

  if (!conv.privacyNoticeAt && intent.kind !== "emergency") {
    await send({
      kind: "text",
      to: conv.contact,
      body: MESSAGES.privacyNotice(clinic.name, deps.config.privacyPolicyUrl),
    });
    await store.updateConversation(conv.id, { privacyNoticeAt: now() });
  }

  switch (intent.kind) {
    case "emergency":
      await send({ kind: "text", to: conv.contact, body: MESSAGES.emergency });
      return handoff(conv, "emergency", deps, now());
    case "clinical":
      await send({ kind: "text", to: conv.contact, body: MESSAGES.clinical });
      return handoff(conv, "clinical", deps, now());
    case "human":
      await send({ kind: "text", to: conv.contact, body: MESSAGES.handoff });
      return handoff(conv, "requested", deps, now());
    case "opt_out":
      await store.updateConversation(conv.id, { marketingOptOutAt: now() });
      await send({ kind: "text", to: conv.contact, body: MESSAGES.optOut });
      return;
    case "data_request":
      await store.createDataRequest(clinic.id, conv.id);
      await send({ kind: "text", to: conv.contact, body: MESSAGES.dataRequest });
      return;
    case "quote_action": {
      if (!deps.quotes) {
        await send({ kind: "text", to: conv.contact, body: MESSAGES.quoteSoon });
        return handoff(conv, "quote:no_service", deps, now());
      }
      const out = await deps.quotes.handleAction(conv, intent.quoteId, intent.action);
      for (const m of out.messages) await send(m);
      if (out.handoff) await handoff(conv, out.handoff, deps, now());
      return;
    }
    case "appointment_action":
      return appointmentAction(
        conv,
        clinic,
        intent.appointmentId,
        intent.action,
        { ...deps, paused },
        now(),
      );
    case "recall_consent":
      return recallConsent(conv, clinic, intent.granted, deps, now());
    case "waitlist_answer": {
      if (!deps.waitlist) {
        await send({ kind: "text", to: conv.contact, body: MESSAGES.schedulingSoon });
        return handoff(conv, "waitlist:no_service", deps, now());
      }
      const out = await deps.waitlist.answer(
        clinic.id,
        conv.contact,
        intent.offerId,
        intent.accept,
        now(),
      );
      await send({ kind: "text", to: conv.contact, body: out.text });
      if (out.handoff) await handoff(conv, out.handoff, deps, now());
      return;
    }
    case "insurance_private": {
      if (!deps.insurance) {
        await send({ kind: "text", to: conv.contact, body: MESSAGES.handoff });
        return handoff(conv, "insurance:no_service", deps, now());
      }
      const out = await deps.insurance.choosePrivate(
        clinic.id,
        conv.contact,
        intent.authorizationId,
        now(),
      );
      await send({ kind: "text", to: conv.contact, body: out.text });
      return;
    }
    case "survey_answer": {
      if (!deps.survey) {
        await send({ kind: "text", to: conv.contact, body: MESSAGES.surveyThanks });
        return handoff(conv, "survey:no_service", deps, now());
      }
      const out = await deps.survey.answer(
        clinic.id,
        conv.contact,
        intent.surveyId,
        intent.rating,
        now(),
      );
      await send({ kind: "text", to: conv.contact, body: out.text });
      if (out.handoff) await handoff(conv, out.handoff, deps, now());
      return;
    }
    case "aftercare_answer": {
      if (!deps.aftercare) {
        await send({ kind: "text", to: conv.contact, body: MESSAGES.handoff });
        return handoff(conv, "aftercare:no_service", deps, now());
      }
      const out = await deps.aftercare.answer(
        clinic.id,
        conv.contact,
        intent.followUpId,
        intent.help ? "HELP" : "OK",
        now(),
      );
      await send({ kind: "text", to: conv.contact, body: out.text });
      if (out.handoff) await handoff(conv, out.handoff, deps, now());
      return;
    }
    case "recall_schedule":
      if (deps.ai)
        return aiTurn(
          conv,
          clinic,
          "Quero agendar uma consulta de retorno",
          undefined,
          deps,
          now(),
        );
      await send({ kind: "text", to: conv.contact, body: MESSAGES.schedulingSoon });
      return handoff(conv, "recall:schedule", deps, now());
    case "menu_choice":
      if (deps.ai && intent.choice === "agendar")
        return aiTurn(conv, clinic, "Quero agendar uma consulta", undefined, deps, now());
      // A new quote needs the dentist's evaluation, so the front desk takes it from here.
      await send({
        kind: "text",
        to: conv.contact,
        body: intent.choice === "orcamento" ? MESSAGES.quoteSoon : MESSAGES.schedulingSoon,
      });
      return handoff(conv, `menu:${intent.choice}`, deps, now());
    case "other":
      if (deps.ai && (event.text || event.replyId))
        return aiTurn(conv, clinic, event.text ?? "", event.replyId, deps, now());
      return sendMenu(conv, deps);
  }
}

async function aiTurn(
  conv: ConversationRecord,
  clinic: ClinicInfo,
  text: string,
  replyId: string | undefined,
  deps: HandlerDeps,
  at: Date,
) {
  const send = (msg: OutboundMessage) => sendAndStore(conv, msg, deps);
  const out = await respond({ conv, clinic, text, replyId, now: at }, deps.ai!);

  if (out.kind === "route") {
    switch (out.route) {
      case "urgencia":
        await send({ kind: "text", to: conv.contact, body: MESSAGES.emergency });
        return handoff(conv, "emergency", deps, at);
      case "clinico":
        await send({ kind: "text", to: conv.contact, body: MESSAGES.clinical });
        return handoff(conv, "clinical", deps, at);
      case "humano":
        await send({ kind: "text", to: conv.contact, body: MESSAGES.handoff });
        return handoff(conv, "requested", deps, at);
      case "orcamento":
        await send({ kind: "text", to: conv.contact, body: MESSAGES.quoteSoon });
        return handoff(conv, "ai:orcamento", deps, at);
      case "saudacao":
        return sendMenu(conv, deps);
    }
  }

  await send({ kind: "text", to: conv.contact, body: out.text });
  if (out.list) await send({ kind: "list", to: conv.contact, ...out.list });
  if (out.handoff) await handoff(conv, `ai:${out.handoff}`, deps, at);
}

async function appointmentAction(
  conv: ConversationRecord,
  clinic: ClinicInfo,
  appointmentId: string,
  action: AppointmentAction,
  deps: HandlerDeps & { paused: boolean },
  at: Date,
) {
  const send = (msg: OutboundMessage) => sendAndStore(conv, msg, deps);
  if (action === "reschedule") {
    if (deps.ai) return aiTurn(conv, clinic, "Quero remarcar minha consulta", undefined, deps, at);
    await send({ kind: "text", to: conv.contact, body: MESSAGES.rescheduleSoon });
    return handoff(conv, "appointment:reschedule", deps, at);
  }
  if (action === "rebook") {
    // The missed appointment stays as a no-show; this is a new booking.
    if (deps.ai)
      return aiTurn(
        conv,
        clinic,
        "Faltei na minha última consulta e quero marcar um novo horário",
        undefined,
        deps,
        at,
      );
    await send({ kind: "text", to: conv.contact, body: MESSAGES.schedulingSoon });
    return handoff(conv, "appointment:rebook", deps, at);
  }

  const agenda = await deps.agendaFor?.(clinic.id);
  const patient = agenda ? await agenda.buscarPaciente({ phone: conv.contact }) : null;
  if (agenda && patient) {
    try {
      const { startsAt } = await agenda.confirmar({ appointmentId, patientId: patient.id });
      const when = formatWhenPtBr(startsAt, agenda.timeZone);
      await send({ kind: "text", to: conv.contact, body: MESSAGES.appointmentConfirmed(when) });
      deps.logger.info({ conversationId: conv.id, appointmentId }, "appointment confirmed");
      // The front desk owns the chat while paused: no new questions from the bot.
      if (!deps.paused) await askRecallConsent(conv, clinic, patient.id, deps, at);
      return;
    } catch (err) {
      if (!(err instanceof AppointmentNotFoundError)) throw err;
    }
  }
  await send({ kind: "text", to: conv.contact, body: MESSAGES.appointmentNotFound });
  return handoff(conv, "appointment:not_found", deps, at);
}

/**
 * Asks once per conversation, after a confirmed appointment, whether the patient wants
 * recall invitations. Skipped if they already answered (here or at the front desk) or
 * replied PARAR.
 */
async function askRecallConsent(
  conv: ConversationRecord,
  clinic: ClinicInfo,
  patientId: string,
  deps: HandlerDeps,
  at: Date,
) {
  if (!deps.recall || conv.recallConsentAskedAt || conv.marketingOptOutAt) return;
  if (await deps.recall.consentOf(clinic.id, patientId)) return;
  await deps.store.updateConversation(conv.id, { recallConsentAskedAt: at });
  await sendAndStore(
    conv,
    {
      kind: "buttons",
      to: conv.contact,
      body: MESSAGES.recallConsentAsk,
      buttons: [...MESSAGES.recallConsentButtons],
    },
    deps,
  );
}

async function recallConsent(
  conv: ConversationRecord,
  clinic: ClinicInfo,
  granted: boolean,
  deps: HandlerDeps,
  at: Date,
) {
  const send = (body: string) => sendAndStore(conv, { kind: "text", to: conv.contact, body }, deps);
  const agenda = await deps.agendaFor?.(clinic.id);
  const patient = agenda ? await agenda.buscarPaciente({ phone: conv.contact }) : null;
  if (
    !patient ||
    !deps.recall ||
    !(await deps.recall.recordConsent(clinic.id, patient.id, granted, at, "WHATSAPP"))
  ) {
    await send(MESSAGES.recallConsentNotFound);
    return handoff(conv, "recall:consent_unrecorded", deps, at);
  }
  deps.logger.info({ conversationId: conv.id, granted }, "recall consent from patient");
  await send(granted ? MESSAGES.recallConsentYes : MESSAGES.recallConsentNo);
}

function sendMenu(conv: ConversationRecord, deps: HandlerDeps) {
  return sendAndStore(
    conv,
    { kind: "buttons", to: conv.contact, body: MESSAGES.menu, buttons: [...MESSAGES.menuButtons] },
    deps,
  );
}

function pauseUntil(from: Date, deps: HandlerDeps): Date {
  return new Date(from.getTime() + deps.config.handoffPauseMinutes * 60_000);
}

async function handoff(conv: ConversationRecord, reason: string, deps: HandlerDeps, at: Date) {
  await deps.store.updateConversation(conv.id, { botPausedUntil: pauseUntil(at, deps) });
  deps.logger.info({ conversationId: conv.id, reason }, "handoff to front desk");
}

async function sendAndStore(conv: ConversationRecord, msg: OutboundMessage, deps: HandlerDeps) {
  const { waMessageId } = await deps.channel.send(msg);
  await deps.store.saveMessage({
    conversationId: conv.id,
    waMessageId,
    direction: "OUTBOUND",
    type: msg.kind,
    body: previewText(msg),
    at: deps.now?.() ?? new Date(),
  });
}
