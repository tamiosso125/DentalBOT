import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { loadEnv } from "../../src/config/env.js";
import { silentLogger } from "../../src/lib/logger.js";
import { FieldCipher } from "../../src/privacy/index.js";
import { fakeButtonReply, fakeTextMessage, signBody } from "../../src/whatsapp/index.js";

/**
 * End to end: real HTTP server, signed webhooks, in-memory queue, Postgres and the sandbox
 * outbox, wired by the same createApp() as production. Runs only against a disposable
 * database: TEST_DATABASE_URL=postgresql://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;

const APP_SECRET = "e2e-app-secret-000000000000";
const ASAAS_TOKEN = "e2e-asaas-token-00000000";
const ADMIN_TOKEN = "e2e-admin-token-0000000000000000000000";
/** Fictitious numbers (55 11 90000-XXXX), different from other test files. */
const PATIENT = "5511900000011";
const OTHER = "5511900000012";
const REQUESTER = "5511900000013";

type OutboxMessage = {
  kind: string;
  to: string;
  body?: string;
  template?: string;
  params?: string[];
  bytes?: number;
};

describe.skipIf(!url)("WhatsApp end to end (HTTP → fila → Postgres → saída)", () => {
  const phoneNumberId = `1${Date.now()}`;
  const env = loadEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    // Placeholder keeps collection working when the suite is skipped (no database).
    DATABASE_URL: url ?? "postgresql://skipped@localhost/skipped",
    QUEUE_MODE: "memory",
    WHATSAPP_MODE: "sandbox",
    ASAAS_ENV: "mock",
    AI_MODE: "off",
    // The test runs the reminder job itself, with a fixed clock.
    INSTALLMENT_REMINDER_INTERVAL_MINUTES: "0",
    APPOINTMENT_REMINDER_INTERVAL_MINUTES: "0",
    PII_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    PII_HASH_SECRET: randomBytes(32).toString("hex"),
    WHATSAPP_VERIFY_TOKEN: "e2e-verify-token-0000",
    WHATSAPP_APP_SECRET: APP_SECRET,
    ASAAS_WEBHOOK_TOKEN: ASAAS_TOKEN,
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    DEFAULT_CLINIC_ID: "",
  });
  const cipher = new FieldCipher(env.PII_ENCRYPTION_KEY, env.PII_HASH_SECRET);
  let app: ReturnType<typeof createApp>;
  let base = "";
  let clinicId = "";
  let patientId = "";
  let dentistId = "";
  let procedureId = "";

  beforeAll(async () => {
    // The staff API needs the clinic id up front, so create the clinic with a fixed id.
    clinicId = `clinic_e2e_${randomBytes(4).toString("hex")}`;
    app = createApp({ ...env, DEFAULT_CLINIC_ID: clinicId }, silentLogger);
    const { db } = app;
    await db.clinic.create({
      data: { id: clinicId, name: "Clínica E2E", whatsappPhoneNumberId: phoneNumberId },
    });
    dentistId = (await db.dentist.create({ data: { clinicId, name: "Dra. E2E" } })).id;
    procedureId = (
      await db.procedure.create({
        data: { clinicId, name: "Restauração", durationMinutes: 60, priceCents: 350_00 },
      })
    ).id;
    patientId = (
      await db.patient.create({
        data: {
          clinicId,
          name: "Paciente Exemplo",
          phoneHash: cipher.hash(PATIENT),
          phoneEncrypted: cipher.encrypt(PATIENT),
          // Fictitious CPF from the test convention; Asaas needs one to bill.
          cpfHash: cipher.hash("52998224725"),
          cpfEncrypted: cipher.encrypt("52998224725"),
        },
      })
    ).id;
    await app.server.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.addresses()[0]!;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    const { db } = app;
    await db.accessLog.deleteMany({ where: { clinicId } });
    await db.quoteItem.deleteMany({ where: { quote: { clinicId } } });
    await db.quote.deleteMany({ where: { clinicId } });
    await db.dataSubjectRequest.deleteMany({ where: { clinicId } });
    await db.message.deleteMany({ where: { conversation: { clinicId } } });
    await db.conversation.deleteMany({ where: { clinicId } });
    await db.appointment.deleteMany({ where: { clinicId } });
    await db.patient.deleteMany({ where: { clinicId } });
    await db.procedure.deleteMany({ where: { clinicId } });
    await db.workingHours.deleteMany({ where: { dentist: { clinicId } } });
    await db.dentist.deleteMany({ where: { clinicId } });
    await db.clinic.delete({ where: { id: clinicId } });
    await db.paymentEvent.deleteMany({ where: { id: { startsWith: "evt_e2e_" } } });
    await app.close();
  });

  async function webhook(payload: unknown, secret = APP_SECRET) {
    const body = JSON.stringify(payload);
    return fetch(`${base}/webhooks/whatsapp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signBody(body, secret),
      },
      body,
    });
  }

  const text = (t: string, from = PATIENT, id?: string) =>
    fakeTextMessage({ phoneNumberId, from, text: t, id });
  const button = (replyId: string, title: string, from = PATIENT) =>
    fakeButtonReply({ phoneNumberId, from, replyId, title });

  async function outbox(): Promise<OutboxMessage[]> {
    const res = await fetch(`${base}/dev/sandbox/outbox`);
    return ((await res.json()) as { messages: OutboxMessage[] }).messages;
  }
  async function clearOutbox() {
    await fetch(`${base}/dev/sandbox/outbox`, { method: "DELETE" });
  }

  /** The queue runs after the 200, so wait until the condition holds. */
  async function until<T>(check: () => Promise<T | undefined | false>, timeoutMs = 5000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = await check();
      if (v) return v;
      if (Date.now() > end) throw new Error("timed out waiting for the queue");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const replies = (n: number, to = PATIENT) =>
    until(async () => {
      const mine = (await outbox()).filter((m) => m.to === to);
      return mine.length >= n && mine;
    });

  const conversationOf = (contact: string) =>
    app.db.conversation.findUnique({
      where: { clinicId_contactHash: { clinicId, contactHash: cipher.hash(contact) } },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });

  it("rejects a webhook with a bad signature and stores nothing", async () => {
    const res = await webhook(text("oi", OTHER), "wrong-secret-0000000000");
    expect(res.status).toBe(401);
    await new Promise((r) => setTimeout(r, 100));
    expect(await conversationOf(OTHER)).toBeNull();
  });

  it("answers the first message with the privacy notice and the menu, all encrypted at rest", async () => {
    await clearOutbox();
    const started = Date.now();
    const res = await webhook(text("oi"));
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5000);

    const sent = await replies(2);
    expect(sent[0]!.body).toContain("Clínica E2E");
    expect(sent[1]!.kind).toBe("buttons");

    // Each reply is stored right after it goes out.
    const conv = await until(async () => {
      const c = await conversationOf(PATIENT);
      return c && c.messages.length >= 3 && c;
    });
    expect(conv.contactEncrypted).not.toContain(PATIENT);
    expect(conv.privacyNoticeAt).not.toBeNull();
    expect(conv.messages.map((m) => m.direction)).toEqual(["INBOUND", "OUTBOUND", "OUTBOUND"]);
    const inbound = conv.messages[0]!;
    expect(inbound.bodyEncrypted).not.toBe("oi");
    expect(cipher.decrypt(inbound.bodyEncrypted!)).toBe("oi");
  });

  it("ignores Meta redelivering the same message", async () => {
    await clearOutbox();
    const payload = text("quero ver o endereço", PATIENT, "wamid.e2e.dup");
    await webhook(payload);
    await replies(1);
    await webhook(payload);
    await new Promise((r) => setTimeout(r, 200));
    const conv = (await conversationOf(PATIENT))!;
    expect(conv.messages.filter((m) => m.waMessageId === "wamid.e2e.dup")).toHaveLength(1);
    const once = (await outbox()).length;
    expect(once).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 100));
    expect((await outbox()).length).toBe(once);
  });

  it("sends an alarm sign to the emergency room and pauses the bot", async () => {
    await clearOutbox();
    await webhook(text("meu rosto está inchado e não consigo respirar direito", OTHER));
    const sent = await replies(1, OTHER);
    expect(sent.at(-1)!.body).toMatch(/pronto-socorro|SAMU|192/i);
    // The handoff is written right after the reply goes out, so wait for it too.
    const conv = await until(async () => {
      const c = await conversationOf(OTHER);
      return c?.botPausedUntil && c;
    });
    expect(conv.botPausedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it("runs a quote from the staff API to the patient's approval and the Asaas payment", async () => {
    const auth = { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" };
    const created = await fetch(`${base}/admin/quotes`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        patientId,
        dentistId,
        items: [{ procedureId, quantity: 2 }],
        installmentCount: 2,
      }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const pdf = await fetch(`${base}/admin/quotes/${id}/pdf`, { headers: auth });
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(
      Buffer.from(await pdf.arrayBuffer())
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");

    // The patient wrote earlier in this file, so the 24h window is open: PDF + buttons.
    await clearOutbox();
    const sent = await fetch(`${base}/admin/quotes/${id}/send`, { method: "POST", headers: auth });
    expect(await sent.json()).toEqual({ via: "session" });
    const out = await outbox();
    expect(out.map((m) => m.kind)).toEqual(["document", "buttons"]);
    expect(out[0]!.bytes).toBeGreaterThan(1000);

    // The patient approves: status and installments land in Postgres, each installment is
    // billed in Asaas (mock) and the patient gets the first payment link.
    await clearOutbox();
    await webhook(button(`quote:${id}:accept`, "Aprovar"));
    const quote = await until(async () => {
      const q = await app.db.quote.findUnique({ where: { id }, include: { installments: true } });
      return q?.status === "ACCEPTED" && q.installments.every((i) => i.status === "BILLED") && q;
    });
    expect(quote.installments.map((i) => i.amountCents).sort()).toEqual([350_00, 350_00]);
    const patient = await app.db.patient.findUniqueOrThrow({ where: { id: patientId } });
    expect(patient.asaasCustomerId).toMatch(/^cus_mock_/);
    const [reply] = await replies(1);
    expect(reply!.body).toContain("Pix, boleto ou cartão");
    expect((await conversationOf(PATIENT))!.botPausedUntil).toBeNull();

    // Asaas confirms installment 1 by webhook (matched by our installment id, too).
    const first = quote.installments.find((i) => i.number === 1)!;
    const asaas = await fetch(`${base}/webhooks/asaas`, {
      method: "POST",
      headers: { "content-type": "application/json", "asaas-access-token": ASAAS_TOKEN },
      body: JSON.stringify({
        id: `evt_e2e_${id}`,
        event: "PAYMENT_RECEIVED",
        payment: {
          id: first.asaasPaymentId,
          status: "RECEIVED",
          value: 350,
          externalReference: first.id,
          paymentDate: "2026-10-20",
        },
      }),
    });
    expect(asaas.status).toBe(200);
    await until(async () => {
      const i = await app.db.installment.findUnique({ where: { id: first.id } });
      return i?.status === "PAID";
    });

    // Two days before installment 2 is due, the reminder job sends its link by template once.
    const second = quote.installments.find((i) => i.number === 2)!;
    const noonSaoPaulo = new Date(second.dueDate.getTime() - 2 * 86_400_000 + 15 * 3_600_000);
    await clearOutbox();
    expect((await app.reminders.run(noonSaoPaulo)).sent).toBe(1);
    expect(await app.reminders.run(noonSaoPaulo)).toEqual({ sent: 0, skipped: 0 });
    const reminders = await outbox();
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({
      kind: "template",
      template: "cobranca_parcela",
      to: PATIENT,
    });
    expect(
      (await app.db.installment.findUniqueOrThrow({ where: { id: second.id } })).reminderSentAt,
    ).not.toBeNull();
  });

  it("reminds an appointment the day before and records the patient's confirmation", async () => {
    // Far-future date, so the real clock of the webhook path still sees it as upcoming.
    const startsAt = new Date("2030-01-15T17:00:00Z"); // Tuesday 14:00 in São Paulo
    const appt = await app.db.appointment.create({
      data: {
        clinicId,
        patientId,
        dentistId,
        procedureId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      },
    });
    const dayBefore = new Date("2030-01-14T15:00:00Z"); // Monday 12:00 in São Paulo
    await clearOutbox();
    expect(await app.appointmentReminders.run(dayBefore)).toEqual({ sent: 1 });
    expect(await app.appointmentReminders.run(dayBefore)).toEqual({ sent: 0 });
    const [reminder] = await outbox();
    expect(reminder).toMatchObject({
      kind: "template",
      template: "lembrete_consulta",
      to: PATIENT,
    });
    expect(reminder!.params).toEqual(["Paciente", "terça-feira, 15/01 às 14:00", "Clínica E2E"]);

    await clearOutbox();
    await webhook(button(`appt:${appt.id}:confirm`, "Confirmar"));
    await until(async () => {
      const a = await app.db.appointment.findUnique({ where: { id: appt.id } });
      return a?.status === "CONFIRMED";
    });
    const [reply] = await replies(1);
    expect(reply!.body).toContain("está confirmada");
  });

  it("lets the front desk book from the panel API and the patient confirm by button", async () => {
    // Wednesdays 8h-12h, far enough ahead that the real clock never catches up.
    await app.db.workingHours.create({
      data: { dentistId, weekday: 3, startMinute: 8 * 60, endMinute: 12 * 60 },
    });
    const admin = (path: string, init: RequestInit = {}) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
      });
    const slots = (await (
      await admin(`/admin/slots?procedureId=${procedureId}&from=2030-01-16`)
    ).json()) as Array<{ dentistId: string; startsAt: string }>;
    expect(slots[0]).toMatchObject({ dentistId, startsAt: "2030-01-16T11:00:00.000Z" });

    await clearOutbox();
    const created = await admin("/admin/appointments", {
      method: "POST",
      body: JSON.stringify({
        patient: { id: patientId },
        procedureId,
        dentistId,
        startsAt: slots[0]!.startsAt,
      }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const [notice] = await outbox();
    expect(notice).toMatchObject({
      kind: "template",
      template: "confirmacao_consulta",
      to: PATIENT,
      params: ["Paciente", "Clínica E2E", "quarta-feira, 16/01 às 08:00"],
    });

    const again = await admin("/admin/appointments", {
      method: "POST",
      body: JSON.stringify({
        patient: { id: patientId },
        procedureId,
        dentistId,
        startsAt: slots[0]!.startsAt,
      }),
    });
    expect(again.status).toBe(409);

    const detail = (await (await admin(`/admin/appointments/${id}`)).json()) as {
      patientPhone: string;
    };
    expect(detail.patientPhone).not.toContain(PATIENT);

    await webhook(button(`appt:${id}:confirm`, "Confirmar"));
    await until(async () => {
      const a = await app.db.appointment.findUnique({ where: { id } });
      return a?.status === "CONFIRMED";
    });

    expect((await admin(`/admin/appointments/${id}/cancel`, { method: "POST" })).status).toBe(204);
    expect((await app.db.appointment.findUniqueOrThrow({ where: { id } })).status).toBe(
      "CANCELLED",
    );
  });

  it("takes a MEUS DADOS request to the export and the anonymization", async () => {
    const admin = async (path: string, method = "GET") =>
      fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    await webhook(text("oi", REQUESTER));
    await replies(1, REQUESTER);
    await webhook(text("MEUS DADOS", REQUESTER));
    await until(async () => (await app.db.dataSubjectRequest.count({ where: { clinicId } })) > 0);

    const [request] = (await (await admin("/admin/data-requests")).json()) as Array<{
      id: string;
      contact: string;
      patientId: string | null;
    }>;
    expect(request).toMatchObject({ contact: "***0013", patientId: null });

    const exported = await admin(`/admin/data-requests/${request!.id}/export`);
    expect(exported.headers.get("content-disposition")).toContain("attachment");
    const dump = (await exported.json()) as {
      conversations: Array<{ contact: string; messages: Array<{ body: string | null }> }>;
    };
    expect(dump.conversations[0]!.contact).toBe(REQUESTER);
    expect(dump.conversations[0]!.messages.map((m) => m.body)).toContain("MEUS DADOS");

    const done = await admin(`/admin/data-requests/${request!.id}/anonymize`, "POST");
    expect(((await done.json()) as { messages: number }).messages).toBeGreaterThan(0);
    expect(await (await admin("/admin/data-requests")).json()).toEqual([]);
    // Nothing left under that number: a new message starts from scratch.
    expect(await conversationOf(REQUESTER)).toBeNull();

    // Both actions left a trace in "Acessos", with the request id and no content.
    const log = (await (await admin("/admin/access-log")).json()) as {
      entries: Array<{ action: string; targetId: string | null }>;
    };
    const actions = log.entries.filter((e) => e.targetId === request!.id).map((e) => e.action);
    expect(actions.sort()).toEqual(["ANONYMIZE", "EXPORT_DATA"]);
  });
});
