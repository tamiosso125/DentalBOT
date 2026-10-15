import type { Logger } from "../lib/logger.js";
import type { OutboundMessage, WhatsAppChannel, WhatsAppEvent } from "../whatsapp/index.js";
import { previewText } from "../whatsapp/index.js";
import { detectIntent } from "./intents.js";
import { MESSAGES } from "./messages.js";
import type { ConversationRecord, ConversationStore } from "./store.js";

export type HandlerDeps = {
  store: ConversationStore;
  channel: WhatsAppChannel;
  logger: Logger;
  now?: () => Date;
  config: { handoffPauseMinutes: number; privacyPolicyUrl: string };
};

/**
 * Processes one normalized WhatsApp event. Runs inside the queue worker, never in the
 * webhook request. Idempotent per waMessageId (Meta redelivers webhooks).
 *
 * Phase 1 foundation: deterministic commands, safety handoffs, coexistence pause and a
 * menu. The LLM orchestrator (router + attendant + tools) plugs in at `answer()`.
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
  });
  await store.updateConversation(conv.id, { lastInboundAt: now() });

  const intent = detectIntent(event.text, event.replyId);
  const paused = conv.botPausedUntil !== null && conv.botPausedUntil > now();

  // Emergencies always get the safety message, even while a human is handling the chat.
  if (paused && intent.kind !== "emergency") {
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
    case "menu_choice":
      // TODO(fase-1): replace with the scheduling and quote flows once the orchestrator lands.
      await send({
        kind: "text",
        to: conv.contact,
        body: intent.choice === "orcamento" ? MESSAGES.quoteSoon : MESSAGES.schedulingSoon,
      });
      return handoff(conv, `menu:${intent.choice}`, deps, now());
    case "other":
      await send({
        kind: "buttons",
        to: conv.contact,
        body: MESSAGES.menu,
        buttons: [...MESSAGES.menuButtons],
      });
      return;
  }
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
  });
}
