import type { Logger } from "../lib/logger.js";
import type { PaymentsGateway } from "../payments/asaas.js";
import { isValidCpf, normalizeCpf } from "../privacy/index.js";

/** What billing needs from an accepted quote. Every read is scoped by clinic id. */
export type QuoteBillingInfo = {
  clinicName: string;
  patientId: string;
  patientName: string;
  /** Decrypted CPF, or null if the clinic never recorded it. Asaas requires one. */
  patientCpf: string | null;
  asaasCustomerId: string | null;
  installments: Array<{
    id: string;
    number: number;
    amountCents: number;
    /** YYYY-MM-DD */
    dueDate: string;
    asaasPaymentId: string | null;
  }>;
};

export interface QuoteBillingRepository {
  billingInfo(clinicId: string, quoteId: string): Promise<QuoteBillingInfo | null>;
  saveAsaasCustomer(clinicId: string, patientId: string, customerId: string): Promise<void>;
  /** Records the Asaas charge and moves the installment PENDING -> BILLED. */
  markBilled(installmentId: string, asaasPaymentId: string): Promise<void>;
}

export type BilledInstallment = {
  number: number;
  amountCents: number;
  dueDate: string;
  invoiceUrl: string;
};

export type BillingResult =
  | { status: "billed"; installments: BilledInstallment[] }
  | { status: "no_cpf" }
  | { status: "nothing_to_bill" };

/**
 * Creates the Asaas charges for an accepted quote, one per installment. The patient picks
 * Pix, boleto or card on the Asaas invoice page.
 *
 * Idempotent: the Asaas customer is the patient (externalReference = Patient.id) and each
 * charge is an installment (externalReference = Installment.id), so a retry after a crash
 * finds what was already created instead of charging twice.
 *
 * Asaas only receives the patient's name and CPF plus "Parcela 1/3 - <clinic>": no
 * procedure names, which would be health data.
 */
export class QuoteBillingService {
  constructor(
    private readonly deps: {
      repo: QuoteBillingRepository;
      gateway: PaymentsGateway;
      logger: Logger;
    },
  ) {}

  async bill(clinicId: string, quoteId: string): Promise<BillingResult> {
    const { repo, gateway, logger } = this.deps;
    const info = await repo.billingInfo(clinicId, quoteId);
    if (!info || info.installments.length === 0) return { status: "nothing_to_bill" };
    if (!info.patientCpf || !isValidCpf(info.patientCpf)) return { status: "no_cpf" };

    let customerId = info.asaasCustomerId;
    if (!customerId) {
      customerId =
        (await gateway.findCustomer(info.patientId))?.id ??
        (
          await gateway.createCustomer({
            name: info.patientName,
            cpfCnpj: normalizeCpf(info.patientCpf),
            externalReference: info.patientId,
          })
        ).id;
      await repo.saveAsaasCustomer(clinicId, info.patientId, customerId);
    }

    const total = info.installments.length;
    const billed: BilledInstallment[] = [];
    for (const inst of [...info.installments].sort((a, b) => a.number - b.number)) {
      const charge =
        (await gateway.findCharge(inst.id)) ??
        (await gateway.createCharge({
          customerId,
          billingType: "UNDEFINED",
          amountCents: inst.amountCents,
          dueDate: inst.dueDate,
          description: `Parcela ${inst.number}/${total} - ${info.clinicName}`,
          externalReference: inst.id,
        }));
      if (inst.asaasPaymentId !== charge.id) await repo.markBilled(inst.id, charge.id);
      billed.push({
        number: inst.number,
        amountCents: inst.amountCents,
        dueDate: inst.dueDate,
        invoiceUrl: charge.invoiceUrl,
      });
    }
    logger.info({ quoteId, installments: billed.length }, "quote billed");
    return { status: "billed", installments: billed };
  }
}
