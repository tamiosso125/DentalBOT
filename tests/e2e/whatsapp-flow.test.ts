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

type OutboxMessage = { kind: string; to: string; body?: string; template?: string; bytes?: number };

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
        },
      })
    ).id;
    await app.server.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.addresses()[0]!;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    const { db } = app;
    await db.quoteItem.deleteMany({ where: { quote: { clinicId } } });
    await db.quote.deleteMany({ where: { clinicId } });
    await db.message.deleteMany({ where: { conversation: { clinicId } } });
    await db.conversation.deleteMany({ where: { clinicId } });
    await db.patient.deleteMany({ where: { clinicId } });
    await db.procedure.deleteMany({ where: { clinicId } });
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

    // The patient approves: status, installments and the handoff land in Postgres.
    await webhook(button(`quote:${id}:accept`, "Aprovar"));
    const quote = await until(async () => {
      const q = await app.db.quote.findUnique({ where: { id }, include: { installments: true } });
      return q?.status === "ACCEPTED" && q;
    });
    expect(quote.installments.map((i) => i.amountCents).sort()).toEqual([350_00, 350_00]);
    await until(async () => (await conversationOf(PATIENT))?.botPausedUntil);

    // The front desk billed installment 1 in Asaas; its payment webhook marks it paid.
    const first = quote.installments.find((i) => i.number === 1)!;
    await app.db.installment.update({
      where: { id: first.id },
      data: { asaasPaymentId: `pay_e2e_${id}`, status: "BILLED" },
    });
    const asaas = await fetch(`${base}/webhooks/asaas`, {
      method: "POST",
      headers: { "content-type": "application/json", "asaas-access-token": ASAAS_TOKEN },
      body: JSON.stringify({
        id: `evt_e2e_${id}`,
        event: "PAYMENT_RECEIVED",
        payment: { id: `pay_e2e_${id}`, status: "RECEIVED", value: 350, paymentDate: "2026-10-20" },
      }),
    });
    expect(asaas.status).toBe(200);
    await until(async () => {
      const i = await app.db.installment.findUnique({ where: { id: first.id } });
      return i?.status === "PAID";
    });
  });
});
