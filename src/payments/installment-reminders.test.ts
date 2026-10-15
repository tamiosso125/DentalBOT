import { describe, expect, it } from "vitest";
import { CLINIC_ID, makeDeps, PATIENT } from "../../tests/support/fixtures.js";
import { silentLogger } from "../lib/logger.js";
import { MockPaymentsGateway } from "./asaas.js";
import { InMemoryReminderRepository, InstallmentReminders } from "./installment-reminders.js";

/** 2nd installment of 3, due Thursday 22/10. Clock starts Monday 19/10, 09:00 in São Paulo. */
async function setup() {
  const ctx = makeDeps();
  const gateway = new MockPaymentsGateway();
  const charge = await gateway.createCharge({
    customerId: "cus_1",
    billingType: "UNDEFINED",
    amountCents: 316_66,
    dueDate: "2026-10-22",
    description: "Parcela 2/3 - Clínica Sorriso",
    externalReference: "inst_2",
  });
  const repo = new InMemoryReminderRepository();
  const row = {
    installmentId: "inst_2",
    clinicId: CLINIC_ID,
    clinicTimeZone: "America/Sao_Paulo",
    patientName: "Maria Exemplo",
    phone: PATIENT,
    number: 2,
    installmentCount: 3,
    amountCents: 316_66,
    dueDate: "2026-10-22",
    status: "BILLED",
    reminderSentAt: null as Date | null,
  };
  repo.rows.push(row);
  const reminders = new InstallmentReminders({
    repo,
    gateway,
    channel: ctx.channel,
    store: ctx.store,
    logger: silentLogger,
  });
  return { ctx, gateway, charge, repo, row, reminders };
}

const at = (iso: string) => new Date(iso);

describe("InstallmentReminders", () => {
  it("sends the payment link by template 3 days before, only once", async () => {
    const { ctx, charge, reminders, row } = await setup();
    expect(await reminders.run(at("2026-10-19T12:00:00Z"))).toEqual({ sent: 1, skipped: 0 });
    expect(ctx.channel.outbox).toMatchObject([
      {
        kind: "template",
        to: PATIENT,
        template: "cobranca_parcela",
        params: [
          "Maria",
          "2/3",
          expect.stringContaining("316,66"),
          "22/10/2026",
          charge.invoiceUrl,
        ],
      },
    ]);
    expect(row.reminderSentAt).not.toBeNull();
    // The message is stored in the conversation, like every outbound message.
    const conv = await ctx.store.getOrCreateConversation(CLINIC_ID, PATIENT);
    expect(ctx.store.messages.filter((m) => m.conversationId === conv.id)).toHaveLength(1);

    await reminders.run(at("2026-10-20T12:00:00Z"));
    expect(ctx.channel.outbox).toHaveLength(1);
  });

  it("waits for the window and for business hours in the clinic's time zone", async () => {
    const { ctx, reminders } = await setup();
    await reminders.run(at("2026-10-18T15:00:00Z")); // 4 days before
    await reminders.run(at("2026-10-19T10:00:00Z")); // 07:00 in São Paulo
    await reminders.run(at("2026-10-19T23:00:00Z")); // 20:00 in São Paulo
    expect(ctx.channel.outbox).toEqual([]);
    await reminders.run(at("2026-10-22T13:00:00Z")); // due day, 10:00: still reminds
    expect(ctx.channel.outbox).toHaveLength(1);
  });

  it("does not remind an installment already paid in Asaas", async () => {
    const { ctx, gateway, reminders, row } = await setup();
    gateway.charges[0]!.status = "RECEIVED";
    expect(await reminders.run(at("2026-10-19T12:00:00Z"))).toEqual({ sent: 0, skipped: 1 });
    expect(ctx.channel.outbox).toEqual([]);
    expect(row.reminderSentAt).not.toBeNull();
  });

  it("retries on the next run when sending fails", async () => {
    const { ctx, reminders, row } = await setup();
    const send = ctx.channel.send.bind(ctx.channel);
    ctx.channel.send = async () => {
      throw new Error("WhatsApp 500");
    };
    expect(await reminders.run(at("2026-10-19T12:00:00Z"))).toEqual({ sent: 0, skipped: 0 });
    expect(row.reminderSentAt).toBeNull();
    ctx.channel.send = send;
    expect((await reminders.run(at("2026-10-19T13:00:00Z"))).sent).toBe(1);
  });

  it("leaves the first installment and unbilled ones alone", async () => {
    const { ctx, reminders, row } = await setup();
    row.number = 1;
    await reminders.run(at("2026-10-19T12:00:00Z"));
    row.number = 2;
    row.status = "PENDING";
    await reminders.run(at("2026-10-19T12:00:00Z"));
    expect(ctx.channel.outbox).toEqual([]);
  });
});
