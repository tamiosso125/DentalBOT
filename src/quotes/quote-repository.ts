import { randomUUID } from "node:crypto";
import type { QuoteBillingInfo, QuoteBillingRepository } from "./quote-billing.js";

export type Coverage = "PRIVATE" | "INSURANCE";
export type QuoteStatus = "DRAFT" | "SENT" | "ACCEPTED" | "REJECTED" | "EXPIRED";

export type QuoteItemView = {
  procedureId: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  coverage: Coverage;
};

/** Everything needed to render, send and answer a quote. */
export type QuoteView = {
  id: string;
  clinicId: string;
  clinicName: string;
  clinicAddress: string | null;
  clinicTimeZone: string;
  patientId: string;
  patientName: string;
  dentistName: string;
  dentistCro: string | null;
  status: QuoteStatus;
  items: QuoteItemView[];
  totalCents: number;
  installmentCount: number;
  notes: string | null;
  /** "YYYY-MM-DD", last day the quote can be accepted. */
  validUntil: string | null;
  createdAt: Date;
  sentAt: Date | null;
  respondedAt: Date | null;
};

export type NewQuote = {
  clinicId: string;
  patientId: string;
  dentistId: string;
  items: QuoteItemView[];
  totalCents: number;
  installmentCount: number;
  notes: string | null;
  validUntil: string | null;
};

export type NewInstallment = { number: number; amountCents: number; dueDate: string };

export type StoredInstallment = NewInstallment & {
  id: string;
  status: "PENDING" | "BILLED";
  asaasPaymentId: string | null;
};

/** Storage port for quotes. Every read and write is scoped by clinic id. */
export interface QuoteRepository {
  dentistExists(clinicId: string, dentistId: string): Promise<boolean>;
  /** Patient name and decrypted WhatsApp number (wa_id), or null if not in this clinic. */
  patientContact(
    clinicId: string,
    patientId: string,
  ): Promise<{ name: string; phone: string } | null>;
  /** Clinic procedures, to price items from the table. */
  procedures(
    clinicId: string,
  ): Promise<Array<{ id: string; name: string; priceCents: number | null }>>;
  create(quote: NewQuote): Promise<string>;
  get(clinicId: string, quoteId: string): Promise<QuoteView | null>;
  markSent(clinicId: string, quoteId: string, at: Date): Promise<void>;
  /**
   * Moves a SENT quote to ACCEPTED/REJECTED/EXPIRED (creating installments on accept).
   * Returns false if the quote was no longer SENT (answered twice, concurrent tap).
   */
  respond(
    clinicId: string,
    quoteId: string,
    status: "ACCEPTED" | "REJECTED" | "EXPIRED",
    at: Date,
    installments: NewInstallment[],
  ): Promise<boolean>;
}

type Stored = Omit<
  QuoteView,
  "clinicName" | "clinicAddress" | "clinicTimeZone" | "patientName" | "dentistName" | "dentistCro"
> & {
  dentistId: string;
  installments: StoredInstallment[];
};

type MemoryPatient = {
  id: string;
  name: string;
  phone: string;
  cpf?: string | null;
  asaasCustomerId?: string | null;
};

/** In-memory quotes (and their billing) for tests and the conversation eval. */
export class InMemoryQuoteRepository implements QuoteRepository, QuoteBillingRepository {
  readonly quotes: Stored[] = [];

  constructor(
    private readonly data: {
      clinic: { id: string; name: string; address: string | null; timeZone: string };
      dentists: Array<{ id: string; name: string; cro: string | null }>;
      patients: MemoryPatient[];
      procedures: Array<{ id: string; name: string; priceCents: number | null }>;
    },
  ) {}

  async dentistExists(clinicId: string, dentistId: string) {
    return clinicId === this.data.clinic.id && this.data.dentists.some((d) => d.id === dentistId);
  }

  async patientContact(clinicId: string, patientId: string) {
    if (clinicId !== this.data.clinic.id) return null;
    const p = this.data.patients.find((x) => x.id === patientId);
    return p ? { name: p.name, phone: p.phone } : null;
  }

  async procedures(clinicId: string) {
    return clinicId === this.data.clinic.id ? this.data.procedures : [];
  }

  async create(q: NewQuote) {
    const id = `quote_${randomUUID().slice(0, 8)}`;
    this.quotes.push({
      ...q,
      id,
      status: "DRAFT",
      createdAt: new Date(),
      sentAt: null,
      respondedAt: null,
      installments: [],
    });
    return id;
  }

  async get(clinicId: string, quoteId: string): Promise<QuoteView | null> {
    const q = this.quotes.find((x) => x.id === quoteId && x.clinicId === clinicId);
    if (!q) return null;
    const dentist = this.data.dentists.find((d) => d.id === q.dentistId)!;
    const patient = this.data.patients.find((p) => p.id === q.patientId)!;
    const view: Partial<Stored> = { ...q };
    delete view.dentistId;
    delete view.installments;
    return {
      ...(view as Omit<Stored, "dentistId" | "installments">),
      items: q.items.map((i) => ({ ...i })),
      clinicName: this.data.clinic.name,
      clinicAddress: this.data.clinic.address,
      clinicTimeZone: this.data.clinic.timeZone,
      patientName: patient.name,
      dentistName: dentist.name,
      dentistCro: dentist.cro,
    };
  }

  async markSent(clinicId: string, quoteId: string, at: Date) {
    const q = this.quotes.find((x) => x.id === quoteId && x.clinicId === clinicId);
    if (q && (q.status === "DRAFT" || q.status === "SENT"))
      Object.assign(q, { status: "SENT", sentAt: at });
  }

  async respond(
    clinicId: string,
    quoteId: string,
    status: "ACCEPTED" | "REJECTED" | "EXPIRED",
    at: Date,
    installments: NewInstallment[],
  ) {
    const q = this.quotes.find((x) => x.id === quoteId && x.clinicId === clinicId);
    if (!q || q.status !== "SENT") return false;
    Object.assign(q, {
      status,
      respondedAt: at,
      installments: installments.map((i) => ({
        ...i,
        id: `inst_${randomUUID().slice(0, 8)}`,
        status: "PENDING",
        asaasPaymentId: null,
      })),
    });
    return true;
  }

  async billingInfo(clinicId: string, quoteId: string): Promise<QuoteBillingInfo | null> {
    const q = this.quotes.find((x) => x.id === quoteId && x.clinicId === clinicId);
    if (!q || q.status !== "ACCEPTED") return null;
    const patient = this.data.patients.find((p) => p.id === q.patientId)!;
    return {
      clinicName: this.data.clinic.name,
      patientId: patient.id,
      patientName: patient.name,
      patientCpf: patient.cpf ?? null,
      asaasCustomerId: patient.asaasCustomerId ?? null,
      installments: q.installments.map((i) => ({
        id: i.id,
        number: i.number,
        amountCents: i.amountCents,
        dueDate: i.dueDate,
        asaasPaymentId: i.asaasPaymentId,
      })),
    };
  }

  async saveAsaasCustomer(clinicId: string, patientId: string, customerId: string) {
    const p = this.data.patients.find((x) => x.id === patientId);
    if (p && clinicId === this.data.clinic.id) p.asaasCustomerId = customerId;
  }

  async markBilled(installmentId: string, asaasPaymentId: string) {
    for (const q of this.quotes)
      for (const i of q.installments)
        if (i.id === installmentId) Object.assign(i, { status: "BILLED", asaasPaymentId });
  }
}
