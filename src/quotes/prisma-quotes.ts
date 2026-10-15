import type { PrismaClient } from "@prisma/client";
import type { FieldCipher } from "../privacy/index.js";
import type { NewInstallment, NewQuote, QuoteRepository, QuoteView } from "./quote-repository.js";

const dateOnly = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);

export class PrismaQuoteRepository implements QuoteRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly cipher: FieldCipher,
  ) {}

  async dentistExists(clinicId: string, dentistId: string) {
    return (await this.db.dentist.count({ where: { id: dentistId, clinicId, active: true } })) > 0;
  }

  async patientContact(clinicId: string, patientId: string) {
    const p = await this.db.patient.findFirst({
      where: { id: patientId, clinicId },
      select: { name: true, phoneEncrypted: true },
    });
    return p ? { name: p.name, phone: this.cipher.decrypt(p.phoneEncrypted) } : null;
  }

  async procedures(clinicId: string) {
    return this.db.procedure.findMany({
      where: { clinicId, active: true },
      select: { id: true, name: true, priceCents: true },
    });
  }

  async create(q: NewQuote) {
    const row = await this.db.quote.create({
      data: {
        clinicId: q.clinicId,
        patientId: q.patientId,
        dentistId: q.dentistId,
        totalCents: q.totalCents,
        installmentCount: q.installmentCount,
        notes: q.notes,
        validUntil: q.validUntil ? toDate(q.validUntil) : null,
        items: {
          create: q.items.map((i) => ({
            procedureId: i.procedureId,
            description: i.description,
            quantity: i.quantity,
            unitPriceCents: i.unitPriceCents,
            coverage: i.coverage,
          })),
        },
      },
      select: { id: true },
    });
    return row.id;
  }

  async get(clinicId: string, quoteId: string): Promise<QuoteView | null> {
    const q = await this.db.quote.findFirst({
      where: { id: quoteId, clinicId },
      include: {
        clinic: { select: { name: true, address: true, timezone: true } },
        patient: { select: { name: true } },
        dentist: { select: { name: true, cro: true } },
        items: { orderBy: { id: "asc" } },
      },
    });
    if (!q) return null;
    return {
      id: q.id,
      clinicId: q.clinicId,
      clinicName: q.clinic.name,
      clinicAddress: q.clinic.address,
      clinicTimeZone: q.clinic.timezone,
      patientId: q.patientId,
      patientName: q.patient.name,
      dentistName: q.dentist.name,
      dentistCro: q.dentist.cro,
      status: q.status,
      items: q.items.map((i) => ({
        procedureId: i.procedureId,
        description: i.description,
        quantity: i.quantity,
        unitPriceCents: i.unitPriceCents,
        coverage: i.coverage,
      })),
      totalCents: q.totalCents,
      installmentCount: q.installmentCount,
      notes: q.notes,
      validUntil: dateOnly(q.validUntil),
      createdAt: q.createdAt,
      sentAt: q.sentAt,
      respondedAt: q.respondedAt,
    };
  }

  async markSent(clinicId: string, quoteId: string, at: Date) {
    await this.db.quote.updateMany({
      where: { id: quoteId, clinicId, status: { in: ["DRAFT", "SENT"] } },
      data: { status: "SENT", sentAt: at },
    });
  }

  async respond(
    clinicId: string,
    quoteId: string,
    status: "ACCEPTED" | "REJECTED" | "EXPIRED",
    at: Date,
    installments: NewInstallment[],
  ) {
    return this.db.$transaction(async (tx) => {
      // Conditional update: only one of two concurrent taps wins.
      const { count } = await tx.quote.updateMany({
        where: { id: quoteId, clinicId, status: "SENT" },
        data: { status, respondedAt: at },
      });
      if (count !== 1) return false;
      if (installments.length) {
        await tx.installment.createMany({
          data: installments.map((i) => ({
            quoteId,
            number: i.number,
            amountCents: i.amountCents,
            dueDate: toDate(i.dueDate),
          })),
        });
      }
      return true;
    });
  }
}
