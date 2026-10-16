import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "../../src/lib/logger.js";
import { MockPaymentsGateway } from "../../src/payments/asaas.js";
import { ClinicPayments } from "../../src/payments/clinic-payments.js";
import { PrismaPaymentEventStore } from "../../src/payments/payment-events.js";
import { FieldCipher } from "../../src/privacy/index.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
/** Tuesday 20/10, 10:00 in São Paulo. */
const NOW = new Date("2026-10-20T13:00:00Z");
/** Noon of 20/10 in São Paulo. */
const NOON = new Date("2026-10-20T15:00:00Z");
const PHONE = "5511900000111";
const DUE = ["2026-09-10", "2026-10-10", "2026-11-10", "2026-12-10"];

describe.skipIf(!url)("ClinicPayments (Postgres)", () => {
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "c".repeat(32));
  const gateway = new MockPaymentsGateway();
  let db: PrismaClient;
  let desk: ClinicPayments;
  let clinicId = "";
  let otherClinicId = "";
  let patientId = "";
  let procedureId = "";
  let otherProcedureId = "";
  const inst: Record<number, string> = {};

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    desk = new ClinicPayments({ db, cipher, gateway, logger: silentLogger });
    clinicId = (await db.clinic.create({ data: { name: "Clínica Balcão" } })).id;
    otherClinicId = (await db.clinic.create({ data: { name: "Outra Clínica" } })).id;
    const dentistId = (await db.dentist.create({ data: { clinicId, name: "Dra. Balcão" } })).id;
    procedureId = (
      await db.procedure.create({ data: { clinicId, name: "Avaliação", durationMinutes: 30 } })
    ).id;
    otherProcedureId = (
      await db.procedure.create({
        data: { clinicId: otherClinicId, name: "Avaliação", durationMinutes: 30 },
      })
    ).id;
    patientId = (
      await db.patient.create({
        data: {
          clinicId,
          name: "Maria Balcão",
          phoneHash: cipher.hash(PHONE),
          phoneEncrypted: cipher.encrypt(PHONE),
        },
      })
    ).id;
    const quote = await db.quote.create({
      data: {
        clinicId,
        patientId,
        dentistId,
        totalCents: 400_00,
        installmentCount: 4,
        status: "ACCEPTED",
        items: { create: { description: "Tratamento", unitPriceCents: 400_00 } },
        installments: {
          create: [1, 2, 3, 4].map((number) => ({
            number,
            amountCents: 100_00,
            dueDate: new Date(DUE[number - 1]!),
            status: number === 2 ? "PENDING" : number === 3 ? "PAID" : "BILLED",
          })),
        },
      },
      include: { installments: true },
    });
    for (const i of quote.installments) inst[i.number] = i.id;
    for (const n of [1, 4]) {
      const charge = await gateway.createCharge({
        customerId: "cus_x",
        billingType: "UNDEFINED",
        amountCents: 100_00,
        dueDate: "2026-10-10",
        description: `Parcela ${n}/4`,
        externalReference: inst[n]!,
      });
      await db.installment.update({ where: { id: inst[n] }, data: { asaasPaymentId: charge.id } });
    }
  });

  afterAll(async () => {
    for (const id of [clinicId, otherClinicId]) {
      await db.clinicPayment.deleteMany({ where: { clinicId: id } });
      await db.quote.deleteMany({ where: { clinicId: id } });
      await db.patient.deleteMany({ where: { clinicId: id } });
      await db.procedure.deleteMany({ where: { clinicId: id } });
      await db.dentist.deleteMany({ where: { clinicId: id } });
      await db.clinic.delete({ where: { id } });
    }
    await db.$disconnect();
  });

  const installment = (n: number) => db.installment.findUniqueOrThrow({ where: { id: inst[n] } });

  it("settles a charged installment in Asaas and here, once", async () => {
    await desk.receiveInstallment(clinicId, inst[1]!, { method: "CASH", date: "2026-10-20" }, NOW);
    expect(await installment(1)).toMatchObject({
      status: "PAID",
      paymentMethod: "CASH",
      receivedAtClinic: true,
      paidAt: NOON,
    });
    const charge = gateway.charges.find((c) => c.externalReference === inst[1]);
    expect(charge).toMatchObject({ status: "RECEIVED_IN_CASH", receivedInCashOn: "2026-10-20" });
    await expect(
      desk.receiveInstallment(clinicId, inst[1]!, { method: "CASH", date: "2026-10-20" }, NOW),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      desk.receiveInstallment(clinicId, inst[3]!, { method: "PIX", date: "2026-10-20" }, NOW),
    ).rejects.toMatchObject({ status: 409 });

    // Asaas then confirms the cash receipt: our record is kept.
    const events = new PrismaPaymentEventStore(db);
    expect(
      await events.markInstallmentPaid(charge!.id, new Date("2026-10-20T00:00:00Z"), inst[1]),
    ).toBe(false);
    expect((await installment(1)).paidAt).toEqual(NOON);
  });

  it("settles an installment not charged yet without calling Asaas", async () => {
    const before = gateway.charges.length;
    await desk.receiveInstallment(
      clinicId,
      inst[2]!,
      { method: "DEBIT_CARD", date: "2026-10-19" },
      NOW,
    );
    expect(await installment(2)).toMatchObject({ status: "PAID", paymentMethod: "DEBIT_CARD" });
    expect(gateway.charges.length).toBe(before);
  });

  it("refuses bad input, other clinics and keeps the installment open when Asaas fails", async () => {
    const receive = (id: string, input: unknown, clinic = clinicId) =>
      desk.receiveInstallment(clinic, id, input, NOW);
    for (const input of [
      { method: "BOLETO", date: "2026-10-20" },
      { method: "CASH", date: "20/10/2026" },
      { method: "CASH", date: "2026-10-21" },
      { method: "CASH", date: "2026-08-01" },
    ])
      await expect(receive(inst[4]!, input), JSON.stringify(input)).rejects.toMatchObject({
        status: 422,
      });
    await expect(
      receive(inst[4]!, { method: "CASH", date: "2026-10-20" }, otherClinicId),
    ).rejects.toMatchObject({ status: 404 });

    const failing = new ClinicPayments({
      db,
      cipher,
      logger: silentLogger,
      gateway: Object.assign(Object.create(gateway) as MockPaymentsGateway, {
        receiveInCash: async () => {
          throw new Error("Asaas down");
        },
      }),
    });
    await expect(
      failing.receiveInstallment(clinicId, inst[4]!, { method: "PIX", date: "2026-10-20" }, NOW),
    ).rejects.toMatchObject({ status: 502 });
    expect((await installment(4)).status).toBe("BILLED");

    // Asaas took it but our write was lost: the retry does not settle it twice.
    const charge = gateway.charges.find((c) => c.externalReference === inst[4])!;
    charge.status = "RECEIVED_IN_CASH";
    await failing.receiveInstallment(
      clinicId,
      inst[4]!,
      { method: "PIX", date: "2026-10-20" },
      NOW,
    );
    expect((await installment(4)).status).toBe("PAID");
  });

  it("records, lists and voids payments outside quotes", async () => {
    const pay = (input: Record<string, unknown>, clinic = clinicId) =>
      desk.register(
        clinic,
        { patientId, amountCents: 150_00, method: "CASH", date: "2026-10-20", ...input },
        NOW,
      );
    await expect(pay({}, otherClinicId)).rejects.toMatchObject({ status: 404 });
    await expect(pay({ procedureId: otherProcedureId })).rejects.toMatchObject({ status: 422 });
    await expect(pay({ amountCents: 0 })).rejects.toMatchObject({ status: 422 });
    await expect(pay({ amountCents: 1.5 })).rejects.toMatchObject({ status: 422 });

    const { id } = await pay({ procedureId });
    await pay({ procedureId: null, method: "PIX", date: "2026-10-18", amountCents: 80_00 });
    const rows = await desk.list(clinicId, NOW);
    expect(rows).toEqual([
      {
        id,
        paidOn: "2026-10-20",
        patientId,
        patientName: "Maria Balcão",
        patientPhone: "***0111",
        procedureName: "Avaliação",
        amountCents: 150_00,
        method: "CASH",
      },
      expect.objectContaining({ paidOn: "2026-10-18", procedureName: null, method: "PIX" }),
    ]);
    expect(await desk.list(otherClinicId, NOW)).toEqual([]);

    await expect(desk.void(otherClinicId, id, NOW)).rejects.toMatchObject({ status: 404 });
    await desk.void(clinicId, id, NOW);
    expect((await desk.list(clinicId, NOW)).map((r) => r.id)).not.toContain(id);
    await expect(desk.void(clinicId, id, NOW)).rejects.toMatchObject({ status: 404 });
  });
});
