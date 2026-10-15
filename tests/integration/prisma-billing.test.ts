import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockPaymentsGateway } from "../../src/payments/asaas.js";
import { BillingError, PrismaBilling } from "../../src/panel/billing.js";
import { FieldCipher } from "../../src/privacy/index.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
// Monday 2026-10-19, 09:00 in São Paulo.
const NOW = new Date("2026-10-19T12:00:00Z");
const PHONE = "5511900000051";

describe.skipIf(!url)("PrismaBilling (Postgres)", () => {
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "b".repeat(32));
  const gateway = new MockPaymentsGateway();
  let db: PrismaClient;
  let billing: PrismaBilling;
  let clinicId = "";
  let otherClinicId = "";
  let quoteId = "";
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    billing = new PrismaBilling(db, cipher, gateway);
    clinicId = (await db.clinic.create({ data: { name: "Clínica Cobrança" } })).id;
    otherClinicId = (await db.clinic.create({ data: { name: "Outra Clínica" } })).id;
    const dentistId = (await db.dentist.create({ data: { clinicId, name: "Dra. Caixa" } })).id;
    const patientId = (
      await db.patient.create({
        data: {
          clinicId,
          name: "Maria Exemplo",
          phoneHash: cipher.hash(PHONE),
          phoneEncrypted: cipher.encrypt(PHONE),
        },
      })
    ).id;
    // Four installments of R$ 100: paid this month, overdue in Asaas, late but not flagged
    // yet, and one still to come.
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
          create: [
            {
              number: 1,
              amountCents: 100_00,
              dueDate: new Date("2026-09-20"),
              status: "PAID",
              paidAt: new Date("2026-10-02T15:00:00Z"),
              paymentMethod: "PIX",
              asaasPaymentId: `pay_${randomBytes(4).toString("hex")}`,
            },
            {
              number: 2,
              amountCents: 100_00,
              dueDate: new Date("2026-10-10"),
              status: "OVERDUE",
              asaasPaymentId: `pay_${randomBytes(4).toString("hex")}`,
            },
            { number: 3, amountCents: 100_00, dueDate: new Date("2026-10-18"), status: "BILLED" },
            { number: 4, amountCents: 100_00, dueDate: new Date("2026-11-20") },
          ],
        },
      },
      include: { installments: true },
    });
    quoteId = quote.id;
    for (const i of quote.installments) ids[i.number] = i.id;
    // Asaas knows the charge of installment 2 by our installment id.
    await gateway.createCharge({
      customerId: "cus_x",
      billingType: "UNDEFINED",
      amountCents: 100_00,
      dueDate: "2026-10-10",
      description: "Parcela 2/4",
      externalReference: ids[2]!,
    } as Parameters<typeof gateway.createCharge>[0]);
  });

  afterAll(async () => {
    for (const id of [clinicId, otherClinicId]) {
      await db.quote.deleteMany({ where: { clinicId: id } });
      await db.patient.deleteMany({ where: { clinicId: id } });
      await db.dentist.deleteMany({ where: { clinicId: id } });
      await db.clinic.delete({ where: { id } });
    }
    await db.$disconnect();
  });

  const numbers = (rows: Array<{ number: number }>) => rows.map((r) => r.number);

  it("lists open installments by due date, flagging the late ones", async () => {
    const open = await billing.installments(clinicId, { filtro: "abertas" }, NOW);
    expect(numbers(open)).toEqual([2, 3, 4]);
    expect(open[0]).toMatchObject({
      quoteId,
      patientName: "Maria Exemplo",
      patientPhone: "***0051",
      of: 4,
      amountCents: 100_00,
      dueDate: "2026-10-10",
      status: "OVERDUE",
      late: true,
      charged: true,
    });
    expect(open.map((r) => r.late)).toEqual([true, true, false]);
  });

  it("filters late, paid, all and one quote, never another clinic's", async () => {
    expect(numbers(await billing.installments(clinicId, { filtro: "vencidas" }, NOW))).toEqual([
      2, 3,
    ]);
    const paid = await billing.installments(clinicId, { filtro: "pagas" }, NOW);
    expect(paid).toMatchObject([{ number: 1, paymentMethod: "PIX", late: false }]);
    expect(
      numbers(await billing.installments(clinicId, { filtro: "todas", quoteId }, NOW)),
    ).toEqual([1, 2, 3, 4]);
    expect(await billing.installments(otherClinicId, { filtro: "todas" }, NOW)).toEqual([]);
    expect(await billing.installments(otherClinicId, { filtro: "todas", quoteId }, NOW)).toEqual(
      [],
    );
  });

  it("sums what is open, late and paid this month", async () => {
    expect(await billing.summary(clinicId, NOW)).toEqual({
      openCents: 300_00,
      lateCents: 200_00,
      lateCount: 2,
      paidThisMonthCents: 100_00,
    });
    expect(await billing.summary(otherClinicId, NOW)).toEqual({
      openCents: 0,
      lateCents: 0,
      lateCount: 0,
      paidThisMonthCents: 0,
    });
  });

  it("fetches the payment link only for an open, charged installment of the clinic", async () => {
    expect(await billing.paymentLink(clinicId, ids[2]!)).toEqual({
      url: expect.stringContaining("https://"),
    });
    const fail = (clinic: string, id: string) =>
      billing.paymentLink(clinic, id).catch((e: unknown) => e as BillingError);
    expect(await fail(otherClinicId, ids[2]!)).toMatchObject({ status: 404 });
    expect(await fail(clinicId, ids[1]!)).toMatchObject({ status: 409 }); // paid
    expect(await fail(clinicId, ids[4]!)).toMatchObject({ status: 409 }); // no charge yet
  });
});
