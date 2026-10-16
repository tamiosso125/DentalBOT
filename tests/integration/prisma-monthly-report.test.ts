import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaMonthlyReports } from "../../src/panel/monthly-report.js";
import { FieldCipher } from "../../src/privacy/index.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
/** Tuesday 20/10, 12:00 in São Paulo. */
const NOW = new Date("2026-10-20T15:00:00Z");

describe.skipIf(!url)("PrismaMonthlyReports (Postgres)", () => {
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "m".repeat(32));
  let db: PrismaClient;
  let reports: PrismaMonthlyReports;
  let clinicId = "";
  let otherClinicId = "";

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    reports = new PrismaMonthlyReports(db);
    clinicId = (await db.clinic.create({ data: { name: "Clínica Resumo" } })).id;
    otherClinicId = (await db.clinic.create({ data: { name: "Outra Clínica" } })).id;
    const dentistId = (await db.dentist.create({ data: { clinicId, name: "Dra. Resumo" } })).id;
    const proc = (name: string) =>
      db.procedure.create({ data: { clinicId, name, durationMinutes: 30 } });
    const limpeza = (await proc("Limpeza")).id;
    const extracao = (await proc("Extração")).id;
    const plan = await db.insurancePlan.create({ data: { clinicId, name: "Odontoprev" } });
    await db.insuranceCoverage.create({
      data: { insurancePlanId: plan.id, procedureId: limpeza },
    });
    const patient = (name: string, phone: string, insurancePlanId: string | null) =>
      db.patient.create({
        data: {
          clinicId,
          name,
          phoneHash: cipher.hash(phone),
          phoneEncrypted: cipher.encrypt(phone),
          insurancePlanId,
        },
      });
    const ana = (await patient("Ana Resumo", "5511900000101", plan.id)).id;
    const bruno = (await patient("Bruno Resumo", "5511900000102", null)).id;
    const appt = (
      patientId: string,
      procedureId: string,
      startsAt: string,
      status: "COMPLETED" | "NO_SHOW" | "CANCELLED",
    ) =>
      db.appointment.create({
        data: {
          clinicId,
          patientId,
          dentistId,
          procedureId,
          status,
          startsAt: new Date(startsAt),
          endsAt: new Date(Date.parse(startsAt) + 1800_000),
        },
      });
    await appt(ana, limpeza, "2026-10-05T13:00:00Z", "COMPLETED"); // insurance by plan
    await appt(bruno, limpeza, "2026-10-06T13:00:00Z", "COMPLETED"); // private
    const authorized = await appt(ana, extracao, "2026-10-07T13:00:00Z", "COMPLETED");
    await db.insuranceAuthorization.create({
      data: {
        clinicId,
        appointmentId: authorized.id,
        patientId: ana,
        insurancePlanId: plan.id,
        status: "AUTHORIZED",
        decidedAt: new Date("2026-10-02T13:00:00Z"),
      },
    });
    await appt(bruno, limpeza, "2026-10-08T13:00:00Z", "NO_SHOW");
    await appt(bruno, extracao, "2026-10-09T13:00:00Z", "CANCELLED");
    // 30/09 at 23:00 in São Paulo is still September there.
    await appt(bruno, extracao, "2026-10-01T02:00:00Z", "COMPLETED");

    const quote = (status: "ACCEPTED" | "REJECTED", totalCents: number) =>
      db.quote.create({
        data: {
          clinicId,
          patientId: bruno,
          dentistId,
          status,
          totalCents,
          installmentCount: 3,
          sentAt: new Date("2026-10-05T15:00:00Z"),
          respondedAt: new Date("2026-10-06T15:00:00Z"),
          items: { create: { description: "Tratamento", unitPriceCents: totalCents } },
        },
      });
    const accepted = await quote("ACCEPTED", 600_00);
    await quote("REJECTED", 900_00);
    await db.installment.createMany({
      data: [
        {
          quoteId: accepted.id,
          number: 1,
          amountCents: 200_00,
          dueDate: new Date("2026-10-06"),
          status: "PAID",
          paidAt: new Date("2026-10-06T16:00:00Z"),
          paymentMethod: "PIX",
        },
        {
          quoteId: accepted.id,
          number: 2,
          amountCents: 200_00,
          dueDate: new Date("2026-10-15"),
          status: "OVERDUE",
        },
        {
          quoteId: accepted.id,
          number: 3,
          amountCents: 200_00,
          dueDate: new Date("2026-11-15"),
        },
      ],
    });
    // Paid at the front desk: one kept, one undone.
    for (const voidedAt of [null, new Date("2026-10-10T16:00:00Z")])
      await db.clinicPayment.create({
        data: {
          clinicId,
          patientId: ana,
          procedureId: extracao,
          amountCents: 50_00,
          method: "CASH",
          paidAt: new Date("2026-10-10T15:00:00Z"),
          voidedAt,
        },
      });
  });

  afterAll(async () => {
    for (const id of [clinicId, otherClinicId]) {
      await db.clinicPayment.deleteMany({ where: { clinicId: id } });
      await db.installment.deleteMany({ where: { quote: { clinicId: id } } });
      await db.quote.deleteMany({ where: { clinicId: id } });
      await db.insuranceAuthorization.deleteMany({ where: { clinicId: id } });
      await db.appointment.deleteMany({ where: { clinicId: id } });
      await db.patient.deleteMany({ where: { clinicId: id } });
      await db.insuranceCoverage.deleteMany({ where: { insurancePlan: { clinicId: id } } });
      await db.insurancePlan.deleteMany({ where: { clinicId: id } });
      await db.procedure.deleteMany({ where: { clinicId: id } });
      await db.dentist.deleteMany({ where: { clinicId: id } });
      await db.clinic.delete({ where: { id } });
    }
    await db.$disconnect();
  });

  it("sums the current month and the one before in the clinic's timezone", async () => {
    const r = await reports.report(clinicId, undefined, NOW);
    expect(r.month).toBe("2026-10");
    expect(r.current).toBe(true);
    expect(r.numbers).toEqual({
      attended: 3,
      attendedInsurance: 2,
      attendedPrivate: 1,
      noShow: 1,
      cancelled: 1,
      receivedCents: 250_00,
      receivedByMethod: {
        PIX: 200_00,
        BOLETO: 0,
        CREDIT_CARD: 0,
        DEBIT_CARD: 0,
        CASH: 50_00,
        OTHER: 0,
      },
      receivedAtClinicCents: 50_00,
      dueOpenCents: 200_00,
      lateCents: 200_00,
      quotesSent: 2,
      quotesAccepted: 1,
      acceptedCents: 600_00,
      quotesRejected: 1,
    });
    expect(r.previous.attended).toBe(1);
    expect(r.topProcedures).toEqual([
      { name: "Limpeza", count: 2 },
      { name: "Extração", count: 1 },
    ]);
  });

  it("reports another month and nothing for another clinic", async () => {
    const nov = await reports.report(clinicId, "2026-11", NOW);
    expect(nov.current).toBe(false);
    expect(nov.numbers).toMatchObject({ attended: 0, dueOpenCents: 200_00, lateCents: 0 });
    expect(nov.previous.attended).toBe(3);

    const other = await reports.report(otherClinicId, undefined, NOW);
    expect(other.numbers).toMatchObject({ attended: 0, receivedCents: 0, quotesSent: 0 });
    expect(other.topProcedures).toEqual([]);
  });
});
