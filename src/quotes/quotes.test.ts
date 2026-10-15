import { describe, expect, it } from "vitest";
import {
  buttonPayload,
  CLINIC_ID,
  makeDeps,
  OTHER_PATIENT,
  PATIENT,
} from "../../tests/support/fixtures.js";
import { handleWhatsAppEvent } from "../conversation/handler.js";
import { detectIntent } from "../conversation/intents.js";
import { CloudApiChannel, normalizeWebhook, toCloudApiBody } from "../whatsapp/index.js";
import { formatCents } from "../lib/money.js";
import { renderQuotePdf, splitInstallments } from "./quote-pdf.js";
import { silentLogger } from "../lib/logger.js";
import { QuoteBillingService } from "./quote-billing.js";
import { addMonths, QuoteValidationError } from "./quote-service.js";

const NEW_QUOTE = {
  patientId: "patient_dev",
  dentistId: "dentist_dev",
  items: [
    { procedureId: "proc_limpeza" },
    { procedureId: "proc_resina", quantity: 2 },
    { procedureId: "proc_avaliacao", coverage: "INSURANCE" as const },
  ],
  installmentCount: 3,
};

async function tap(ctx: ReturnType<typeof makeDeps>, replyId: string, from = PATIENT) {
  for (const e of normalizeWebhook(buttonPayload(replyId, "botão", from)))
    await handleWhatsAppEvent(e, ctx.deps);
}

/** Patient wrote recently, so the 24h window is open. */
async function openWindow(ctx: ReturnType<typeof makeDeps>, contact = PATIENT) {
  const conv = await ctx.store.getOrCreateConversation(CLINIC_ID, contact);
  await ctx.store.updateConversation(conv.id, {
    lastInboundAt: ctx.clock.now,
    privacyNoticeAt: ctx.clock.now,
  });
}

describe("splitInstallments", () => {
  it("puts the remainder on the first installment", () => {
    expect(splitInstallments(100_00, 3)).toEqual([33_34, 33_33, 33_33]);
    expect(splitInstallments(90_00, 3)).toEqual([30_00, 30_00, 30_00]);
    expect(splitInstallments(5_00, 1)).toEqual([5_00]);
  });
  it("rejects invalid counts", () => {
    expect(() => splitInstallments(100, 0)).toThrow();
  });
});

describe("addMonths", () => {
  it("clamps to the last day of the month", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-10-22", 2)).toBe("2026-12-22");
    expect(addMonths("2026-11-30", 3)).toBe("2027-02-28");
  });
});

describe("quote intents", () => {
  it("parses quote buttons and ignores anything else", () => {
    expect(detectIntent("Aprovar", "quote:quote_ab12:accept")).toEqual({
      kind: "quote_action",
      quoteId: "quote_ab12",
      action: "accept",
    });
    expect(detectIntent("x", "quote:abc:pay").kind).toBe("other");
    expect(detectIntent("quote:abc:accept").kind).toBe("other");
  });
});

describe("QuoteService.create", () => {
  it("prices items from the table and leaves insurance items out of the total", async () => {
    const ctx = makeDeps();
    const { id } = await ctx.quotes.create(CLINIC_ID, NEW_QUOTE);
    const q = (await ctx.quotes.get(CLINIC_ID, id))!;
    expect(q.status).toBe("DRAFT");
    expect(q.totalCents).toBe(250_00 + 2 * 350_00);
    expect(q.items.map((i) => i.unitPriceCents)).toEqual([250_00, 350_00, 0]);
    expect(q.validUntil).toBe("2026-11-03");
  });

  it("rejects unknown ids, missing prices and other clinics", async () => {
    const ctx = makeDeps();
    const bad = [
      { ...NEW_QUOTE, patientId: "nope" },
      { ...NEW_QUOTE, dentistId: "nope" },
      { ...NEW_QUOTE, items: [{ procedureId: "nope" }] },
      // Avaliação has no table price: the dentist must give one.
      { ...NEW_QUOTE, items: [{ procedureId: "proc_avaliacao" }] },
      { ...NEW_QUOTE, items: [] },
      { ...NEW_QUOTE, installmentCount: 13 },
      { ...NEW_QUOTE, extra: true },
    ];
    for (const input of bad)
      await expect(ctx.quotes.create(CLINIC_ID, input)).rejects.toBeInstanceOf(
        QuoteValidationError,
      );
    await expect(ctx.quotes.create("other_clinic", NEW_QUOTE)).rejects.toBeInstanceOf(
      QuoteValidationError,
    );
  });

  it("accepts a dentist price for items without a table price", async () => {
    const ctx = makeDeps();
    const { id } = await ctx.quotes.create(CLINIC_ID, {
      ...NEW_QUOTE,
      items: [{ description: "Coroa de porcelana", unitPriceCents: 1800_00 }],
      installmentCount: 1,
    });
    expect((await ctx.quotes.get(CLINIC_ID, id))!.totalCents).toBe(1800_00);
  });
});

describe("renderQuotePdf", () => {
  it("renders a complete PDF", async () => {
    const ctx = makeDeps();
    const { id } = await ctx.quotes.create(CLINIC_ID, {
      ...NEW_QUOTE,
      notes: "Retorno em 6 meses.",
    });
    const q = (await ctx.quotes.get(CLINIC_ID, id))!;
    const pdf = await renderQuotePdf(q, { compress: false });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.subarray(-6).toString()).toContain("%%EOF");
    expect(pdf.length).toBeGreaterThan(1000);
  });
});

describe("QuoteService.send", () => {
  it("inside the 24h window sends the PDF and the approve buttons", async () => {
    const ctx = makeDeps();
    await openWindow(ctx);
    const { id } = await ctx.quotes.create(CLINIC_ID, NEW_QUOTE);
    expect(await ctx.quotes.send(CLINIC_ID, id)).toEqual({ via: "session" });
    const [doc, buttons] = ctx.channel.outbox;
    expect(doc).toMatchObject({ kind: "document", to: PATIENT, mimeType: "application/pdf" });
    expect(buttons).toMatchObject({ kind: "buttons", to: PATIENT });
    if (buttons?.kind !== "buttons") throw new Error("expected buttons");
    expect(buttons.body).toContain(formatCents(950_00));
    expect(buttons.body).toContain("3x");
    expect(buttons.buttons.map((b) => b.id)).toEqual([
      `quote:${id}:accept`,
      `quote:${id}:reject`,
      "handoff",
    ]);
    expect((await ctx.quotes.get(CLINIC_ID, id))!.status).toBe("SENT");
  });

  it("outside the window uses the approved template", async () => {
    const ctx = makeDeps();
    const { id } = await ctx.quotes.create(CLINIC_ID, NEW_QUOTE);
    expect(await ctx.quotes.send(CLINIC_ID, id)).toEqual({ via: "template" });
    expect(ctx.channel.outbox).toHaveLength(1);
    expect(ctx.channel.outbox[0]).toMatchObject({
      kind: "template",
      template: "orcamento_disponivel",
      params: ["Maria", "Clínica Sorriso", formatCents(950_00)],
      buttonPayloads: [`quote:${id}:view`, "handoff"],
    });
  });

  it("refuses to resend an answered quote", async () => {
    const ctx = makeDeps();
    await openWindow(ctx);
    const { id } = await ctx.quotes.create(CLINIC_ID, NEW_QUOTE);
    await ctx.quotes.send(CLINIC_ID, id);
    await tap(ctx, `quote:${id}:reject`);
    await expect(ctx.quotes.send(CLINIC_ID, id)).rejects.toBeInstanceOf(QuoteValidationError);
  });
});

describe("quote buttons in the conversation", () => {
  async function sentQuote(ctx: ReturnType<typeof makeDeps>, input = NEW_QUOTE) {
    const { id } = await ctx.quotes.create(CLINIC_ID, input);
    await ctx.quotes.send(CLINIC_ID, id);
    ctx.channel.clear();
    return id;
  }

  it("'Ver orçamento' from the template sends the PDF", async () => {
    const ctx = makeDeps();
    const id = await sentQuote(ctx);
    await tap(ctx, `quote:${id}:view`);
    expect(ctx.channel.outbox.map((m) => m.kind)).toEqual(["text", "document", "buttons"]);
  });

  it("accepting records the installments, bills them in Asaas and sends the first link", async () => {
    const ctx = makeDeps();
    const id = await sentQuote(ctx);
    await tap(ctx, `quote:${id}:accept`);
    const stored = ctx.quoteRepo.quotes.find((q) => q.id === id)!;
    expect(stored.status).toBe("ACCEPTED");
    expect(
      stored.installments.map(({ number, amountCents, dueDate }) => ({
        number,
        amountCents,
        dueDate,
      })),
    ).toEqual([
      { number: 1, amountCents: 316_68, dueDate: "2026-10-22" },
      { number: 2, amountCents: 316_66, dueDate: "2026-11-22" },
      { number: 3, amountCents: 316_66, dueDate: "2026-12-22" },
    ]);

    // One Asaas customer (by CPF) and one charge per installment, no procedure names.
    expect(ctx.payments.customers).toMatchObject([
      { cpfCnpj: "52998224725", externalReference: "patient_dev" },
    ]);
    expect(ctx.payments.charges.map((c) => [c.amountCents, c.dueDate, c.billingType])).toEqual([
      [316_68, "2026-10-22", "UNDEFINED"],
      [316_66, "2026-11-22", "UNDEFINED"],
      [316_66, "2026-12-22", "UNDEFINED"],
    ]);
    expect(ctx.payments.charges[0]!.description).toBe("Parcela 1/3 - Clínica Sorriso");
    expect(stored.installments.every((i) => i.status === "BILLED" && i.asaasPaymentId)).toBe(true);

    const last = ctx.channel.outbox.at(-1)!;
    expect(last.kind === "text" && last.body).toContain(ctx.payments.charges[0]!.invoiceUrl);
    expect(last.kind === "text" && last.body).toContain("22/10/2026");
    // Billed automatically: the bot stays on, no handoff.
    const conv = await ctx.store.getOrCreateConversation(CLINIC_ID, PATIENT);
    expect(conv.botPausedUntil).toBeNull();
  });

  it("without a CPF on file the front desk takes over the billing", async () => {
    const ctx = makeDeps();
    const id = await sentQuote(ctx, { ...NEW_QUOTE, patientId: "patient_other" });
    await tap(ctx, `quote:${id}:accept`, OTHER_PATIENT);
    expect(ctx.payments.charges).toEqual([]);
    const last = ctx.channel.outbox.at(-1)!;
    expect(last.kind === "text" && last.body).toContain("CPF");
    const conv = await ctx.store.getOrCreateConversation(CLINIC_ID, OTHER_PATIENT);
    expect(conv.botPausedUntil).not.toBeNull();
  });

  it("if Asaas fails the approval stays and the front desk is called", async () => {
    const ctx = makeDeps();
    const id = await sentQuote(ctx);
    ctx.payments.createCharge = async () => {
      throw new Error("Asaas POST /payments failed: HTTP 503 (?)");
    };
    await tap(ctx, `quote:${id}:accept`);
    expect(ctx.quoteRepo.quotes.find((q) => q.id === id)!.status).toBe("ACCEPTED");
    const last = ctx.channel.outbox.at(-1)!;
    expect(last.kind === "text" && last.body).toContain("recepção vai te mandar a cobrança");
    const conv = await ctx.store.getOrCreateConversation(CLINIC_ID, PATIENT);
    expect(conv.botPausedUntil).not.toBeNull();
  });

  it("billing again after a crash reuses the Asaas customer and charges", async () => {
    const ctx = makeDeps();
    const id = await sentQuote(ctx);
    await tap(ctx, `quote:${id}:accept`);
    const billing = new QuoteBillingService({
      repo: ctx.quoteRepo,
      gateway: ctx.payments,
      logger: silentLogger,
    });
    // As if the process died after Asaas created the charges but before we saved them.
    const stored = ctx.quoteRepo.quotes.find((q) => q.id === id)!;
    for (const i of stored.installments)
      Object.assign(i, { status: "PENDING", asaasPaymentId: null });
    const again = await billing.bill(CLINIC_ID, id);
    expect(again.status).toBe("billed");
    expect(ctx.payments.customers).toHaveLength(1);
    expect(ctx.payments.charges).toHaveLength(3);
    expect(stored.installments.map((i) => i.asaasPaymentId)).toEqual(
      ctx.payments.charges.map((c) => c.id),
    );
  });

  it("a quote fully covered by insurance has nothing to bill", async () => {
    const ctx = makeDeps();
    const id = await sentQuote(ctx, {
      ...NEW_QUOTE,
      items: [{ procedureId: "proc_avaliacao", coverage: "INSURANCE" as const }],
      installmentCount: 1,
    } as typeof NEW_QUOTE);
    await tap(ctx, `quote:${id}:accept`);
    expect(ctx.payments.charges).toEqual([]);
    const last = ctx.channel.outbox.at(-1)!;
    expect(last.kind === "text" && last.body).toContain("Não há valor particular");
  });

  it("a second tap does not answer twice", async () => {
    const ctx = makeDeps();
    const id = await sentQuote(ctx);
    await tap(ctx, `quote:${id}:reject`);
    await tap(ctx, `quote:${id}:accept`);
    const stored = ctx.quoteRepo.quotes.find((q) => q.id === id)!;
    expect(stored.status).toBe("REJECTED");
    expect(stored.installments).toEqual([]);
    const last = ctx.channel.outbox.at(-1);
    expect(last?.kind === "text" && last.body).toContain("não aprovado");
  });

  it("another patient cannot see or answer the quote", async () => {
    const ctx = makeDeps();
    const id = await sentQuote(ctx);
    await tap(ctx, `quote:${id}:accept`, OTHER_PATIENT);
    expect(ctx.quoteRepo.quotes.find((q) => q.id === id)!.status).toBe("SENT");
    expect(ctx.channel.outbox.some((m) => m.kind === "document")).toBe(false);
  });

  it("an expired quote cannot be accepted", async () => {
    const ctx = makeDeps();
    const id = await sentQuote(ctx, { ...NEW_QUOTE, validDays: 1 } as typeof NEW_QUOTE);
    ctx.clock.now = new Date("2026-10-22T12:00:00Z");
    await tap(ctx, `quote:${id}:accept`);
    expect(ctx.quoteRepo.quotes.find((q) => q.id === id)!.status).toBe("EXPIRED");
  });

  it("is recorded even while the front desk handles the chat", async () => {
    const ctx = makeDeps();
    const id = await sentQuote(ctx);
    const conv = await ctx.store.getOrCreateConversation(CLINIC_ID, PATIENT);
    await ctx.store.updateConversation(conv.id, {
      botPausedUntil: new Date(ctx.clock.now.getTime() + 3_600_000),
    });
    await tap(ctx, `quote:${id}:accept`);
    expect(ctx.quoteRepo.quotes.find((q) => q.id === id)!.status).toBe("ACCEPTED");
  });
});

describe("Cloud API bodies", () => {
  it("sends documents by media id and template buttons with payloads", () => {
    const doc = toCloudApiBody(
      {
        kind: "document",
        to: PATIENT,
        filename: "orcamento.pdf",
        mimeType: "application/pdf",
        data: Buffer.from("%PDF-"),
        caption: "Orçamento",
      },
      "media_123",
    );
    expect(doc).toMatchObject({
      type: "document",
      document: { id: "media_123", filename: "orcamento.pdf", caption: "Orçamento" },
    });

    const tpl = toCloudApiBody({
      kind: "template",
      to: PATIENT,
      template: "orcamento_disponivel",
      params: ["Maria", "Clínica Sorriso", "R$ 950,00"],
      buttonPayloads: ["quote:q1:view", "handoff"],
    }) as { template: { components: Array<Record<string, unknown>> } };
    expect(tpl.template.components.slice(1)).toEqual([
      {
        type: "button",
        sub_type: "quick_reply",
        index: "0",
        parameters: [{ type: "payload", payload: "quote:q1:view" }],
      },
      {
        type: "button",
        sub_type: "quick_reply",
        index: "1",
        parameters: [{ type: "payload", payload: "handoff" }],
      },
    ]);
  });

  it("uploads the PDF to /media before sending it", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body });
      const json = url.endsWith("/media") ? { id: "media_9" } : { messages: [{ id: "wamid.1" }] };
      return new Response(JSON.stringify(json), { status: 200 });
    }) as unknown as typeof fetch;
    const channel = new CloudApiChannel({
      accessToken: "token",
      phoneNumberId: "100000000000001",
      graphApiVersion: "v23.0",
      fetchImpl,
    });
    await channel.send({
      kind: "document",
      to: PATIENT,
      filename: "orcamento.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("%PDF-"),
    });
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["media", "messages"]);
    expect(calls[0]!.body).toBeInstanceOf(FormData);
    expect(JSON.parse(calls[1]!.body as string)).toMatchObject({ document: { id: "media_9" } });
  });
});
