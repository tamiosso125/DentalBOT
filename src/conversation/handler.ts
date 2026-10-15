import { respond, type OrchestratorDeps } from "../ai/orchestrator.js";
import type { Logger } from "../lib/logger.js";
import type { QuoteService } from "../quotes/quote-service.js";
import type { OutboundMessage, WhatsAppChannel, WhatsAppEvent } from "../whatsapp/index.js";
import { previewText } from "../whatsapp/index.js";
import { detectIntent } from "./intents.js";
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
  // Quote buttons are deterministic answers to something the clinic sent, so they are
  // recorded even then.
  if (paused && intent.kind !== "emergency" && intent.kind !== "quote_action") {
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
