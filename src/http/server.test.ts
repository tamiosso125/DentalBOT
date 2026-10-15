import { describe, expect, it } from "vitest";
import {
  CLINIC_ID,
  echoPayload,
  makeDeps,
  signed,
  textPayload,
} from "../../tests/support/fixtures.js";
import { silentLogger } from "../lib/logger.js";
import type { AsaasWebhookEvent } from "../payments/asaas.js";
import { handleWhatsAppEvent } from "../conversation/handler.js";
import { InMemoryQueue } from "../queue/queue.js";
import type { WhatsAppEvent } from "../whatsapp/index.js";
import type { PanelQueries } from "../panel/panel-queries.js";
import { buildServer } from "./server.js";

const SECRET = "test-app-secret-0000000000";
const VERIFY = "test-verify-token-000";
const ASAAS_TOKEN = "test-asaas-token-0000";

const ADMIN = "test-admin-token-00000000000000000000";

/** Records what the panel routes ask for; the Prisma queries have their own integration test. */
function stubPanel() {
  const calls: unknown[][] = [];
  const panel: PanelQueries = {
    agenda: async (...a) => (calls.push(["agenda", ...a]), []),
    patients: async (...a) => (calls.push(["patients", ...a]), []),
    catalog: async (...a) => (calls.push(["catalog", ...a]), null),
    quotes: async (...a) => (calls.push(["quotes", ...a]), []),
    handoffs: async (...a) => (calls.push(["handoffs", ...a]), []),
  };
  return { panel, calls };
}

function setup() {
  const { panel, calls } = stubPanel();
  const { deps, channel, quotes } = makeDeps();
  const whatsappQueue = new InMemoryQueue<WhatsAppEvent>(
    (e) => handleWhatsAppEvent(e, deps),
    silentLogger,
  );
  const asaasEvents: AsaasWebhookEvent[] = [];
  const asaasQueue = new InMemoryQueue<AsaasWebhookEvent>(async (e) => {
    asaasEvents.push(e);
  }, silentLogger);
  const app = buildServer({
    logger: silentLogger,
    whatsappQueue,
    asaasQueue,
    config: {
      whatsappVerifyToken: VERIFY,
      whatsappAppSecret: SECRET,
      asaasWebhookToken: ASAAS_TOKEN,
    },
    sandbox: channel,
    admin: { token: ADMIN, clinicId: CLINIC_ID, quotes, panel },
  });
  return { app, channel, whatsappQueue, asaasQueue, asaasEvents, panelCalls: calls };
}

describe("WhatsApp webhook", () => {
  it("answers Meta's verification challenge", async () => {
    const { app } = setup();
    const ok = await app.inject({
      method: "GET",
      url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=42`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("42");

    const bad = await app.inject({
      method: "GET",
      url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42",
    });
    expect(bad.statusCode).toBe(403);
  });

  it("rejects unsigned or tampered payloads", async () => {
    const { app, channel, whatsappQueue } = setup();
    const { body, signature } = signed(textPayload("oi"), SECRET);
    const tampered = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      payload: body.replace("oi", "ei"),
    });
    expect(tampered.statusCode).toBe(401);
    await whatsappQueue.drain();
    expect(channel.outbox).toHaveLength(0);
  });

  it("acks with 200 and processes the message in the queue", async () => {
    const { app, channel, whatsappQueue } = setup();
    const { body, signature } = signed(textPayload("oi"), SECRET);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    await whatsappQueue.drain();
    expect(channel.outbox).toHaveLength(2);

    const outbox = await app.inject({ method: "GET", url: "/dev/sandbox/outbox" });
    expect(outbox.json().messages).toHaveLength(2);
  });

  it("accepts coexistence echoes", async () => {
    const { app, whatsappQueue } = setup();
    const { body, signature } = signed(echoPayload("Oi, aqui é a recepção"), SECRET);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    await whatsappQueue.drain();
  });
});

describe("Asaas webhook", () => {
  const event = {
    id: "evt_test_1",
    event: "PAYMENT_RECEIVED",
    payment: { id: "pay_test_1", status: "RECEIVED", value: 150, externalReference: "inst_1" },
  };

  it("requires the access token", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "POST", url: "/webhooks/asaas", payload: event });
    expect(res.statusCode).toBe(401);
  });

  it("enqueues valid events", async () => {
    const { app, asaasQueue, asaasEvents } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/asaas",
      headers: { "asaas-access-token": ASAAS_TOKEN },
      payload: event,
    });
    expect(res.statusCode).toBe(200);
    await asaasQueue.drain();
    expect(asaasEvents).toHaveLength(1);
  });
});

describe("admin quote API", () => {
  const auth = { authorization: `Bearer ${ADMIN}` };
  const body = {
    patientId: "patient_dev",
    dentistId: "dentist_dev",
    items: [{ procedureId: "proc_limpeza" }],
  };

  it("requires the bearer token", async () => {
    const { app } = setup();
    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: ADMIN }]) {
      const res = await app.inject({
        method: "POST",
        url: "/admin/quotes",
        headers,
        payload: body,
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it("creates, renders and sends a quote", async () => {
    const { app, channel } = setup();
    const created = await app.inject({
      method: "POST",
      url: "/admin/quotes",
      headers: auth,
      payload: body,
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: string }>();

    const view = await app.inject({ method: "GET", url: `/admin/quotes/${id}`, headers: auth });
    expect(view.json()).toMatchObject({ id, status: "DRAFT", totalCents: 250_00 });

    const pdf = await app.inject({ method: "GET", url: `/admin/quotes/${id}/pdf`, headers: auth });
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");

    const sent = await app.inject({
      method: "POST",
      url: `/admin/quotes/${id}/send`,
      headers: auth,
    });
    expect(sent.json()).toEqual({ via: "template" });
    expect(channel.outbox.at(-1)).toMatchObject({ kind: "template" });
  });

  it("answers 422 for invalid quotes, 404 for unknown ids and 400 for bad JSON", async () => {
    const { app } = setup();
    const invalid = await app.inject({
      method: "POST",
      url: "/admin/quotes",
      headers: auth,
      payload: { ...body, items: [] },
    });
    expect(invalid.statusCode).toBe(422);
    for (const url of ["/admin/quotes/nope", "/admin/quotes/nope/pdf"]) {
      expect((await app.inject({ method: "GET", url, headers: auth })).statusCode).toBe(404);
    }
    const unsent = await app.inject({
      method: "POST",
      url: "/admin/quotes/nope/send",
      headers: auth,
    });
    expect(unsent.statusCode).toBe(422);
    const broken = await app.inject({
      method: "POST",
      url: "/admin/quotes",
      headers: { ...auth, "content-type": "application/json" },
      payload: "{",
    });
    expect(broken.statusCode).toBe(400);
  });

  it("keeps PDF bytes out of the sandbox outbox JSON", async () => {
    const { app, channel } = setup();
    await channel.send({
      kind: "document",
      to: "5511900000001",
      filename: "orcamento.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("%PDF-1.3"),
    });
    const res = await app.inject({ method: "GET", url: "/dev/sandbox/outbox" });
    expect(res.json().messages[0]).toMatchObject({ kind: "document", bytes: 8 });
    expect(res.json().messages[0].data).toBeUndefined();
  });
});

describe("admin panel read API", () => {
  const auth = { authorization: `Bearer ${ADMIN}` };

  it("requires the bearer token on every read route", async () => {
    const { app } = setup();
    for (const url of [
      "/admin/agenda?from=2026-10-19",
      "/admin/patients?q=maria",
      "/admin/catalog",
      "/admin/quotes",
      "/admin/handoffs",
    ]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    }
  });

  it("passes validated queries scoped to the configured clinic", async () => {
    const { app, panelCalls } = setup();
    const get = (url: string) => app.inject({ method: "GET", url, headers: auth });
    expect((await get("/admin/agenda?from=2026-10-19&days=3")).statusCode).toBe(200);
    expect((await get("/admin/patients?q=%20maria%20")).statusCode).toBe(200);
    expect((await get("/admin/quotes?status=SENT")).statusCode).toBe(200);
    expect((await get("/admin/handoffs")).statusCode).toBe(200);
    expect((await get("/admin/catalog")).statusCode).toBe(404);
    expect(panelCalls.map((c) => c.slice(0, 3))).toEqual([
      ["agenda", CLINIC_ID, { from: "2026-10-19", days: 3 }],
      ["patients", CLINIC_ID, "maria"],
      ["quotes", CLINIC_ID, "SENT"],
      ["handoffs", CLINIC_ID, expect.any(Date)],
      ["catalog", CLINIC_ID],
    ]);
  });

  it("answers 400 for invalid or unknown query parameters", async () => {
    const { app, panelCalls } = setup();
    for (const url of [
      "/admin/agenda",
      "/admin/agenda?from=19/10/2026",
      "/admin/agenda?from=2026-10-19&days=90",
      "/admin/patients?q=a",
      "/admin/quotes?status=PAID",
      "/admin/quotes?clinicId=other",
    ]) {
      const res = await app.inject({ method: "GET", url, headers: auth });
      expect(res.statusCode, url).toBe(400);
    }
    expect(panelCalls).toEqual([]);
  });
});
