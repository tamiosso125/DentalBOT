import { describe, expect, it } from "vitest";
import {
  CLINIC_ID,
  echoPayload,
  makeDeps,
  PATIENT,
  signed,
  textPayload,
} from "../../tests/support/fixtures.js";
import { silentLogger } from "../lib/logger.js";
import type { AsaasWebhookEvent } from "../payments/asaas.js";
import { handleWhatsAppEvent } from "../conversation/handler.js";
import { InMemoryQueue } from "../queue/queue.js";
import type { WhatsAppEvent } from "../whatsapp/index.js";
import type { PanelQueries } from "../panel/panel-queries.js";
import { BillingError, type Billing } from "../panel/billing.js";
import { RecallError, type RecallService } from "../recall/recall.js";
import { ClinicSetupError, type ClinicSetup } from "../panel/clinic-setup.js";
import { PatientDataError, type PatientData } from "../panel/patient-data.js";
import { buildServer } from "./server.js";

const SECRET = "test-app-secret-0000000000";
const VERIFY = "test-verify-token-000";
const ASAAS_TOKEN = "test-asaas-token-0000";

const ADMIN = "test-admin-token-00000000000000000000";
const NOW = new Date("2026-10-19T12:00:00Z");

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
    attendance: async (...a) => (
      calls.push(["attendance", ...a]),
      { pending: [], month: { attended: 0, noShow: 0, noShowNotices: 0, rebooked: 0 } }
    ),
    quoteFollowUp: async (...a) => (
      calls.push(["quoteFollowUp", ...a]),
      { waiting: [], month: { accepted: 1, rejected: 0, expired: 0 } }
    ),
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

/** Only dentist "d1" exists; procedure names must be unique ("Limpeza" is taken). */
function stubSetup() {
  const calls: unknown[][] = [];
  const noDentist = (id: string) => {
    if (id !== "d1") throw new ClinicSetupError(404, "Dentista não encontrado.");
  };
  const setup: ClinicSetup = {
    view: async (...a) => (
      calls.push(["view", ...a]),
      { clinic: null, dentists: [], procedures: [], insurancePlans: [], blocks: [] }
    ),
    saveClinic: async (...a) => void calls.push(["saveClinic", ...a]),
    createDentist: async (...a) => (calls.push(["createDentist", ...a]), { id: "d2" }),
    updateDentist: async (...a) => (calls.push(["updateDentist", ...a]), noDentist(a[1])),
    setWorkingHours: async (...a) => (calls.push(["setWorkingHours", ...a]), noDentist(a[1])),
    createProcedure: async (...a) => {
      calls.push(["createProcedure", ...a]);
      if ((a[1] as { name?: string }).name === "Limpeza")
        throw new ClinicSetupError(409, "Já existe um procedimento com esse nome.");
      return { id: "p2" };
    },
    updateProcedure: async (...a) => void calls.push(["updateProcedure", ...a]),
    createPlan: async (...a) => (calls.push(["createPlan", ...a]), { id: "plan2" }),
    updatePlan: async (...a) => void calls.push(["updatePlan", ...a]),
    setCoverage: async (...a) => {
      calls.push(["setCoverage", ...a]);
      if (a[1] !== "plan1") throw new ClinicSetupError(404, "Convênio não encontrado.");
    },
    createBlock: async (...a) => (calls.push(["createBlock", ...a]), { id: "b1", appointments: 2 }),
    deleteBlock: async (...a) => void calls.push(["deleteBlock", ...a]),
  };
  return { setup, calls };
}

/** Only installment "i1" has a charge in Asaas. */
function stubBilling() {
  const calls: unknown[][] = [];
  const billing: Billing = {
    installments: async (...a) => (calls.push(["installments", ...a]), []),
    summary: async (...a) => (
      calls.push(["summary", ...a]),
      { openCents: 0, lateCents: 0, lateCount: 0, toCallCount: 0, paidThisMonthCents: 0 }
    ),
    paymentLink: async (...a) => {
      calls.push(["paymentLink", ...a]);
      if (a[1] !== "i1")
        throw new BillingError(409, "A cobrança desta parcela ainda não foi emitida no Asaas.");
      return { url: "https://sandbox.asaas.com/i/pay_1" };
    },
  };
  return { billing, calls };
}

/** Only patient "p1" is the clinic's. */
function stubRecall() {
  const calls: unknown[][] = [];
  const recall: Pick<RecallService, "list" | "setConsent"> = {
    list: async (...a) => (
      calls.push(["list", ...a]),
      { afterMonths: 6, schedule: "terça, das 9h às 12h", consentText: "Aceito", rows: [] }
    ),
    setConsent: async (...a) => {
      calls.push(["setConsent", ...a]);
      if (a[1] !== "p1") throw new RecallError(404, "Paciente não encontrado.");
    },
  };
  return { recall, calls };
}

function setup() {
  const { panel, calls } = stubPanel();
  const recall = stubRecall();
  const billing = stubBilling();
  const clinicSetup = stubSetup();
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
      setup: clinicSetup.setup,
      billing: billing.billing,
      recall: recall.recall,
      waitlist: ctx.waitlist,
      survey: ctx.survey,
      now: () => NOW,
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
    setupCalls: clinicSetup.calls,
    billingCalls: billing.calls,
    recallCalls: recall.calls,
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
      ["POST", "/admin/appointments/a1/attendance"],
      ["GET", "/admin/attendance"],
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

    const early = await post(`/admin/appointments/${id}/attendance`, { attended: true });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toContain("depois do horário");

    expect((await post(`/admin/appointments/${id}/cancel`, {})).statusCode).toBe(204);
    expect((await post(`/admin/appointments/${id}/cancel`, {})).statusCode).toBe(404);
    expect(ctx.agendaRepo.appointments[0]!.status).toBe("CANCELLED");
  });

  it("reads pending attendance and the month's counts for the clinic", async () => {
    const { app, panelCalls } = setup();
    const res = await app.inject({ method: "GET", url: "/admin/attendance", headers: auth });
    expect(res.json()).toEqual({
      pending: [],
      month: { attended: 0, noShow: 0, noShowNotices: 0, rebooked: 0 },
    });
    expect(panelCalls).toContainEqual(["attendance", CLINIC_ID, NOW]);
  });

  it("reads the quotes waiting for an answer, not as a quote id", async () => {
    const { app, panelCalls } = setup();
    const res = await app.inject({ method: "GET", url: "/admin/quotes/follow-up", headers: auth });
    expect(res.json()).toEqual({ waiting: [], month: { accepted: 1, rejected: 0, expired: 0 } });
    expect(panelCalls).toContainEqual(["quoteFollowUp", CLINIC_ID, NOW]);
    const anon = await app.inject({ method: "GET", url: "/admin/quotes/follow-up" });
    expect(anon.statusCode).toBe(401);
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

describe("admin clinic setup API", () => {
  const auth = { authorization: `Bearer ${ADMIN}` };
  const routes = [
    ["GET", "/admin/setup"],
    ["PUT", "/admin/setup/clinic"],
    ["POST", "/admin/setup/dentists"],
    ["PUT", "/admin/setup/dentists/d1"],
    ["PUT", "/admin/setup/dentists/d1/hours"],
    ["POST", "/admin/setup/procedures"],
    ["PUT", "/admin/setup/procedures/p1"],
    ["POST", "/admin/setup/plans"],
    ["PUT", "/admin/setup/plans/plan1"],
    ["PUT", "/admin/setup/plans/plan1/coverage"],
    ["POST", "/admin/setup/blocks"],
    ["DELETE", "/admin/setup/blocks/b1"],
  ] as const;

  it("requires the bearer token on every route", async () => {
    const { app, setupCalls } = setup();
    for (const [method, url] of routes)
      expect((await app.inject({ method, url, payload: {} })).statusCode, url).toBe(401);
    expect(setupCalls).toEqual([]);
  });

  it("passes every change to the clinic of the token and maps refusals", async () => {
    const { app, setupCalls } = setup();
    const call = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: object) =>
      app.inject({ method, url, headers: auth, payload });
    const hours = { hours: [{ weekday: 1, startMinute: 480, endMinute: 720 }] };
    const block = { dentistId: "d1", fromDate: "2026-12-24", toDate: "2026-12-25" };

    expect((await call("GET", "/admin/setup")).json()).toMatchObject({ clinic: null });
    expect((await call("PUT", "/admin/setup/clinic", { name: "Clínica Sorriso" })).statusCode).toBe(
      204,
    );
    const dentist = await call("POST", "/admin/setup/dentists", { name: "Dra. Ana" });
    expect([dentist.statusCode, dentist.json()]).toEqual([201, { id: "d2" }]);
    expect((await call("PUT", "/admin/setup/dentists/d1", { name: "Dra. Ana" })).statusCode).toBe(
      204,
    );
    expect((await call("PUT", "/admin/setup/dentists/d1/hours", hours)).statusCode).toBe(204);
    const missing = await call("PUT", "/admin/setup/dentists/d9/hours", hours);
    expect([missing.statusCode, missing.json()]).toEqual([
      404,
      { error: "Dentista não encontrado." },
    ]);
    const taken = await call("POST", "/admin/setup/procedures", { name: "Limpeza" });
    expect(taken.statusCode).toBe(409);
    expect((await call("PUT", "/admin/setup/procedures/p1", { name: "Canal" })).statusCode).toBe(
      204,
    );
    const coverage = { items: [{ procedureId: "p1", requiresAuthorization: true }] };
    expect((await call("POST", "/admin/setup/plans", { name: "Odontoprev" })).json()).toEqual({
      id: "plan2",
    });
    expect((await call("PUT", "/admin/setup/plans/plan1", { name: "Odontoprev" })).statusCode).toBe(
      204,
    );
    expect((await call("PUT", "/admin/setup/plans/plan1/coverage", coverage)).statusCode).toBe(204);
    expect((await call("PUT", "/admin/setup/plans/plan9/coverage", coverage)).statusCode).toBe(404);
    expect((await call("POST", "/admin/setup/blocks", block)).json()).toEqual({
      id: "b1",
      appointments: 2,
    });
    expect((await call("DELETE", "/admin/setup/blocks/b1")).statusCode).toBe(204);

    expect(setupCalls.map((c) => c.slice(0, 3))).toEqual([
      ["view", CLINIC_ID, NOW],
      ["saveClinic", CLINIC_ID, { name: "Clínica Sorriso" }],
      ["createDentist", CLINIC_ID, { name: "Dra. Ana" }],
      ["updateDentist", CLINIC_ID, "d1"],
      ["setWorkingHours", CLINIC_ID, "d1"],
      ["setWorkingHours", CLINIC_ID, "d9"],
      ["createProcedure", CLINIC_ID, { name: "Limpeza" }],
      ["updateProcedure", CLINIC_ID, "p1"],
      ["createPlan", CLINIC_ID, { name: "Odontoprev" }],
      ["updatePlan", CLINIC_ID, "plan1"],
      ["setCoverage", CLINIC_ID, "plan1"],
      ["setCoverage", CLINIC_ID, "plan9"],
      ["createBlock", CLINIC_ID, block],
      ["deleteBlock", CLINIC_ID, "b1"],
    ]);
  });
});

describe("admin billing API", () => {
  const auth = { authorization: `Bearer ${ADMIN}` };

  it("requires the bearer token", async () => {
    const { app, billingCalls } = setup();
    for (const url of [
      "/admin/installments",
      "/admin/installments/summary",
      "/admin/installments/i1/link",
    ])
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    expect(billingCalls).toEqual([]);
  });

  it("validates the filter and maps a missing charge to a readable error", async () => {
    const { app, billingCalls } = setup();
    const get = (url: string) => app.inject({ method: "GET", url, headers: auth });

    expect((await get("/admin/installments")).statusCode).toBe(200);
    expect((await get("/admin/installments?filtro=vencidas&quoteId=q1")).statusCode).toBe(200);
    expect((await get("/admin/installments?filtro=outra")).statusCode).toBe(400);
    expect((await get("/admin/installments/summary")).json()).toMatchObject({ lateCount: 0 });
    const link = await get("/admin/installments/i1/link");
    expect(link.json()).toEqual({ url: "https://sandbox.asaas.com/i/pay_1" });
    expect(link.headers["cache-control"]).toBe("no-store");
    const missing = await get("/admin/installments/i2/link");
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error).toContain("ainda não foi emitida");

    expect(billingCalls).toEqual([
      ["installments", CLINIC_ID, { filtro: "abertas" }, NOW],
      ["installments", CLINIC_ID, { filtro: "vencidas", quoteId: "q1" }, NOW],
      ["summary", CLINIC_ID, NOW],
      ["paymentLink", CLINIC_ID, "i1"],
      ["paymentLink", CLINIC_ID, "i2"],
    ]);
  });
});

describe("admin recall API", () => {
  const auth = { authorization: `Bearer ${ADMIN}` };

  it("requires the bearer token", async () => {
    const { app, recallCalls } = setup();
    expect((await app.inject({ method: "GET", url: "/admin/recall" })).statusCode).toBe(401);
    const post = await app.inject({
      method: "POST",
      url: "/admin/recall/p1/consent",
      payload: { granted: true },
    });
    expect(post.statusCode).toBe(401);
    expect(recallCalls).toEqual([]);
  });

  it("lists candidates and records consent for the clinic", async () => {
    const { app, recallCalls } = setup();
    const list = await app.inject({ method: "GET", url: "/admin/recall", headers: auth });
    expect(list.json()).toMatchObject({ afterMonths: 6, rows: [] });
    const consent = (id: string) =>
      app.inject({
        method: "POST",
        url: `/admin/recall/${id}/consent`,
        headers: auth,
        payload: { granted: true },
      });
    expect((await consent("p1")).statusCode).toBe(204);
    const missing = await consent("p9");
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("Paciente não encontrado.");
    expect(recallCalls).toEqual([
      ["list", CLINIC_ID, NOW],
      ["setConsent", CLINIC_ID, "p1", { granted: true }, NOW],
      ["setConsent", CLINIC_ID, "p9", { granted: true }, NOW],
    ]);
  });
});

describe("admin waitlist API", () => {
  const auth = { authorization: `Bearer ${ADMIN}` };

  it("requires the bearer token", async () => {
    const { app } = setup();
    for (const [method, url] of [
      ["GET", "/admin/waitlist"],
      ["POST", "/admin/waitlist"],
      ["POST", "/admin/waitlist/w1/remove"],
    ] as const)
      expect((await app.inject({ method, url, payload: {} })).statusCode, url).toBe(401);
  });

  it("adds, lists and removes a patient for the clinic", async () => {
    const { app, ctx } = setup();
    const maria = await ctx.agenda.cadastrarPaciente({ name: "Maria Exemplo", phone: PATIENT });
    const add = (payload: Record<string, string>) =>
      app.inject({ method: "POST", url: "/admin/waitlist", headers: auth, payload });
    const body = { patientId: maria.id, procedureId: "proc_avaliacao", until: "2026-10-30" };
    const created = await add(body);
    expect(created.statusCode).toBe(201);
    expect((await add(body)).statusCode).toBe(409);
    expect((await add({ ...body, until: "ontem" })).statusCode).toBe(422);
    expect((await add({ ...body, patientId: "p9" })).json()).toEqual({
      error: "Paciente ou procedimento não encontrado.",
    });

    const list = await app.inject({ method: "GET", url: "/admin/waitlist", headers: auth });
    expect(list.json().rows).toEqual([
      expect.objectContaining({ patientName: "Maria Exemplo", status: "WAITING" }),
    ]);
    const remove = (id: string) =>
      app.inject({ method: "POST", url: `/admin/waitlist/${id}/remove`, headers: auth });
    expect((await remove(created.json().id)).statusCode).toBe(204);
    expect((await remove(created.json().id)).statusCode).toBe(404);
  });
});

describe("admin surveys API", () => {
  it("requires the bearer token and returns the clinic's summary", async () => {
    const { app } = setup();
    expect((await app.inject({ method: "GET", url: "/admin/surveys" })).statusCode).toBe(401);
    const res = await app.inject({
      method: "GET",
      url: "/admin/surveys",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      month: { sent: 0, answers: 0, average: null, byRating: [0, 0, 0, 0, 0] },
      low: [],
    });
  });
});
