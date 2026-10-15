import type { PrismaClient } from "@prisma/client";
import type { Logger } from "../lib/logger.js";
import { PAID_EVENTS, type AsaasWebhookEvent } from "./asaas.js";

/** Applies an Asaas webhook to our installments. Idempotent per Asaas event id. */
export interface PaymentEventStore {
  /** Returns false if the event was already processed. */
  markProcessed(eventId: string, event: string): Promise<boolean>;
  markInstallmentPaid(asaasPaymentId: string, paidAt: Date): Promise<boolean>;
  markInstallmentOverdue(asaasPaymentId: string): Promise<boolean>;
}

export async function handleAsaasEvent(
  evt: AsaasWebhookEvent,
  deps: { store: PaymentEventStore; logger: Logger },
) {
  if (!(await deps.store.markProcessed(evt.id, evt.event))) return;
  if (!evt.payment) return;

  if (PAID_EVENTS.has(evt.event)) {
    const paidAt = new Date(evt.payment.clientPaymentDate ?? evt.payment.paymentDate ?? Date.now());
    const found = await deps.store.markInstallmentPaid(evt.payment.id, paidAt);
    deps.logger.info({ asaasPaymentId: evt.payment.id, found }, "installment paid");
  } else if (evt.event === "PAYMENT_OVERDUE") {
    await deps.store.markInstallmentOverdue(evt.payment.id);
  }
}

export class InMemoryPaymentEventStore implements PaymentEventStore {
  readonly processed = new Set<string>();
  readonly installments = new Map<string, { status: string; paidAt?: Date }>();

  async markProcessed(eventId: string) {
    if (this.processed.has(eventId)) return false;
    this.processed.add(eventId);
    return true;
  }

  async markInstallmentPaid(asaasPaymentId: string, paidAt: Date) {
    const inst = this.installments.get(asaasPaymentId);
    if (!inst) return false;
    Object.assign(inst, { status: "PAID", paidAt });
    return true;
  }

  async markInstallmentOverdue(asaasPaymentId: string) {
    const inst = this.installments.get(asaasPaymentId);
    if (!inst || inst.status === "PAID") return false;
    inst.status = "OVERDUE";
    return true;
  }
}

export class PrismaPaymentEventStore implements PaymentEventStore {
  constructor(private readonly db: PrismaClient) {}

  async markProcessed(eventId: string, event: string) {
    const res = await this.db.paymentEvent.createMany({
      data: [{ id: eventId, event }],
      skipDuplicates: true,
    });
    return res.count === 1;
  }

  async markInstallmentPaid(asaasPaymentId: string, paidAt: Date) {
    const res = await this.db.installment.updateMany({
      where: { asaasPaymentId },
      data: { status: "PAID", paidAt },
    });
    return res.count > 0;
  }

  async markInstallmentOverdue(asaasPaymentId: string) {
    const res = await this.db.installment.updateMany({
      where: { asaasPaymentId, status: { not: "PAID" } },
      data: { status: "OVERDUE" },
    });
    return res.count > 0;
  }
}
