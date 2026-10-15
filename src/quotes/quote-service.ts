import { z } from "zod";
import type { QuoteAction } from "../conversation/intents.js";
import { MESSAGES } from "../conversation/messages.js";
import type { ConversationRecord, ConversationStore } from "../conversation/store.js";
import type { Logger } from "../lib/logger.js";
import { formatCents } from "../lib/money.js";
import { addDays, dateInZone } from "../scheduling/time.js";
import { previewText, type OutboundMessage, type WhatsAppChannel } from "../whatsapp/index.js";
import { quoteSummary, renderQuotePdf, splitInstallments } from "./quote-pdf.js";
import type { NewInstallment, QuoteRepository, QuoteView } from "./quote-repository.js";

/** What the dentist (later, the panel) sends to create a quote. */
export const newQuoteSchema = z.strictObject({
  patientId: z.string().min(1),
  dentistId: z.string().min(1),
  items: z
    .array(
      z
        .strictObject({
          procedureId: z.string().min(1).optional(),
          description: z.string().min(2).max(120).optional(),
          quantity: z.number().int().min(1).max(32).default(1),
          /** Cents. Omit to use the procedure's table price. */
          unitPriceCents: z.number().int().min(0).max(10_000_000).optional(),
          coverage: z.enum(["PRIVATE", "INSURANCE"]).default("PRIVATE"),
        })
        .refine((i) => i.procedureId || i.description, "item needs procedureId or description"),
    )
    .min(1)
    .max(30),
  installmentCount: z.number().int().min(1).max(12).default(1),
  notes: z.string().max(500).optional(),
  validDays: z.number().int().min(1).max(90).default(15),
});
export type NewQuoteInput = z.input<typeof newQuoteSchema>;

export class QuoteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteValidationError";
  }
}

export type QuoteDeps = {
  repo: QuoteRepository;
  channel: WhatsAppChannel;
  store: ConversationStore;
  logger: Logger;
  now?: () => Date;
};

const WINDOW_MS = 24 * 60 * 60_000;
/** First installment is due a few days after the patient approves. */
const FIRST_DUE_IN_DAYS = 3;

/**
 * Quotes: the dentist builds one, the bot sends the PDF on WhatsApp and records the
 * patient's answer. Prices come from the clinic's table or from the dentist, never from
 * the model.
 */
export class QuoteService {
  private readonly now: () => Date;

  constructor(private readonly deps: QuoteDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async create(clinicId: string, raw: unknown): Promise<{ id: string }> {
    const parsed = newQuoteSchema.safeParse(raw);
    if (!parsed.success)
      throw new QuoteValidationError(parsed.error.issues.map((i) => i.message).join("; "));
    const input = parsed.data;
    const { repo } = this.deps;

    if (!(await repo.dentistExists(clinicId, input.dentistId)))
      throw new QuoteValidationError("dentist not found in this clinic");
    if (!(await repo.patientContact(clinicId, input.patientId)))
      throw new QuoteValidationError("patient not found in this clinic");

    const procedures = await repo.procedures(clinicId);
    const items = input.items.map((i) => {
      const proc = i.procedureId ? procedures.find((p) => p.id === i.procedureId) : undefined;
      if (i.procedureId && !proc)
        throw new QuoteValidationError("procedure not found in this clinic");
      const unit = i.coverage === "INSURANCE" ? 0 : (i.unitPriceCents ?? proc?.priceCents ?? null);
      if (unit === null)
        throw new QuoteValidationError(
          `price required for ${proc?.name ?? "item"} (no table price)`,
        );
      return {
        procedureId: proc?.id ?? null,
        description: i.description ?? proc!.name,
        quantity: i.quantity,
        unitPriceCents: unit,
        coverage: i.coverage,
      };
    });
    const totalCents = items
      .filter((i) => i.coverage === "PRIVATE")
      .reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0);
    if (input.installmentCount > 1 && totalCents < input.installmentCount * 100)
      throw new QuoteValidationError("installments below R$ 1,00 each");

    const today = new Date(this.now()).toISOString().slice(0, 10);
    const id = await repo.create({
      clinicId,
      patientId: input.patientId,
      dentistId: input.dentistId,
      items,
      totalCents,
      installmentCount: input.installmentCount,
      notes: input.notes ?? null,
      validUntil: addDays(today, input.validDays),
    });
    this.deps.logger.info({ quoteId: id, items: items.length }, "quote created");
    return { id };
  }

  get(clinicId: string, quoteId: string) {
    return this.deps.repo.get(clinicId, quoteId);
  }

  async pdf(clinicId: string, quoteId: string): Promise<Buffer | null> {
    const q = await this.deps.repo.get(clinicId, quoteId);
    return q ? renderQuotePdf(q) : null;
  }

  /**
   * Sends the quote to the patient. Inside the 24h window: PDF + approve buttons.
   * Outside it, WhatsApp only allows the approved template; its "Ver orçamento" button
   * brings the patient back and the PDF goes out then.
   */
  async send(clinicId: string, quoteId: string): Promise<{ via: "session" | "template" }> {
    const q = await this.deps.repo.get(clinicId, quoteId);
    if (!q) throw new QuoteValidationError("quote not found");
    if (q.status !== "DRAFT" && q.status !== "SENT")
      throw new QuoteValidationError(`quote already ${q.status.toLowerCase()}`);
    const contact = await this.deps.repo.patientContact(clinicId, q.patientId);
    if (!contact) throw new QuoteValidationError("patient not found in this clinic");

    const conv = await this.deps.store.getOrCreateConversation(clinicId, contact.phone);
    const now = this.now();
    const inWindow =
      conv.lastInboundAt !== null && now.getTime() - conv.lastInboundAt.getTime() < WINDOW_MS;

    if (inWindow) {
      for (const m of await this.quoteMessages(q, conv.contact)) await this.sendAndStore(conv, m);
    } else {
      await this.sendAndStore(conv, {
        kind: "template",
        to: conv.contact,
        template: "orcamento_disponivel",
        params: [firstName(q.patientName), q.clinicName, formatCents(q.totalCents)],
        buttonPayloads: [`quote:${q.id}:view`, "handoff"],
      });
    }
    await this.deps.repo.markSent(clinicId, quoteId, now);
    this.deps.logger.info({ quoteId, via: inWindow ? "session" : "template" }, "quote sent");
    return { via: inWindow ? "session" : "template" };
  }

  /**
   * A patient tapped a quote button. Only the quote's own patient can see or answer it;
   * anyone else gets "not found" (we do not reveal that the quote exists).
   */
  async handleAction(
    conv: ConversationRecord,
    quoteId: string,
    action: QuoteAction,
  ): Promise<{ messages: OutboundMessage[]; handoff?: string }> {
    const to = conv.contact;
    const q = await this.deps.repo.get(conv.clinicId, quoteId);
    const owner = q ? await this.deps.repo.patientContact(conv.clinicId, q.patientId) : null;
    if (!q || owner?.phone !== conv.contact) {
      this.deps.logger.warn({ conversationId: conv.id }, "quote action for a quote not owned");
      return { messages: [text(to, MESSAGES.quoteNotFound)], handoff: "quote:not_found" };
    }

    if (q.status !== "SENT") {
      const label =
        q.status === "ACCEPTED" ? "aprovado" : q.status === "REJECTED" ? "não aprovado" : "vencido";
      return q.status === "DRAFT"
        ? { messages: [text(to, MESSAGES.quoteNotFound)], handoff: "quote:draft" }
        : { messages: [text(to, MESSAGES.quoteAlreadyAnswered(label))] };
    }

    if (action === "view") return { messages: await this.quoteMessages(q, to) };

    const now = this.now();
    const today = dateInZone(now, q.clinicTimeZone);
    if (q.validUntil && today > q.validUntil) {
      await this.deps.repo.respond(conv.clinicId, q.id, "EXPIRED", now, []);
      return {
        messages: [text(to, MESSAGES.quoteExpired(quoteSummary(q).validUntil!))],
        handoff: "quote:expired",
      };
    }

    const status = action === "accept" ? "ACCEPTED" : "REJECTED";
    const installments = action === "accept" ? installmentPlan(q, today) : [];
    if (!(await this.deps.repo.respond(conv.clinicId, q.id, status, now, installments)))
      return {
        messages: [
          text(
            to,
            MESSAGES.quoteAlreadyAnswered(action === "accept" ? "aprovado" : "não aprovado"),
          ),
        ],
      };

    this.deps.logger.info({ quoteId: q.id, status }, "quote answered");
    return action === "accept"
      ? // The front desk takes over to send the charge (Asaas) until billing is automated.
        { messages: [text(to, MESSAGES.quoteAccepted)], handoff: "quote:accepted" }
      : { messages: [text(to, MESSAGES.quoteRejected)] };
  }

  private async quoteMessages(q: QuoteView, to: string): Promise<OutboundMessage[]> {
    const s = quoteSummary(q);
    return [
      {
        kind: "document",
        to,
        filename: `orcamento-${q.id}.pdf`,
        mimeType: "application/pdf",
        data: await renderQuotePdf(q),
        caption: `Orçamento ${q.clinicName}`,
      },
      {
        kind: "buttons",
        to,
        body: MESSAGES.quoteIntro(firstName(q.patientName), s.total, s.plan, s.validUntil),
        buttons: MESSAGES.quoteButtons(q.id),
      },
    ];
  }

  private async sendAndStore(conv: ConversationRecord, msg: OutboundMessage) {
    const { waMessageId } = await this.deps.channel.send(msg);
    await this.deps.store.saveMessage({
      conversationId: conv.id,
      waMessageId,
      direction: "OUTBOUND",
      type: msg.kind,
      body: previewText(msg),
      at: this.now(),
    });
  }
}

const text = (to: string, body: string): OutboundMessage => ({ kind: "text", to, body });
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** Monthly installments of the private total; first due a few days after approval. */
export function installmentPlan(q: QuoteView, today: string): NewInstallment[] {
  if (q.totalCents === 0) return [];
  const first = addDays(today, FIRST_DUE_IN_DAYS);
  return splitInstallments(q.totalCents, q.installmentCount).map((amountCents, i) => ({
    number: i + 1,
    amountCents,
    dueDate: addMonths(first, i),
  }));
}

/** Same day next months, clamped to the month's last day (31/01 -> 28/02). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}
