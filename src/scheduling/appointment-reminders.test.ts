import { describe, expect, it } from "vitest";
import {
  buttonPayload,
  CLINIC_ID,
  echoPayload,
  makeDeps,
  OTHER_PATIENT,
  PATIENT,
} from "../../tests/support/fixtures.js";
import { handleWhatsAppEvent } from "../conversation/handler.js";
import { detectIntent } from "../conversation/intents.js";
import { silentLogger } from "../lib/logger.js";
import { normalizeWebhook, previewText, type WebhookPayload } from "../whatsapp/index.js";
import {
  AppointmentReminders,
  InMemoryAppointmentReminderRepository,
} from "./appointment-reminders.js";

const at = (iso: string) => new Date(iso);

/** Avaliação on Tuesday 20/10 at 14:00 in São Paulo. Clock starts Monday 19/10, 09:00. */
async function setup() {
  const ctx = makeDeps();
  const patient = await ctx.agenda.cadastrarPaciente({ name: "Maria Exemplo", phone: PATIENT });
  const slots = await ctx.agenda.listarHorarios({
    procedureId: "proc_avaliacao",
    from: "2026-10-20",
    days: 1,
  });
  const slot = slots.find((s) => s.startsAt.toISOString() === "2026-10-20T17:00:00.000Z")!;
  const { appointmentId } = await ctx.agenda.reservar({ patientId: patient.id, slot });
  return { ctx, patient, appointmentId };
}

describe("AppointmentReminders", () => {
  it("sends the reminder template the day before, once, with the reply buttons", async () => {
    const { ctx, appointmentId } = await setup();
    expect(await ctx.appointmentReminders.run(at("2026-10-19T12:00:00Z"))).toEqual({ sent: 1 });
    expect(ctx.channel.outbox).toMatchObject([
      {
        kind: "template",
        to: PATIENT,
        template: "lembrete_consulta",
        params: ["Maria", "terça-feira, 20/10 às 14:00", "Clínica Sorriso"],
        buttonPayloads: [`appt:${appointmentId}:confirm`, `appt:${appointmentId}:reschedule`],
      },
    ]);
    const conv = await ctx.store.getOrCreateConversation(CLINIC_ID, PATIENT);
    expect(ctx.store.messages.filter((m) => m.conversationId === conv.id)).toHaveLength(1);

    await ctx.appointmentReminders.run(at("2026-10-19T15:00:00Z"));
    expect(ctx.channel.outbox).toHaveLength(1);
  });

  it("only reminds on the day before and in business hours of the clinic's zone", async () => {
    const { ctx } = await setup();
    await ctx.appointmentReminders.run(at("2026-10-18T15:00:00Z")); // two days before
    await ctx.appointmentReminders.run(at("2026-10-19T11:00:00Z")); // 08:00 in São Paulo
    await ctx.appointmentReminders.run(at("2026-10-19T22:00:00Z")); // 19:00 in São Paulo
    await ctx.appointmentReminders.run(at("2026-10-20T12:00:00Z")); // the day itself
    expect(ctx.channel.outbox).toEqual([]);
  });

  it("skips cancelled appointments and reminds again after a reschedule", async () => {
    const { ctx, patient, appointmentId } = await setup();
    await ctx.appointmentReminders.run(at("2026-10-19T12:00:00Z"));
    const [later] = await ctx.agenda.listarHorarios({
      procedureId: "proc_avaliacao",
      from: "2026-10-22",
      days: 1,
    });
    await ctx.agenda.remarcar({ appointmentId, patientId: patient.id, slot: later! });
    await ctx.appointmentReminders.run(at("2026-10-21T12:00:00Z"));
    expect(ctx.channel.outbox.map((m) => m.kind === "template" && m.params[1])).toEqual([
      "terça-feira, 20/10 às 14:00",
      "quinta-feira, 22/10 às 08:00",
    ]);

    const fresh = await setup();
    await fresh.ctx.agenda.cancelar({
      appointmentId: fresh.appointmentId,
      patientId: fresh.patient.id,
    });
    expect(await fresh.ctx.appointmentReminders.run(at("2026-10-19T12:00:00Z"))).toEqual({
      sent: 0,
    });
  });

  it("releases the reminder when sending fails, so the next run retries", async () => {
    const { ctx } = await setup();
    const reminders = new AppointmentReminders({
      repo: new InMemoryAppointmentReminderRepository(ctx.agendaRepo, "Clínica Sorriso"),
      channel: {
        send: async () => {
          throw new Error("WhatsApp unavailable");
        },
      },
      store: ctx.store,
      logger: silentLogger,
    });
    expect(await reminders.run(at("2026-10-19T12:00:00Z"))).toEqual({ sent: 0 });
    expect(ctx.agendaRepo.appointments[0]!.reminderSentAt).toBeNull();
    expect(await ctx.appointmentReminders.run(at("2026-10-19T13:00:00Z"))).toEqual({ sent: 1 });
  });
});

describe("reminder buttons", () => {
  async function deliver(payload: WebhookPayload, deps: ReturnType<typeof makeDeps>["deps"]) {
    for (const e of normalizeWebhook(payload)) await handleWhatsAppEvent(e, deps);
  }

  it("parses the reminder buttons and ignores anything else", () => {
    expect(detectIntent("Confirmar", "appt:appt_1:confirm")).toEqual({
      kind: "appointment_action",
      appointmentId: "appt_1",
      action: "confirm",
    });
    expect(detectIntent("Remarcar", "appt:appt_1:reschedule")).toMatchObject({
      action: "reschedule",
    });
    expect(detectIntent("x", "appt:appt_1:cancel").kind).toBe("other");
    expect(detectIntent("appt:appt_1:confirm").kind).toBe("other");
  });

  it("does not confirm someone else's appointment from another number", async () => {
    const { ctx, appointmentId } = await setup();
    await ctx.agenda.cadastrarPaciente({ name: "João Exemplo", phone: OTHER_PATIENT });
    await deliver(
      buttonPayload(`appt:${appointmentId}:confirm`, "Confirmar", OTHER_PATIENT),
      ctx.deps,
    );
    expect(ctx.agendaRepo.appointments[0]!.status).toBe("PENDING_CONFIRMATION");
    expect(previewText(ctx.channel.outbox.at(-1)!)).toContain("Não encontrei essa consulta");
    expect(ctx.channel.outbox.at(-1)!.to).toBe(OTHER_PATIENT);
  });

  it("leaves Remarcar to the front desk while it is in the chat", async () => {
    const { ctx, appointmentId } = await setup();
    await deliver(echoPayload("Oi, Maria!"), ctx.deps);
    await deliver(buttonPayload(`appt:${appointmentId}:reschedule`, "Remarcar"), ctx.deps);
    expect(ctx.channel.outbox).toEqual([]);
  });

  it("hands the confirmation to the front desk when there is no agenda", async () => {
    const { ctx, appointmentId } = await setup();
    const deps = { ...ctx.deps, agendaFor: undefined };
    await deliver(buttonPayload(`appt:${appointmentId}:confirm`, "Confirmar"), deps);
    expect(previewText(ctx.channel.outbox.at(-1)!)).toContain("Não encontrei essa consulta");
    expect(ctx.agendaRepo.appointments[0]!.status).toBe("PENDING_CONFIRMATION");
    const conv = await ctx.store.getOrCreateConversation(CLINIC_ID, PATIENT);
    expect(conv.botPausedUntil).not.toBeNull();
  });
});
