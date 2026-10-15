import { describe, expect, it } from "vitest";
import {
  buttonPayload,
  echoPayload,
  makeDeps,
  PATIENT,
  textPayload,
} from "../../tests/support/fixtures.js";
import { normalizeWebhook, previewText, type WebhookPayload } from "../whatsapp/index.js";
import { handleWhatsAppEvent, type HandlerDeps } from "./handler.js";

async function deliver(payload: WebhookPayload, deps: HandlerDeps) {
  for (const e of normalizeWebhook(payload)) await handleWhatsAppEvent(e, deps);
}

describe("handleWhatsAppEvent", () => {
  it("sends the privacy notice once, then the menu", async () => {
    const { deps, channel } = makeDeps();
    await deliver(textPayload("oi"), deps);
    expect(channel.outbox).toHaveLength(2);
    expect(previewText(channel.outbox[0]!)).toContain("política de privacidade");
    expect(channel.outbox[1]!.kind).toBe("buttons");

    channel.clear();
    await deliver(textPayload("olá de novo"), deps);
    expect(channel.outbox).toHaveLength(1);
    expect(channel.outbox[0]!.kind).toBe("buttons");
  });

  it("ignores duplicated webhooks", async () => {
    const { deps, channel } = makeDeps();
    const payload = textPayload("oi");
    await deliver(payload, deps);
    await deliver(payload, deps);
    expect(channel.outbox).toHaveLength(2);
  });

  it("hands clinical questions to a human and stays quiet afterwards", async () => {
    const { deps, channel, store } = makeDeps();
    await deliver(textPayload("estou com dor no dente, posso tomar antibiótico?"), deps);
    const last = previewText(channel.outbox.at(-1)!);
    expect(last).toContain("Não consigo dar orientações clínicas");
    const conv = [...store.conversations.values()][0]!;
    expect(conv.botPausedUntil).not.toBeNull();

    channel.clear();
    await deliver(textPayload("alô?"), deps);
    expect(channel.outbox).toHaveLength(0);
  });

  it("answers emergencies even while paused", async () => {
    const { deps, channel } = makeDeps();
    await deliver(textPayload("atendente"), deps);
    channel.clear();
    await deliver(textPayload("meu rosto está inchado e não consigo engolir"), deps);
    expect(previewText(channel.outbox[0]!)).toContain("pronto-socorro");
  });

  it("pauses when the front desk replies from the app (coexistence)", async () => {
    const { deps, channel, clock } = makeDeps();
    await deliver(textPayload("oi"), deps);
    await deliver(echoPayload("Oi! Aqui é a Ana, da recepção."), deps);
    channel.clear();

    await deliver(textPayload("quero marcar"), deps);
    expect(channel.outbox).toHaveLength(0);

    clock.now = new Date(clock.now.getTime() + 5 * 60 * 60_000);
    await deliver(textPayload("oi de novo"), deps);
    expect(channel.outbox).toHaveLength(1);
  });

  it("handles PARAR and MEUS DADOS", async () => {
    const { deps, channel, store } = makeDeps();
    await deliver(textPayload("PARAR"), deps);
    expect(previewText(channel.outbox.at(-1)!)).toContain("não vai mais receber");
    expect([...store.conversations.values()][0]!.marketingOptOutAt).not.toBeNull();

    await deliver(textPayload("Meus dados"), deps);
    expect(store.dataRequests).toHaveLength(1);
  });

  it("routes menu buttons to the front desk for now", async () => {
    const { deps, channel } = makeDeps();
    await deliver(buttonPayload("menu:agendar", "Agendar consulta"), deps);
    expect(previewText(channel.outbox.at(-1)!)).toContain("agendamento");
    expect(channel.outbox.every((m) => m.to === PATIENT)).toBe(true);
  });

  it("stores message bodies only through the store", async () => {
    const { deps, store } = makeDeps();
    await deliver(textPayload("oi"), deps);
    expect(store.messages.map((m) => m.direction)).toEqual(["INBOUND", "OUTBOUND", "OUTBOUND"]);
  });
});
