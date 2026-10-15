import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "../lib/logger.js";
import { AsaasHttpGateway, centsToReais, MockPaymentsGateway } from "./asaas.js";
import { handleAsaasEvent, InMemoryPaymentEventStore } from "./payment-events.js";

describe("Asaas gateway", () => {
  it("converts cents to reais and rejects invalid amounts", () => {
    expect(centsToReais(15050)).toBe(150.5);
    expect(() => centsToReais(0)).toThrow();
    expect(() => centsToReais(10.5)).toThrow();
  });

  it("sends the API key header and decimal values", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ id: "pay_1", status: "PENDING", invoiceUrl: "u" }),
    );
    const gw = new AsaasHttpGateway("key_test", "https://api-sandbox.asaas.com/v3", fetchImpl);
    await gw.createCharge({
      customerId: "cus_1",
      billingType: "PIX",
      amountCents: 20000,
      dueDate: "2026-10-30",
      description: "Parcela 1/3",
      externalReference: "inst_1",
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api-sandbox.asaas.com/v3/payments");
    expect((init.headers as Record<string, string>).access_token).toBe("key_test");
    expect(JSON.parse(init.body as string).value).toBe(200);
  });

  it("mock gateway works without an account", async () => {
    const gw = new MockPaymentsGateway();
    const { id } = await gw.createCustomer({
      name: "Teste",
      cpfCnpj: "00000000000",
      externalReference: "p1",
    });
    const charge = await gw.createCharge({
      customerId: id,
      billingType: "BOLETO",
      amountCents: 5000,
      dueDate: "2026-10-30",
      description: "Teste",
      externalReference: "i1",
    });
    expect(charge.bankSlipUrl).toContain(charge.id);
  });
});

describe("handleAsaasEvent", () => {
  it("marks the installment paid once", async () => {
    const store = new InMemoryPaymentEventStore();
    store.installments.set("pay_1", { status: "BILLED" });
    const evt = {
      id: "evt_1",
      event: "PAYMENT_RECEIVED",
      payment: { id: "pay_1", status: "RECEIVED", value: 100, paymentDate: "2026-10-20" },
    };
    await handleAsaasEvent(evt, { store, logger: silentLogger });
    await handleAsaasEvent({ ...evt, event: "PAYMENT_OVERDUE" }, { store, logger: silentLogger });
    expect(store.installments.get("pay_1")!.status).toBe("PAID");
  });

  it("does not mark paid installments as overdue", async () => {
    const store = new InMemoryPaymentEventStore();
    store.installments.set("pay_2", { status: "PAID" });
    await handleAsaasEvent(
      {
        id: "evt_2",
        event: "PAYMENT_OVERDUE",
        payment: { id: "pay_2", status: "OVERDUE", value: 1 },
      },
      { store, logger: silentLogger },
    );
    expect(store.installments.get("pay_2")!.status).toBe("PAID");
  });
});
