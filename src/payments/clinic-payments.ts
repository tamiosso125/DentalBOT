import type { InstallmentStatus, PaymentMethod, PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { Logger } from "../lib/logger.js";
import { maskPhone, type FieldCipher } from "../privacy/index.js";
import { addDays, dateInZone, zonedToUtc } from "../scheduling/time.js";
import type { PaymentsGateway } from "./asaas.js";

/**
 * Money received at the front desk (cash, card machine, Pix straight to the clinic), recorded
 * in the panel: either an open quote installment, which is then settled in Asaas too so
 * nobody keeps charging it, or a payment outside any quote ("avulso").
 */

/** How the front desk can receive. Boleto only exists through Asaas. */
export const CLINIC_METHODS = ["CASH", "DEBIT_CARD", "CREDIT_CARD", "PIX"] as const;
/** How far back a payment can be dated (typed late, e.g. after a weekend). */
export const MAX_DAYS_BACK = 60;
/** R$ 100.000,00: anything above is a typo. */
const MAX_CENTS = 10_000_000;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const receiveInstallmentSchema = z.strictObject({
  method: z.enum(CLINIC_METHODS),
  date: day,
});

export const clinicPaymentSchema = z.strictObject({
  patientId: z.string().min(1).max(64),
  procedureId: z.string().min(1).max(64).nullable().optional(),
  amountCents: z.number().int().positive().max(MAX_CENTS),
  method: z.enum(CLINIC_METHODS),
  date: day,
});

export type ClinicPaymentRow = {
  id: string;
  paidOn: string;
  patientId: string;
  patientName: string;
  /** Last 4 digits only. */
  patientPhone: string;
  procedureName: string | null;
  amountCents: number;
  method: PaymentMethod;
};

/** A request the front desk can act on. `status` is the HTTP code. */
export class ClinicPaymentError extends Error {
  constructor(
    readonly status: 404 | 409 | 422 | 502,
    message: string,
  ) {
    super(message);
    this.name = "ClinicPaymentError";
  }
}

const OPEN: InstallmentStatus[] = ["PENDING", "BILLED", "OVERDUE"];
/** Asaas statuses that mean the charge is already settled. */
const SETTLED = new Set(["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"]);

export class ClinicPayments {
  constructor(
    private readonly deps: {
      db: PrismaClient;
      cipher: FieldCipher;
      gateway: PaymentsGateway;
      logger: Logger;
    },
  ) {}

  /** Settles an open installment paid at the front desk, in Asaas first when it was charged. */
  async receiveInstallment(clinicId: string, installmentId: string, input: unknown, now: Date) {
    const parsed = receiveInstallmentSchema.safeParse(input);
    if (!parsed.success) throw new ClinicPaymentError(422, "Escolha a forma e o dia do pagamento.");
    const { db, gateway, logger } = this.deps;
    const timeZone = await this.timeZone(clinicId);
    const paidAt = this.paidAt(parsed.data.date, now, timeZone);
    const inst = await db.installment.findFirst({
      where: { id: installmentId, quote: { clinicId } },
      select: { id: true, status: true, amountCents: true, asaasPaymentId: true },
    });
    if (!inst) throw new ClinicPaymentError(404, "Parcela não encontrada.");
    if (!OPEN.includes(inst.status))
      throw new ClinicPaymentError(409, "Esta parcela não está em aberto.");

    if (inst.asaasPaymentId) {
      try {
        // Our installment id is the charge's external reference; a retry finds it settled.
        const charge = await gateway.findCharge(inst.id);
        if (charge && !SETTLED.has(charge.status))
          await gateway.receiveInCash(charge.id, parsed.data.date, inst.amountCents);
      } catch (err) {
        logger.error(
          { installmentId, err: err instanceof Error ? err.message : "unknown" },
          "asaas receiveInCash failed",
        );
        throw new ClinicPaymentError(
          502,
          "Não consegui dar baixa da parcela no Asaas agora. Tente de novo em alguns minutos.",
        );
      }
    }
    const { count } = await db.installment.updateMany({
      where: { id: inst.id, status: { in: OPEN } },
      data: {
        status: "PAID",
        paidAt,
        paymentMethod: parsed.data.method,
        receivedAtClinic: true,
      },
    });
    if (count === 0) throw new ClinicPaymentError(409, "Esta parcela não está em aberto.");
    logger.info({ installmentId, method: parsed.data.method }, "installment received at clinic");
  }

  /** Records a payment outside any quote. */
  async register(clinicId: string, input: unknown, now: Date): Promise<{ id: string }> {
    const parsed = clinicPaymentSchema.safeParse(input);
    if (!parsed.success)
      throw new ClinicPaymentError(422, "Confira o paciente, o valor, a forma e o dia.");
    const { db, logger } = this.deps;
    const p = parsed.data;
    const paidAt = this.paidAt(p.date, now, await this.timeZone(clinicId));
    const patient = await db.patient.findFirst({
      where: { id: p.patientId, clinicId, anonymizedAt: null },
      select: { id: true },
    });
    if (!patient) throw new ClinicPaymentError(404, "Paciente não encontrado.");
    if (p.procedureId) {
      const proc = await db.procedure.count({ where: { id: p.procedureId, clinicId } });
      if (!proc) throw new ClinicPaymentError(422, "Procedimento não encontrado.");
    }
    const created = await db.clinicPayment.create({
      data: {
        clinicId,
        patientId: p.patientId,
        procedureId: p.procedureId ?? null,
        amountCents: p.amountCents,
        method: p.method,
        paidAt,
      },
      select: { id: true },
    });
    logger.info({ clinicPaymentId: created.id, method: p.method }, "clinic payment recorded");
    return created;
  }

  /** Payments outside quotes from the last MAX_DAYS_BACK days, newest first. */
  async list(clinicId: string, now: Date): Promise<ClinicPaymentRow[]> {
    const timeZone = await this.timeZone(clinicId);
    const from = zonedToUtc(addDays(dateInZone(now, timeZone), -MAX_DAYS_BACK), 0, timeZone);
    const rows = await this.deps.db.clinicPayment.findMany({
      where: { clinicId, voidedAt: null, paidAt: { gte: from } },
      orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }],
      take: 200,
      select: {
        id: true,
        paidAt: true,
        amountCents: true,
        method: true,
        patient: { select: { id: true, name: true, phoneEncrypted: true } },
        procedure: { select: { name: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      paidOn: dateInZone(r.paidAt, timeZone),
      patientId: r.patient.id,
      patientName: r.patient.name,
      patientPhone: maskPhone(this.deps.cipher.decrypt(r.patient.phoneEncrypted)),
      procedureName: r.procedure?.name ?? null,
      amountCents: r.amountCents,
      method: r.method,
    }));
  }

  /** Undoes a payment typed by mistake. The row stays, marked void. */
  async void(clinicId: string, id: string, now: Date) {
    const { count } = await this.deps.db.clinicPayment.updateMany({
      where: { id, clinicId, voidedAt: null },
      data: { voidedAt: now },
    });
    if (count === 0) throw new ClinicPaymentError(404, "Pagamento não encontrado.");
    this.deps.logger.info({ clinicPaymentId: id }, "clinic payment voided");
  }

  /** Noon of `date` in the clinic: never in the future, at most MAX_DAYS_BACK days ago. */
  private paidAt(date: string, now: Date, timeZone: string): Date {
    const today = dateInZone(now, timeZone);
    if (date > today) throw new ClinicPaymentError(422, "O dia do pagamento não pode ser futuro.");
    if (date < addDays(today, -MAX_DAYS_BACK))
      throw new ClinicPaymentError(
        422,
        `Só dá para registrar pagamentos dos últimos ${MAX_DAYS_BACK} dias.`,
      );
    return zonedToUtc(date, 12 * 60, timeZone);
  }

  private async timeZone(clinicId: string) {
    const c = await this.deps.db.clinic.findUnique({
      where: { id: clinicId },
      select: { timezone: true },
    });
    return c?.timezone ?? "America/Sao_Paulo";
  }
}
