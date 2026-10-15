import { describe, expect, it } from "vitest";
import { CLINIC_ID, makeDeps, PATIENT } from "../../tests/support/fixtures.js";
import { handleWhatsAppEvent } from "../conversation/handler.js";
import { silentLogger } from "../lib/logger.js";
import { fakeButtonReply, normalizeWebhook, previewText } from "../whatsapp/index.js";
import { AgendaService } from "./agenda-service.js";
import { StaffAgenda, StaffAgendaError } from "./staff-agenda.js";

// Clock: Monday 19/10/2026, 09:00 in São Paulo. Tuesday 20/10 14:00 = 17:00Z.
const TUESDAY_14H = "2026-10-20T17:00:00.000Z";
const WEDNESDAY_10H = "2026-10-21T13:00:00.000Z";

async function setup() {
  const ctx = makeDeps();
  const maria = await ctx.agenda.cadastrarPaciente({ name: "Maria Exemplo", phone: PATIENT });
  return { ...ctx, maria };
}

const bookBody = (patient: unknown, startsAt = WEDNESDAY_10H) => ({
  patient,
  procedureId: "proc_avaliacao",
  dentistId: "dentist_dev",
  startsAt,
});

async function rejection(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(StaffAgendaError);
  return err as StaffAgendaError;
}

describe("StaffAgenda", () => {
  it("lists free slots with the bot's rules", async () => {
    const { staffAgenda } = await setup();
    const slots = await staffAgenda.slots(CLINIC_ID, {
      procedureId: "proc_avaliacao",
      from: "2026-10-20",
    });
    expect(slots[0]).toEqual({
      dentistId: "dentist_dev",
      startsAt: "2026-10-20T11:00:00.000Z",
      endsAt: "2026-10-20T11:30:00.000Z",
    });
    expect(slots.some((s) => s.startsAt === "2026-10-20T15:00:00.000Z")).toBe(false); // lunch
    await rejection(staffAgenda.slots(CLINIC_ID, { procedureId: "x", from: "20/10/2026" }));
  });

  it("books for a patient and sends the confirmation template with the buttons", async () => {
    const { staffAgenda, channel, agendaRepo, maria } = await setup();
    const { id, notified } = await staffAgenda.book(CLINIC_ID, bookBody({ id: maria.id }));
    expect(notified).toBe(true);
    expect(agendaRepo.appointments).toMatchObject([
      { id, patientId: maria.id, status: "PENDING_CONFIRMATION", reminderSentAt: null },
    ]);
    expect(channel.outbox).toMatchObject([
      {
        kind: "template",
        to: PATIENT,
        template: "confirmacao_consulta",
        params: ["Maria", "Clínica Sorriso", "quarta-feira, 21/10 às 10:00"],
        buttonPayloads: [`appt:${id}:confirm`, `appt:${id}:reschedule`],
      },
    ]);
  });

  it("registers a new patient by phone, reusing an existing record", async () => {
    const { staffAgenda, agendaRepo, maria } = await setup();
    const again = await staffAgenda.book(
      CLINIC_ID,
      bookBody({ name: "Maria E.", phone: "(11) 90000-0001" }),
    );
    expect(agendaRepo.appointments.find((a) => a.id === again.id)!.patientId).toBe(maria.id);

    const fresh = await staffAgenda.book(
      CLINIC_ID,
      bookBody({ name: "João Exemplo", phone: "11 90000-0002" }, TUESDAY_14H),
    );
    const patient = agendaRepo.patients.find(
      (p) => p.id === agendaRepo.appointments.find((a) => a.id === fresh.id)!.patientId,
    );
    expect(patient).toMatchObject({ name: "João Exemplo", phone: "5511900000002" });

    const bad = await rejection(
      staffAgenda.book(CLINIC_ID, bookBody({ name: "Sem Celular", phone: "123" })),
    );
    expect(bad.status).toBe(422);
  });

  it("refuses a taken slot, a time outside working hours and unknown ids", async () => {
    const { staffAgenda, maria } = await setup();
    await staffAgenda.book(CLINIC_ID, bookBody({ id: maria.id }));
    expect((await rejection(staffAgenda.book(CLINIC_ID, bookBody({ id: maria.id })))).status).toBe(
      409,
    );
    const lunch = bookBody({ id: maria.id }, "2026-10-21T15:30:00.000Z"); // 12:30
    expect((await rejection(staffAgenda.book(CLINIC_ID, lunch))).status).toBe(409);
    expect(
      (await rejection(staffAgenda.book(CLINIC_ID, bookBody({ id: "pat_outra_clinica" })))).status,
    ).toBe(404);
    expect(
      (
        await rejection(
          staffAgenda.book(CLINIC_ID, { ...bookBody({ id: maria.id }), procedureId: "proc_x" }),
        )
      ).status,
    ).toBe(422);
    expect(
      (await rejection(staffAgenda.book("other_clinic", bookBody({ id: maria.id })))).status,
    ).toBe(404);
  });

  it("does not send the day-before reminder again when the notice already went out", async () => {
    const { staffAgenda, agendaRepo, appointmentReminders, channel, maria, clock } = await setup();
    const tomorrow = await staffAgenda.book(CLINIC_ID, bookBody({ id: maria.id }, TUESDAY_14H));
    const later = await staffAgenda.book(CLINIC_ID, bookBody({ id: maria.id }));
    expect(agendaRepo.appointments.find((a) => a.id === tomorrow.id)!.reminderSentAt).toEqual(
      clock.now,
    );
    expect(agendaRepo.appointments.find((a) => a.id === later.id)!.reminderSentAt).toBeNull();
    expect(await appointmentReminders.run(clock.now)).toEqual({ sent: 0 });
    expect(channel.outbox).toHaveLength(2);
  });

  it("moves and cancels an appointment, telling the patient the new date", async () => {
    const { staffAgenda, agendaRepo, channel, maria } = await setup();
    const { id } = await staffAgenda.book(CLINIC_ID, {
      ...bookBody({ id: maria.id }),
      notify: false,
    });
    expect(channel.outbox).toEqual([]);

    const moved = await staffAgenda.reschedule(CLINIC_ID, id, {
      dentistId: "dentist_dev",
      startsAt: TUESDAY_14H,
    });
    expect(moved).toEqual({ notified: true });
    expect(agendaRepo.appointments[0]).toMatchObject({
      startsAt: new Date(TUESDAY_14H),
      status: "PENDING_CONFIRMATION",
    });
    expect(previewText(channel.outbox[0]!)).toContain("terça-feira, 20/10 às 14:00");

    await staffAgenda.cancel(CLINIC_ID, id);
    expect(agendaRepo.appointments[0]!.status).toBe("CANCELLED");
    expect((await rejection(staffAgenda.cancel(CLINIC_ID, id))).status).toBe(404);
    expect(
      (
        await rejection(
          staffAgenda.reschedule(CLINIC_ID, id, {
            dentistId: "dentist_dev",
            startsAt: WEDNESDAY_10H,
          }),
        )
      ).status,
    ).toBe(404);
  });

  it("keeps the booking when the WhatsApp notice fails", async () => {
    const ctx = await setup();
    const staff = new StaffAgenda({
      open: async () => ({
        agenda: new AgendaService(ctx.agendaRepo, {
          now: () => ctx.clock.now,
          minNoticeMinutes: 0,
        }),
        repo: ctx.agendaRepo,
        clinicName: "Clínica Sorriso",
      }),
      channel: {
        send: async () => {
          throw new Error("WhatsApp unavailable");
        },
      },
      store: ctx.store,
      logger: silentLogger,
      now: () => ctx.clock.now,
    });
    const r = await staff.book(CLINIC_ID, bookBody({ id: ctx.maria.id }, TUESDAY_14H));
    expect(r.notified).toBe(false);
    // No notice went out, so the day-before reminder still will.
    expect(ctx.agendaRepo.appointments[0]!.reminderSentAt).toBeNull();
  });

  it("lets the patient confirm from the notice's button", async () => {
    const { staffAgenda, agendaRepo, deps, maria } = await setup();
    const { id } = await staffAgenda.book(CLINIC_ID, bookBody({ id: maria.id }));
    const payload = fakeButtonReply({
      phoneNumberId: "100000000000001",
      from: PATIENT,
      replyId: `appt:${id}:confirm`,
      title: "Confirmar",
    });
    for (const e of normalizeWebhook(payload)) await handleWhatsAppEvent(e, deps);
    expect(agendaRepo.appointments[0]!.status).toBe("CONFIRMED");
  });
});
