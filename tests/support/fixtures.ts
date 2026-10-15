import type { HandlerDeps } from "../../src/conversation/handler.js";
import { InMemoryConversationStore } from "../../src/conversation/store.js";
import { silentLogger } from "../../src/lib/logger.js";
import {
  fakeAppEcho,
  fakeButtonReply,
  fakeTextMessage,
  SandboxChannel,
  signBody,
} from "../../src/whatsapp/index.js";

export const PHONE_NUMBER_ID = "100000000000001";
/** Fictitious test number (convention: 55 + DDD + 90000-XXXX). */
export const PATIENT = "5511900000001";

export function makeDeps(now = new Date("2026-10-19T12:00:00Z")) {
  const store = new InMemoryConversationStore({
    id: "clinic_test",
    name: "Clínica Sorriso",
    phoneNumberId: PHONE_NUMBER_ID,
  });
  const channel = new SandboxChannel();
  const clock = { now };
  const deps: HandlerDeps = {
    store,
    channel,
    logger: silentLogger,
    now: () => clock.now,
    config: { handoffPauseMinutes: 240, privacyPolicyUrl: "https://example.com/privacidade" },
  };
  return { store, channel, clock, deps };
}

export const textPayload = (text: string, from = PATIENT) =>
  fakeTextMessage({ phoneNumberId: PHONE_NUMBER_ID, from, text });

export const buttonPayload = (replyId: string, title: string, from = PATIENT) =>
  fakeButtonReply({ phoneNumberId: PHONE_NUMBER_ID, from, replyId, title });

export const echoPayload = (text: string, to = PATIENT) =>
  fakeAppEcho({ phoneNumberId: PHONE_NUMBER_ID, to, text });

export function signed(payload: unknown, secret: string) {
  const body = JSON.stringify(payload);
  return { body, signature: signBody(body, secret) };
}
