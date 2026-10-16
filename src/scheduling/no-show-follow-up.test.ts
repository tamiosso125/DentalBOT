import { describe, expect, it } from "vitest";
import { buttonPayload, CLINIC_ID, makeDeps, PATIENT } from "../../tests/support/fixtures.js";
import { handleWhatsAppEvent } from "../conversation/handler.js";
import { detectIntent } from "../conversation/intents.js";
import { MESSAGES } from "../conversation/messages.js";
import { normalizeWebhook, renderTemplate } from "../whatsapp/index.js";
import { noShowButtons } from "./no-show-follow-up.js";

const at = (iso: string) => new Date(iso);

/** Maria misses her Avaliação on Tuesday 20/10 at 14:00 (São Paulo); the front desk marks it. */
async function setup(opts: { attended?: boolean } = {}) {
  const ctx = makeDeps();
  const patient = await ctx.agenda.cadastrarPaciente({ name: "Maria Exemplo", phone: PATIENT });
  const book = async (day: string, hourUtc: string) => {
    const slots = await ctx.agenda.listarHorarios({
      procedureId: "proc_avaliacao",
      from: day,
      days: 1,
    });
    const slot = slots.find((s) => s.startsAt.toISOString() === `${day}T${hourUtc}:00:00.000Z`)!;
    return (await ctx.agenda.reservar({ patientId: patient.id, slot })).appointmentId;
  };
  const appointmentId = await book("2026-10-20", "17");
  ctx.clock.now = at("2026-10-20T18:00:00Z");
  await ctx.staffAgenda.attendance(CLINIC_ID, appointmentId, { attended: opts.attended ?? false });
  const notices = () =>
    ctx.channel.outbox.filter((m) => "template" in m && m.template === "consulta_perdida");
  return { ...ctx, appointmentId, book, notices };
}

describe("no-show follow-up", () => {
  it("sends the message once, the day after the missed appointment", async () => {
    const { noShowFollowUps, appointmentId, notices } = await setup();
    // Same day, 17h: too soon. Wednesday 8h: before the window.
    expect(await noShowFollowUps.run(at("2026-10-20T20:00:00Z"))).toEqual({ sent: 0 });
    expect(await noShowFollowUps.run(at("2026-10-21T11:00:00Z"))).toEqual({ sent: 0 });
    expect(await noShowFollowUps.run(at("2026-10-21T12:00:00Z"))).toEqual({ sent: 1 });
    expect(notices()).toEqual([
      expect.objectContaining({
        to: PATIENT,
        params: ["Maria", "terça-feira, 20/10 às 14:00", "Clínica Sorriso"],
        buttonPayloads: noShowButtons(appointmentId),
      }),
    ]);
    expect(
      renderTemplate("consulta_perdida", [
        "Maria",
        "terça-feira, 20/10 às 14:00",
        "Clínica Sorriso",
      ]),
    ).toContain("Sentimos sua falta");
    expect(await noShowFollowUps.run(at("2026-10-21T13:00:00Z"))).toEqual({ sent: 0 });
  });

  it("says nothing after an attended appointment, a late marking or a new booking", async () => {
    const attended = await setup({ attended: true });
    expect(await attended.noShowFollowUps.run(at("2026-10-21T12:00:00Z"))).toEqual({ sent: 0 });

    const late = await setup();
    // Saturday 24/10: 4 days later.
    expect(await late.noShowFollowUps.run(at("2026-10-24T12:00:00Z"))).toEqual({ sent: 0 });

    const rebooked = await setup();
    rebooked.clock.now = at("2026-10-20T19:00:00Z");
    await rebooked.book("2026-10-22", "17");
    expect(await rebooked.noShowFollowUps.run(at("2026-10-21T12:00:00Z"))).toEqual({ sent: 0 });
  });

  it("waits for the front desk to leave the chat and retries a failed send", async () => {
    const { noShowFollowUps, store, channel, notices } = await setup();
    const conv = await store.getOrCreateConversation(CLINIC_ID, PATIENT);
    await store.updateConversation(conv.id, { botPausedUntil: at("2026-10-21T13:00:00Z") });
    expect(await noShowFollowUps.run(at("2026-10-21T12:00:00Z"))).toEqual({ sent: 0 });
    const send = channel.send.bind(channel);
    channel.send = async () => {
      throw new Error("network");
    };
    expect(await noShowFollowUps.run(at("2026-10-21T14:00:00Z"))).toEqual({ sent: 0 });
    channel.send = send;
    expect(await noShowFollowUps.run(at("2026-10-21T15:00:00Z"))).toEqual({ sent: 1 });
    expect(notices()).toHaveLength(1);
  });

  it("'Marcar novo horário' goes to the front desk when the AI is off", async () => {
    const { noShowFollowUps, appointmentId, deps, channel, store, clock } = await setup();
    await noShowFollowUps.run(at("2026-10-21T12:00:00Z"));
    expect(detectIntent(undefined, `appt:${appointmentId}:rebook`)).toEqual({
      kind: "appointment_action",
      appointmentId,
      action: "rebook",
    });
    clock.now = at("2026-10-21T13:00:00Z");
    const before = channel.outbox.length;
    for (const e of normalizeWebhook(
      buttonPayload(`appt:${appointmentId}:rebook`, "Marcar novo horário"),
    ))
      await handleWhatsAppEvent(e, deps);
    const replies = channel.outbox.slice(before).map((m) => ("body" in m ? m.body : m.kind));
    expect(replies.at(-1)).toBe(MESSAGES.schedulingSoon);
    const conv = await store.getOrCreateConversation(CLINIC_ID, PATIENT);
    expect(conv.botPausedUntil).not.toBeNull();
  });
});
