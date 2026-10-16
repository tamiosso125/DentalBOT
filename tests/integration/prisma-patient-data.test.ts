import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PatientDataError, PrismaPatientData } from "../../src/panel/patient-data.js";
import { FieldCipher } from "../../src/privacy/index.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
const PHONE = "5511900000031";
const STRANGER = "5511900000032";
const CPF = "52998224725";
const NOW = new Date("2026-10-19T12:00:00Z");

describe.skipIf(!url)("PrismaPatientData (Postgres)", () => {
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "y".repeat(32));
  let db: PrismaClient;
  let data: PrismaPatientData;
  let clinicId = "";
  let otherClinicId = "";
  let patientId = "";
  let installmentId = "";
  let patientRequestId = "";
  let strangerRequestId = "";
  let strangerConversationId = "";
  let patientConversationIds: string[] = [];

  async function conversation(contact: string, linkedPatientId: string | null, body: string) {
    const c = await db.conversation.create({
      data: {
        clinicId,
        patientId: linkedPatientId,
        contactHash: cipher.hash(contact),
        contactEncrypted: cipher.encrypt(contact),
        agentState: { offeredSlots: [] },
      },
    });
    await db.message.create({
      data: {
        conversationId: c.id,
        direction: "INBOUND",
        type: "text",
        bodyEncrypted: cipher.encrypt(body),
        createdAt: new Date("2026-10-18T12:00:00Z"),
      },
    });
    return c.id;
  }

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    data = new PrismaPatientData(db, cipher);
    clinicId = (await db.clinic.create({ data: { name: "Clínica LGPD Teste" } })).id;
    otherClinicId = (await db.clinic.create({ data: { name: "Outra Clínica" } })).id;
    const dentistId = (await db.dentist.create({ data: { clinicId, name: "Dra. Dados" } })).id;
    const procedureId = (
      await db.procedure.create({ data: { clinicId, name: "Limpeza", durationMinutes: 30 } })
    ).id;
    patientId = (
      await db.patient.create({
        data: {
          clinicId,
          name: "Maria Exemplo",
          phoneHash: cipher.hash(PHONE),
          phoneEncrypted: cipher.encrypt(PHONE),
          cpfHash: cipher.hash(CPF),
          cpfEncrypted: cipher.encrypt(CPF),
          birthDate: new Date("1990-05-01"),
          consents: { create: { purpose: "PRIVACY_NOTICE", granted: true, textVersion: "v1" } },
        },
      })
    ).id;
    const apptIds: string[] = [];
    for (const startsAt of ["2026-10-01T13:00:00Z", "2026-10-21T13:00:00Z"]) {
      const s = new Date(startsAt);
      const appt = await db.appointment.create({
        data: {
          clinicId,
          patientId,
          dentistId,
          procedureId,
          startsAt: s,
          endsAt: new Date(s.getTime() + 30 * 60_000),
          status: "CONFIRMED",
        },
      });
      apptIds.push(appt.id);
    }
    const plan = await db.insurancePlan.create({ data: { clinicId, name: "Odontoprev" } });
    await db.insuranceAuthorization.create({
      data: {
        clinicId,
        patientId,
        appointmentId: apptIds[1]!,
        insurancePlanId: plan.id,
        status: "AUTHORIZED",
        decidedAt: new Date("2026-10-19T15:00:00Z"),
      },
    });
    await db.satisfactionSurvey.create({
      data: {
        clinicId,
        patientId,
        appointmentId: apptIds[0]!,
        sentAt: new Date("2026-10-02T14:00:00Z"),
        rating: 4,
        answeredAt: new Date("2026-10-02T15:00:00Z"),
      },
    });
    await db.aftercareFollowUp.create({
      data: {
        clinicId,
        patientId,
        appointmentId: apptIds[0]!,
        instructionsSentAt: new Date("2026-10-01T14:00:00Z"),
        checkInSentAt: new Date("2026-10-02T14:00:00Z"),
        answer: "OK",
        answeredAt: new Date("2026-10-02T14:30:00Z"),
      },
    });
    await db.waitlistEntry.create({
      data: { clinicId, patientId, procedureId, until: new Date("2026-10-31T03:00:00Z") },
    });
    const quote = await db.quote.create({
      data: {
        clinicId,
        patientId,
        dentistId,
        totalCents: 300_00,
        status: "ACCEPTED",
        notes: "Tratamento em duas sessões",
        items: { create: { description: "Restauração", unitPriceCents: 300_00 } },
        installments: {
          create: { number: 1, amountCents: 300_00, dueDate: new Date("2026-10-20") },
        },
      },
      include: { installments: true },
    });
    installmentId = quote.installments[0]!.id;
    // Paid at the front desk: one kept, one undone (not exported).
    for (const voidedAt of [null, NOW])
      await db.clinicPayment.create({
        data: {
          clinicId,
          patientId,
          procedureId,
          amountCents: 120_00,
          method: "CASH",
          paidAt: new Date("2026-10-05T15:00:00Z"),
          voidedAt,
        },
      });
    // Linked conversation, plus a second one under the same number not linked yet.
    const linked = await conversation(PHONE, patientId, "Quero marcar uma limpeza");
    await db.conversation.update({
      where: { id: linked },
      data: { contactHash: cipher.hash(`${PHONE}-old`) },
    });
    const unlinked = await conversation(PHONE, null, "Oi de novo");
    patientConversationIds = [linked, unlinked];
    // Asked from the number's newer conversation, which no booking linked to her yet.
    patientRequestId = (
      await db.dataSubjectRequest.create({ data: { clinicId, conversationId: unlinked } })
    ).id;

    strangerConversationId = await conversation(STRANGER, null, "Qual o endereço?");
    strangerRequestId = (
      await db.dataSubjectRequest.create({
        data: { clinicId, conversationId: strangerConversationId, createdAt: NOW },
      })
    ).id;
  });

  afterAll(async () => {
    for (const id of [clinicId, otherClinicId]) {
      await db.dataSubjectRequest.deleteMany({ where: { clinicId: id } });
      await db.message.deleteMany({ where: { conversation: { clinicId: id } } });
      await db.conversation.deleteMany({ where: { clinicId: id } });
      await db.quote.deleteMany({ where: { clinicId: id } });
      await db.waitlistEntry.deleteMany({ where: { clinicId: id } });
      await db.aftercareFollowUp.deleteMany({ where: { clinicId: id } });
      await db.clinicPayment.deleteMany({ where: { clinicId: id } });
      await db.satisfactionSurvey.deleteMany({ where: { clinicId: id } });
      await db.insuranceAuthorization.deleteMany({ where: { clinicId: id } });
      await db.appointment.deleteMany({ where: { clinicId: id } });
      await db.consent.deleteMany({ where: { patient: { clinicId: id } } });
      await db.patient.deleteMany({ where: { clinicId: id } });
      await db.procedure.deleteMany({ where: { clinicId: id } });
      await db.insurancePlan.deleteMany({ where: { clinicId: id } });
      await db.dentist.deleteMany({ where: { clinicId: id } });
      await db.clinic.delete({ where: { id } });
    }
    await db.$disconnect();
  });

  it("lists the open MEUS DADOS requests of the clinic, with the contact masked", async () => {
    expect(await data.dataRequests(clinicId)).toEqual([
      expect.objectContaining({
        id: patientRequestId,
        patientId,
        patientName: "Maria Exemplo",
        contact: "***0031",
      }),
      expect.objectContaining({ id: strangerRequestId, patientId: null, contact: "***0032" }),
    ]);
    expect(await data.dataRequests(otherClinicId)).toEqual([]);
  });

  it("exports everything stored about the patient, decrypted", async () => {
    const out = await data.export(clinicId, { requestId: patientRequestId }, NOW);
    expect(out.patient).toMatchObject({
      name: "Maria Exemplo",
      phone: PHONE,
      cpf: CPF,
      birthDate: "1990-05-01",
    });
    expect(out.consents).toMatchObject([
      { purpose: "PRIVACY_NOTICE", granted: true, source: "STAFF" },
    ]);
    expect(out.appointments).toHaveLength(2);
    expect(out.waitlist).toEqual([
      expect.objectContaining({ procedure: "Limpeza", status: "WAITING", closedAt: null }),
    ]);
    expect(out.authorizations).toEqual([
      {
        appointmentAt: "2026-10-21T13:00:00.000Z",
        plan: "Odontoprev",
        status: "AUTHORIZED",
        decidedAt: "2026-10-19T15:00:00.000Z",
        privateChosenAt: null,
      },
    ]);
    expect(out.clinicPayments).toEqual([
      {
        paidAt: "2026-10-05T15:00:00.000Z",
        amountCents: 120_00,
        method: "CASH",
        procedure: "Limpeza",
      },
    ]);
    expect(out.surveys).toEqual([
      {
        appointmentAt: "2026-10-01T13:00:00.000Z",
        sentAt: "2026-10-02T14:00:00.000Z",
        rating: 4,
        answeredAt: "2026-10-02T15:00:00.000Z",
      },
    ]);
    expect(out.aftercare).toEqual([
      {
        procedure: expect.any(String),
        appointmentAt: "2026-10-01T13:00:00.000Z",
        instructionsSentAt: "2026-10-01T14:00:00.000Z",
        checkInSentAt: "2026-10-02T14:00:00.000Z",
        answer: "OK",
        answeredAt: "2026-10-02T14:30:00.000Z",
      },
    ]);
    expect(out.quotes).toMatchObject([
      { notes: "Tratamento em duas sessões", installments: [{ number: 1, status: "PENDING" }] },
    ]);
    expect(out.conversations.flatMap((c) => c.messages.map((m) => m.body)).sort()).toEqual([
      "Oi de novo",
      "Quero marcar uma limpeza",
    ]);
    expect(await data.export(clinicId, { patientId }, NOW)).toEqual(out);
    await expect(data.export(otherClinicId, { patientId }, NOW)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("refuses to anonymize while an installment is open", async () => {
    const err = await data.anonymize(clinicId, { patientId }, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PatientDataError);
    expect(err).toMatchObject({ status: 409 });
    expect((await data.summary(clinicId, patientId))!.openInstallments).toBe(1);
  });

  it("anonymizes the patient, keeping the financial records", async () => {
    await db.installment.update({
      where: { id: installmentId },
      data: { status: "PAID", paidAt: NOW },
    });
    const result = await data.anonymize(clinicId, { requestId: patientRequestId }, NOW);
    expect(result).toEqual({ cancelledAppointments: 1, conversations: 2, messages: 2 });

    const p = await db.patient.findUniqueOrThrow({ where: { id: patientId } });
    expect(p).toMatchObject({
      name: "Paciente anonimizado",
      cpfHash: null,
      cpfEncrypted: null,
      birthDate: null,
      anonymizedAt: NOW,
    });
    expect(p.phoneHash).not.toBe(cipher.hash(PHONE));
    expect(cipher.decrypt(p.phoneEncrypted)).toBe("");
    const appts = await db.appointment.findMany({
      where: { patientId },
      orderBy: { startsAt: "asc" },
    });
    expect(appts.map((a) => a.status)).toEqual(["CONFIRMED", "CANCELLED"]); // past one kept
    expect(await db.waitlistEntry.findMany({ where: { patientId } })).toMatchObject([
      { status: "REMOVED", closedAt: NOW },
    ]);
    const quote = await db.quote.findFirstOrThrow({
      where: { patientId },
      include: { installments: true },
    });
    expect(quote).toMatchObject({ notes: null, totalCents: 300_00 });
    expect(quote.installments).toMatchObject([{ status: "PAID", amountCents: 300_00 }]);
    const convs = await db.conversation.findMany({
      where: { id: { in: patientConversationIds } },
      include: { messages: true },
    });
    expect(convs).toHaveLength(2);
    for (const c of convs) {
      expect(c).toMatchObject({ agentState: null });
      expect(cipher.decrypt(c.contactEncrypted)).toBe("");
      expect(c.messages.every((m) => m.bodyEncrypted === null)).toBe(true);
    }
    expect((await data.dataRequests(clinicId)).map((r) => r.id)).toEqual([strangerRequestId]);

    // The number is free: the same person can come back as a new patient.
    await db.patient.create({
      data: {
        clinicId,
        name: "Maria de Volta",
        phoneHash: cipher.hash(PHONE),
        phoneEncrypted: cipher.encrypt(PHONE),
      },
    });
    expect(await data.summary(clinicId, patientId)).toMatchObject({
      phone: "****",
      anonymizedAt: NOW.toISOString(),
      openInstallments: 0,
    });
  });

  it("handles a request from a contact that never registered", async () => {
    const out = await data.export(clinicId, { requestId: strangerRequestId }, NOW);
    expect(out.patient).toBeNull();
    expect(out.conversations).toMatchObject([
      { contact: STRANGER, messages: [{ body: "Qual o endereço?" }] },
    ]);
    await data.resolveRequest(clinicId, strangerRequestId, NOW);
    await expect(data.resolveRequest(clinicId, strangerRequestId, NOW)).rejects.toMatchObject({
      status: 404,
    });
    expect(await data.anonymize(clinicId, { requestId: strangerRequestId }, NOW)).toEqual({
      cancelledAppointments: 0,
      conversations: 1,
      messages: 1,
    });
    const c = await db.conversation.findUniqueOrThrow({ where: { id: strangerConversationId } });
    expect(c.contactHash).not.toBe(cipher.hash(STRANGER));
  });
});
