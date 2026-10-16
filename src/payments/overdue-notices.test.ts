import { describe, expect, it } from "vitest";
import { buttonPayload, CLINIC_ID, makeDeps, PATIENT } from "../../tests/support/fixtures.js";
import { handleWhatsAppEvent } from "../conversation/handler.js";
import { normalizeWebhook } from "../whatsapp/index.js";

const at = (iso: string) => new Date(iso);

/**
 * Maria approves a quote in 3 installments on Monday 19/10, 09:00 (São Paulo). The 1st is
 * due Thursday 22/10, the next ones on 22/11 and 22/12; all are charged in Asaas.
 */
async function setup() {
  const ctx = makeDeps();
  const { id } = await ctx.quotes.create(CLINIC_ID, {
    patientId: "patient_dev",
    dentistId: "dentist_dev",
    items: [{ procedureId: "proc_limpeza" }, { procedureId: "proc_resina", quantity: 2 }],
    installmentCount: 3,
  });
  await ctx.quotes.send(CLINIC_ID, id);
  const tap = async (replyId: string, title: string) => {
    const before = ctx.channel.outbox.length;
    for (const e of normalizeWebhook(buttonPayload(replyId, title)))
      await handleWhatsAppEvent(e, ctx.deps);
    return ctx.channel.outbox.slice(before);
  };
  await tap(`quote:${id}:accept`, "Aprovar");
  const installments = ctx.quoteRepo.quotes.find((q) => q.id === id)!.installments;
  const notices = () =>
    ctx.channel.outbox.filter((m) => "template" in m && m.template === "parcela_vencida");
  return { ...ctx, installments, notices, tap };
}

describe("overdue notices", () => {
  it("tells the patient once, the day after the due date, with the payment link", async () => {
    const { overdueNotices, installments, payments, notices } = await setup();
    expect(installments.map((i) => [i.dueDate, i.status])).toEqual([
      ["2026-10-22", "BILLED"],
      ["2026-11-22", "BILLED"],
      ["2026-12-22", "BILLED"],
    ]);
    expect(await overdueNotices.run(at("2026-10-22T15:00:00Z"))).toEqual({ sent: 0, skipped: 0 });

    expect(await overdueNotices.run(at("2026-10-23T12:00:00Z"))).toEqual({ sent: 1, skipped: 0 });
    const charge = payments.charges.find((c) => c.externalReference === installments[0]!.id)!;
    expect(notices()).toEqual([
      expect.objectContaining({
        to: PATIENT,
        params: [
          "Maria",
          "1/3",
          "Clínica Sorriso",
          expect.stringContaining("R$"),
          "22/10/2026",
          charge.invoiceUrl,
        ],
        buttonPayloads: ["handoff"],
      }),
    ]);
    expect(await overdueNotices.run(at("2026-10-24T12:00:00Z"))).toEqual({ sent: 0, skipped: 0 });
  });

  it("says nothing when Asaas already has the payment", async () => {
    const { overdueNotices, installments, payments, notices } = await setup();
    payments.charges.find((c) => c.externalReference === installments[0]!.id)!.status = "RECEIVED";
    expect(await overdueNotices.run(at("2026-10-23T12:00:00Z"))).toEqual({ sent: 0, skipped: 1 });
    expect(notices()).toEqual([]);
  });

  it("waits for daytime and for the front desk to leave the chat", async () => {
    const { overdueNotices, store, notices } = await setup();
    // Friday 23/10, 21:00 in São Paulo.
    expect(await overdueNotices.run(at("2026-10-24T00:00:00Z"))).toEqual({ sent: 0, skipped: 0 });
    const conv = await store.getOrCreateConversation(CLINIC_ID, PATIENT);
    await store.updateConversation(conv.id, { botPausedUntil: at("2026-10-23T13:00:00Z") });
    expect(await overdueNotices.run(at("2026-10-23T12:00:00Z"))).toEqual({ sent: 0, skipped: 0 });
    expect(await overdueNotices.run(at("2026-10-23T14:00:00Z"))).toEqual({ sent: 1, skipped: 0 });
    expect(notices()).toHaveLength(1);
  });

  it("leaves debts older than a month to the front desk and retries a failed send", async () => {
    const { overdueNotices, channel, notices } = await setup();
    // 23/11: the 1st installment is 32 days late, the 2nd one day.
    const send = channel.send.bind(channel);
    channel.send = async () => {
      throw new Error("network");
    };
    expect(await overdueNotices.run(at("2026-11-23T12:00:00Z"))).toEqual({ sent: 0, skipped: 0 });
    channel.send = send;
    expect(await overdueNotices.run(at("2026-11-24T12:00:00Z"))).toEqual({ sent: 1, skipped: 0 });
    expect(notices().map((m) => ("params" in m ? m.params?.[1] : null))).toEqual(["2/3"]);
  });

  it("'Falar com a recepção' calls the front desk", async () => {
    const { overdueNotices, store, tap } = await setup();
    await overdueNotices.run(at("2026-10-23T12:00:00Z"));
    await tap("handoff", "Falar com a recepção");
    const conv = await store.getOrCreateConversation(CLINIC_ID, PATIENT);
    expect(conv.botPausedUntil).not.toBeNull();
  });
});
