import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/lib/logger.js";
import { AccessLog, AUDITED } from "../../src/panel/access-log.js";
import { FieldCipher } from "../../src/privacy/index.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
const at = (iso: string) => new Date(iso);
/** Monday 19/10, 9:00 in São Paulo. */
const NOW = at("2026-10-19T12:00:00Z");

describe.skipIf(!url)("AccessLog (Postgres)", () => {
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "a".repeat(32));
  let db: PrismaClient;
  let log: AccessLog;
  let clinicId = "";
  let otherClinicId = "";
  let patientId = "";
  let otherPatientId = "";
  let appointmentId = "";
  let quoteId = "";
  let installmentId = "";
  let requestId = "";

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    log = new AccessLog({ db, logger: createLogger("silent") });
    clinicId = (await db.clinic.create({ data: { name: "Clínica Acessos" } })).id;
    otherClinicId = (await db.clinic.create({ data: { name: "Outra Acessos" } })).id;
    const patient = async (cid: string, name: string, phone: string) =>
      (
        await db.patient.create({
          data: {
            clinicId: cid,
            name,
            phoneHash: cipher.hash(phone),
            phoneEncrypted: cipher.encrypt(phone),
          },
        })
      ).id;
    patientId = await patient(clinicId, "Maria Acessos", "5511900000121");
    otherPatientId = await patient(otherClinicId, "João Outro", "5511900000122");
    const dentistId = (await db.dentist.create({ data: { clinicId, name: "Dra. Acessos" } })).id;
    const procedureId = (
      await db.procedure.create({ data: { clinicId, name: "Limpeza", durationMinutes: 30 } })
    ).id;
    appointmentId = (
      await db.appointment.create({
        data: {
          clinicId,
          patientId,
          dentistId,
          procedureId,
          startsAt: at("2026-10-20T12:00:00Z"),
          endsAt: at("2026-10-20T12:30:00Z"),
        },
      })
    ).id;
    const quote = await db.quote.create({
      data: {
        clinicId,
        patientId,
        dentistId,
        totalCents: 200_00,
        installments: {
          create: [{ number: 1, amountCents: 200_00, dueDate: at("2026-11-01T03:00:00Z") }],
        },
      },
      include: { installments: true },
    });
    quoteId = quote.id;
    installmentId = quote.installments[0]!.id;
    const conv = await db.conversation.create({
      data: {
        clinicId,
        patientId,
        contactHash: cipher.hash("5511900000121"),
        contactEncrypted: cipher.encrypt("5511900000121"),
      },
    });
    requestId = (
      await db.dataSubjectRequest.create({ data: { clinicId, conversationId: conv.id } })
    ).id;
  });

  afterAll(async () => {
    for (const id of [clinicId, otherClinicId]) {
      await db.accessLog.deleteMany({ where: { clinicId: id } });
      await db.staffUser.deleteMany({ where: { clinicId: id } });
      await db.dataSubjectRequest.deleteMany({ where: { clinicId: id } });
      await db.conversation.deleteMany({ where: { clinicId: id } });
      await db.quote.deleteMany({ where: { clinicId: id } });
      await db.appointment.deleteMany({ where: { clinicId: id } });
      await db.patient.deleteMany({ where: { clinicId: id } });
      await db.procedure.deleteMany({ where: { clinicId: id } });
      await db.dentist.deleteMany({ where: { clinicId: id } });
      await db.clinic.delete({ where: { id } });
    }
    await db.$disconnect();
  });

  it("finds the patient behind each action, scoped by clinic", async () => {
    const rec = (key: string, id?: string, body?: unknown, when = NOW) =>
      log.record(clinicId, { rule: AUDITED[key]!, id, body }, when);
    await rec("GET /admin/patients");
    await rec("GET /admin/patients/:id/record", patientId, undefined, at("2026-10-19T12:01:00Z"));
    await rec("GET /admin/appointments/:id", appointmentId, undefined, at("2026-10-19T12:02:00Z"));
    await rec("GET /admin/quotes/:id/pdf", quoteId, undefined, at("2026-10-19T12:03:00Z"));
    await rec(
      "POST /admin/installments/:id/receive",
      installmentId,
      { method: "PIX" },
      at("2026-10-19T12:04:00Z"),
    );
    await rec(
      "GET /admin/data-requests/:id/export",
      requestId,
      undefined,
      at("2026-10-19T12:05:00Z"),
    );
    await rec(
      "POST /admin/clinic-payments",
      undefined,
      { patientId, amountCents: 100 },
      at("2026-10-19T12:06:00Z"),
    );
    // Another clinic's record is not looked up: the entry keeps the id only.
    await rec(
      "GET /admin/patients/:id/record",
      otherPatientId,
      undefined,
      at("2026-10-19T12:07:00Z"),
    );

    const page = await log.list(clinicId, {}, NOW);
    expect(page).toMatchObject({ from: "2026-09-20", to: "2026-10-19", truncated: false });
    expect(page.entries.map((e) => [e.action, e.patientName, e.targetId])).toEqual([
      ["VIEW_RECORD", null, null],
      ["REGISTER_CLINIC_PAYMENT", "Maria Acessos", null],
      ["EXPORT_DATA", "Maria Acessos", requestId],
      ["RECEIVE_INSTALLMENT", "Maria Acessos", installmentId],
      ["VIEW_QUOTE_PDF", "Maria Acessos", quoteId],
      ["VIEW_APPOINTMENT", "Maria Acessos", appointmentId],
      ["VIEW_RECORD", "Maria Acessos", null],
      ["SEARCH_PATIENTS", null, null],
    ]);
    const own = await log.list(clinicId, { patientId }, NOW);
    expect(own.entries).toHaveLength(6);
    expect((await log.list(otherClinicId, {}, NOW)).entries).toEqual([]);
  });

  it("names who was signed in", async () => {
    const bia = await db.staffUser.create({
      data: {
        clinicId,
        name: "Bia Recepção",
        role: "RECEPTION",
        emailHash: cipher.hash("bia@clinica.test"),
        emailEncrypted: cipher.encrypt("bia@clinica.test"),
        passwordHash: "x",
      },
    });
    await log.record(
      clinicId,
      { rule: AUDITED["POST /admin/auth/login"]!, staffUserId: bia.id },
      at("2026-10-19T12:10:00Z"),
    );
    const [last] = (await log.list(clinicId, {}, NOW)).entries;
    expect(last).toMatchObject({ action: "LOGIN", staffName: "Bia Recepção", patientId: null });
  });

  it("filters by day in the clinic's timezone and rejects a bad period", async () => {
    // 23:30 on 18/10 in São Paulo is already 19/10 in UTC.
    await log.record(
      clinicId,
      { rule: AUDITED["GET /admin/patients/:id"]!, id: patientId },
      at("2026-10-19T02:30:00Z"),
    );
    const day = await log.list(clinicId, { from: "2026-10-18", to: "2026-10-18" }, NOW);
    expect(day.entries.map((e) => e.action)).toEqual(["VIEW_DATA"]);
    for (const q of [
      { from: "2026-10-19", to: "2026-10-18" },
      { from: "2025-01-01", to: "2026-10-18" },
      { from: "18/10/2026" },
    ])
      await expect(log.list(clinicId, q, NOW)).rejects.toMatchObject({ status: 400 });
  });

  it("purges entries past the retention period", async () => {
    await db.accessLog.create({
      data: { clinicId, action: "VIEW_RECORD", patientId, at: at("2025-01-01T12:00:00Z") },
    });
    expect(await log.purge(365, NOW)).toBeGreaterThanOrEqual(1);
    expect(await db.accessLog.count({ where: { clinicId, at: { lt: at("2025-10-01") } } })).toBe(0);
    expect(await db.accessLog.count({ where: { clinicId } })).toBe(10);
  });
});
