import type { InstallmentStatus, PaymentMethod, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { dateInZone, zonedToUtc } from "../scheduling/time.js";

/**
 * Month at a glance for the dentist ("Resumo do mês"): appointments, money received through
 * Asaas and quotes, in the clinic's timezone. Read-only; every query is scoped by clinic.
 */

export type MonthNumbers = {
  /** Marked "Compareceu". */
  attended: number;
  /** Of the attended: insurance or private (see `payerOf`). */
  attendedInsurance: number;
  attendedPrivate: number;
  noShow: number;
  cancelled: number;
  /** Installments paid in the month (by paidAt), in cents. */
  receivedCents: number;
  receivedByMethod: Record<PaymentMethod | "OTHER", number>;
  /** Installments due in the month and still open, in cents (late ones included). */
  dueOpenCents: number;
  /** Of `dueOpenCents`, the part already past its due date. */
  lateCents: number;
  quotesSent: number;
  quotesAccepted: number;
  /** Private total of the quotes accepted in the month, in cents. */
  acceptedCents: number;
  quotesRejected: number;
};

export type MonthlyReport = {
  /** "YYYY-MM". */
  month: string;
  /** The month is still running: numbers count up to now. */
  current: boolean;
  numbers: MonthNumbers;
  /** The month before, for comparison. */
  previous: MonthNumbers;
  /** Most attended procedures of the month, most first (up to 5). */
  topProcedures: Array<{ name: string; count: number }>;
};

export const reportQuerySchema = z.strictObject({
  mes: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
});

export interface MonthlyReports {
  report(clinicId: string, month: string | undefined, now: Date): Promise<MonthlyReport>;
}

const OPEN: InstallmentStatus[] = ["PENDING", "BILLED", "OVERDUE"];

/** "2026-10" -> "2026-09" (n = -1). */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

/**
 * Insurance when the insurer authorized it, private when it denied it; otherwise by the
 * patient's current plan covering the procedure. The plan can change after the visit, so
 * older months are an estimate.
 */
export function payerOf(a: {
  authorization: { status: "AUTHORIZED" | "DENIED" } | null;
  coveredByPlan: boolean;
}): "INSURANCE" | "PRIVATE" {
  if (a.authorization) return a.authorization.status === "AUTHORIZED" ? "INSURANCE" : "PRIVATE";
  return a.coveredByPlan ? "INSURANCE" : "PRIVATE";
}

export class PrismaMonthlyReports implements MonthlyReports {
  constructor(private readonly db: PrismaClient) {}

  async report(clinicId: string, month: string | undefined, now: Date): Promise<MonthlyReport> {
    const clinic = await this.db.clinic.findUnique({
      where: { id: clinicId },
      select: { timezone: true },
    });
    const timeZone = clinic?.timezone ?? "America/Sao_Paulo";
    const today = dateInZone(now, timeZone);
    const target = month ?? today.slice(0, 7);
    const [numbers, previous, topProcedures] = await Promise.all([
      this.numbers(clinicId, target, today, timeZone),
      this.numbers(clinicId, shiftMonth(target, -1), today, timeZone),
      this.topProcedures(clinicId, target, timeZone),
    ]);
    return {
      month: target,
      current: target === today.slice(0, 7),
      numbers,
      previous,
      topProcedures,
    };
  }

  private range(month: string, timeZone: string) {
    return {
      gte: zonedToUtc(`${month}-01`, 0, timeZone),
      lt: zonedToUtc(`${shiftMonth(month, 1)}-01`, 0, timeZone),
    };
  }

  private async numbers(
    clinicId: string,
    month: string,
    today: string,
    timeZone: string,
  ): Promise<MonthNumbers> {
    const when = this.range(month, timeZone);
    // Due dates are calendar dates stored at UTC midnight.
    const dueIn = {
      gte: new Date(`${month}-01T00:00:00Z`),
      lt: new Date(`${shiftMonth(month, 1)}-01T00:00:00Z`),
    };
    const lateBefore = new Date(Math.min(dueIn.lt.getTime(), Date.parse(`${today}T00:00:00Z`)));
    const quotes = { clinicId };
    const [statuses, attended, paid, dueOpen, late, sent, accepted, rejected] = await Promise.all([
      this.db.appointment.groupBy({
        by: ["status"],
        where: { clinicId, startsAt: when, status: { in: ["NO_SHOW", "CANCELLED"] } },
        _count: true,
      }),
      this.db.appointment.findMany({
        where: { clinicId, startsAt: when, status: "COMPLETED" },
        select: {
          procedureId: true,
          authorization: { select: { status: true } },
          patient: {
            select: {
              insurancePlan: {
                select: { coverages: { where: { covered: true }, select: { procedureId: true } } },
              },
            },
          },
        },
      }),
      this.db.installment.groupBy({
        by: ["paymentMethod"],
        where: { quote: quotes, status: "PAID", paidAt: when },
        _sum: { amountCents: true },
      }),
      this.db.installment.aggregate({
        where: { quote: quotes, status: { in: OPEN }, dueDate: dueIn },
        _sum: { amountCents: true },
      }),
      this.db.installment.aggregate({
        where: {
          quote: quotes,
          status: { in: OPEN },
          dueDate: { gte: dueIn.gte, lt: lateBefore },
        },
        _sum: { amountCents: true },
      }),
      this.db.quote.count({ where: { ...quotes, sentAt: when } }),
      this.db.quote.aggregate({
        where: { ...quotes, status: "ACCEPTED", respondedAt: when },
        _sum: { totalCents: true },
        _count: true,
      }),
      this.db.quote.count({ where: { ...quotes, status: "REJECTED", respondedAt: when } }),
    ]);
    const count = (s: string) => statuses.find((x) => x.status === s)?._count ?? 0;
    const insurance = attended.filter(
      (a) =>
        payerOf({
          authorization: a.authorization,
          coveredByPlan: !!a.patient.insurancePlan?.coverages.some(
            (c) => c.procedureId === a.procedureId,
          ),
        }) === "INSURANCE",
    ).length;
    const receivedByMethod = { PIX: 0, BOLETO: 0, CREDIT_CARD: 0, OTHER: 0 };
    for (const p of paid) receivedByMethod[p.paymentMethod ?? "OTHER"] += p._sum.amountCents ?? 0;
    return {
      attended: attended.length,
      attendedInsurance: insurance,
      attendedPrivate: attended.length - insurance,
      noShow: count("NO_SHOW"),
      cancelled: count("CANCELLED"),
      receivedCents: Object.values(receivedByMethod).reduce((a, b) => a + b, 0),
      receivedByMethod,
      dueOpenCents: dueOpen._sum.amountCents ?? 0,
      lateCents: late._sum.amountCents ?? 0,
      quotesSent: sent,
      quotesAccepted: accepted._count,
      acceptedCents: accepted._sum.totalCents ?? 0,
      quotesRejected: rejected,
    };
  }

  private async topProcedures(clinicId: string, month: string, timeZone: string) {
    const groups = await this.db.appointment.groupBy({
      by: ["procedureId"],
      where: { clinicId, startsAt: this.range(month, timeZone), status: "COMPLETED" },
      _count: true,
    });
    const top = groups.sort((a, b) => b._count - a._count).slice(0, 5);
    const names = await this.db.procedure.findMany({
      where: { clinicId, id: { in: top.map((g) => g.procedureId) } },
      select: { id: true, name: true },
    });
    return top.map((g) => ({
      name: names.find((p) => p.id === g.procedureId)?.name ?? "",
      count: g._count,
    }));
  }
}
