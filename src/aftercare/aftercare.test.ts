import { describe, expect, it } from "vitest";
import {
  buttonPayload,
  CLINIC_ID,
  EXTRACTION_CARE,
  makeDeps,
  OTHER_PATIENT,
  PATIENT,
  textPayload,
} from "../../tests/support/fixtures.js";
import { handleWhatsAppEvent } from "../conversation/handler.js";
import { detectIntent } from "../conversation/intents.js";
import { MESSAGES } from "../conversation/messages.js";
import { normalizeWebhook, renderTemplate } from "../whatsapp/index.js";
import { AFTERCARE_MESSAGES, aftercareButtons, oneLine } from "./aftercare.js";

const at = (iso: string) => new Date(iso);
const CARE_ONE_LINE =
  "Morda a gaze por 30 minutos. Nas primeiras 24 horas, não cuspa nem faça bochecho. Prefira alimentos frios e pastosos.";

/**
 * Maria's appointment on Tuesday 20/10 at 14:00 (São Paulo), an extraction unless
 * `procedureId` says otherwise. The front desk marks attendance half an hour after the end.
 */
async function setup(opts: { procedureId?: string; attended?: boolean } = {}) {
  const ctx = makeDeps();
  const patient = await ctx.agenda.cadastrarPaciente({ name: "Maria Exemplo", phone: PATIENT });
  ctx.clock.now = at("2026-10-19T12:00:00Z");
  const slots = await ctx.agenda.listarHorarios({
    procedureId: opts.procedureId ?? "proc_extracao",
    from: "2026-10-20",
    days: 1,
  });
  const slot = slots.find((s) => s.startsAt.toISOString() === "2026-10-20T17:00:00.000Z")!;
  const { appointmentId } = await ctx.agenda.reservar({ patientId: patient.id, slot });
  ctx.clock.now = new Date(slot.endsAt.getTime() + 30 * 60_000);
  await ctx.staffAgenda.attendance(CLINIC_ID, appointmentId, {
    attended: opts.attended ?? true,
  });
  const sent = (template: string) =>
    ctx.channel.outbox.filter((m) => "template" in m && m.template === template);
  const tap = async (replyId: string, title: string, from = PATIENT) => {
    const before = ctx.channel.outbox.length;
    for (const e of normalizeWebhook(buttonPayload(replyId, title, from)))
      await handleWhatsAppEvent(e, ctx.deps);
    return ctx.channel.outbox.slice(before).map((m) => ("body" in m ? m.body : m.kind));
  };
  return { ...ctx, appointmentId, sent, tap };
}

describe("post-procedure care", () => {
  it("sends the dentist's text right after attendance, once, on one line", async () => {
    const { aftercare, sent } = await setup();
    expect(await aftercare.run(at("2026-10-20T18:30:00Z"))).toEqual({
      instructions: 1,
      checkIns: 0,
    });
    expect(sent("orientacoes_pos_procedimento")).toEqual([
      expect.objectContaining({
        to: PATIENT,
        params: ["Maria", "Clínica Sorriso", "Extração simples", CARE_ONE_LINE],
      }),
    ]);
    expect(oneLine(EXTRACTION_CARE)).toBe(CARE_ONE_LINE);
    expect(
      renderTemplate("orientacoes_pos_procedimento", [
        "Maria",
        "Clínica Sorriso",
        "Extração simples",
        CARE_ONE_LINE,
      ]),
    ).toContain("recomenda depois do seu procedimento (Extração simples): Morda a gaze");
    expect(await aftercare.run(at("2026-10-20T19:00:00Z"))).toEqual({
      instructions: 0,
      checkIns: 0,
    });
  });

  it("sends nothing for procedures without care text, no-shows or old appointments", async () => {
    const cleaning = await setup({ procedureId: "proc_limpeza" });
    expect(await cleaning.aftercare.run(at("2026-10-20T18:30:00Z"))).toMatchObject({
      instructions: 0,
    });
    const noShow = await setup({ attended: false });
    expect(await noShow.aftercare.run(at("2026-10-20T18:30:00Z"))).toMatchObject({
      instructions: 0,
    });
    // Thursday: the appointment was two days ago, the advice would come too late.
    const late = await setup();
    expect(await late.aftercare.run(at("2026-10-22T14:00:00Z"))).toMatchObject({
      instructions: 0,
    });
    // Attendance marked at night: the text waits for 8h the next day.
    const night = await setup();
    expect(await night.aftercare.run(at("2026-10-21T01:00:00Z"))).toMatchObject({
      instructions: 0,
    });
    expect(await night.aftercare.run(at("2026-10-21T11:00:00Z"))).toMatchObject({
      instructions: 1,
    });
  });

  it("asks how the patient is the next day, within hours, with the two buttons", async () => {
    const { aftercare, aftercareRepo, sent } = await setup();
    await aftercare.run(at("2026-10-20T18:30:00Z"));
    // Same day: too soon. Wednesday 9h: before the window.
    expect(await aftercare.run(at("2026-10-20T22:00:00Z"))).toMatchObject({ checkIns: 0 });
    expect(await aftercare.run(at("2026-10-21T12:00:00Z"))).toMatchObject({ checkIns: 0 });
    expect(await aftercare.run(at("2026-10-21T14:00:00Z"))).toEqual({
      instructions: 0,
      checkIns: 1,
    });
    const id = aftercareRepo.followUps[0]!.id;
    expect(sent("acompanhamento_pos_procedimento")).toEqual([
      expect.objectContaining({
        params: ["Maria", "Extração simples", "Clínica Sorriso"],
        buttonPayloads: aftercareButtons(id),
      }),
    ]);
    expect(await aftercare.run(at("2026-10-21T15:00:00Z"))).toMatchObject({ checkIns: 0 });
  });

  it("waits for the front desk to leave the chat and retries a failed send", async () => {
    const { aftercare, aftercareRepo, store, channel, sent } = await setup();
    const conv = await store.getOrCreateConversation(CLINIC_ID, PATIENT);
    await store.updateConversation(conv.id, { botPausedUntil: at("2026-10-20T19:00:00Z") });
    expect(await aftercare.run(at("2026-10-20T18:30:00Z"))).toMatchObject({ instructions: 0 });

    const send = channel.send.bind(channel);
    channel.send = async () => {
      throw new Error("network");
    };
    expect(await aftercare.run(at("2026-10-20T19:30:00Z"))).toMatchObject({ instructions: 0 });
    expect(aftercareRepo.followUps).toEqual([]);
    channel.send = send;
    expect(await aftercare.run(at("2026-10-20T20:00:00Z"))).toMatchObject({ instructions: 1 });

    channel.send = async () => {
      throw new Error("network");
    };
    expect(await aftercare.run(at("2026-10-21T14:00:00Z"))).toMatchObject({ checkIns: 0 });
    expect(aftercareRepo.followUps[0]!.checkInSentAt).toBeNull();
    channel.send = send;
    expect(await aftercare.run(at("2026-10-21T15:00:00Z"))).toMatchObject({ checkIns: 1 });
    expect(sent("acompanhamento_pos_procedimento")).toHaveLength(1);
  });

  it('"Tudo bem" answers once and lets the satisfaction survey go', async () => {
    const { aftercare, aftercareRepo, survey, tap, store } = await setup();
    await aftercare.run(at("2026-10-20T18:30:00Z"));
    await aftercare.run(at("2026-10-21T14:00:00Z"));
    // The rating waits for the check-in answer.
    expect(await survey.run(at("2026-10-21T14:30:00Z"))).toEqual({ sent: 0 });
    const id = aftercareRepo.followUps[0]!.id;
    expect(detectIntent(undefined, `care:${id}:help`)).toEqual({
      kind: "aftercare_answer",
      followUpId: id,
      help: true,
    });
    expect(await tap(`care:${id}:ok`, "Tudo bem", OTHER_PATIENT)).toContain(
      AFTERCARE_MESSAGES.notFound,
    );
    expect((await tap(`care:${id}:ok`, "Tudo bem")).at(-1)).toBe(AFTERCARE_MESSAGES.ok);
    expect(await tap(`care:${id}:ok`, "Tudo bem")).toEqual([AFTERCARE_MESSAGES.answered]);
    expect(aftercareRepo.followUps[0]).toMatchObject({ answer: "OK" });
    const conv = await store.getOrCreateConversation(CLINIC_ID, PATIENT);
    expect(conv.botPausedUntil).toBeNull();
    expect(await survey.run(at("2026-10-21T15:00:00Z"))).toEqual({ sent: 1 });
  });

  it('"Preciso de ajuda" calls the front desk, even after "Tudo bem" and while paused', async () => {
    const { aftercare, aftercareRepo, survey, tap, store, clock } = await setup();
    await aftercare.run(at("2026-10-20T18:30:00Z"));
    await aftercare.run(at("2026-10-21T14:00:00Z"));
    const id = aftercareRepo.followUps[0]!.id;
    clock.now = at("2026-10-21T14:30:00Z");
    await tap(`care:${id}:ok`, "Tudo bem");
    const conv = await store.getOrCreateConversation(CLINIC_ID, PATIENT);
    await store.updateConversation(conv.id, { botPausedUntil: at("2026-10-21T16:00:00Z") });
    clock.now = at("2026-10-21T15:00:00Z");
    const help = await tap(`care:${id}:help`, "Preciso de ajuda");
    expect(help.at(-1)).toBe(AFTERCARE_MESSAGES.help);
    expect(AFTERCARE_MESSAGES.help).toContain("pronto-socorro");
    expect(aftercareRepo.followUps[0]).toMatchObject({ answer: "HELP" });
    const after = await store.getOrCreateConversation(CLINIC_ID, PATIENT);
    expect(after.botPausedUntil!.getTime()).toBeGreaterThan(at("2026-10-21T16:00:00Z").getTime());
    // A later "Tudo bem" does not hide the request for help.
    await tap(`care:${id}:ok`, "Tudo bem");
    expect(aftercareRepo.followUps[0]).toMatchObject({ answer: "HELP" });
    // Nor does the survey come to someone who needed help.
    expect(await survey.run(at("2026-10-22T14:00:00Z"))).toEqual({ sent: 0 });
  });

  it("an alarm sign written after the instructions still goes to the emergency message", async () => {
    const { aftercare, channel, deps, store, clock } = await setup();
    await aftercare.run(at("2026-10-20T18:30:00Z"));
    clock.now = at("2026-10-20T23:00:00Z");
    const before = channel.outbox.length;
    for (const e of normalizeWebhook(textPayload("o sangramento não para desde a extração")))
      await handleWhatsAppEvent(e, deps);
    const replies = channel.outbox.slice(before).map((m) => ("body" in m ? m.body : m.kind));
    expect(replies.at(-1)).toBe(MESSAGES.emergency);
    const conv = await store.getOrCreateConversation(CLINIC_ID, PATIENT);
    expect(conv.botPausedUntil).not.toBeNull();
  });

  it("summarizes the month and lists help requests with a masked phone", async () => {
    const { aftercare, aftercareRepo } = await setup();
    await aftercare.run(at("2026-10-20T18:30:00Z"));
    await aftercare.run(at("2026-10-21T14:00:00Z"));
    const id = aftercareRepo.followUps[0]!.id;
    await aftercare.answer(CLINIC_ID, PATIENT, id, "HELP", at("2026-10-21T15:00:00Z"));
    const summary = await aftercare.summary(CLINIC_ID, at("2026-10-22T12:00:00Z"));
    expect(summary.month).toEqual({ sent: 1, checkIns: 1, ok: 0, help: 1 });
    expect(summary.help).toEqual([
      expect.objectContaining({
        patientName: "Maria Exemplo",
        patientPhone: "***0001",
        procedureName: "Extração simples",
      }),
    ]);
    expect((await aftercare.summary(CLINIC_ID, at("2026-11-10T12:00:00Z"))).help).toEqual([]);
    expect(await aftercare.summary("other_clinic", at("2026-10-22T12:00:00Z"))).toMatchObject({
      month: { sent: 0 },
      help: [],
    });
  });
});
