import type { InstallmentStatus, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { PaymentsGateway } from "../payments/asaas.js";
import { maskPhone, type FieldCipher } from "../privacy/index.js";
import { addDays, dateInZone, zonedToUtc } from "../scheduling/time.js";

/**
 * Installments for the staff panel ("Cobranças"): what is open, late or paid, per clinic.
 * Charges themselves are created by QuoteBillingService and settled by Asaas webhooks;
 * this module only reads, plus fetches the payment link of a charge on demand.
 */

export type InstallmentRow = {
  id: string;
  quoteId: string;
  patientName: string;
  /** Last 4 digits only. */
  patientPhone: string;
  number: number;
  of: number;
  amountCents: number;
  dueDate: string;
  status: InstallmentStatus;
  /** Open and past its due date, even if Asaas has not flagged it OVERDUE yet. */
  late: boolean;
  /** A charge exists in Asaas (the link can be fetched). */
  charged: boolean;
  paidAt: string | null;
  paymentMethod: string | null;
  /** Paid at the front desk (recorded in the panel). */
  receivedAtClinic: boolean;
  /** When the bot sent the "past due" notice (null = not sent). */
  overdueNoticeAt: string | null;
};

export type BillingSummary = {
  openCents: number;
  lateCents: number;
  lateCount: number;
  /** Open installments late by TO_CALL_AFTER_DAYS or more: the front desk should call. */
  toCallCount: number;
  /** Paid in the current month, by paidAt. */
  paidThisMonthCents: number;
};

export const INSTALLMENT_FILTERS = ["abertas", "vencidas", "ligar", "pagas", "todas"] as const;

/** Past this many days late, the bot's notice was not enough: the front desk calls. */
export const TO_CALL_AFTER_DAYS = 7;

export const installmentQuerySchema = z.strictObject({
  filtro: z.enum(INSTALLMENT_FILTERS).default("abertas"),
  quoteId: z.string().min(1).max(64).optional(),
});

/** A request the front desk can act on. `status` is the HTTP code. */
export class BillingError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "BillingError";
  }
}

const OPEN: InstallmentStatus[] = ["PENDING", "BILLED", "OVERDUE"];

export interface Billing {
  installments(
    clinicId: string,
    q: z.infer<typeof installmentQuerySchema>,
    now: Date,
  ): Promise<InstallmentRow[]>;
  summary(clinicId: string, now: Date): Promise<BillingSummary>;
  paymentLink(clinicId: string, installmentId: string): Promise<{ url: string }>;
}

/** Due dates are calendar dates (stored at UTC midnight); compare them with the clinic's today. */
const day = (date: string) => new Date(`${date}T00:00:00Z`);

/** Open installments due TO_CALL_AFTER_DAYS or more days before `today`. */
const toCall = (today: string): Prisma.InstallmentWhereInput => ({
  status: { in: OPEN },
  dueDate: { lte: day(addDays(today, -TO_CALL_AFTER_DAYS)) },
});

export class PrismaBilling implements Billing {
  constructor(
    private readonly db: PrismaClient,
    private readonly cipher: FieldCipher,
    private readonly gateway: PaymentsGateway,
  ) {}

  async installments(
    clinicId: string,
    q: z.infer<typeof installmentQuerySchema>,
    now: Date,
  ): Promise<InstallmentRow[]> {
    const { today } = await this.clinicDay(clinicId, now);
    const where: Prisma.InstallmentWhereInput = {
      quote: { clinicId, ...(q.quoteId ? { id: q.quoteId } : {}) },
    };
    if (q.filtro === "abertas") where.status = { in: OPEN };
    if (q.filtro === "pagas") where.status = "PAID";
    if (q.filtro === "vencidas")
      where.OR = [{ status: "OVERDUE" }, { status: { in: OPEN }, dueDate: { lt: day(today) } }];
    if (q.filtro === "ligar") Object.assign(where, toCall(today));
    const rows = await this.db.installment.findMany({
      where,
      orderBy:
        q.filtro === "pagas"
          ? [{ paidAt: "desc" }]
          : [{ dueDate: "asc" }, { quoteId: "asc" }, { number: "asc" }],
      take: 200,
      include: {
        quote: {
          select: {
            installmentCount: true,
            patient: { select: { name: true, phoneEncrypted: true } },
          },
        },
      },
    });
    return rows.map((i) => ({
      id: i.id,
      quoteId: i.quoteId,
      patientName: i.quote.patient.name,
      patientPhone: maskPhone(this.cipher.decrypt(i.quote.patient.phoneEncrypted)),
      number: i.number,
      of: i.quote.installmentCount,
      amountCents: i.amountCents,
      dueDate: i.dueDate.toISOString().slice(0, 10),
      status: i.status,
      late: OPEN.includes(i.status) && i.dueDate < day(today),
      charged: i.asaasPaymentId !== null,
      paidAt: i.paidAt?.toISOString() ?? null,
      paymentMethod: i.paymentMethod,
      receivedAtClinic: i.receivedAtClinic,
      overdueNoticeAt: i.overdueNoticeAt?.toISOString() ?? null,
    }));
  }

  async summary(clinicId: string, now: Date): Promise<BillingSummary> {
    const { today, timeZone } = await this.clinicDay(clinicId, now);
    const monthStart = zonedToUtc(`${today.slice(0, 7)}-01`, 0, timeZone);
    const scope = { quote: { clinicId } };
    const [open, late, paid, call] = await Promise.all([
      this.db.installment.aggregate({
        where: { ...scope, status: { in: OPEN } },
        _sum: { amountCents: true },
      }),
      this.db.installment.aggregate({
        where: {
          ...scope,
          OR: [{ status: "OVERDUE" }, { status: { in: OPEN }, dueDate: { lt: day(today) } }],
        },
        _sum: { amountCents: true },
        _count: true,
      }),
      this.db.installment.aggregate({
        where: { ...scope, status: "PAID", paidAt: { gte: monthStart } },
        _sum: { amountCents: true },
      }),
      this.db.installment.count({ where: { ...scope, ...toCall(today) } }),
    ]);
    return {
      openCents: open._sum.amountCents ?? 0,
      lateCents: late._sum.amountCents ?? 0,
      lateCount: late._count,
      toCallCount: call,
      paidThisMonthCents: paid._sum.amountCents ?? 0,
    };
  }

  private async clinicDay(clinicId: string, now: Date) {
    const clinic = await this.db.clinic.findUnique({
      where: { id: clinicId },
      select: { timezone: true },
    });
    const timeZone = clinic?.timezone ?? "America/Sao_Paulo";
    return { today: dateInZone(now, timeZone), timeZone };
  }

  async paymentLink(clinicId: string, installmentId: string) {
    const inst = await this.db.installment.findFirst({
      where: { id: installmentId, quote: { clinicId } },
      select: { id: true, status: true, asaasPaymentId: true },
    });
    if (!inst) throw new BillingError(404, "Parcela não encontrada.");
    if (!OPEN.includes(inst.status))
      throw new BillingError(409, "Esta parcela não está em aberto.");
    // The charge carries our installment id as its external reference.
    const charge = inst.asaasPaymentId ? await this.gateway.findCharge(inst.id) : null;
    if (!charge)
      throw new BillingError(409, "A cobrança desta parcela ainda não foi emitida no Asaas.");
    return { url: charge.invoiceUrl };
  }
}
