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
import { normalizeWebhook, renderTemplate } from "../whatsapp/index.js";
import { SURVEY_MESSAGES, surveyButtons } from "./survey.js";

const at = (iso: string) => new Date(iso);

/**
 * Maria's Avaliação on Tuesday 20/10 at 14:00 (São Paulo). The front desk marks
 * "Compareceu" at 15:00, unless `attended` is false.
 */
async function setup(opts: { attended?: boolean; day?: string; hourUtc?: string } = {}) {
  const ctx = makeDeps();
  const patient = await ctx.agenda.cadastrarPaciente({ name: "Maria Exemplo", phone: PATIENT });
  const visit = async (day: string, hourUtc: string, attended = true) => {
    ctx.clock.now = at("2026-10-19T12:00:00Z");
    const slots = await ctx.agenda.listarHorarios({
      procedureId: "proc_avaliacao",
      from: day,
      days: 1,
    });
    const slot = slots.find((s) => s.startsAt.toISOString() === `${day}T${hourUtc}:00:00.000Z`)!;
    const { appointmentId } = await ctx.agenda.reservar({ patientId: patient.id, slot });
    ctx.clock.now = new Date(slot.endsAt.getTime() + 30 * 60_000);
    await ctx.staffAgenda.attendance(CLINIC_ID, appointmentId, { attended });
    return appointmentId;
  };
  const appointmentId = await visit(opts.day ?? "2026-10-20", opts.hourUtc ?? "17", opts.attended);
  const surveys = () =>
    ctx.channel.outbox.filter((m) => "template" in m && m.template === "pesquisa_satisfacao");
  const tap = async (replyId: string, title: string, from = PATIENT) => {
    const before = ctx.channel.outbox.length;
    for (const e of normalizeWebhook(buttonPayload(replyId, title, from)))
      await handleWhatsAppEvent(e, ctx.deps);
    return ctx.channel.outbox.slice(before).map((m) => ("body" in m ? m.body : m.kind));
  };
  return { ...ctx, appointmentId, surveys, tap, visit };
}

describe("satisfaction survey", () => {
  it("asks once, the day after an attended appointment, with the rating buttons", async () => {
    const { survey, surveyRepo, surveys } = await setup();
    // Same day, 17h in São Paulo: too soon.
    expect(await survey.run(at("2026-10-20T20:00:00Z"))).toEqual({ sent: 0 });
    // Wednesday 9h: before the sending window.
    expect(await survey.run(at("2026-10-21T12:00:00Z"))).toEqual({ sent: 0 });
    expect(await survey.run(at("2026-10-21T14:00:00Z"))).toEqual({ sent: 1 });
    const id = surveyRepo.surveys[0]!.id;
    expect(surveys()).toEqual([
      expect.objectContaining({
        to: PATIENT,
        params: ["Maria", "Clínica Sorriso", "20/10"],
        buttonPayloads: surveyButtons(id),
      }),
    ]);
    expect(renderTemplate("pesquisa_satisfacao", ["Maria", "Clínica Sorriso", "20/10"])).toContain(
      "de 1 a 5",
    );
    expect(await survey.run(at("2026-10-21T15:00:00Z"))).toEqual({ sent: 0 });
  });

  it("does not ask after a no-show, nor days later, nor twice in a month", async () => {
    const noShow = await setup({ attended: false });
    expect(await noShow.survey.run(at("2026-10-21T14:00:00Z"))).toEqual({ sent: 0 });

    const late = await setup();
    // Saturday 24/10: the appointment is 4 days old.
    expect(await late.survey.run(at("2026-10-24T14:00:00Z"))).toEqual({ sent: 0 });

    const twice = await setup();
    expect(await twice.survey.run(at("2026-10-21T14:00:00Z"))).toEqual({ sent: 1 });
    await twice.visit("2026-10-22", "17");
    expect(await twice.survey.run(at("2026-10-23T14:00:00Z"))).toEqual({ sent: 0 });
  });

  it("waits for the front desk to leave the chat and retries a failed send", async () => {
    const { survey, store, channel, surveyRepo, surveys } = await setup();
    const conv = await store.getOrCreateConversation(CLINIC_ID, PATIENT);
    await store.updateConversation(conv.id, { botPausedUntil: at("2026-10-21T15:00:00Z") });
    expect(await survey.run(at("2026-10-21T14:00:00Z"))).toEqual({ sent: 0 });

    const send = channel.send.bind(channel);
    channel.send = async () => {
      throw new Error("network");
    };
    expect(await survey.run(at("2026-10-21T16:00:00Z"))).toEqual({ sent: 0 });
    expect(surveyRepo.surveys).toEqual([]);
    channel.send = send;
    expect(await survey.run(at("2026-10-21T17:00:00Z"))).toEqual({ sent: 1 });
    expect(surveys()).toHaveLength(1);
  });

  it("thanks a good rating once and ignores someone else's tap", async () => {
    const { survey, surveyRepo, tap, store } = await setup();
    await survey.run(at("2026-10-21T14:00:00Z"));
    const id = surveyRepo.surveys[0]!.id;
    expect(detectIntent(undefined, `survey:${id}:4`)).toEqual({
      kind: "survey_answer",
      surveyId: id,
      rating: 4,
    });
    expect(await tap(`survey:${id}:5`, "5 - Excelente", OTHER_PATIENT)).toContain(
      SURVEY_MESSAGES.notFound,
    );
    expect((await tap(`survey:${id}:5`, "5 - Excelente")).at(-1)).toBe(SURVEY_MESSAGES.thanks);
    expect(await tap(`survey:${id}:1`, "1 - Péssimo")).toEqual([SURVEY_MESSAGES.answered]);
    expect(surveyRepo.surveys[0]).toMatchObject({ rating: 5 });
    const conv = await store.getOrCreateConversation(CLINIC_ID, PATIENT);
    expect(conv.botPausedUntil).toBeNull();
  });

  it("a low rating calls the front desk, even while it is in the chat", async () => {
    const { survey, surveyRepo, tap, store, clock } = await setup();
    await survey.run(at("2026-10-21T14:00:00Z"));
    const id = surveyRepo.surveys[0]!.id;
    const conv = await store.getOrCreateConversation(CLINIC_ID, PATIENT);
    await store.updateConversation(conv.id, { botPausedUntil: at("2026-10-21T16:00:00Z") });
    clock.now = at("2026-10-21T15:00:00Z");
    expect((await tap(`survey:${id}:2`, "2 - Ruim")).at(-1)).toBe(SURVEY_MESSAGES.low);
    const after = await store.getOrCreateConversation(CLINIC_ID, PATIENT);
    expect(after.botPausedUntil!.getTime()).toBeGreaterThan(at("2026-10-21T16:00:00Z").getTime());
  });

  it("summarizes the month and lists the low ratings with a masked phone", async () => {
    const { survey, surveyRepo } = await setup();
    await survey.run(at("2026-10-21T14:00:00Z"));
    const id = surveyRepo.surveys[0]!.id;
    await survey.answer(CLINIC_ID, PATIENT, id, 2, at("2026-10-21T15:00:00Z"));
    const summary = await survey.summary(CLINIC_ID, at("2026-10-22T12:00:00Z"));
    expect(summary.month).toEqual({ sent: 1, answers: 1, average: 2, byRating: [0, 1, 0, 0, 0] });
    expect(summary.low).toEqual([
      expect.objectContaining({ patientName: "Maria Exemplo", patientPhone: "***0001", rating: 2 }),
    ]);
    // November: a new month, the low rating still shows for 30 days.
    const next = await survey.summary(CLINIC_ID, at("2026-11-02T12:00:00Z"));
    expect(next.month.sent).toBe(0);
    expect(next.low).toHaveLength(1);
    expect(await survey.summary("other_clinic", at("2026-10-22T12:00:00Z"))).toMatchObject({
      month: { sent: 0 },
      low: [],
    });
  });
});
