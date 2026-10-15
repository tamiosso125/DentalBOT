import type { PrismaClient } from "@prisma/client";
import type { FieldCipher } from "../privacy/index.js";
import type { QuoteBillingRepository } from "./quote-billing.js";
import type { QuoteFollowUpRepository } from "./quote-follow-up.js";
import type { NewInstallment, NewQuote, QuoteRepository, QuoteView } from "./quote-repository.js";

const dateOnly = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);

export class PrismaQuoteRepository
  implements QuoteRepository, QuoteBillingRepository, QuoteFollowUpRepository
{
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

  async billingInfo(clinicId: string, quoteId: string) {
    const q = await this.db.quote.findFirst({
      where: { id: quoteId, clinicId, status: "ACCEPTED" },
      include: {
        clinic: { select: { name: true } },
        patient: { select: { id: true, name: true, cpfEncrypted: true, asaasCustomerId: true } },
        installments: { where: { status: { in: ["PENDING", "BILLED"] } } },
      },
    });
    if (!q) return null;
    return {
      clinicName: q.clinic.name,
      patientId: q.patient.id,
      patientName: q.patient.name,
      patientCpf: q.patient.cpfEncrypted ? this.cipher.decrypt(q.patient.cpfEncrypted) : null,
      asaasCustomerId: q.patient.asaasCustomerId,
      installments: q.installments.map((i) => ({
        id: i.id,
        number: i.number,
        amountCents: i.amountCents,
        dueDate: dateOnly(i.dueDate)!,
        asaasPaymentId: i.asaasPaymentId,
      })),
    };
  }

  async saveAsaasCustomer(clinicId: string, patientId: string, customerId: string) {
    await this.db.patient.updateMany({
      where: { id: patientId, clinicId },
      data: { asaasCustomerId: customerId },
    });
  }

  async markBilled(installmentId: string, asaasPaymentId: string) {
    // A webhook may already have marked it PAID: never move it back.
    await this.db.installment.updateMany({
      where: { id: installmentId, status: "PENDING" },
      data: { status: "BILLED", asaasPaymentId },
    });
  }

  async unanswered(sentBefore: Date, clinicId?: string) {
    const rows = await this.db.quote.findMany({
      where: {
        ...(clinicId ? { clinicId } : {}),
        status: "SENT",
        reminderSentAt: null,
        sentAt: { lte: sentBefore },
        validUntil: { not: null },
        patient: { anonymizedAt: null },
      },
      orderBy: { sentAt: "asc" },
      take: 200,
      select: {
        id: true,
        clinicId: true,
        totalCents: true,
        sentAt: true,
        validUntil: true,
        clinic: { select: { name: true, timezone: true } },
        patient: { select: { name: true, phoneEncrypted: true } },
      },
    });
    return rows.map((q) => ({
      quoteId: q.id,
      clinicId: q.clinicId,
      clinicName: q.clinic.name,
      clinicTimeZone: q.clinic.timezone,
      patientName: q.patient.name,
      phone: this.cipher.decrypt(q.patient.phoneEncrypted),
      totalCents: q.totalCents,
      sentAt: q.sentAt!,
      validUntil: dateOnly(q.validUntil)!,
    }));
  }

  async claimReminder(quoteId: string, at: Date) {
    const { count } = await this.db.quote.updateMany({
      where: { id: quoteId, status: "SENT", reminderSentAt: null },
      data: { reminderSentAt: at },
    });
    return count === 1;
  }

  async releaseReminder(quoteId: string) {
    await this.db.quote.updateMany({ where: { id: quoteId }, data: { reminderSentAt: null } });
  }

  async expiring(onOrBefore: string) {
    const rows = await this.db.quote.findMany({
      where: { status: "SENT", validUntil: { lte: toDate(onOrBefore) } },
      take: 500,
      select: { id: true, validUntil: true, clinic: { select: { timezone: true } } },
    });
    return rows.map((q) => ({
      quoteId: q.id,
      clinicTimeZone: q.clinic.timezone,
      validUntil: dateOnly(q.validUntil)!,
    }));
  }

  async expire(quoteId: string, at: Date) {
    const { count } = await this.db.quote.updateMany({
      where: { id: quoteId, status: "SENT" },
      data: { status: "EXPIRED", respondedAt: at },
    });
    return count === 1;
  }
}
