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
import { PatientDataError, type PatientData } from "../panel/patient-data.js";
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
    appointment: async (...a) => (calls.push(["appointment", ...a]), null),
    patients: async (...a) => (calls.push(["patients", ...a]), []),
    catalog: async (...a) => (calls.push(["catalog", ...a]), null),
    quotes: async (...a) => (calls.push(["quotes", ...a]), []),
    handoffs: async (...a) => (calls.push(["handoffs", ...a]), []),
  };
  return { panel, calls };
}

/** Patient "p1" has an open installment; "r1" is the only open request. */
function stubPatientData() {
  const calls: unknown[][] = [];
  const data: PatientData = {
    dataRequests: async (...a) => (
      calls.push(["dataRequests", ...a]),
      [{ id: "r1", createdAt: "x", patientId: null, patientName: null, contact: "***0001" }]
    ),
    resolveRequest: async (...a) => {
      calls.push(["resolveRequest", ...a]);
      if (a[1] !== "r1") throw new PatientDataError(404, "Pedido não encontrado.");
    },
    summary: async (...a) => (calls.push(["summary", ...a]), null),
    export: async (...a) => {
      calls.push(["export", ...a]);
      return { generatedAt: "x", clinic: "Clínica Sorriso", patient: null } as never;
    },
    anonymize: async (...a) => {
      calls.push(["anonymize", ...a]);
      if ("patientId" in a[1]) throw new PatientDataError(409, "Há 1 parcela(s) em aberto.");
      return { cancelledAppointments: 0, conversations: 1, messages: 3 };
    },
  };
  return { data, calls };
}

function setup() {
  const { panel, calls } = stubPanel();
  const patientData = stubPatientData();
  const ctx = makeDeps();
  const { deps, channel, quotes, staffAgenda } = ctx;
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
    admin: {
      token: ADMIN,
      clinicId: CLINIC_ID,
      quotes,
      panel,
      agenda: staffAgenda,
      patientData: patientData.data,
    },
  });
  return {
    app,
    ctx,
    channel,
    whatsappQueue,
    asaasQueue,
    asaasEvents,
    panelCalls: calls,
    dataCalls: patientData.calls,
  };
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

describe("admin agenda API", () => {
  const auth = { authorization: `Bearer ${ADMIN}` };
  const booking = (patientId: string, startsAt = "2026-10-21T13:00:00.000Z") => ({
    patient: { id: patientId },
    procedureId: "proc_avaliacao",
    dentistId: "dentist_dev",
    startsAt,
  });

  it("requires the bearer token on every agenda route", async () => {
    const { app } = setup();
    for (const [method, url] of [
      ["GET", "/admin/slots?procedureId=proc_avaliacao&from=2026-10-20"],
      ["GET", "/admin/appointments/a1"],
      ["POST", "/admin/appointments"],
      ["POST", "/admin/appointments/a1/reschedule"],
      ["POST", "/admin/appointments/a1/cancel"],
    ] as const) {
      expect((await app.inject({ method, url, payload: {} })).statusCode).toBe(401);
    }
  });

  it("lists slots, books, moves and cancels with readable errors", async () => {
    const { app, ctx } = setup();
    const p = await ctx.agenda.cadastrarPaciente({ name: "Maria Exemplo", phone: "5511900000001" });

    const slots = await app.inject({
      method: "GET",
      url: "/admin/slots?procedureId=proc_avaliacao&from=2026-10-21",
      headers: auth,
    });
    expect(slots.json()[0]).toEqual({
      dentistId: "dentist_dev",
      startsAt: "2026-10-21T11:00:00.000Z",
      endsAt: "2026-10-21T11:30:00.000Z",
    });

    const post = (url: string, payload: object) =>
      app.inject({ method: "POST", url, headers: auth, payload });
    const created = await post("/admin/appointments", booking(p.id));
    expect(created.statusCode).toBe(201);
    const { id, notified } = created.json<{ id: string; notified: boolean }>();
    expect(notified).toBe(true);

    const taken = await post("/admin/appointments", booking(p.id));
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toContain("não está mais livre");
    expect((await post("/admin/appointments", { patient: {} })).statusCode).toBe(422);

    const moved = await post(`/admin/appointments/${id}/reschedule`, {
      dentistId: "dentist_dev",
      startsAt: "2026-10-21T14:00:00.000Z",
      notify: false,
    });
    expect(moved.json()).toEqual({ notified: false });

    expect((await post(`/admin/appointments/${id}/cancel`, {})).statusCode).toBe(204);
    expect((await post(`/admin/appointments/${id}/cancel`, {})).statusCode).toBe(404);
    expect(ctx.agendaRepo.appointments[0]!.status).toBe("CANCELLED");
  });

  it("returns 404 for an appointment the panel query does not find", async () => {
    const { app, panelCalls } = setup();
    const res = await app.inject({ method: "GET", url: "/admin/appointments/a1", headers: auth });
    expect(res.statusCode).toBe(404);
    expect(panelCalls).toContainEqual(["appointment", CLINIC_ID, "a1"]);
  });
});

describe("admin LGPD API", () => {
  const auth = { authorization: `Bearer ${ADMIN}` };
  const routes = [
    ["GET", "/admin/data-requests"],
    ["POST", "/admin/data-requests/r1/resolve"],
    ["GET", "/admin/data-requests/r1/export"],
    ["POST", "/admin/data-requests/r1/anonymize"],
    ["GET", "/admin/patients/p1"],
    ["GET", "/admin/patients/p1/export"],
    ["POST", "/admin/patients/p1/anonymize"],
  ] as const;

  it("requires the bearer token on every route", async () => {
    const { app, dataCalls } = setup();
    for (const [method, url] of routes)
      expect((await app.inject({ method, url, payload: {} })).statusCode, url).toBe(401);
    expect(dataCalls).toEqual([]);
  });

  it("downloads the export as a JSON attachment and maps refusals to readable errors", async () => {
    const { app, dataCalls } = setup();
    const call = (method: "GET" | "POST", url: string) =>
      app.inject({ method, url, headers: auth, payload: method === "POST" ? {} : undefined });

    expect((await call("GET", "/admin/data-requests")).json()).toHaveLength(1);
    const exported = await call("GET", "/admin/data-requests/r1/export");
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-disposition"]).toBe('attachment; filename="dados-r1.json"');
    expect(exported.headers["cache-control"]).toBe("no-store");
    expect(exported.json()).toMatchObject({ clinic: "Clínica Sorriso" });

    expect((await call("POST", "/admin/data-requests/r1/anonymize")).json()).toEqual({
      cancelledAppointments: 0,
      conversations: 1,
      messages: 3,
    });
    const refused = await call("POST", "/admin/patients/p1/anonymize");
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain("parcela");
    expect((await call("GET", "/admin/patients/p1")).statusCode).toBe(404);
    expect((await call("POST", "/admin/data-requests/r1/resolve")).statusCode).toBe(204);
    expect((await call("POST", "/admin/data-requests/r2/resolve")).statusCode).toBe(404);

    expect(dataCalls.map((c) => c.slice(0, 3))).toEqual([
      ["dataRequests", CLINIC_ID],
      ["export", CLINIC_ID, { requestId: "r1" }],
      ["anonymize", CLINIC_ID, { requestId: "r1" }],
      ["anonymize", CLINIC_ID, { patientId: "p1" }],
      ["summary", CLINIC_ID, "p1"],
      ["resolveRequest", CLINIC_ID, "r1"],
      ["resolveRequest", CLINIC_ID, "r2"],
    ]);
  });
});
