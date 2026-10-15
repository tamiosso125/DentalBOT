import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPaymentEventStore } from "../../src/payments/payment-events.js";
import { FieldCipher } from "../../src/privacy/index.js";
import { PrismaQuoteRepository } from "../../src/quotes/prisma-quotes.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
const PHONE = "5511900000003";

describe.skipIf(!url)("PrismaQuoteRepository (Postgres)", () => {
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "z".repeat(32));
  let db: PrismaClient;
  let repo: PrismaQuoteRepository;
  let clinicId = "";
  let otherClinicId = "";
  let dentistId = "";
  let patientId = "";

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    repo = new PrismaQuoteRepository(db, cipher);
    clinicId = (await db.clinic.create({ data: { name: "Clínica Orçamento Teste" } })).id;
    otherClinicId = (await db.clinic.create({ data: { name: "Outra Clínica" } })).id;
    dentistId = (
      await db.dentist.create({ data: { clinicId, name: "Dra. Teste", cro: "CRO-SP 00000" } })
    ).id;
    patientId = (
      await db.patient.create({
        data: {
          clinicId,
          name: "Paciente Exemplo",
          phoneHash: cipher.hash(PHONE),
          phoneEncrypted: cipher.encrypt(PHONE),
        },
      })
    ).id;
  });

  afterAll(async () => {
    for (const id of [clinicId, otherClinicId]) {
      await db.quoteItem.deleteMany({ where: { quote: { clinicId: id } } });
      await db.quote.deleteMany({ where: { clinicId: id } });
      await db.patient.deleteMany({ where: { clinicId: id } });
      await db.dentist.deleteMany({ where: { clinicId: id } });
      await db.clinic.delete({ where: { id } });
    }
    await db.$disconnect();
  });

  const newQuote = () =>
    repo.create({
      clinicId,
      patientId,
      dentistId,
      items: [
        {
          procedureId: null,
          description: "Restauração",
          quantity: 2,
          unitPriceCents: 350_00,
          coverage: "PRIVATE",
        },
        {
          procedureId: null,
          description: "Avaliação",
          quantity: 1,
          unitPriceCents: 0,
          coverage: "INSURANCE",
        },
      ],
      totalCents: 700_00,
      installmentCount: 2,
      notes: null,
      validUntil: "2026-11-03",
    });

  it("round-trips a quote and decrypts the patient phone", async () => {
    const id = await newQuote();
    const q = (await repo.get(clinicId, id))!;
    expect(q).toMatchObject({
      status: "DRAFT",
      patientName: "Paciente Exemplo",
      dentistCro: "CRO-SP 00000",
      totalCents: 700_00,
      installmentCount: 2,
      validUntil: "2026-11-03",
    });
    expect(q.items.map((i) => i.description)).toEqual(["Restauração", "Avaliação"]);
    expect(await repo.patientContact(clinicId, patientId)).toEqual({
      name: "Paciente Exemplo",
      phone: PHONE,
    });
  });

  it("scopes every read by clinic", async () => {
    const id = await newQuote();
    expect(await repo.get(otherClinicId, id)).toBeNull();
    expect(await repo.patientContact(otherClinicId, patientId)).toBeNull();
    expect(await repo.dentistExists(otherClinicId, dentistId)).toBe(false);
  });

  it("only one of two concurrent answers wins, with installments created once", async () => {
    const id = await newQuote();
    await repo.markSent(clinicId, id, new Date());
    const plan = [
      { number: 1, amountCents: 350_00, dueDate: "2026-10-22" },
      { number: 2, amountCents: 350_00, dueDate: "2026-11-22" },
    ];
    const results = await Promise.all([
      repo.respond(clinicId, id, "ACCEPTED", new Date(), plan),
      repo.respond(clinicId, id, "ACCEPTED", new Date(), plan),
      repo.respond(clinicId, id, "REJECTED", new Date(), []),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const row = await db.quote.findUniqueOrThrow({
      where: { id },
      include: { installments: true },
    });
    expect(row.installments).toHaveLength(row.status === "ACCEPTED" ? 2 : 0);
  });

  it("gives billing the decrypted CPF and records charges without undoing a payment", async () => {
    await db.patient.update({
      where: { id: patientId },
      data: { cpfHash: cipher.hash("52998224725"), cpfEncrypted: cipher.encrypt("52998224725") },
    });
    const id = await newQuote();
    await repo.markSent(clinicId, id, new Date());
    expect(await repo.billingInfo(clinicId, id)).toBeNull(); // not accepted yet
    await repo.respond(clinicId, id, "ACCEPTED", new Date(), [
      { number: 1, amountCents: 350_00, dueDate: "2026-10-22" },
      { number: 2, amountCents: 350_00, dueDate: "2026-11-22" },
    ]);
    const info = (await repo.billingInfo(clinicId, id))!;
    expect(info).toMatchObject({
      patientCpf: "52998224725",
      asaasCustomerId: null,
      clinicName: "Clínica Orçamento Teste",
    });
    expect(info.installments.map((i) => i.dueDate).sort()).toEqual(["2026-10-22", "2026-11-22"]);
    expect(await repo.billingInfo(otherClinicId, id)).toBeNull();

    await repo.saveAsaasCustomer(clinicId, patientId, "cus_test_1");
    const [one, two] = [...info.installments].sort((a, b) => a.number - b.number);

    // Installment 2 is paid before we stored its Asaas id: the webhook finds it by our id.
    const payments = new PrismaPaymentEventStore(db);
    expect(await payments.markInstallmentPaid(`pay_test_${id}_2`, new Date(), two!.id)).toBe(true);
    await repo.markBilled(one!.id, `pay_test_${id}_1`);
    await repo.markBilled(two!.id, `pay_test_${id}_2`);

    const rows = await db.installment.findMany({
      where: { quoteId: id },
      orderBy: { number: "asc" },
    });
    expect(rows.map((r) => [r.status, r.asaasPaymentId])).toEqual([
      ["BILLED", `pay_test_${id}_1`],
      ["PAID", `pay_test_${id}_2`],
    ]);
    expect((await db.patient.findUniqueOrThrow({ where: { id: patientId } })).asaasCustomerId).toBe(
      "cus_test_1",
    );
  });
});
