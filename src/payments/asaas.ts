import { randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * Asaas integration (Pix, boleto, credit card). Amounts inside DentalBOT are integer
 * cents; Asaas uses decimal reais, so conversion happens only here.
 */

/** UNDEFINED lets the patient pick Pix, boleto or card on the Asaas invoice page. */
export type BillingType = "PIX" | "BOLETO" | "CREDIT_CARD" | "UNDEFINED";

export type CreateCustomerInput = {
  name: string;
  cpfCnpj: string;
  mobilePhone?: string;
  /** Our Patient.id. */
  externalReference: string;
};

export type CreateChargeInput = {
  customerId: string;
  billingType: BillingType;
  amountCents: number;
  /** YYYY-MM-DD */
  dueDate: string;
  description: string;
  /** Our Installment.id, echoed back in webhooks. */
  externalReference: string;
};

export type Charge = {
  id: string;
  status: string;
  invoiceUrl: string;
  bankSlipUrl?: string | null;
};

export interface PaymentsGateway {
  createCustomer(input: CreateCustomerInput): Promise<{ id: string }>;
  /** Customer created earlier for this patient (retry after a crash), if any. */
  findCustomer(externalReference: string): Promise<{ id: string } | null>;
  createCharge(input: CreateChargeInput): Promise<Charge>;
  /** Charge created earlier for this installment (retry after a crash), if any. */
  findCharge(externalReference: string): Promise<Charge | null>;
  getPixQrCode(chargeId: string): Promise<{ payload: string; encodedImage: string }>;
  /**
   * The charge was paid at the clinic: Asaas marks it RECEIVED_IN_CASH and stops its own
   * reminders. `paymentDate` is YYYY-MM-DD.
   */
  receiveInCash(chargeId: string, paymentDate: string, amountCents: number): Promise<void>;
}

export const ASAAS_BASE_URL = {
  sandbox: "https://api-sandbox.asaas.com/v3",
  production: "https://api.asaas.com/v3",
} as const;

export function centsToReais(cents: number): number {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error("amount must be positive cents");
  return cents / 100;
}

export class AsaasHttpGateway implements PaymentsGateway {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        access_token: this.apiKey,
        "Content-Type": "application/json",
        "User-Agent": "dentalbot",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { errors?: Array<{ code?: string }> };
      const codes = err.errors?.map((e) => e.code).join(",") ?? "?";
      throw new Error(`Asaas ${method} ${path} failed: HTTP ${res.status} (${codes})`);
    }
    return (await res.json()) as T;
  }

  async createCustomer(input: CreateCustomerInput) {
    const data = await this.request<{ id: string }>("POST", "/customers", {
      name: input.name,
      cpfCnpj: input.cpfCnpj,
      mobilePhone: input.mobilePhone,
      externalReference: input.externalReference,
      notificationDisabled: true,
    });
    return { id: data.id };
  }

  async findCustomer(externalReference: string) {
    const page = await this.request<{ data: Array<{ id: string; deleted?: boolean }> }>(
      "GET",
      `/customers?externalReference=${encodeURIComponent(externalReference)}`,
    );
    const found = page.data.find((c) => !c.deleted);
    return found ? { id: found.id } : null;
  }

  async findCharge(externalReference: string) {
    const page = await this.request<{ data: Array<Charge & { deleted?: boolean }> }>(
      "GET",
      `/payments?externalReference=${encodeURIComponent(externalReference)}`,
    );
    return page.data.find((c) => !c.deleted) ?? null;
  }

  async createCharge(input: CreateChargeInput) {
    return this.request<Charge>("POST", "/payments", {
      customer: input.customerId,
      billingType: input.billingType,
      value: centsToReais(input.amountCents),
      dueDate: input.dueDate,
      description: input.description,
      externalReference: input.externalReference,
    });
  }

  async getPixQrCode(chargeId: string) {
    return this.request<{ payload: string; encodedImage: string }>(
      "GET",
      `/payments/${encodeURIComponent(chargeId)}/pixQrCode`,
    );
  }

  async receiveInCash(chargeId: string, paymentDate: string, amountCents: number) {
    await this.request("POST", `/payments/${encodeURIComponent(chargeId)}/receiveInCash`, {
      paymentDate,
      value: centsToReais(amountCents),
      notifyCustomer: false,
    });
  }
}

/** No account needed. Records calls so tests and the sandbox can inspect them. */
export class MockPaymentsGateway implements PaymentsGateway {
  readonly customers: Array<CreateCustomerInput & { id: string }> = [];
  readonly charges: Array<CreateChargeInput & Charge> = [];

  async createCustomer(input: CreateCustomerInput) {
    const id = `cus_mock_${randomUUID().slice(0, 8)}`;
    this.customers.push({ ...input, id });
    return { id };
  }

  async findCustomer(externalReference: string) {
    const c = this.customers.find((x) => x.externalReference === externalReference);
    return c ? { id: c.id } : null;
  }

  async findCharge(externalReference: string) {
    return this.charges.find((x) => x.externalReference === externalReference) ?? null;
  }

  async createCharge(input: CreateChargeInput) {
    centsToReais(input.amountCents);
    const id = `pay_mock_${randomUUID().slice(0, 8)}`;
    const charge: Charge = {
      id,
      status: "PENDING",
      invoiceUrl: `https://sandbox.asaas.com/i/${id}`,
      bankSlipUrl: input.billingType === "BOLETO" ? `https://sandbox.asaas.com/b/pdf/${id}` : null,
    };
    this.charges.push({ ...input, ...charge });
    return charge;
  }

  async getPixQrCode(chargeId: string) {
    return { payload: `00020126MOCKPIX${chargeId}`, encodedImage: "" };
  }

  async receiveInCash(chargeId: string, paymentDate: string, amountCents: number) {
    const charge = this.charges.find((c) => c.id === chargeId);
    if (!charge) throw new Error(`Asaas mock: charge ${chargeId} not found`);
    centsToReais(amountCents);
    Object.assign(charge, { status: "RECEIVED_IN_CASH", receivedInCashOn: paymentDate });
  }
}

// ---------- Webhook ----------

/** Events that mean money arrived (Pix/boleto received, card confirmed). */
export const PAID_EVENTS = new Set(["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"]);

export const asaasWebhookSchema = z.object({
  id: z.string(),
  event: z.string(),
  dateCreated: z.string().optional(),
  payment: z
    .object({
      id: z.string(),
      status: z.string(),
      value: z.number(),
      billingType: z.string().optional(),
      externalReference: z.string().nullish(),
      paymentDate: z.string().nullish(),
      clientPaymentDate: z.string().nullish(),
    })
    .optional(),
});

export type AsaasWebhookEvent = z.infer<typeof asaasWebhookSchema>;
