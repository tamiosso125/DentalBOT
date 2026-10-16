import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPatientRecords } from "../../src/panel/patient-record.js";
import { FieldCipher } from "../../src/privacy/index.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
const PHONE = "5511900000101";
/** Monday 19/10, 9:00 in São Paulo. */
const NOW = new Date("2026-10-19T12:00:00Z");
const at = (iso: string) => new Date(iso);

describe.skipIf(!url)("PrismaPatientRecords (Postgres)", () => {
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "f".repeat(32));
  let db: PrismaClient;
  let records: PrismaPatientRecords;
  let clinicId = "";
  let otherClinicId = "";
  let patientId = "";
  let plainPatientId = "";
  const appt: Record<string, string> = {};

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    records = new PrismaPatientRecords(db, cipher);
    clinicId = (await db.clinic.create({ data: { name: "Clínica Ficha" } })).id;
    otherClinicId = (await db.clinic.create({ data: { name: "Outra Clínica" } })).id;
    const dentistId = (await db.dentist.create({ data: { clinicId, name: "Dra. Ficha" } })).id;
    const proc = async (name: string) =>
      (await db.procedure.create({ data: { clinicId, name, durationMinutes: 30 } })).id;
    const cleaning = await proc("Limpeza");
    const extraction = await proc("Extração simples");
    const planId = (await db.insurancePlan.create({ data: { clinicId, name: "Odontoprev" } })).id;
    patientId = (
      await db.patient.create({
        data: {
          clinicId,
          name: "Maria Ficha",
          phoneHash: cipher.hash(PHONE),
          phoneEncrypted: cipher.encrypt(PHONE),
          cpfHash: cipher.hash("52998224725"),
          cpfEncrypted: cipher.encrypt("52998224725"),
          birthDate: at("1990-05-17"),
          insurancePlanId: planId,
          insuranceCardEncrypted: cipher.encrypt("0012345678"),
        },
      })
    ).id;
    plainPatientId = (
      await db.patient.create({
        data: {
          clinicId,
          name: "João Ficha",
          phoneHash: cipher.hash("5511900000102"),
          phoneEncrypted: cipher.encrypt("5511900000102"),
        },
      })
    ).id;
    const mk = async (
      key: string,
      startsAt: string,
      status: "COMPLETED" | "NO_SHOW" | "CONFIRMED" | "CANCELLED",
      procedureId = cleaning,
    ) => {
      const s = at(startsAt);
      appt[key] = (
        await db.appointment.create({
          data: {
            clinicId,
            patientId,
            dentistId,
            procedureId,
            status,
            startsAt: s,
            endsAt: new Date(s.getTime() + 1800_000),
          },
        })
      ).id;
    };
    await mk("cleaning", "2026-09-01T13:00:00Z", "COMPLETED");
    await mk("missed", "2026-09-15T13:00:00Z", "NO_SHOW");
    await mk("extraction", "2026-10-13T13:00:00Z", "COMPLETED", extraction);
    await mk("cancelled", "2026-10-14T13:00:00Z", "CANCELLED");
    await mk("next", "2026-10-26T13:00:00Z", "CONFIRMED", extraction);
    await db.satisfactionSurvey.create({
      data: {
        clinicId,
        patientId,
        appointmentId: appt.cleaning!,
        sentAt: at("2026-09-02T13:00:00Z"),
        rating: 5,
        answeredAt: at("2026-09-02T14:00:00Z"),
      },
    });
    await db.aftercareFollowUp.create({
      data: {
        clinicId,
        patientId,
        appointmentId: appt.extraction!,
        instructionsSentAt: at("2026-10-13T15:00:00Z"),
        checkInSentAt: at("2026-10-14T13:00:00Z"),
        answer: "HELP",
        answeredAt: at("2026-10-14T13:30:00Z"),
      },
    });
    await db.insuranceAuthorization.create({
      data: {
        clinicId,
        patientId,
        appointmentId: appt.next!,
        insurancePlanId: planId,
        status: "AUTHORIZED",
        decidedAt: at("2026-10-16T15:00:00Z"),
      },
    });
    await db.quote.create({
      data: {
        clinicId,
        patientId,
        dentistId,
        totalCents: 900_00,
        status: "ACCEPTED",
        installmentCount: 3,
        createdAt: at("2026-09-01T15:00:00Z"),
        items: { create: { description: "Restaurações", unitPriceCents: 900_00 } },
        installments: {
          create: [
            { number: 1, amountCents: 300_00, dueDate: at("2026-09-10"), status: "PAID" },
            // Due date passed, Asaas has not flagged it yet.
            { number: 2, amountCents: 300_00, dueDate: at("2026-10-10"), status: "BILLED" },
            { number: 3, amountCents: 300_00, dueDate: at("2026-11-10"), status: "PENDING" },
          ],
        },
      },
    });
    await db.quote.create({
      data: {
        clinicId,
        patientId,
        dentistId,
        totalCents: 150_00,
        status: "SENT",
        items: { create: { description: "Clareamento", unitPriceCents: 150_00 } },
        createdAt: at("2026-10-15T12:00:00Z"),
      },
    });
    for (const voidedAt of [null, NOW])
      await db.clinicPayment.create({
        data: {
          clinicId,
          patientId,
          procedureId: cleaning,
          amountCents: 120_00,
          method: "CASH",
          paidAt: at("2026-09-01T14:00:00Z"),
          voidedAt,
        },
      });
    await db.waitlistEntry.create({
      data: { clinicId, patientId, procedureId: cleaning, until: at("2026-11-30T03:00:00Z") },
    });
    await db.waitlistEntry.create({
      data: { clinicId, patientId, procedureId: cleaning, until: at("2026-10-01T03:00:00Z") },
    });
    await db.consent.create({
      data: { patientId, purpose: "MARKETING", granted: true, textVersion: "v1" },
    });
    for (const [author, text, createdAt] of [
      ["RECEPTION", "Prefere horários de manhã", "2026-10-01T12:00:00Z"],
      ["DENTIST", "Tem medo de agulha", "2026-10-10T12:00:00Z"],
    ] as const)
      await db.patientNote.create({
        data: {
          clinicId,
          patientId,
          author,
          textEncrypted: cipher.encrypt(text),
          createdAt: at(createdAt),
        },
      });
    await db.conversation.create({
      data: {
        clinicId,
        patientId,
        contactHash: cipher.hash(PHONE),
        contactEncrypted: cipher.encrypt(PHONE),
        botPausedUntil: at("2026-10-19T14:00:00Z"),
        marketingOptOutAt: at("2026-10-18T12:00:00Z"),
      },
    });
  });

  afterAll(async () => {
    for (const id of [clinicId, otherClinicId]) {
      await db.patientNote.deleteMany({ where: { clinicId: id } });
      await db.conversation.deleteMany({ where: { clinicId: id } });
      await db.consent.deleteMany({ where: { patient: { clinicId: id } } });
      await db.waitlistEntry.deleteMany({ where: { clinicId: id } });
      await db.clinicPayment.deleteMany({ where: { clinicId: id } });
      await db.quote.deleteMany({ where: { clinicId: id } });
      await db.insuranceAuthorization.deleteMany({ where: { clinicId: id } });
      await db.aftercareFollowUp.deleteMany({ where: { clinicId: id } });
      await db.satisfactionSurvey.deleteMany({ where: { clinicId: id } });
      await db.appointment.deleteMany({ where: { clinicId: id } });
      await db.patient.deleteMany({ where: { clinicId: id } });
      await db.insurancePlan.deleteMany({ where: { clinicId: id } });
      await db.procedure.deleteMany({ where: { clinicId: id } });
      await db.dentist.deleteMany({ where: { clinicId: id } });
      await db.clinic.delete({ where: { id } });
    }
    await db.$disconnect();
  });

  it("gathers the patient's history with the phone and card masked", async () => {
    const r = (await records.record(clinicId, patientId, NOW))!;
    expect(r.patient).toEqual({
      id: patientId,
      name: "Maria Ficha",
      phone: "***0101",
      hasCpf: true,
      birthDate: "1990-05-17",
      createdAt: expect.any(String),
      anonymizedAt: null,
    });
    expect(JSON.stringify(r)).not.toContain("52998224725");
    expect(JSON.stringify(r)).not.toContain("0012345678");
    expect(r.insurance).toEqual({ plan: "Odontoprev", cardEnd: "5678" });
    expect(r.recallConsent).toMatchObject({ granted: true, source: "STAFF" });
    expect(r.marketingOptOutAt).toBe("2026-10-18T12:00:00.000Z");
    expect(r.botPausedUntil).toBe("2026-10-19T14:00:00.000Z");
    expect(r.counts).toEqual({ upcoming: 1, attended: 2, noShow: 1, cancelled: 1 });
    expect(r.appointments.map((a) => a.id)).toEqual([
      appt.next,
      appt.cancelled,
      appt.extraction,
      appt.missed,
      appt.cleaning,
    ]);
    expect(r.appointments[0]).toMatchObject({
      procedure: "Extração simples",
      dentist: "Dra. Ficha",
      status: "CONFIRMED",
      authorization: "AUTHORIZED",
    });
    expect(r.appointments[2]).toMatchObject({ aftercareAnswer: "HELP", surveyRating: null });
    expect(r.appointments[4]).toMatchObject({ surveyRating: 5, aftercareAnswer: null });
  });

  it("sums what was paid and what is still open, past due dates counting as overdue", async () => {
    const r = (await records.record(clinicId, patientId, NOW))!;
    expect(r.quotes).toEqual([
      expect.objectContaining({ status: "SENT", totalCents: 150_00, installments: 0 }),
      expect.objectContaining({
        status: "ACCEPTED",
        totalCents: 900_00,
        installments: 3,
        paidCents: 300_00,
        openCents: 600_00,
        overdue: 1,
      }),
    ]);
    expect(r.balance).toEqual({ openCents: 600_00, overdueCents: 300_00 });
    expect(r.clinicPayments).toEqual([
      expect.objectContaining({ amountCents: 120_00, method: "CASH", procedure: "Limpeza" }),
    ]);
    expect(r.waitlist).toEqual([
      expect.objectContaining({ procedure: "Limpeza", until: "2026-11-30T03:00:00.000Z" }),
    ]);
  });

  it("shows the staff notes decrypted, newest first", async () => {
    const r = (await records.record(clinicId, patientId, NOW))!;
    expect(r.notes).toEqual([
      expect.objectContaining({ author: "DENTIST", text: "Tem medo de agulha" }),
      expect.objectContaining({ author: "RECEPTION", text: "Prefere horários de manhã" }),
    ]);
  });

  it("shows an empty history and refuses another clinic's patient", async () => {
    const r = (await records.record(clinicId, plainPatientId, NOW))!;
    expect(r).toMatchObject({
      insurance: null,
      recallConsent: null,
      marketingOptOutAt: null,
      botPausedUntil: null,
      counts: { upcoming: 0, attended: 0, noShow: 0, cancelled: 0 },
      appointments: [],
      quotes: [],
      balance: { openCents: 0, overdueCents: 0 },
      notes: [],
      patient: { hasCpf: false, birthDate: null },
    });
    expect(await records.record(otherClinicId, patientId, NOW)).toBeNull();
    // After the pause ends, the chat is the bot's again.
    const later = (await records.record(clinicId, patientId, at("2026-10-19T15:00:00Z")))!;
    expect(later.botPausedUntil).toBeNull();
  });
});
