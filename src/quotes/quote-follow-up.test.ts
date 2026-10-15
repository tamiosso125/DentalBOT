import { describe, expect, it } from "vitest";
import { buttonPayload, CLINIC_ID, makeDeps, PATIENT } from "../../tests/support/fixtures.js";
import { handleWhatsAppEvent } from "../conversation/handler.js";
import { normalizeWebhook } from "../whatsapp/index.js";

const DAY = 86_400_000;
const later = (from: Date, ms: number) => new Date(from.getTime() + ms);

/** A quote sent Monday 19/10 09:00 (outside the 24h window, so by template), valid 15 days. */
async function setup(validDays = 15) {
  const ctx = makeDeps();
  const { id } = await ctx.quotes.create(CLINIC_ID, {
    patientId: "patient_dev",
    dentistId: "dentist_dev",
    items: [{ procedureId: "proc_limpeza" }],
    validDays,
  });
  await ctx.quotes.send(CLINIC_ID, id);
  const quote = () => ctx.quoteRepo.quotes.find((q) => q.id === id)!;
  const tap = async (replyId: string, title: string) => {
    const before = ctx.channel.outbox.length;
    for (const e of normalizeWebhook(buttonPayload(replyId, title)))
      await handleWhatsAppEvent(e, ctx.deps);
    return ctx.channel.outbox.slice(before);
  };
  return { ...ctx, id, quote, tap };
}

describe("quote follow-ups", () => {
  it("reminds once, three days after sending, and the button brings the quote back", async () => {
    const { quoteFollowUps, channel, clock, id, quote, tap } = await setup();
    expect(await quoteFollowUps.run(later(clock.now, 2 * DAY))).toEqual({
      reminded: 0,
      expired: 0,
    });

    clock.now = later(clock.now, 3 * DAY);
    expect(await quoteFollowUps.run(clock.now)).toEqual({ reminded: 1, expired: 0 });
    expect(channel.outbox.at(-1)).toMatchObject({
      to: PATIENT,
      template: "lembrete_orcamento",
      params: ["Maria", "Clínica Sorriso", expect.stringContaining("R$"), "03/11/2026"],
      buttonPayloads: [`quote:${id}:view`, "handoff"],
    });
    expect(await quoteFollowUps.run(later(clock.now, DAY))).toEqual({ reminded: 0, expired: 0 });

    const sent = await tap(`quote:${id}:view`, "Ver orçamento");
    expect(sent.map((m) => m.kind)).toContain("document");
    await tap(`quote:${id}:accept`, "Aprovar");
    expect(quote().status).toBe("ACCEPTED");
  });

  it("waits for daytime and for the front desk to finish talking to the patient", async () => {
    const { quoteFollowUps, store, clock } = await setup();
    // Thursday 22/10, 22:00 in São Paulo.
    expect(await quoteFollowUps.run(new Date("2026-10-23T01:00:00Z"))).toEqual({
      reminded: 0,
      expired: 0,
    });

    clock.now = later(clock.now, 3 * DAY);
    const conv = await store.getOrCreateConversation(CLINIC_ID, PATIENT);
    await store.updateConversation(conv.id, { botPausedUntil: later(clock.now, 3600_000) });
    expect(await quoteFollowUps.run(clock.now)).toEqual({ reminded: 0, expired: 0 });
    expect(await quoteFollowUps.run(later(clock.now, 2 * 3600_000))).toEqual({
      reminded: 1,
      expired: 0,
    });
  });

  it("does not remind about a quote the patient already answered", async () => {
    const { quoteFollowUps, clock, id, tap } = await setup();
    await tap(`quote:${id}:reject`, "Não aprovar");
    expect(await quoteFollowUps.run(later(clock.now, 3 * DAY))).toEqual({
      reminded: 0,
      expired: 0,
    });
  });

  it("says 'hoje' on the last day and expires the quote the day after", async () => {
    const { quoteFollowUps, channel, clock, quote } = await setup(3);
    // Thursday 22/10, the last valid day.
    clock.now = later(clock.now, 3 * DAY);
    await quoteFollowUps.run(clock.now);
    expect(channel.outbox.at(-1)).toMatchObject({
      template: "lembrete_orcamento",
      params: [expect.any(String), expect.any(String), expect.any(String), "hoje"],
    });

    expect(await quoteFollowUps.run(later(clock.now, 12 * 3600_000))).toEqual({
      reminded: 0,
      expired: 0,
    });
    clock.now = later(clock.now, DAY);
    expect(await quoteFollowUps.run(clock.now)).toEqual({ reminded: 0, expired: 1 });
    expect(quote()).toMatchObject({ status: "EXPIRED", respondedAt: clock.now });
  });

  it("never reminds about an expired quote and retries a failed send", async () => {
    const { quoteFollowUps, channel, clock, quote } = await setup(2);
    // Sent but never reminded (the job was off); validity is over when it runs.
    expect(await quoteFollowUps.run(later(clock.now, 4 * DAY))).toEqual({
      reminded: 0,
      expired: 1,
    });
    expect(quote().status).toBe("EXPIRED");

    const other = await setup();
    const send = other.channel.send.bind(other.channel);
    other.channel.send = async () => {
      throw new Error("network");
    };
    other.clock.now = later(other.clock.now, 3 * DAY);
    expect(await other.quoteFollowUps.run(other.clock.now)).toEqual({ reminded: 0, expired: 0 });
    other.channel.send = send;
    expect(await other.quoteFollowUps.run(other.clock.now)).toEqual({ reminded: 1, expired: 0 });
    expect(
      channel.outbox.filter((m) => "template" in m && m.template === "lembrete_orcamento"),
    ).toEqual([]);
  });
});
